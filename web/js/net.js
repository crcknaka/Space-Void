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

// Resolve once ICE gathering finishes (non-trickle). We wait for a TURN
// relay candidate (needed on mobile/strict NAT) before resolving, with a
// generous cap — otherwise a fast 'complete' with only host candidates would
// post an SDP lacking the relay path and mobile peers could never connect.
function iceComplete(pc) {
  return new Promise((resolve) => {
    let sawRelay = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCand);
      resolve();
    };
    const onCand = (e) => {
      if (e.candidate && /typ relay/.test(e.candidate.candidate || '')) {
        sawRelay = true;
        setTimeout(finish, 400); // got a relay path — a moment for any extras, then go
      }
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCand);
    setTimeout(finish, 9000); // hard cap so a stuck gatherer never hangs
  });
}

async function postSDP(room, slot, role, sdp) {
  await fetch('/api/rtc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, slot, role, sdp: { type: sdp.type, sdp: sdp.sdp } }),
  });
}

async function getSDP(room, slot, role) {
  const r = await fetch(`/api/rtc?room=${room}&slot=${slot}&role=${role}`);
  if (!r.ok) return null;
  return (await r.json()).sdp;
}

async function listSlots(room) {
  try {
    const r = await fetch(`/api/rtc?room=${room}&list=1`);
    if (!r.ok) return [];
    return (await r.json()).slots || [];
  } catch { return []; }
}

function randSlot() {
  const a = new Uint32Array(2); crypto.getRandomValues(a);
  return (a[0].toString(36) + a[1].toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 12) || 'g';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.state = 'idle'; // idle | signaling | connecting | open | reconnecting | failed | closed
    this.rtt = 0;        // round-trip time in ms (ping)
    this._cancelled = false;
    this._pingTimer = null;
    this._recoverTimer = null;
    this.onMessage = () => {};
    this.onState = () => {};
  }

  _set(s) { this.state = s; this.onState(s); }

  _wireChannel(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { this._set('open'); this._startPing(); };
    dc.onclose = () => this._set('closed');
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      // intercept ping/pong before handing off to the game
      if (msg.k === '__ping') { this.send({ k: '__pong', t: msg.t }); return; }
      if (msg.k === '__pong') { this.rtt = Date.now() - msg.t; return; }
      this.onMessage(msg);
    };
  }

  _startPing() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => this.send({ k: '__ping', t: Date.now() }), 1000);
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
    await postSDP(this.code, 'main', 'offer', this.pc.localDescription);

    this._set('connecting');
    const answer = await poll(() => getSDP(this.code, 'main', 'answer'), 1200, 120000, () => this._cancelled);
    if (this._cancelled) return;
    if (!answer) { this._set('failed'); return; }
    await this.pc.setRemoteDescription(answer);
    this._cleanupRoom();
    return this.code;
  }

  async joinRoom(code) {
    this.code = String(code || '').toUpperCase();
    this._set('signaling');
    const offer = await poll(() => getSDP(this.code, 'main', 'offer'), 1000, 20000, () => this._cancelled);
    if (this._cancelled) return;
    if (!offer) { this._set('failed'); return; }

    this.pc = new RTCPeerConnection(await getIce());
    this._watchConnection();
    this.pc.ondatachannel = (e) => this._wireChannel(e.channel);

    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await iceComplete(this.pc);
    await postSDP(this.code, 'main', 'answer', this.pc.localDescription);
    this._set('connecting');
  }

  _watchConnection() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') {
        if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
        if (this.state === 'reconnecting') this._set('open');
      } else if (s === 'disconnected') {
        // transient drop (wifi hiccup): give ICE a chance to recover before giving up
        if (this.state === 'open') {
          this._set('reconnecting');
          this._recoverTimer = setTimeout(() => { if (this.state === 'reconnecting') this._set('closed'); }, 12000);
        }
      } else if (s === 'failed') {
        if (this.state === 'open' || this.state === 'reconnecting') this._set('closed');
        else this._set('failed');
      }
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
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null;
    this.pc = null;
    if (this.state !== 'closed') this._set('closed');
  }
}

/* --------------------- 4-player co-op: host hub + guest link --------------------- */

// Host: answers each guest that posts an offer (star topology, host = hub).
export class CoopHub {
  constructor() {
    this.isHost = true;
    this.code = null;
    this.peers = new Map();     // slot -> { pc, dc, rtt, _pt }
    this.locked = false;        // stop accepting once the game starts
    this._cancelled = false;
    this._handled = new Set();
    this.onGuestJoin = () => {};
    this.onGuestLeave = () => {};
    this.onMessage = () => {};   // (slot, msg)
  }

  get count() { return [...this.peers.values()].filter((p) => p.dc?.readyState === 'open').length; }

  async createRoom() { this.code = makeCode(); this._loop(); return this.code; }

  async _loop() {
    while (!this._cancelled) {
      if (!this.locked && this.peers.size < 3) {
        for (const slot of await listSlots(this.code)) {
          if (this._cancelled) return;
          if (!this._handled.has(slot) && this.peers.size < 3) { this._handled.add(slot); this._accept(slot); }
        }
      }
      await sleep(1200);
    }
  }

  async _accept(slot) {
    try {
      const offer = await getSDP(this.code, slot, 'offer');
      if (!offer || this._cancelled) return;
      const pc = new RTCPeerConnection(await getIce());
      const peer = { pc, dc: null, rtt: 0, _pt: null };
      this.peers.set(slot, peer);
      pc.ondatachannel = (e) => { peer.dc = e.channel; this._wire(slot, peer, e.channel); };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'closed') this._drop(slot);
      };
      await pc.setRemoteDescription(offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await iceComplete(pc);
      await postSDP(this.code, slot, 'answer', pc.localDescription);
    } catch { this._drop(slot); }
  }

  _wire(slot, peer, dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { this.onGuestJoin(slot); peer._pt = setInterval(() => this.sendTo(slot, { k: '__ping', t: Date.now() }), 1000); };
    dc.onclose = () => this._drop(slot);
    dc.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.k === '__ping') { this.sendTo(slot, { k: '__pong', t: m.t }); return; }
      if (m.k === '__pong') { peer.rtt = Date.now() - m.t; return; }
      this.onMessage(slot, m);
    };
  }

  _drop(slot) {
    const p = this.peers.get(slot);
    if (!p) return;
    if (p._pt) clearInterval(p._pt);
    try { p.dc?.close(); } catch {}
    try { p.pc?.close(); } catch {}
    this.peers.delete(slot);
    this.onGuestLeave(slot);
  }

  sendTo(slot, o) {
    const p = this.peers.get(slot);
    if (p?.dc?.readyState === 'open') { try { p.dc.send(JSON.stringify(o)); } catch {} }
  }

  broadcast(o) {
    const s = JSON.stringify(o);
    for (const p of this.peers.values()) if (p.dc?.readyState === 'open') { try { p.dc.send(s); } catch {} }
  }

  avgPing() {
    const v = [...this.peers.values()].map((p) => p.rtt).filter(Boolean);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  }

  cleanupRoom() { if (this.code) fetch(`/api/rtc?room=${this.code}`, { method: 'DELETE' }).catch(() => {}); }
  cancel() { this._cancelled = true; this.close(); }
  close() { this._cancelled = true; for (const slot of [...this.peers.keys()]) this._drop(slot); this.cleanupRoom(); }
}

// Guest: offers to the host (single connection). Mirrors Net but guest = offerer.
export class CoopLink {
  constructor() {
    this.isHost = false;
    this.code = null;
    this.slot = null;
    this.pc = null;
    this.dc = null;
    this.state = 'idle';
    this.rtt = 0;
    this._cancelled = false;
    this._pingTimer = null;
    this._recoverTimer = null;
    this.onMessage = () => {};
    this.onState = () => {};
  }

  _set(s) { this.state = s; this.onState(s); }
  send(o) { if (this.dc?.readyState === 'open') { try { this.dc.send(JSON.stringify(o)); } catch {} } }

  _wire(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { this._set('open'); if (!this._pingTimer) this._pingTimer = setInterval(() => this.send({ k: '__ping', t: Date.now() }), 1000); };
    dc.onclose = () => this._set('closed');
    dc.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.k === '__ping') { this.send({ k: '__pong', t: m.t }); return; }
      if (m.k === '__pong') { this.rtt = Date.now() - m.t; return; }
      this.onMessage(m);
    };
  }

  async join(code) {
    this.code = String(code || '').toUpperCase();
    this.slot = randSlot();
    this._set('signaling');
    this.pc = new RTCPeerConnection(await getIce());
    this._watch();
    this._wire(this.pc.createDataChannel('game', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await iceComplete(this.pc);
    await postSDP(this.code, this.slot, 'offer', this.pc.localDescription);
    this._set('connecting');
    const ans = await poll(() => getSDP(this.code, this.slot, 'answer'), 1000, 60000, () => this._cancelled);
    if (this._cancelled) return;
    if (!ans) { this._set('failed'); return; }
    await this.pc.setRemoteDescription(ans);
  }

  _watch() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') {
        if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
        if (this.state === 'reconnecting') this._set('open');
      } else if (s === 'disconnected') {
        if (this.state === 'open') {
          this._set('reconnecting');
          this._recoverTimer = setTimeout(() => { if (this.state === 'reconnecting') this._set('closed'); }, 12000);
        }
      } else if (s === 'failed') {
        if (this.state === 'open' || this.state === 'reconnecting') this._set('closed');
        else this._set('failed');
      }
    };
  }

  cancel() { this._cancelled = true; this.close(); }
  close() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._recoverTimer) { clearTimeout(this._recoverTimer); this._recoverTimer = null; }
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null; this.pc = null;
    if (this.state !== 'closed') this._set('closed');
  }
}
