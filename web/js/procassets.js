// procassets.js — procedural replacements for the old PNG sprite set.
// generateSprites(images) overwrites the image dict with canvases baked from
// low-poly meshes (ships, boss, rocket, asteroid) and 2D-drawn effects
// (bolts, power-up pods, explosion sheet, thruster flames). Keys and sizes
// mirror the PNGs, so every drawImage call site keeps working untouched.
// Everything is seeded/fixed → host and guest bake identical sprites.
import { genShip } from './shipgen.js';
import { SHIPS, shipOverrides } from './ships.js';
import { bossStaticMesh, BOSS_VIEW } from './bossgen.js';
import {
  renderMesh, fitTransform, projectPoint, VIEW, makeRng,
  newMesh, addLathe, addPlateY, addPlateZ,
} from './mesh3d.js';

const SEEDS = { player1: 4, player2: 2, basic: 3, weaver: 2, hunter: 1, tank: 5, boss: 7, sniper: 6, carrier: 2, shieldbearer: 4, strafer: 8 };
const LEFT = { ...VIEW, ry: Math.PI }; // enemies fly (and are drawn) facing left

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function bakeInto(mesh, w, h, view = VIEW, margin = 0.92) {
  const c = cv(w, h);
  const fit = fitTransform(mesh, w, h, view, margin);
  renderMesh(c.getContext('2d'), mesh, { ...view, ...fit });
  c.mesh = mesh;           // kept for 3D debris on destruction
  c.fitScale = fit.scale;  // px per model unit at canvas size
  if (mesh.nozzles) {
    // engine points in sprite px — drawFlames() anchors plumes here
    c.nozzles = mesh.nozzles.map((n) => {
      const p = projectPoint(view, fit, [n.x, n.y, n.z]);
      return { x: p.x, y: p.y, r: n.r * p.s };
    });
  }
  return c;
}

// Roll/bank animation frames for the player ship: same auto-fit for every
// frame (stable anchor), only the roll angle changes. Player.draw picks a
// frame from its tilt — a real 3D bank instead of the old sprite rotation.
function bakeBankFrames(mesh, w, h, n = 7, maxBank = 0.42) {
  const fit = fitTransform(mesh, w, h, VIEW, 0.8);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const c = cv(w, h);
    renderMesh(c.getContext('2d'), mesh, { ...VIEW, ...fit, rx: VIEW.rx + maxBank * ((i / (n - 1)) * 2 - 1) });
    frames.push(c);
  }
  return frames;
}

/* --------------------------------- rocket --------------------------------- */

function rocketMesh(body = [205, 210, 220], accent = [235, 70, 70]) {
  const m = newMesh();
  const accD = accent.map((v) => (v * 0.82) | 0);
  addLathe(m, [
    { x: 20, r: 0.4 }, { x: 13, r: 2.4 }, { x: 6, r: 2.9 }, { x: -10, r: 2.9 }, { x: -17, r: 2.1 },
  ], 8, body, { capBack: true, capColor: [255, 180, 90], capE: 1 });
  // nose cone
  addLathe(m, [{ x: 20, r: 0.5 }, { x: 14, r: 2.3 }], 8, accent);
  // cross fins
  addPlateZ(m, [[-9, 2], [-16, 7.5], [-18, 6.5], [-17, 2]], 0, 1.1, accent);
  addPlateZ(m, [[-9, -2], [-16, -7.5], [-18, -6.5], [-17, -2]], 0, 1.1, accent);
  addPlateY(m, [[-9, 2], [-16, 7.5], [-18, 6.5], [-17, 2]], 0, 1.1, accD);
  addPlateY(m, [[-9, -2], [-16, -7.5], [-18, -6.5], [-17, -2]], 0, 1.1, accD);
  return m;
}

/* -------------------------------- asteroid -------------------------------- */

// Photo-style 2D bake — the look of the original asteroid.png (craggy
// outline, grainy surface, craters, cracks, top-left key light) rebuilt in
// canvas so the game stays fully procedural and each seed is a new rock.
function bakeRock(seed, volcanic = false, D = 192) {
  const R = makeRng(seed);
  const c = cv(D, D);
  const g = c.getContext('2d');
  const cx = D / 2, cy = D / 2, rad = D * 0.47;

  // jagged silhouette: integer harmonics (loop closes cleanly) + hard jitter
  const lumps = [];
  for (let i = 0; i < 4; i++) lumps.push({ f: 2 + ((R() * 4) | 0), ph: R() * Math.PI * 2, amp: 0.05 + R() * 0.06 });
  const n = 34, pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let r = 0.86;
    for (const l of lumps) r += Math.cos(a * l.f + l.ph) * l.amp;
    r += (R() - 0.5) * 0.17;
    r = Math.max(0.55, Math.min(1, r));
    pts.push([cx + Math.cos(a) * rad * r, cy + Math.sin(a) * rad * r]);
  }
  const path = () => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
  };

  g.save();
  path();
  g.clip();

  // base volume: dark rock falling off into near-black away from the light;
  // per-seed warmth so the variants aren't the exact same shade of gray
  const warm = 0.94 + R() * 0.13;
  const tone = (l) => `rgb(${Math.round(l * warm)},${Math.round(l * 0.93)},${Math.round((l * 0.82) / warm)})`;
  let gr = g.createRadialGradient(cx - D * 0.24, cy - D * 0.26, D * 0.06, cx, cy, D * 0.66);
  gr.addColorStop(0, tone(140));
  gr.addColorStop(0.5, tone(76));
  gr.addColorStop(1, tone(24));
  g.fillStyle = gr;
  g.fillRect(0, 0, D, D);

  // chiseled facets: hard-edged light/dark polygons, not soft blobs
  for (let i = 0; i < 20; i++) {
    const fx = cx + (R() - 0.5) * D * 0.8, fy = cy + (R() - 0.5) * D * 0.8;
    const fr = D * (0.07 + R() * 0.14), fn = 3 + ((R() * 3) | 0), a0 = R() * Math.PI * 2;
    g.beginPath();
    for (let v = 0; v < fn; v++) {
      const va = a0 + (v / fn) * Math.PI * 2;
      const vr = fr * (0.6 + R() * 0.6);
      const px = fx + Math.cos(va) * vr, py = fy + Math.sin(va) * vr;
      v ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath();
    // faces tilted toward the top-left light read bright, away read dark
    const lit = (fx - cx) + (fy - cy) < 0 ? R() < 0.6 : R() < 0.25;
    g.fillStyle = lit
      ? `rgba(205,195,178,${0.07 + R() * 0.13})`
      : `rgba(12,10,9,${0.1 + R() * 0.18})`;
    g.fill();
  }

  // coarse photo grain
  for (let i = 0; i < 4200; i++) {
    const x = R() * D, y = R() * D, s = R() < 0.8 ? 1 : 2;
    g.fillStyle = R() < 0.55
      ? `rgba(14,12,10,${0.07 + R() * 0.18})`
      : `rgba(225,215,198,${0.05 + R() * 0.13})`;
    g.fillRect(x, y, s, s);
  }
  // mineral glints on the lit side
  for (let i = 0; i < 60; i++) {
    const x = cx + (R() - 0.8) * D * 0.5, y = cy + (R() - 0.8) * D * 0.5;
    g.fillStyle = `rgba(255,248,232,${0.3 + R() * 0.45})`;
    g.fillRect(x, y, 1 + (R() < 0.25 ? 1 : 0), 1);
  }

  // pits & craters: irregular dark gouges, faint lit far wall
  const pits = 12 + ((R() * 6) | 0);
  for (let i = 0; i < pits; i++) {
    const a = R() * Math.PI * 2, d = Math.sqrt(R()) * rad * 0.72;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const big = R() < 0.28;
    const r = D * (big ? 0.045 + R() * 0.045 : 0.012 + R() * 0.028);
    const sq = 0.6 + R() * 0.4, rot = R() * Math.PI;
    g.save();
    g.translate(x, y); g.rotate(rot); g.scale(1, sq);
    const p = g.createRadialGradient(0, 0, 0, 0, 0, r);
    p.addColorStop(0, `rgba(8,7,6,${0.5 + R() * 0.3})`);
    p.addColorStop(0.7, `rgba(8,7,6,${0.25 + R() * 0.2})`);
    p.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = p;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    if (big) { // far wall catches the light
      g.lineWidth = Math.max(1, r * 0.16);
      g.strokeStyle = `rgba(215,205,185,${0.2 + R() * 0.2})`;
      g.beginPath(); g.arc(0, 0, r * 0.8, Math.PI * 0.1, Math.PI * 0.65); g.stroke();
    }
    g.restore();
  }

  // hairline cracks with branches
  const crack = (x, y, a, segs, w) => {
    g.lineWidth = w;
    g.strokeStyle = `rgba(10,8,7,${0.4 + R() * 0.25})`;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      a += (R() - 0.5) * 1.2;
      x += Math.cos(a) * D * (0.03 + R() * 0.05);
      y += Math.sin(a) * D * (0.03 + R() * 0.05);
      g.lineTo(x, y);
      if (w > 1 && R() < 0.3) crackBranch.push([x, y, a + (R() < 0.5 ? 1 : -1) * (0.6 + R())]);
    }
    g.stroke();
  };
  const crackBranch = [];
  for (let i = 0, cn = 3 + ((R() * 3) | 0); i < cn; i++) {
    crack(cx + (R() - 0.5) * D * 0.6, cy + (R() - 0.5) * D * 0.6, R() * Math.PI * 2, 4 + ((R() * 4) | 0), 1 + R());
  }
  for (const [bx, by, ba] of crackBranch.splice(0, 4)) crack(bx, by, ba, 2 + ((R() * 3) | 0), 1);

  // key light: strong sheen top-left, deep shade bottom-right
  gr = g.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
  gr.addColorStop(0, 'rgba(255,250,238,0.28)');
  gr.addColorStop(0.4, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,0.72)');
  g.fillStyle = gr;
  g.fillRect(0, 0, D, D);

  // shadow-side rim only (a full outline reads like a sticker)
  gr = g.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.1)');
  gr.addColorStop(1, 'rgba(0,0,0,0.8)');
  path();
  g.lineWidth = D * 0.05;
  g.strokeStyle = gr;
  g.stroke();
  g.restore();

  if (volcanic) {
    // magma rock: glowing fissures + embers over the finished surface
    g.save();
    path();
    g.clip();
    g.globalCompositeOperation = 'lighter';
    let heat = g.createRadialGradient(cx, cy, 0, cx, cy, D * 0.42);
    heat.addColorStop(0, 'rgba(255,80,20,0.13)');
    heat.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = heat;
    g.fillRect(0, 0, D, D);
    g.shadowColor = 'rgba(255,90,30,0.9)';
    g.shadowBlur = 7;
    for (let i = 0, fn = 4 + ((R() * 3) | 0); i < fn; i++) {
      g.lineWidth = 1.4 + R() * 1.3;
      g.strokeStyle = `rgba(255,${110 + ((R() * 60) | 0)},40,${0.5 + R() * 0.35})`;
      let x = cx + (R() - 0.5) * D * 0.55, y = cy + (R() - 0.5) * D * 0.55, a = R() * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0, segs = 3 + ((R() * 4) | 0); s < segs; s++) {
        a += (R() - 0.5) * 1.3;
        x += Math.cos(a) * D * (0.03 + R() * 0.05);
        y += Math.sin(a) * D * (0.03 + R() * 0.05);
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.shadowBlur = 0;
    for (let i = 0; i < 26; i++) {
      const x = cx + (R() - 0.5) * D * 0.7, y = cy + (R() - 0.5) * D * 0.7;
      g.fillStyle = `rgba(255,${120 + ((R() * 80) | 0)},50,${0.3 + R() * 0.5})`;
      g.fillRect(x, y, 1 + (R() < 0.3 ? 1 : 0), 1);
    }
    g.restore();
  }
  return c; // no mesh attached: rocks burst into dust, not 3D debris
}

/* ------------------------------ bullet bolts ------------------------------ */

function makeBolt(core, outer, w = 24, h = 12) {
  const c = cv(w, h);
  const g = c.getContext('2d');
  const cx = w / 2, cy = h / 2;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, cx - 1);
  grad.addColorStop(0, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.translate(cx, cy); g.scale(1, h / w * 0.9); g.translate(-cx, -cy);
  g.fillStyle = grad;
  g.fillRect(0, cy - w, w, w * 2);
  g.restore();
  const ell = (rx, ry, fill) => {
    g.fillStyle = fill;
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
  };
  ell(cx * 0.75, cy * 0.5, core);
  ell(cx * 0.45, cy * 0.3, '#fff');
  return c;
}

/* ------------------------------ power-up pods ------------------------------ */

// Glossy round badge like the original PNG power-ups: dark orb, bright white
// rim, colored neon glyph, specular highlight, soft colored halo.
function makePowerup(color, glyph) {
  const c = cv(120, 60);
  const g = c.getContext('2d');
  const cx = 60, cy = 30, r = 20; // r + halo must stay inside the 60px height
  const col = (a) => `rgba(${color[0]},${color[1]},${color[2]},${a})`;
  // halo (reaches r+9 = 29px — 1px inside the canvas edge, no clipping)
  let grad = g.createRadialGradient(cx, cy, r * 0.5, cx, cy, r + 9);
  grad.addColorStop(0, col(0.4));
  grad.addColorStop(1, col(0));
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r + 9, 0, Math.PI * 2); g.fill();
  // dark glossy ball
  grad = g.createRadialGradient(cx - 7, cy - 9, 2, cx, cy, r);
  grad.addColorStop(0, 'rgb(72,80,94)');
  grad.addColorStop(0.55, 'rgb(28,32,40)');
  grad.addColorStop(1, 'rgb(8,10,14)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  // bright rim + thin colored inner ring
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.beginPath(); g.arc(cx, cy, r - 1, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 1.5;
  g.strokeStyle = col(0.75);
  g.beginPath(); g.arc(cx, cy, r - 4.5, 0, Math.PI * 2); g.stroke();
  // colored neon glyph
  g.save();
  g.translate(cx, cy);
  g.scale(0.74, 0.74);
  g.strokeStyle = col(1);
  g.fillStyle = col(1);
  g.lineWidth = 3.6;
  g.lineJoin = g.lineCap = 'round';
  g.shadowColor = col(1);
  g.shadowBlur = 9;
  glyph(g);
  g.restore();
  // specular highlight
  g.save();
  g.translate(cx - 4, cy - 11);
  g.scale(1.5, 0.75);
  grad = g.createRadialGradient(0, 0, 0, 0, 0, 8);
  grad.addColorStop(0, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.fill();
  g.restore();
  return c;
}

const GLYPHS = {
  bolt(g) { // rapid fire
    g.beginPath();
    g.moveTo(4, -13); g.lineTo(-6, 2); g.lineTo(-1, 2); g.lineTo(-4, 13); g.lineTo(7, -3); g.lineTo(1, -3);
    g.closePath(); g.fill();
  },
  clock(g) { // slow motion
    g.beginPath(); g.arc(0, 0, 11, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(0, -6); g.lineTo(0, 0); g.lineTo(6, 3); g.stroke();
  },
  burst(g) { // kill all
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
      g.lineTo(Math.cos(a) * 13, Math.sin(a) * 13);
      g.stroke();
    }
    g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.fill();
  },
  missile(g) { // rockets
    g.beginPath();
    g.moveTo(12, 0); g.lineTo(4, -5); g.lineTo(-8, -5); g.lineTo(-12, -9);
    g.lineTo(-12, 9); g.lineTo(-8, 5); g.lineTo(4, 5);
    g.closePath(); g.fill();
  },
  fan(g) { // spread shot
    for (const dy of [-9, 0, 9]) {
      g.beginPath();
      g.moveTo(-10, dy * 0.35); g.lineTo(8, dy); g.stroke();
      g.beginPath();
      g.moveTo(8, dy); g.lineTo(3, dy - 3.5); g.moveTo(8, dy); g.lineTo(3, dy + 3.5); g.stroke();
    }
  },
  shield(g) {
    g.beginPath();
    g.moveTo(0, -13); g.quadraticCurveTo(10, -10, 11, -6);
    g.quadraticCurveTo(11, 6, 0, 13);
    g.quadraticCurveTo(-11, 6, -11, -6);
    g.quadraticCurveTo(-10, -10, 0, -13);
    g.closePath(); g.stroke();
  },
  beam(g) { // laser
    g.beginPath(); g.moveTo(-13, 0); g.lineTo(13, 0); g.stroke();
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(-9, -5); g.lineTo(9, -5); g.stroke();
    g.beginPath(); g.moveTo(-9, 5); g.lineTo(9, 5); g.stroke();
  },
};

/* ----------------------------- explosion sheet ----------------------------- */

function makeExplosionSheet() {
  const F = 96, N = 5;
  const c = cv(F * N, F);
  const g = c.getContext('2d');
  const R = makeRng(722025);
  for (let i = 0; i < N; i++) {
    const t = (i + 0.6) / N;
    const cx = i * F + F / 2, cy = F / 2;
    g.save();
    g.beginPath(); g.rect(i * F, 0, F, F); g.clip();
    // fireball core
    const r0 = 10 + 34 * t;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r0);
    grad.addColorStop(0, `rgba(255,255,235,${0.95 * (1 - t * 0.5)})`);
    grad.addColorStop(0.35, `rgba(255,200,90,${0.9 * (1 - t * 0.55)})`);
    grad.addColorStop(0.75, `rgba(255,110,40,${0.75 * (1 - t * 0.7)})`);
    grad.addColorStop(1, 'rgba(120,30,10,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, r0, 0, Math.PI * 2); g.fill();
    // chunky secondary blobs flying outward
    const blobs = 7;
    for (let b = 0; b < blobs; b++) {
      const a = (b / blobs) * Math.PI * 2 + R() * 0.8;
      const d = (8 + R() * 26) * t * 1.6;
      const br = (5 + R() * 8) * (1 - t * 0.55);
      const bg = g.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, cx + Math.cos(a) * d, cy + Math.sin(a) * d, br);
      bg.addColorStop(0, `rgba(255,${170 + (R() * 60) | 0},60,${0.8 * (1 - t * 0.6)})`);
      bg.addColorStop(1, 'rgba(120,30,10,0)');
      g.fillStyle = bg;
      g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, br, 0, Math.PI * 2); g.fill();
    }
    // expanding shock ring on later frames
    if (t > 0.35) {
      g.globalAlpha = Math.max(0, 1.15 - t * 1.3);
      g.lineWidth = 3.5 * (1 - t) + 1;
      g.strokeStyle = 'rgb(255,210,140)';
      g.beginPath(); g.arc(cx, cy, 8 + 40 * t, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }
    // hot sparks
    for (let s2 = 0; s2 < 10; s2++) {
      const a = R() * Math.PI * 2;
      const d = (10 + R() * 34) * t * 1.35;
      g.fillStyle = `rgba(255,240,180,${(1 - t) * 0.9})`;
      g.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2, 2);
    }
    g.restore();
  }
  return c;
}

/* ----------------------------- thruster flames ----------------------------- */
// 4 frames, 64x64, plume pointing left (call sites flip as needed).

// Anime-style jet plume: pointed teardrop with mach diamonds and a hot core.
// Nozzle anchor at canvas (48, 32) — drawFlames() aligns this to the engine.
function makeFlames(inner, outer) {
  const frames = [];
  const R = makeRng(0xF1A);
  const NX = 48, NY = 32;
  const col = (c2, a) => `rgba(${c2[0]},${c2[1]},${c2[2]},${a})`;
  for (let f = 0; f < 4; f++) {
    const c = cv(64, 64);
    const g = c.getContext('2d');
    const len = [27, 35, 30, 40][f] + R() * 3;
    const wid = 11.5 + (f % 2) * 2 + R() * 1.5;
    const sway = (R() - 0.5) * 2.5;
    g.globalCompositeOperation = 'lighter';
    // ambient glow around the nozzle
    let grad = g.createRadialGradient(NX - len * 0.35, NY, 0, NX - len * 0.35, NY, len * 0.8);
    grad.addColorStop(0, col(outer, 0.4));
    grad.addColorStop(1, col(outer, 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(NX - len * 0.35, NY, len * 0.8, 0, Math.PI * 2); g.fill();
    // pointed plume body
    g.beginPath();
    g.moveTo(NX, NY - wid / 2);
    g.quadraticCurveTo(NX - len * 0.45, NY - wid * 0.66, NX - len, NY + sway);
    g.quadraticCurveTo(NX - len * 0.45, NY + wid * 0.66, NX, NY + wid / 2);
    g.closePath();
    grad = g.createLinearGradient(NX, 0, NX - len, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.22, col(inner, 0.95));
    grad.addColorStop(0.6, col(outer, 0.8));
    grad.addColorStop(1, col(outer, 0));
    g.fillStyle = grad;
    g.fill();
    // mach diamonds — shift a little every frame
    for (const [dxf, ds] of [[0.24, 0.55], [0.46, 0.4]]) {
      const mx = NX - len * (dxf + f * 0.02);
      const s = wid * ds;
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.moveTo(mx + s, NY);
      g.lineTo(mx, NY - s * 0.55);
      g.lineTo(mx - s, NY);
      g.lineTo(mx, NY + s * 0.55);
      g.closePath();
      g.fill();
    }
    // hot core right at the nozzle
    grad = g.createRadialGradient(NX - 2, NY, 0, NX - 2, NY, 6);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, col(inner, 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(NX - 2, NY, 6, 0, Math.PI * 2); g.fill();
    frames.push(c);
  }
  return frames;
}

/* --------------------------------- main ----------------------------------- */

export function generateSprites(images) {
  // player ships (+ 3D bank frames used by Player.draw via img.bankFrames)
  const p1 = genShip(SEEDS.player1, 'player');
  images.player1_ship = bakeInto(p1, 100, 60);
  images.player1_ship.bankFrames = bakeBankFrames(p1, 100, 60);
  const p2 = genShip(SEEDS.player2, 'player', { hue: [300, 322], accHue: [298, 315] });
  images.player2_ship = bakeInto(p2, 100, 60);
  images.player2_ship.bankFrames = bakeBankFrames(p2, 100, 60);

  // selectable player ships (Phase 5) — one baked hull per roster entry
  images.ships = {};
  for (const s of SHIPS) {
    const mesh = genShip(s.seed, 'player', shipOverrides(s));
    const spr = bakeInto(mesh, 100, 60);
    spr.bankFrames = bakeBankFrames(mesh, 100, 60);
    images.ships[s.id] = spr;
  }

  // enemy families — one distinct generated ship per type, facing left
  images.enemy_basic = bakeInto(genShip(SEEDS.basic, 'basic'), 100, 60, LEFT);
  images.enemy_weaver = bakeInto(genShip(SEEDS.weaver, 'weaver'), 100, 60, LEFT);
  images.enemy_hunter = bakeInto(genShip(SEEDS.hunter, 'hunter'), 100, 60, LEFT);
  images.enemy_tank = bakeInto(genShip(SEEDS.tank, 'tank'), 132, 80, LEFT);
  images.enemy_sniper = bakeInto(genShip(SEEDS.sniper, 'sniper'), 108, 48, LEFT);
  images.enemy_carrier = bakeInto(genShip(SEEDS.carrier, 'carrier'), 144, 88, LEFT);
  images.enemy_shieldbearer = bakeInto(genShip(SEEDS.shieldbearer, 'shieldbearer'), 104, 64, LEFT);
  images.enemy_strafer = bakeInto(genShip(SEEDS.strafer, 'strafer'), 124, 68, LEFT);
  images.enemy_ship = images.enemy_basic; // wreck tints & fallbacks
  // static level-1 boss (coop guests see this; the host renders bosses live)
  images.boss = bakeInto(bossStaticMesh(1), 300, 300, BOSS_VIEW, 0.94);

  // several rock variants; varIdx travels with the sprite for co-op sync
  images.asteroids = [11, 29, 47, 68].map((s, i) => {
    const r = bakeRock(s);
    r.varIdx = i;
    return r;
  });
  // volcanic rocks (rare spawns): glowing fissures, blast wave when cracked
  [83, 97].forEach((s, k) => {
    const r = bakeRock(s, true);
    r.varIdx = 4 + k;
    r.volcanic = true;
    images.asteroids.push(r);
  });
  images.asteroid = images.asteroids[0];
  images.rocket = bakeInto(rocketMesh(), 48, 24, VIEW, 0.95);
  images.enemy_rocket = bakeInto(rocketMesh([125, 62, 68], [255, 75, 60]), 48, 24, VIEW, 0.95);
  images.bullet = makeBolt('rgb(255,225,120)', 'rgba(255,190,70,0.9)');
  // combo-tier bolts: hotter and bigger as the multiplier climbs
  images.bullet2 = makeBolt('rgb(255,190,80)', 'rgba(255,140,40,0.95)', 28, 14);
  images.bullet3 = makeBolt('rgb(190,240,255)', 'rgba(90,190,255,0.95)', 34, 16);
  images.enemy_bullet = makeBolt('rgb(255,120,110)', 'rgba(255,70,60,0.9)');

  // colors follow the original badges: shooting green, slow-mo orange
  images.powerup = makePowerup([110, 255, 120], GLYPHS.bolt);
  images.slow_motion_powerup = makePowerup([255, 180, 60], GLYPHS.clock);
  images.kill_all_powerup = makePowerup([255, 80, 200], GLYPHS.burst);
  images.rocket_powerup = makePowerup([255, 95, 80], GLYPHS.missile);
  images.spread_powerup = makePowerup([255, 220, 80], GLYPHS.fan);
  images.shield_powerup = makePowerup([0, 210, 255], GLYPHS.shield);
  images.laser_powerup = makePowerup([90, 160, 255], GLYPHS.beam);

  images.explosion_spritesheet = makeExplosionSheet();

  images.thrusters = {
    player1: makeFlames([150, 220, 255], [50, 120, 255]),
    player2: makeFlames([255, 170, 240], [255, 60, 200]),
    enemy: makeFlames([255, 210, 140], [255, 110, 30]),
  };
  return images;
}
