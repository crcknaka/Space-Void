// WebRTC signaling rendezvous over Vercel Blob (non-trickle ICE).
// Slotted so one room can host several peers (4-player co-op):
//   VS 1:1        -> slot 'main' (host offers, guest answers)
//   Co-op N:1     -> one slot per guest (guest offers, host answers)
//
// POST /api/rtc  { room, slot, role:'offer'|'answer', sdp }
// GET  /api/rtc?room=X&slot=Y&role=Z   -> { sdp }
// GET  /api/rtc?room=X&list=1          -> { slots:[...] }  (slots that posted an offer)
// DELETE /api/rtc?room=X               -> remove the whole room
import { put, list, del } from '@vercel/blob';

const ROOM_RE = /^[A-Z0-9]{4,6}$/;
const SLOT_RE = /^[A-Za-z0-9]{1,16}$/;
const key = (room, slot, role) => `rtc/${room}__${slot}__${role}.json`;

async function readBlob(pathname) {
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const room = String(req.query.room || '').toUpperCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });

    if (req.query.list) {
      // slots that have posted an offer
      try {
        const { blobs } = await list({ prefix: `rtc/${room}__`, limit: 100 });
        const slots = blobs
          .map((b) => b.pathname.match(new RegExp(`^rtc/${room}__([A-Za-z0-9]+)__offer\\.json$`)))
          .filter(Boolean).map((m) => m[1]);
        return res.status(200).json({ slots });
      } catch { return res.status(200).json({ slots: [] }); }
    }

    const slot = String(req.query.slot || 'main');
    const role = req.query.role === 'answer' ? 'answer' : 'offer';
    if (!SLOT_RE.test(slot)) return res.status(400).json({ error: 'bad slot' });
    const data = await readBlob(key(room, slot, role));
    return res.status(200).json({ sdp: data?.sdp || null });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const room = String(body.room || '').toUpperCase();
    const slot = String(body.slot || 'main');
    const role = body.role === 'answer' ? 'answer' : 'offer';
    const sdp = body.sdp;
    if (!ROOM_RE.test(room) || !SLOT_RE.test(slot)) return res.status(400).json({ error: 'bad room/slot' });
    if (!sdp || typeof sdp !== 'object' || String(sdp.sdp || '').length > 20000) {
      return res.status(400).json({ error: 'bad sdp' });
    }
    await put(key(room, slot, role), JSON.stringify({ sdp, ts: Date.now() }), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const room = String(req.query.room || '').toUpperCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'bad room' });
    try {
      const { blobs } = await list({ prefix: `rtc/${room}__`, limit: 100 });
      await Promise.all(blobs.map((b) => del(b.url)));
    } catch {}
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
