// bggen.js — procedural space backdrops: deep-space gradient, star dust,
// a detailed hero planet (turbulent gas bands or cratered rock, rings, moons,
// polar caps, limb darkening) plus a couple of small distant worlds.
// Seeded per level → a new scene every level, identical on every client.
//
// The tile is WIDER than the widest viewport (MAX_W = 1760), so the same
// planet can never be on screen twice, and everything either wraps across
// the seam (stars, smudges) or keeps a safe margin from it (planets, rings).
import { makeRng } from './mesh3d.js';

export function makeSpaceBackdrop(seed, w = 2400, h = 1100) {
  const R = makeRng((seed * 40503 + 9601) >>> 0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  const hue = (R() * 360) | 0;
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#03040a');
  bg.addColorStop(0.55, `hsl(${hue}, 42%, ${5 + R() * 4}%)`);
  bg.addColorStop(1, '#04050c');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // faint galactic smudges — drawn wrapped so the seam stays invisible
  for (let i = 0; i < 5; i++) {
    const gx = R() * w, gy = R() * h, gr = 120 + R() * 260;
    for (const ox of [0, -w, w]) {
      const sm = g.createRadialGradient(gx + ox, gy, 0, gx + ox, gy, gr);
      sm.addColorStop(0, `hsla(${(hue + R() * 80) % 360}, 60%, 55%, ${0.03 + R() * 0.04})`);
      sm.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sm;
      g.beginPath(); g.arc(gx + ox, gy, gr, 0, Math.PI * 2); g.fill();
    }
  }

  // star dust, wrapped across the seam
  for (let i = 0; i < 700; i++) {
    const x = R() * w, y = R() * h;
    const s = R() < 0.85 ? 1 : 2;
    g.fillStyle = `rgba(255,255,255,${0.15 + R() * 0.5})`;
    g.fillRect(x, y, s, s);
    if (x < 4) g.fillRect(x + w, y, s, s);
    if (x > w - 4) g.fillRect(x - w, y, s, s);
  }

  // small distant worlds only — the hero planet lives on its own parallax
  // layer now (world.js) so fresh planets keep arriving instead of the tile
  // repeating the same one
  const nFar = 2 + ((R() * 2) | 0);
  for (let i = 0; i < nFar; i++) {
    const fr = h * (0.03 + R() * 0.05);
    const fx = fr * 2.5 + R() * (w - fr * 5);
    drawPlanet(g, fx, h * (0.1 + R() * 0.75), fr, (hue + 90 + R() * 140) % 360, R, true);
  }
  return c;
}

// A single hero planet (+moons) on a transparent canvas — the scrolling
// planet layer draws these 1:1 and asks for a new seed for every arrival.
export function makePlanetSprite(seed) {
  const R = makeRng((seed * 92821 + 4409) >>> 0);
  const r = 130 + R() * 250;
  const w = Math.ceil(r * 4.9), h = Math.ceil(r * 2.7);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.planetR = r; // comet-impact targeting
  const g = c.getContext('2d');
  drawPlanet(g, w / 2, h / 2, r, (R() * 360) | 0, R, false);
  if (R() < 0.4) {
    // station is NOT baked in — the world draws it live so it can slowly
    // orbit, spin and blink (see drawLiveStation)
    c.station = {
      d: r * (1.3 + R() * 0.45),
      a0: R() * Math.PI * 2,
      s: r * (0.11 + R() * 0.05),
      spin: (R() < 0.5 ? 1 : -1) * (0.5 + R() * 0.5),
    };
  }
  const nm = R() < 0.6 ? 1 + ((R() * 2) | 0) : 0;
  for (let i = 0; i < nm; i++) {
    const mr = r * (0.06 + R() * 0.08);
    const ang = R() * Math.PI * 2;
    const d = r * (1.5 + R() * 0.7);
    const mx = Math.max(mr + 3, Math.min(w - mr - 3, w / 2 + Math.cos(ang) * d));
    const my = Math.max(mr + 3, Math.min(h - mr - 3, h / 2 + Math.sin(ang) * d * 0.6));
    drawMoon(g, mx, my, mr, R);
  }
  return c;
}

/* --------------------------------- planet ---------------------------------- */
// far = small distant world: same structure, cheaper detail counts.

function drawPlanet(g, x, y, r, baseHue, R, far) {
  const gasGiant = R() < 0.55;
  const pHue = (baseHue + 140 + R() * 120) % 360;
  const sat = 32 + R() * 30;
  // distance haze: every planet gets its own brightness; far ones are dimmer —
  // they should read as scenery, not sit at the same visual depth as the game
  const dim = far ? 0.4 + R() * 0.22 : 0.5 + R() * 0.34;
  const hasRing = !far && R() < 0.45;
  const ringTilt = 0.26 + R() * 0.2;
  const ringR = r * (1.45 + R() * 0.3);
  if (hasRing) drawRing(g, x, y, ringR, ringTilt, pHue, R, true, dim);

  g.save();
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();

  // base sphere, lit from the upper-left
  const base = g.createRadialGradient(x - r * 0.45, y - r * 0.45, r * 0.1, x, y, r * 1.05);
  base.addColorStop(0, `hsl(${pHue}, ${sat}%, ${60 + R() * 10}%)`);
  base.addColorStop(0.55, `hsl(${pHue}, ${sat}%, ${36 + R() * 8}%)`);
  base.addColorStop(1, `hsl(${(pHue + 20) % 360}, ${sat}%, 14%)`);
  g.fillStyle = base;
  g.fillRect(x - r, y - r, r * 2, r * 2);

  if (gasGiant) {
    // turbulent latitude bands: each is a stack of offset ellipses, so edges
    // wobble instead of reading as flat stripes
    const bands = far ? 5 : 8 + ((R() * 6) | 0);
    for (let i = 0; i < bands; i++) {
      const by = y - r + (i + 0.5) * ((r * 2) / bands);
      const bh = ((r * 2) / bands) * (0.5 + R() * 0.45);
      const light = R() < 0.5;
      const col = `hsl(${(pHue + (R() - 0.5) * 46 + 360) % 360}, ${sat + (light ? -6 : 8)}%, ${light ? 58 + R() * 14 : 22 + R() * 10}%)`;
      const wob = far ? 1 : 3;
      for (let k2 = 0; k2 < wob; k2++) {
        g.globalAlpha = (0.10 + R() * 0.1) / wob * (light ? 1.6 : 1.9);
        g.fillStyle = col;
        g.beginPath();
        g.ellipse(x + (R() - 0.5) * r * 0.24, by + (R() - 0.5) * bh * 0.5,
          r * (0.95 + R() * 0.16), bh * (0.4 + R() * 0.28), (R() - 0.5) * 0.05, 0, Math.PI * 2);
        g.fill();
      }
    }
    // wind-shear streaks: thin elongated wisps along the bands
    const streaks = far ? 8 : 40;
    for (let i = 0; i < streaks; i++) {
      const sy2 = y + (R() - 0.5) * 1.9 * r;
      g.globalAlpha = 0.04 + R() * 0.05;
      g.fillStyle = R() < 0.5 ? '#000' : '#fff';
      g.beginPath();
      g.ellipse(x + (R() - 0.5) * 1.6 * r, sy2, r * (0.1 + R() * 0.3), r * (0.006 + R() * 0.012), 0, 0, Math.PI * 2);
      g.fill();
    }

    // storm ovals with a darker rim — the "great spot" look
    const storms = far ? 1 : 2 + ((R() * 3) | 0);
    for (let i = 0; i < storms; i++) {
      const sx = x + (R() - 0.5) * 1.4 * r, sy = y + (R() - 0.5) * 1.2 * r;
      const sw2 = r * (0.09 + R() * 0.12), sh2 = sw2 * (0.45 + R() * 0.25);
      g.globalAlpha = 0.4;
      g.strokeStyle = `hsl(${(pHue + 25) % 360}, ${sat}%, 20%)`;
      g.lineWidth = Math.max(1.5, sw2 * 0.16);
      g.beginPath(); g.ellipse(sx, sy, sw2, sh2, (R() - 0.5) * 0.3, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.5;
      g.fillStyle = `hsl(${(pHue + 30 + R() * 30) % 360}, ${sat + 18}%, ${55 + R() * 18}%)`;
      g.beginPath(); g.ellipse(sx, sy, sw2 * 0.78, sh2 * 0.72, 0, 0, Math.PI * 2); g.fill();
    }
  } else {
    // rocky world: continents as tight blob clusters (one color per landmass —
    // scattered translucent circles read as bubbles, clusters read as land)
    const masses = far ? 2 : 4 + ((R() * 3) | 0);
    for (let m = 0; m < masses; m++) {
      const mx2 = x + (R() - 0.5) * 1.7 * r, my2 = y + (R() - 0.5) * 1.7 * r;
      const landHue = (pHue + (R() - 0.5) * 50 + 360) % 360;
      const dark = R() < 0.45;
      g.fillStyle = `hsl(${landHue}, ${sat * 0.95}%, ${dark ? 20 + R() * 8 : 58 + R() * 12}%)`;
      const mr2 = r * (0.16 + R() * 0.2);
      const blobs = far ? 6 : 14;
      let bx = mx2, by = my2;
      for (let i = 0; i < blobs; i++) { // random-walk blob chain = ragged landmass
        g.globalAlpha = 0.16 + R() * 0.1;
        g.beginPath();
        g.arc(bx, by, mr2 * (0.28 + R() * 0.3), 0, Math.PI * 2);
        g.fill();
        const a = R() * Math.PI * 2;
        bx += Math.cos(a) * mr2 * 0.4;
        by += Math.sin(a) * mr2 * 0.32;
      }
    }
    const craters = far ? 3 : 9;
    for (let i = 0; i < craters; i++) {
      const cx2 = x + (R() - 0.5) * 1.6 * r, cy2 = y + (R() - 0.5) * 1.6 * r;
      const cr2 = r * (0.025 + R() * 0.05);
      g.globalAlpha = 0.4;
      g.fillStyle = 'rgba(0,0,0,0.45)'; // bowl shadow
      g.beginPath(); g.arc(cx2, cy2, cr2, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.35)'; // sunlit rim (lower-right arc)
      g.lineWidth = Math.max(1, cr2 * 0.25);
      g.beginPath(); g.arc(cx2, cy2, cr2, Math.PI * 0.15, Math.PI * 0.85); g.stroke();
    }
    if (R() < 0.45) { // polar ice caps — feathered, subtle
      for (const s of [-1, 1]) {
        const cw = r * (0.42 + R() * 0.15), ch = r * (0.1 + R() * 0.05);
        const cy2 = y + s * r * 0.97;
        const cap = g.createRadialGradient(x, cy2, 0, x, cy2, cw);
        cap.addColorStop(0, 'rgba(235,245,255,0.55)');
        cap.addColorStop(0.7, 'rgba(235,245,255,0.25)');
        cap.addColorStop(1, 'rgba(235,245,255,0)');
        g.globalAlpha = 1;
        g.save();
        g.translate(x, cy2); g.scale(1, ch / cw); g.translate(-x, -cy2);
        g.fillStyle = cap;
        g.beginPath(); g.arc(x, cy2, cw, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
  }

  if (!gasGiant) {
    // wispy cloud layer over the continents
    const clouds = far ? 3 : 9;
    for (let i = 0; i < clouds; i++) {
      g.globalAlpha = 0.06 + R() * 0.08;
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(x + (R() - 0.5) * 1.7 * r, y + (R() - 0.5) * 1.7 * r,
        r * (0.14 + R() * 0.22), r * (0.02 + R() * 0.035), (R() - 0.5) * 0.5, 0, Math.PI * 2);
      g.fill();
    }
    // city lights sparkling on the night side (lower-right of the terminator)
    if (!far && R() < 0.4) {
      g.globalAlpha = 1;
      for (let i = 0; i < 70; i++) {
        const a = R() * Math.PI * 0.5 - Math.PI * 0.05; // lower-right quadrant
        const d = r * (0.35 + Math.sqrt(R()) * 0.6);
        g.fillStyle = `rgba(255,190,110,${0.25 + R() * 0.45})`;
        const s2 = R() < 0.85 ? 1 : 2;
        g.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, s2, s2);
      }
    }
  }

  // fine surface grain
  const grains = far ? 60 : 560;
  for (let i = 0; i < grains; i++) {
    const a = R() * Math.PI * 2, d = Math.sqrt(R()) * r;
    g.globalAlpha = 0.025 + R() * 0.05;
    g.fillStyle = R() < 0.5 ? '#000' : '#fff';
    g.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.5, 1.5);
  }
  g.globalAlpha = 1;

  // limb darkening — the sphere reads round instead of flat
  const limb = g.createRadialGradient(x, y, r * 0.62, x, y, r);
  limb.addColorStop(0, 'rgba(0,0,0,0)');
  limb.addColorStop(0.82, 'rgba(0,0,0,0.12)');
  limb.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = limb;
  g.fillRect(x - r, y - r, r * 2, r * 2);

  // night side: radial shadow centered on the light direction
  const night = g.createRadialGradient(x - r * 0.6, y - r * 0.6, r * 0.35, x - r * 0.6, y - r * 0.6, r * 2.15);
  night.addColorStop(0, 'rgba(0,0,0,0)');
  night.addColorStop(0.62, 'rgba(0,0,0,0)');
  night.addColorStop(0.85, 'rgba(2,3,8,0.55)');
  night.addColorStop(1, 'rgba(2,3,8,0.92)');
  g.fillStyle = night;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  // distance haze: pull the whole disc toward the sky color
  g.globalAlpha = 1;
  g.fillStyle = `rgba(6,8,16,${(1 - dim) * 0.75})`;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.restore();

  // atmosphere: soft halo + crisp catch-light arc on the sunlit limb
  const prev = g.globalCompositeOperation;
  g.globalCompositeOperation = 'lighter';
  const atm = g.createRadialGradient(x, y, r * 0.92, x, y, r * 1.1);
  atm.addColorStop(0, 'rgba(0,0,0,0)');
  atm.addColorStop(0.75, `hsla(${pHue}, 80%, 65%, ${(far ? 0.1 : 0.14) * dim})`);
  atm.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = atm;
  g.beginPath(); g.arc(x, y, r * 1.1, 0, Math.PI * 2); g.fill();
  g.globalAlpha = (far ? 0.35 : 0.55) * dim;
  g.strokeStyle = `hsla(${pHue}, 90%, 78%, 0.8)`;
  g.lineWidth = Math.max(1.2, r * 0.012);
  g.beginPath(); g.arc(x, y, r * 1.005, Math.PI * 0.8, Math.PI * 1.62); g.stroke();
  g.globalAlpha = 1;
  g.globalCompositeOperation = prev;

  if (hasRing) drawRing(g, x, y, ringR, ringTilt, pHue, R, false, dim);
}

// farHalf: the part passing behind the planet's upper limb (drawn first).
function drawRing(g, x, y, rr, tilt, hue, R, farHalf, dim = 1) {
  g.save();
  g.beginPath();
  if (farHalf) g.rect(x - rr * 1.3, y - rr, rr * 2.6, rr);
  else g.rect(x - rr * 1.3, y, rr * 2.6, rr);
  g.clip();
  // several distinct ringlets with a gap — reads as a ring system, not a smear
  const ringlets = [[1, 0.34, 0.055], [0.9, 0.26, 0.04], [0.78, 0.3, 0.028], [0.66, 0.18, 0.02]];
  for (const [f, a, lw] of ringlets) {
    g.globalAlpha = a * (0.55 + 0.45 * dim);
    g.lineWidth = rr * lw;
    g.strokeStyle = `hsl(${hue}, 26%, ${62 + f * 14}%)`;
    g.beginPath();
    g.ellipse(x, y, rr * f, rr * f * tilt, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  g.globalAlpha = 1;
}

// Orbital station drawn live each frame: slow self-rotation + blinking beacon.
export function drawLiveStation(g, cx, cy, s, rot, t) {
  g.save();
  g.translate(cx, cy);
  g.rotate(rot);
  g.fillStyle = 'rgb(30,34,44)';
  g.fillRect(-s, -s * 0.12, s * 2, s * 0.24);          // spine
  g.fillRect(-s * 0.25, -s * 0.3, s * 0.5, s * 0.6);   // hub
  g.fillStyle = 'rgb(22,30,52)';
  g.fillRect(-s * 1.5, -s * 0.4, s * 0.45, s * 0.8);   // solar wings
  g.fillRect(s * 1.05, -s * 0.4, s * 0.45, s * 0.8);
  g.fillStyle = 'rgba(255,220,150,0.8)';
  for (let i = 0; i < 4; i++) g.fillRect(-s * 0.8 + i * s * 0.45, -s * 0.03, 1.5, 1.5); // windows
  // blinking beacon on top of the hub
  if (Math.sin(t / 240) > 0.45) {
    g.fillStyle = 'rgba(255,90,80,0.95)';
    g.fillRect(-1.2, -s * 0.3 - 3, 2.4, 2.4);
  }
  g.restore();
}

function drawMoon(g, x, y, r, R) {
  const grad = g.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r);
  const lit = 55 + R() * 15;
  grad.addColorStop(0, `hsl(30, 8%, ${lit}%)`);
  grad.addColorStop(0.7, `hsl(30, 8%, ${lit * 0.55}%)`);
  grad.addColorStop(1, `hsl(30, 8%, ${lit * 0.2}%)`);
  g.fillStyle = grad;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  // a few craters even at moon scale
  for (let i = 0; i < 4; i++) {
    g.globalAlpha = 0.3;
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(x + (R() - 0.5) * 1.3 * r, y + (R() - 0.5) * 1.3 * r, r * (0.08 + R() * 0.12), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}


/* -------------------------------- sector names ------------------------------- */
// "SECTOR 4 · KHARON DRIFT" — seeded per level, same for every player.
const SYL_A = ['KAR', 'VEL', 'THO', 'RHI', 'AZH', 'MOR', 'QUE', 'TAL', 'ISH', 'ODA', 'BRA', 'KES', 'UMB', 'NYX', 'SOL', 'FEN', 'ORI', 'CYG', 'DRA', 'HEL'];
const SYL_B = ['on', 'ara', 'eus', 'ion', 'ith', 'os', 'ane', 'ir', 'ux', 'ea', 'antis', 'orn', 'ari', 'ex', 'ium'];
const PLACE = ['DRIFT', 'REACH', 'EXPANSE', 'VERGE', 'GATE', 'BELT', 'SHOALS', 'ABYSS', 'CROSSING', 'VEIL', 'FRONTIER', 'RIFT', 'DEEP', 'PASSAGE'];

export function sectorName(level) {
  const R = makeRng((level * 7919 + 271) >>> 0);
  const star = SYL_A[(R() * SYL_A.length) | 0] + SYL_B[(R() * SYL_B.length) | 0].toUpperCase();
  return `${star} ${PLACE[(R() * PLACE.length) | 0]}`;
}
