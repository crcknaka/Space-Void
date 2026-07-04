// Returns the ICE server list for WebRTC. Kept server-side so TURN credentials
// stay secret and can be swapped without a client redeploy.
//
// Priority:
//   1. METERED_API_KEY (+ METERED_SUBDOMAIN)  -> Metered dynamic credentials (reliable, free 50GB tier)
//   2. TURN_URL / TURN_USER / TURN_PASS        -> a static TURN server (e.g. self-hosted coturn)
//   3. fallback: Google STUN + free Open Relay TURN (best-effort public relay)
const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const OPENRELAY = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const { METERED_API_KEY, METERED_SUBDOMAIN, TURN_URL, TURN_USER, TURN_PASS } = process.env;

  if (METERED_API_KEY && METERED_SUBDOMAIN) {
    try {
      const r = await fetch(`https://${METERED_SUBDOMAIN}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`);
      if (r.ok) {
        const turn = await r.json();
        return res.status(200).json({ iceServers: [...STUN, ...turn] });
      }
    } catch { /* fall through */ }
  }

  if (TURN_URL && TURN_USER && TURN_PASS) {
    const urls = TURN_URL.split(',').map((u) => u.trim());
    return res.status(200).json({ iceServers: [...STUN, { urls, username: TURN_USER, credential: TURN_PASS }] });
  }

  return res.status(200).json({ iceServers: [...STUN, ...OPENRELAY] });
}
