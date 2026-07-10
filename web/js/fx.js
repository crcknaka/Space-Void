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
export const glowElite = makeGlow(34, 'rgba(255,205,90,0.5)');

export function drawGlow(g, glow, x, y, scale = 1) {
  const prev = g.globalCompositeOperation;
  g.globalCompositeOperation = 'lighter';
  const w = glow.width * scale;
  g.drawImage(glow, x - w / 2, y - w / 2, w, w);
  g.globalCompositeOperation = prev;
}

/* ------------------------------ sprite tinting ------------------------------ */

const tintCache = new Map();

// Returns a tinted copy of an image (cached). Used for enemy variants & hit flashes.
export function tinted(img, color, key) {
  const k = key || `${img.src}|${color}`;
  let c = tintCache.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width || 1;
  c.height = img.height || 1;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  if (img.nozzles) c.nozzles = img.nozzles; // tinted ships keep their engine points
  tintCache.set(k, c);
  return c;
}

/* ------------------------------ shield bubble ------------------------------ */
// Hexagonal energy shield with an optional impact ripple. Shared by the
// player bubble, the boss shield phase, and the coop-guest rendering.

const hexPatterns = new Map();
function hexPattern(g, color) {
  let p = hexPatterns.get(color);
  if (p) return p;
  const s = 9; // hex edge
  const w = Math.round(s * 3), h = Math.round(s * Math.sqrt(3));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const q = c.getContext('2d');
  q.strokeStyle = color;
  q.lineWidth = 1;
  const hex = (cx, cy) => {
    q.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      q[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * s, cy + Math.sin(a) * s);
    }
    q.closePath();
    q.stroke();
  };
  hex(0, 0); hex(w / 2, h / 2); hex(w, 0); hex(0, h); hex(w, h);
  p = g.createPattern(c, 'repeat');
  hexPatterns.set(color, p);
  return p;
}

// ripple: { a: impact angle, p: progress 0..1 } or null
export function drawShieldBubble(g, x, y, r, t, color = 'rgb(80,220,255)', ripple = null) {
  const prev = g.globalCompositeOperation;
  g.globalCompositeOperation = 'lighter';
  // soft energy fill
  g.globalAlpha = 0.1 + 0.03 * Math.sin(t / 140);
  g.fillStyle = color;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  // hex lattice, brighter toward the rim
  g.save();
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
  g.globalAlpha = 0.20 + 0.06 * Math.sin(t / 230);
  g.fillStyle = hexPattern(g, color);
  g.fillRect(x - r, y - r, r * 2, r * 2);
  // impact ripple: bright rings spreading over the surface from the hit point
  if (ripple && ripple.p < 1) {
    const hx = x + Math.cos(ripple.a) * r * 0.92;
    const hy = y + Math.sin(ripple.a) * r * 0.92;
    for (const f of [1, 0.55]) {
      g.globalAlpha = (1 - ripple.p) * 0.85 * f;
      g.lineWidth = 3.2 * (1 - ripple.p) + 0.8;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(hx, hy, r * 1.15 * ripple.p * f + 2, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.restore();
  // rim
  g.globalAlpha = 0.55 + (ripple && ripple.p < 1 ? 0.3 * (1 - ripple.p) : 0);
  g.lineWidth = 2.5;
  g.strokeStyle = color;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.globalAlpha = 1;
  g.globalCompositeOperation = prev;
}

/* ------------------------------ procedural nebulae ------------------------------ */

export function makeNebula(size = 512, baseHue = null) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const hueBase = baseHue ?? 170 + Math.random() * 190; // teal..blue..purple..pink
  const clusters = 2 + Math.floor(Math.random() * 3);
  for (let cl = 0; cl < clusters; cl++) {
    const ccx = size * (0.25 + Math.random() * 0.5);
    const ccy = size * (0.25 + Math.random() * 0.5);
    for (let i = 0; i < 22; i++) {
      const cx = ccx + (Math.random() - 0.5) * size * 0.45;
      const cy = ccy + (Math.random() - 0.5) * size * 0.45;
      const r = size * (0.04 + Math.random() * 0.22);
      const hue = hueBase + (Math.random() - 0.5) * 70;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `hsla(${hue},75%,55%,${0.04 + Math.random() * 0.07})`);
      grad.addColorStop(1, 'hsla(0,0%,0%,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  // radial mask: fade to transparent toward the canvas edge so scaled-up
  // nebulae never show hard square borders
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.75, 'rgba(0,0,0,0.75)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';
  return c;
}

export function makeNebulaField(count = 3, baseHue = null) {
  return Array.from({ length: count }, () => ({
    img: makeNebula(512, baseHue == null ? null : baseHue + (Math.random() - 0.5) * 50),
    s: 320 + Math.random() * 520,
    x: Math.random() * (W + 800) - 200,
    y: Math.random() * H,
    v: 0.03 + Math.random() * 0.09,   // slow parallax drift
    a: 0.4 + Math.random() * 0.35,
  }));
}

export function updateNebulae(field, k, mul = 1) {
  for (const nb of field) {
    nb.x -= nb.v * mul * k;
    if (nb.x + nb.s < 0) {
      nb.x = W + Math.random() * 400;
      nb.y = Math.random() * H;
    }
  }
}

export function drawNebulae(g, field) {
  const prev = g.globalCompositeOperation;
  const q = g.imageSmoothingQuality;
  g.globalCompositeOperation = 'screen';
  g.imageSmoothingQuality = 'low'; // soft clouds — high-quality resampling is wasted here
  for (const nb of field) {
    g.globalAlpha = nb.a;
    g.drawImage(nb.img, nb.x, nb.y - nb.s / 2, nb.s, nb.s);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = prev;
  g.imageSmoothingQuality = q;
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
