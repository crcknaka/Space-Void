// Global leaderboard API — stores top-100 as a single JSON blob in Vercel Blob.
// GET  /api/scores          -> top 10
// POST /api/scores {name, score, mode} -> {ok, rank, top}
import { put, list } from '@vercel/blob';

const PATH = 'leaderboard.json';
const MAX_KEEP = 100;

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const board = await readBoard();
    return res.status(200).json(board.slice(0, 10));
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const score = Math.floor(Number(body.score));
    const name = String(body.name || '')
      .replace(/[^\w \-^.!?]/g, '')
      .trim()
      .slice(0, 14) || 'PLAYER';
    const mode = body.mode === 'coop' ? 'coop' : 'single';

    if (!Number.isFinite(score) || score <= 0 || score > 1_000_000) {
      return res.status(400).json({ error: 'bad score' });
    }

    const board = await readBoard();
    const entry = { name, score, mode, ts: Date.now() };
    board.push(entry);
    board.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const top = board.slice(0, MAX_KEEP);

    await put(PATH, JSON.stringify(top), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    const rank = top.indexOf(entry) + 1; // 0 => didn't make top-100
    return res.status(200).json({ ok: true, rank, top: top.slice(0, 10) });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
