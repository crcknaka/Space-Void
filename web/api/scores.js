// Global leaderboard API — stores top-200 as a single JSON blob in Vercel Blob.
// GET  /api/scores?mode=all|single|coop|daily&name=X -> {top: [...10], you: {rank,score}|null}
// POST /api/scores {name, score, mode, sig}          -> {ok, rank, top}  (top/rank within the mode)
import { put, list } from '@vercel/blob';

const PATH = 'leaderboard.json';
const MAX_KEEP = 200;
const PEPPER = 'void-pepper-7f3a';

function sig(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

const todayUTC = () => new Date().toISOString().slice(0, 10);

async function readBoard() {
  try {
    const { blobs } = await list({ prefix: PATH, limit: 1 });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function filterBoard(board, mode) {
  if (mode === 'single' || mode === 'coop') return board.filter((e) => e.mode === mode);
  if (mode === 'daily') {
    const d = todayUTC();
    return board.filter((e) => e.mode === 'daily' && e.day === d);
  }
  return board.filter((e) => e.mode !== 'daily'); // 'all': single + coop
}

const cleanName = (raw) =>
  String(raw || '').replace(/[^\w \-^.!?]/g, '').trim().slice(0, 14) || 'PLAYER';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const mode = String(req.query.mode || 'all');
    const name = cleanName(req.query.name || '');
    const board = filterBoard(await readBoard(), mode);
    let you = null;
    if (req.query.name) {
      const i = board.findIndex((e) => e.name === name);
      if (i >= 0) you = { rank: i + 1, score: board[i].score };
    }
    return res.status(200).json({ top: board.slice(0, 10), you });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const score = Math.floor(Number(body.score));
    const mode = ['single', 'coop', 'daily'].includes(body.mode) ? body.mode : null;
    const name = cleanName(body.name);

    if (!mode || !Number.isFinite(score) || score <= 0 || score > 1_000_000) {
      return res.status(400).json({ error: 'bad request' });
    }
    // signature over the raw client values — casual tamper deterrent
    if (body.sig !== sig(`${body.name}|${body.score}|${body.mode}|${PEPPER}`)) {
      return res.status(400).json({ error: 'bad signature' });
    }

    const board = await readBoard();
    const entry = { name, score, mode, ts: Date.now() };
    if (mode === 'daily') entry.day = todayUTC();
    board.push(entry);
    board.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const top = board.slice(0, MAX_KEEP);

    await put(PATH, JSON.stringify(top), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    const sameMode = filterBoard(top, mode === 'daily' ? 'daily' : mode);
    const rank = sameMode.indexOf(entry) + 1; // 0 => didn't make the kept range
    return res.status(200).json({ ok: true, rank, top: sameMode.slice(0, 10) });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
