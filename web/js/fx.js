// Pre-rendered glow sprites + vignette (cheap additive lighting)
import { W, H } from './const.js';

export function makeGlow(r, color) {
  const c = document.createElement('canvas');
  c.width = c.height = r * 2;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

export const glowBullet = makeGlow(14, 'rgba(255,210,100,0.55)');
export const glowEnemyBullet = makeGlow(14, 'rgba(255,90,90,0.55)');
export const glowPowerup = makeGlow(44, 'rgba(120,200,255,0.35)');
export const glowEngine = makeGlow(18, 'rgba(255,160,60,0.4)');
export const glowExplosion = makeGlow(60, 'rgba(255,190,90,0.7)');

export function drawGlow(g, glow, x, y, scale = 1) {
  const prev = g.globalCompositeOperation;
  g.globalCompositeOperation = 'lighter';
  const w = glow.width * scale;
  g.drawImage(glow, x - w / 2, y - w / 2, w, w);
  g.globalCompositeOperation = prev;
}

export function makeVignette() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.38)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  return c;
}
