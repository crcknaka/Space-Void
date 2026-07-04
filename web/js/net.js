// WebRTC peer connection + signaling client.
// Host createRoom() -> gets a code, waits for a guest.
// Guest joinRoom(code) -> connects to the host.
// Once open, both use net.send(obj) / net.onMessage(fn) over a data channel.

// STUN finds your public address; TURN relays traffic when a direct P2P path
// is blocked (strict/symmetric NAT, mobile carriers). The live server list is
// fetched from /api/ice so a reliable TURN can be configured via env vars; this
// is the offline/fallback set (best-effort public relay).
const FALLBACK_ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

let iceCache = null;
async function getIce() {
  if (iceCache) return iceCache;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch('/api/ice', { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      if (data.iceServers?.length) { iceCache = data; return data; }
    }
  } catch { /* offline / error -> fallback */ }
  iceCache = FALLBACK_ICE;
  return FALLBACK_ICE;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeCode() {
  let c = '';
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return c;
}

// Resolve once ICE gathering finishes (non-trickle), capped so a stuck
// gatherer never hangs the handshake.
function iceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, 5000); // allow time to gather TURN relay candidates
  });
}

async function postSDP(room, role, sdp) {
  await fetch('/api/rtc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, role, sdp: { type: sdp.type, sdp: sdp.sdp } }),
  });
}

async function getSDP(room, role) {
  const r = await fetch(`/api/rtc?room=${room}&role=${role}`);
  if (!r.ok) return null;
  return (await r.json()).sdp;
}

async function poll(fn, intervalMs, timeoutMs, cancelled) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cancelled()) return null;
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export class Net {
  constructor(isHost) {
    this.isHost = isHost;
    this.pc = null;
    this.dc = null;
    this.code = null;
    this.state = 'idle'; // idle | signaling | connecting | open | failed | closed
    this._cancelled = false;
    this.onMessage = () => {};
    this.onState = () => {};
  }

  _set(s) { this.state = s; this.onState(s); }

  _wireChannel(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this._set('open');
    dc.onclose = () => this._set('closed');
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(msg);
    };
  }

  send(obj) {
    if (this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(obj)); } catch {}
    }
  }

  async createRoom() {
    this._set('signaling');
    this.code = makeCode();
    this.pc = new RTCPeerConnection(await getIce());
    this._watchConnection();
    this._wireChannel(this.pc.createDataChannel('game', { ordered: true }));

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await iceComplete(this.pc);
    await postSDP(this.code, 'offer', this.pc.localDescription);

    this._set('connecting');
    const answer = await poll(() => getSDP(this.code, 'answer'), 1200, 120000, () => this._cancelled);
    if (this._cancelled) return;
    if (!answer) { this._set('failed'); return; }
    await this.pc.setRemoteDescription(answer);
    this._cleanupRoom();
    return this.code;
  }

  async joinRoom(code) {
    this.code = String(code || '').toUpperCase();
    this._set('signaling');
    const offer = await poll(() => getSDP(this.code, 'offer'), 1000, 20000, () => this._cancelled);
    if (this._cancelled) return;
    if (!offer) { this._set('failed'); return; }

    this.pc = new RTCPeerConnection(await getIce());
    this._watchConnection();
    this.pc.ondatachannel = (e) => this._wireChannel(e.channel);

    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await iceComplete(this.pc);
    await postSDP(this.code, 'answer', this.pc.localDescription);
    this._set('connecting');
  }

  _watchConnection() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if ((s === 'failed' || s === 'disconnected') && this.state !== 'open') this._set('failed');
      if (s === 'failed' && this.state === 'open') this._set('closed');
    };
  }

  _cleanupRoom() {
    if (!this.code) return;
    fetch(`/api/rtc?room=${this.code}`, { method: 'DELETE' }).catch(() => {});
  }

  cancel() {
    this._cancelled = true;
    this.close();
  }

  close() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null;
    this.pc = null;
    if (this.state !== 'closed') this._set('closed');
  }
}
