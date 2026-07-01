// Screen dimensions (same as settings.py)
export const W = 600;
export const H = 880;
export const STEP = 1000 / 60; // fixed 60 FPS logic step, like pygame's Clock().tick(60)

export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// AABB overlap on center-based sprites; shrink approximates pygame mask collision fairness
export function overlap(a, b, shrink = 0.8) {
  const aw = (a.w * shrink) / 2, ah = (a.h * shrink) / 2;
  const bw = (b.w * shrink) / 2, bh = (b.h * shrink) / 2;
  return Math.abs(a.x - b.x) < aw + bw && Math.abs(a.y - b.y) < ah + bh;
}
