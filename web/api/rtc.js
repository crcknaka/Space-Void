// WebRTC signaling rendezvous over Vercel Blob.
// Non-trickle ICE: each side posts ONE complete SDP (offer or answer), so a
// room is just two small blobs — no candidate races, no long-lived connection.
//
// POST /api/rtc  { room, role: 'offer'|'answer', sdp }  -> { ok }
// GET  /api/rtc?room=XXXX&role=offer|answer            -> { sdp } | { sdp: null }
import { put, list, del } from '@vercel/blob';

const ROOM_RE = /^[A-Z0-9]{4,6}$/;
const key = (room, role) => `rtc/${room}-${role}.json`;

async function readBlob(pathname) {
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const room = String(req.query.room || '').toUpperCase();
    const role = req.query.role === 'answer' ? 'answer' : 'offer';
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });
    const data = await readBlob(key(room, role));
    return res.status(200).json({ sdp: data?.sdp || null });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const room = String(body.room || '').toUpperCase();
    const role = body.role === 'answer' ? 'answer' : 'offer';
    const sdp = body.sdp;
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });
    if (!sdp || typeof sdp !== 'object' || String(sdp.sdp || '').length > 20000) {
      return res.status(400).json({ error: 'bad sdp' });
    }
    await put(key(room, role), JSON.stringify({ sdp, ts: Date.now() }), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    // best-effort room cleanup once connected
    const room = String(req.query.room || '').toUpperCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });
    try {
      const { blobs } = await list({ prefix: `rtc/${room}-`, limit: 10 });
      await Promise.all(blobs.map((b) => del(b.url)));
    } catch {}
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
