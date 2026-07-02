// World dimensions. Base 600x880 (settings.py); the world adapts to the screen
// aspect so fullscreen/widescreen/phones get a fully used display (no letterbox).
// ES module bindings are live — importers always see current values.
export let W = 600;
export let H = 880;
export const BASE_W = 600, BASE_H = 880;
export const MAX_W = 1760, MAX_H = 1560; // capped by background art size

export function setSize(w, h) { W = w; H = h; }

export const STEP = 1000 / 60; // reference 60 FPS logic step, like pygame's Clock().tick(60)

// Game-logic RNG — seedable for the daily challenge (mulberry32).
// Draw-only randomness must keep using Math.random so render rate can't
// desync the seeded stream.
let rngFn = Math.random;
export function setRngSeed(seed) {
  if (seed == null) { rngFn = Math.random; return; }
  let s = (seed >>> 0) || 1;
  rngFn = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rand = (a, b) => a + rngFn() * (b - a);
export const randInt = (a, b) => Math.floor(a + rngFn() * (b - a + 1));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// AABB overlap on center-based sprites; shrink approximates pygame mask collision fairness
export function overlap(a, b, shrink = 0.8) {
  const aw = (a.w * shrink) / 2, ah = (a.h * shrink) / 2;
  const bw = (b.w * shrink) / 2, bh = (b.h * shrink) / 2;
  return Math.abs(a.x - b.x) < aw + bw && Math.abs(a.y - b.y) < ah + bh;
}
