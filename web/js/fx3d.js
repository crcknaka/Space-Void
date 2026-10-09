// fx3d.js — pooled GPU particle / effects / dynamic-light system for the three.js view of SPACE VOID.
//
// Self-contained: imports nothing, receives the THREE namespace (core r170 API only).
// World: XZ play plane at y=0, +X forward, +Y up; units = simulation pixels.
// Colours are LINEAR; values above 1 are HDR and bloom.
//
// Draw calls (8 max, each skipped while empty):
//   smoke sprites · rings · fire sprites · beams+engine plumes · glows/auras ·
//   streaks (sparks + flecks + lightning + tracers) · bolts · shrapnel (ONE InstancedMesh, 6 shapes).
// Plus a fixed pool of PointLights that live in the scene permanently (intensity 0 when
// idle) so shaders never recompile.
//
// Frame order expected from the caller:
//   fx.update(dtMs, camera, drawingBufferHeightPx);  // simulate; clears last frame's immediate-mode things
//   ...one-shots, emitters, and the immediate-mode calls for THIS frame:
//      fx.bolt / fx.beam / fx.tracer / fx.aura / fx.heatGlow / fx.lightNow / fx.exhaust ...
//      (rate-based emitters, also once per frame per source: fx.exhaust / fx.rocketTrail / fx.fireTrail / fx.arcs)
//   fx.commit();                                     // ranks the frame's lights -> PointLights + fx.lightData
//   render
// commit() is optional: if it is skipped, the next update() does it (lights then lag one frame).
//
// Light list for other shaders (fog / mist glow):
//   fx.lightData  Float32Array, 8 floats per entry: x, y, z,  r, g, b (linear),  radius,  intensity 0..1
//   fx.lightCount number of valid entries (<= 16), strongest (by on-screen relevance) first.

/* ------------------------------------------------------------------------- */
/* Palette — tune colours here (before constructing, or call fx.rebuildRamps()) */
/* ------------------------------------------------------------------------- */

// Ramps are colour-over-life stop lists: [t, r, g, b, alpha], t in 0..1.
// Ramp rgb is MULTIPLIED by the per-particle tint (white by default).
export const FX_PALETTE = {
  // explosion fireball: white-hot -> yellow -> orange -> deep red -> gone (additive, HDR)
  fire: [
    [0.00, 2.15, 1.14, 0.27, 0.92],
    [0.08, 2.1, 0.96, 0.2, 0.9],
    [0.26, 1.85, 0.66, 0.1, 0.8],
    [0.50, 1.45, 0.36, 0.045, 0.6],
    [0.75, 1.0, 0.17, 0.02, 0.34],
    [1.00, 0.5, 0.05, 0.01, 0.00],
  ],
  // explosion smoke: the fire-lit look now comes from the per-particle heat term in the shader
  smoke: [
    [0.00, 1.0, 1.0, 1.0, 0.00],
    [0.08, 1.0, 1.0, 1.0, 0.62],
    [0.30, 1.0, 1.0, 1.0, 0.52],
    [0.60, 1.0, 1.0, 1.0, 0.36],
    [1.00, 0.8, 0.8, 0.85, 0.00],
  ],
  // unlit smoke puff (damage smoke, rocket trail)
  smokePlain: [
    [0.00, 1.0, 1.0, 1.0, 0.00],
    [0.12, 1.0, 1.0, 1.0, 0.46],
    [0.50, 1.0, 1.0, 1.0, 0.32],
    [1.00, 0.8, 0.8, 0.8, 0.00],
  ],
  // rocket smoke: visible from the nozzle on (no fade-in gap behind a fast rocket), thinning slowly
  smokeTrail: [
    [0.00, 1.0, 1.0, 1.0, 0.42],
    [0.06, 1.0, 1.0, 1.0, 0.6],
    [0.45, 1.0, 1.0, 1.0, 0.42],
    [1.00, 0.8, 0.8, 0.85, 0.00],
  ],
  dustRamp: [
    [0.00, 1.15, 1.1, 1.0, 0.00],
    [0.08, 1.0, 1.0, 1.0, 0.50],
    [0.50, 1.0, 1.0, 1.0, 0.32],
    [1.00, 0.85, 0.85, 0.85, 0.00],
  ],
  exhaustPlayer: [
    [0.00, 0.8, 1.4, 2.1, 0.80],
    [0.25, 0.3, 0.9, 2.0, 0.60],
    [0.60, 0.12, 0.4, 1.7, 0.36],
    [1.00, 0.05, 0.15, 1.0, 0.00],
  ],
  exhaustEnemy: [
    [0.00, 2.2, 1.45, 0.7, 0.80],
    [0.25, 1.8, 0.7, 0.14, 0.60],
    [0.60, 1.3, 0.28, 0.04, 0.36],
    [1.00, 0.6, 0.05, 0.01, 0.00],
  ],
  // generic "hot then fades" ramp for custom-tinted fire/exhaust
  tint: [
    [0.00, 1.6, 1.6, 1.6, 0.90],
    [0.30, 1.0, 1.0, 1.0, 0.70],
    [1.00, 0.25, 0.25, 0.25, 0.00],
  ],
  // flashes (muzzle, impact, explosion core)
  flash: [
    [0.00, 1.0, 1.0, 1.0, 1.00],
    [0.30, 0.8, 0.8, 0.8, 0.70],
    [1.00, 0.2, 0.2, 0.2, 0.00],
  ],

  // plain colours [r, g, b] (linear, HDR where > 1)
  spark: [3.6, 2.5, 1.1],
  ember: [2.6, 1.05, 0.2],
  explosionFlash: [2.0, 1.5, 0.72],     // yellow-white, never pure white
  explosionTongue: [2.2, 1.05, 0.26],   // the radial burst the core breaks into
  soot: [0.05, 0.036, 0.03],           // what a flame's body turns into as its glow dies
  explosionStreak: [0.75, 0.95, 1.5],   // anamorphic lens streak through the flash
  explosionLight: [1.0, 0.62, 0.3],
  shockwave: [1.3, 1.0, 0.65],        // thin energy ring
  shockwaveSoft: [0.4, 0.55, 0.85],    // faint wide "distortion" ring behind it
  muzzlePlayer: [1.0, 2.0, 2.7],
  muzzleEnemy: [2.7, 1.0, 0.36],
  impact: [3.0, 2.3, 1.2],
  smokeGrey: [0.17, 0.165, 0.16],
  smokeHeat: [1.9, 0.72, 0.17],       // glow of young smoke lit from inside by the fire
  smokeKey: [1.0, 0.93, 0.84],        // sun-side tint of smoke
  smokeShade: [0.34, 0.37, 0.46],     // shadow-side tint of smoke
  rocketSmoke: [0.32, 0.31, 0.30],
  dust: [0.42, 0.36, 0.30],
  metal: [0.17, 0.18, 0.2],
  shrapnelHeat: [1.0, 0.24, 0.035],    // emissive colour of glowing chunks (x heat, up to ~5)
  hull: [0.1, 0.105, 0.12],          // small dark hull bits
  fleck: [1.05, 1.2, 1.5],              // tumbling metal flecks that glint (streak pool)
  microSpark: [3.4, 2.9, 1.9],         // the finest, fastest sparks
  dustMote: [0.42, 0.34, 0.26],        // faint lit dust specks in the haze after a blast
  haze: [0.3, 0.26, 0.22],             // the brief expanding dust haze itself
  arc: [0.75, 1.5, 3.2],               // little electric arcs crawling over dying hulls

  // bolts, indexed by kind: player, playerHot, playerPlasma, enemy, enemyHeavy
  // (kept just above the bloom threshold on purpose: small very bright things give UnrealBloom square halos)
  boltCore: [[0.85, 1.15, 1.35], [1.4, 1.1, 0.55], [1.15, 0.9, 1.5], [1.5, 1.15, 0.5], [1.5, 0.85, 1.15]],
  boltHalo: [[0.05, 0.36, 1.15], [1.1, 0.46, 0.05], [0.7, 0.14, 1.4], [1.7, 0.07, 0.02], [1.5, 0.03, 0.55]],

  beamLaser: [0.14, 0.7, 1.5],
  beamBoss: [1.6, 0.32, 0.06],
  beamTelegraph: [0.85, 0.18, 0.08],
  beamAim: [1.1, 0.09, 0.06],
  beamGuide: [0.2, 0.55, 1.0],
  markerCalm: [0.7, 0.42, 0.08],
  markerHot: [1.9, 0.14, 0.04],
  plumePlayer: [0.1, 0.45, 1.5],
  plumeEnemy: [1.5, 0.38, 0.06],
  lightning: [0.6, 1.2, 2.8],
  warp: [0.5, 1.1, 2.4],
  pickup: [0.8, 2.0, 1.0],
  shield: [0.25, 1.0, 2.4],
};

// Numeric defaults that are worth tuning by eye.
export const FX_TUNING = {
  lightRef: 3e4,             // candela of a light with relative intensity 1 (= a scale-1 explosion)
  explosionLightPeak: 3e4,   // candela-ish, x scale^2
  muzzleLightPeak: 6e3,
  lightHeight: 60,           // lights sit this far above the event so they light upper surfaces
  lightFocusRadius: 700,     // lights further than this from the camera's focus point lose priority
  lightAttack: 0.03,         // s: how fast a real PointLight rises to a new target
  lightRelease: 0.07,        // s: how fast it fades when its source loses its slot
  lightDataGain: 1.5,        // multiplier on rgb written to fx.lightData
  lightDataBudget: 1.6,      // the intensities in fx.lightData never sum to more than this (1 = one full explosion flash)
  boltLight: 1.0,            // multiplier on the light that clusters of bolts cast
  smokeAlpha: 1.0,           // global multiplier on smoke opacity
  worldDriftX: -45,          // units/s: smoke drifts backward as the world scrolls
  smokeRise: 34,             // units/s upward
  exhaustRate: 16,           // wisp particles / s / nozzle at quality 1 (the plume itself is a shader)
  plumeLength: 3.6,          // plume length in nozzle widths (x ~1.8 with full boost)
  nearFade0: 50, nearFade1: 200, // sprites fade out this close to the camera (units)
  fireOcclusion: 0.8,        // how strongly flame bodies hide what is behind them (0 = the old purely additive fire)
  exposureLoad: 0.6,         // local exposure budget: flash/light gain = 1 / (1 + this x recent blast energy nearby)
  exposureRadius: 190,       // ...within about this distance (units)
  exposureDecay: 0.24,       // ...forgotten with this time constant (s)
  exposureScale: 0.6,        // ...and big blasts are held back by 1 / (1 + this x (scale - 1))
  boltMinPx: 1.0,            // multiplier on the minimum on-screen size of bolts (at a 720 px tall view)
  rocketSmokeStep: 4.5,      // world units between the puffs of a rocket's smoke trail (smaller = denser ribbon)
};

/* ------------------------------------------------------------------------- */
/* small helpers                                                              */
/* ------------------------------------------------------------------------- */

const RAMP_N = 32;
const RAMP_NAMES = ['fire', 'smoke', 'smokePlain', 'dustRamp', 'exhaustPlayer', 'exhaustEnemy', 'tint', 'flash', 'smokeTrail'];
const R_FIRE = 0, R_SMOKE = 1, R_SMOKE_PLAIN = 2, R_DUST = 3, R_EXH_PLAYER = 4, R_EXH_ENEMY = 5, R_TINT = 6, R_FLASH = 7, R_TRAIL = 8;

// atlas layout: 4 x 4 cells
const ATLAS_COLS = 4, ATLAS_ROWS = 6, CELL = 128;
const C_SMOKE0 = 0;                 // 0..3  smoke puffs (rg = normal, a = density)
const C_LICK0 = 6;                  // 6,7   elongated flame tongues (head at +x)
const C_DOT = 8, C_FLARE = 9, C_STREAK = 10, C_SPARKLE = 11, C_GLOW = 12, C_HOLLOW = 13;
const C_WISP0 = 16;                 // 16..19 thin curling smoke filaments (smoke cells: rg = normal)
const C_BURST = 20;                 // radial burst of uneven tongues (the first frames of a blast)
const wispCell = () => C_WISP0 + ((rnd() * 4) | 0);
const FLAME_CELLS = [4, 5, 14, 15]; // blobby flames
const flameCell = () => FLAME_CELLS[(rnd() * 4) | 0];

const BOLT_KIND = { player: 0, playerHot: 1, playerPlasma: 2, enemy: 3, enemyHeavy: 4 };
// per kind: quad half-width (how far the glow may reach), tail length, core radius (all world units at scale 1),
// min quad half-width in px. Bolts are needles: the visible core is ~2.4 x the core radius wide.
// Enemy bodies are teardrops ~10 long x ~5 wide (the sim hitbox) plus a thin dark rim.
const BOLT_DIM = [
  5.0, 64, 1.05, 2.4,    // player
  5.5, 84, 1.12, 2.5,    // playerHot
  7.0, 100, 1.3, 2.8,    // playerPlasma
  6.5, 32, 2.3, 5.0,     // enemy       (min size: a ~3.5 px white core inside a ~9 px halo at 720p, however far)
  7.5, 46, 2.65, 5.8,    // enemyHeavy
];
const BOLT_LIGHT = [0.020, 0.026, 0.045, 0.022, 0.040]; // relative light each bolt adds to its cluster

const BEAM_KIND = { laser: 0, boss: 1, telegraph: 2, aim: 3, guide: 4, marker: 5 };
const K_PLUME = 6, K_NOZZLE = 7;
// per kind: default width, quad half-width / width, light per sample (relative), palette key, default y
const BEAM_DEF = [
  { width: 10, hwK: 1.75, light: 0.1, col: 'beamLaser', y: 0 },
  { width: 34, hwK: 1.6, light: 0.35, col: 'beamBoss', y: 0 },
  { width: 5, hwK: 1.5, light: 0, col: 'beamTelegraph', y: 0 },
  { width: 1.6, hwK: 1.5, light: 0, col: 'beamAim', y: 0 },
  { width: 1.6, hwK: 1.5, light: 0, col: 'beamGuide', y: 0 },
  { width: 22, hwK: 0.5, light: 0, col: 'markerCalm', y: 1 },
];
const G_SOFT = 0, G_AURA = 1, G_STAR = 2, G_STREAK = 3, G_SHIELD = 4;

const rnd = Math.random;
const rr = (a, b) => a + (b - a) * rnd();
const TAU = Math.PI * 2;

// scratch direction (no allocations)
let DX = 0, DY = 0, DZ = 0;
function randSphere() {
  const u = rnd() * 2 - 1, a = rnd() * TAU, r = Math.sqrt(1 - u * u);
  DX = r * Math.cos(a); DY = u; DZ = r * Math.sin(a);
}
// cone around (dirX, dirZ) in the XZ plane; spread in radians; `lift` = vertical spread factor
function randCone(dirX, dirZ, spread, lift) {
  const l = Math.hypot(dirX, dirZ);
  if (l < 1e-5) { randSphere(); DY *= lift; return; }
  const a = Math.atan2(dirZ, dirX) + (rnd() - 0.5) * 2 * spread;
  const e = (rnd() - 0.5) * 2 * spread * lift;
  const c = Math.cos(e);
  DX = Math.cos(a) * c; DY = Math.sin(e); DZ = Math.sin(a) * c;
}

function buildRamps(pal) {
  const lut = new Float32Array(RAMP_NAMES.length * RAMP_N * 4);
  for (let r = 0; r < RAMP_NAMES.length; r++) {
    const stops = pal[RAMP_NAMES[r]] || FX_PALETTE[RAMP_NAMES[r]]; // (a custom palette may predate newer ramps)
    for (let i = 0; i < RAMP_N; i++) {
      const t = i / (RAMP_N - 1);
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
      const span = b[0] - a[0];
      const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
      const o = (r * RAMP_N + i) * 4;
      for (let c = 0; c < 4; c++) lut[o + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
    }
  }
  return lut;
}

/* ---------------------------- procedural textures -------------------------- */

function hash2(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, s) {
  let v = 0, amp = 0.5, n = 0;
  for (let o = 0; o < 4; o++) { v += amp * vnoise(x, y, s + o * 17); n += amp; x *= 2.03; y *= 2.03; amp *= 0.5; }
  return v / n;
}
// tiling value noise (lattice period p) and its fbm
function pnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = hash2(x0, y0, s), b = hash2(x1, y0, s), c = hash2(x0, y1, s), d = hash2(x1, y1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function pfbm(u, v, p, s, oct) {
  let val = 0, amp = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { val += amp * pnoise(u * p, v * p, p, s + o * 13); n += amp; p *= 2; amp *= 0.5; }
  return val / n;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// 128^2 tiling noise: r = soft fbm, g = finer fbm, b = ridged (filaments), a = coarse
function buildNoise() {
  const N = 128, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, o = (y * N + x) * 4;
      const a = pfbm(u, v, 4, 11, 4), b = pfbm(u, v, 8, 53, 4), c = pfbm(u, v, 6, 97, 4), d = pfbm(u, v, 2, 131, 3);
      data[o] = Math.round(clamp01((a - 0.5) * 1.7 + 0.5) * 255);
      data[o + 1] = Math.round(clamp01((b - 0.5) * 1.8 + 0.5) * 255);
      data[o + 2] = Math.round(clamp01(1 - Math.abs(c - 0.5) * 5.5) * 255);
      data[o + 3] = Math.round(clamp01((d - 0.5) * 1.6 + 0.5) * 255);
    }
  }
  return { data, size: N };
}

// RGBA8 atlas. Smoke cells: rg = surface normal (sprite space), a = density.
// Every other cell: r = heat (1 at the hot core, 0 at the wispy edge), a = density.
// All cells fade to zero before their border so mips never bleed between cells.
function buildAtlas() {
  const W = ATLAS_COLS * CELL, H = ATLAS_ROWS * CELL;
  const data = new Uint8Array(W * H * 4);
  const dens = new Float32Array(CELL * CELL);
  const heat = new Float32Array(CELL * CELL);
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const cx = (cell % ATLAS_COLS) * CELL, cy = Math.floor(cell / ATLAS_COLS) * CELL;
    const seed = 101 + cell * 31;
    const isWisp = cell >= C_WISP0;
    const isSmoke = cell < 4 || isWisp;
    const isBlob = cell === 4 || cell === 5 || cell === 14 || cell === 15;
    const isLick = cell === 6 || cell === 7;
    const lobes = [];
    const nl = isSmoke ? 7 : 5;
    for (let k = 0; k < nl; k++) {
      const a = hash2(k, 1, seed) * TAU, d = hash2(k, 2, seed) * (isSmoke ? 0.36 : 0.3);
      lobes.push(Math.cos(a) * d, Math.sin(a) * d, (isSmoke ? 0.32 : 0.26) + hash2(k, 3, seed) * 0.26);
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const u = ((x + 0.5) / CELL) * 2 - 1, v = ((y + 0.5) / CELL) * 2 - 1;
        const r = Math.hypot(u, v);
        const box = (1 - sstep(0.86, 0.985, Math.abs(u))) * (1 - sstep(0.86, 0.985, Math.abs(v)));
        let d = 0, h = 1;
        if (isWisp) {
          // wisps: a few soft, torn streamers swept along a gentle curve (no closed loops, no hard ridges)
          const bend = (hash2(1, 7, seed) - 0.5) * 1.6, tilt = hash2(2, 7, seed) * TAU;
          const ca = Math.cos(tilt), sa = Math.sin(tilt);
          const ru = u * ca + v * sa, rv = -u * sa + v * ca;
          const cv = rv - bend * (ru * ru - 0.25);                 // curved cross coordinate
          const wob = (fbm(ru * 1.4 + 3.3, rv * 0.6 + 1.7, seed + 5) - 0.5) * 0.7;
          const n = fbm(ru * 1.1 + 5.1, (cv + wob) * 4.2 + 2.2, seed);       // stretched along the streamer
          const n2 = fbm(ru * 3.2 + 1.3, (cv + wob) * 9.0 + 7.2, seed + 3);
          const band = Math.exp(-Math.pow((cv + wob) * (cell < C_WISP0 + 2 ? 2.4 : 3.3), 2));
          const strand = sstep(0.42, 0.78, n) * (0.4 + 0.9 * n2);
          d = clamp01(band * strand * (1 - sstep(0.35, 0.92, r)) * 1.25);
        } else if (isSmoke || isBlob) {
          const wu = u + (fbm(u * 1.6 + 7.3, v * 1.6 + 1.1, seed + 5) - 0.5) * 0.55;
          const wv = v + (fbm(u * 1.6 + 2.9, v * 1.6 + 8.7, seed + 9) - 0.5) * 0.55;
          let s = 0;
          for (let k = 0; k < lobes.length; k += 3) {
            const q = 1 - Math.hypot(wu - lobes[k], wv - lobes[k + 1]) / lobes[k + 2];
            if (q > 0) s += q * q;
          }
          s = Math.min(1, s * 1.35);
          const edge = 1 - sstep(0.62, 0.96, r);
          if (isSmoke) {
            // cauliflower: billows from a cellular-ish fbm
            const n = fbm(wu * 2.4 + 3.1, wv * 2.4 + 5.2, seed);
            const n2 = fbm(wu * 5.5 + 1.3, wv * 5.5 + 2.2, seed + 3);
            // soft skirt: density keeps falling off towards the silhouette instead of saturating
            // long soft skirt (no thresholds anywhere: a threshold is what makes puffs look like potatoes)
            const body = Math.pow(1 - Math.exp(-s * 1.15), 1.7);
            d = clamp01(body * (0.22 + 1.05 * n) * (0.7 + 0.5 * n2) * edge * 1.15);
          } else {
            // flame blob: ragged, torn by ridged noise, hot towards the lobes' centres
            const n = fbm(wu * 3.0 + 1.7, wv * 3.0 + 9.4, seed);
            const rid = 1 - Math.abs(fbm(wu * 4.2 + 4.4, wv * 4.2 + 0.6, seed + 21) - 0.5) * 2.6;
            d = clamp01(s * (0.15 + 1.25 * n * n) * (0.45 + 0.75 * clamp01(rid)) * edge * 1.9);
            h = clamp01(s * s * 1.25 * (0.4 + n));
          }
        } else if (isLick) {
          // tongue of flame: bright rounded head at +x, thinning torn tail towards -x
          const s = clamp01((u + 0.9) / 1.75);             // 0 tail .. 1 head
          const wob = (fbm(u * 1.7 + 3.3, 0.5, seed) - 0.5) * 0.5 * (1 - s);
          const hw = (0.035 + 0.3 * Math.pow(s, 1.25)) * (1 - sstep(0.86, 1.0, s) * 0.85);
          const dv = Math.abs(v - wob) / hw;
          const n = fbm(u * 3.2 + 1.1, v * 6.5 + 4.2, seed + 2);
          const body = dv < 1 ? Math.pow(1 - dv * dv, 1.2) : 0;
          d = clamp01(body * Math.pow(s, 0.7) * (0.45 + 1.1 * n) * 1.35) * sstep(0, 0.07, s);
          h = clamp01((1 - dv) * s * 1.5);
        } else if (cell === C_DOT) {
          // glow dot: tight core over a soft gaussian skirt
          const g = Math.exp(-r * r * 6.5) * 0.6 + Math.exp(-r * r * 30) * 0.55;
          d = Math.min(1, g) * (1 - sstep(0.8, 1, r));
        } else if (cell === C_FLARE) {
          // star flare: small core, 4 long thin spikes, 4 short diagonal ones
          const core = Math.exp(-r * r * 60);
          const sp = (Math.exp(-Math.abs(v) * 70) * Math.pow(Math.max(0, 1 - Math.abs(u)), 2.4)
            + Math.exp(-Math.abs(u) * 70) * Math.pow(Math.max(0, 1 - Math.abs(v)), 2.4));
          const a = (u + v) * 0.7071, b = (u - v) * 0.7071;
          const sp2 = (Math.exp(-Math.abs(b) * 85) * Math.pow(Math.max(0, 1 - Math.abs(a) * 1.9), 2.2)
            + Math.exp(-Math.abs(a) * 85) * Math.pow(Math.max(0, 1 - Math.abs(b) * 1.9), 2.2));
          d = Math.min(1, core + sp * 0.8 + sp2 * 0.45 + Math.exp(-r * r * 9) * 0.12) * box;
        } else if (cell === C_STREAK) {
          // anamorphic lens streak: one long horizontal needle
          const line = Math.exp(-Math.abs(v) * 46) * Math.pow(Math.max(0, 1 - Math.abs(u)), 1.7);
          const soft = Math.exp(-Math.abs(v) * 11) * Math.pow(Math.max(0, 1 - Math.abs(u) * 1.25), 2) * 0.22;
          d = Math.min(1, line + soft) * box;
        } else if (cell === C_SPARKLE) {
          // twinkle: 4 needle-thin points
          const sp = Math.exp(-Math.abs(v) * 90) * Math.pow(Math.max(0, 1 - Math.abs(u)), 3)
            + Math.exp(-Math.abs(u) * 90) * Math.pow(Math.max(0, 1 - Math.abs(v)), 3);
          d = Math.min(1, sp + Math.exp(-r * r * 90)) * box;
        } else if (cell === C_GLOW) {
          // wide soft glow with a long tail
          d = Math.pow(Math.max(0, 1 - r), 2.2) * 0.9;
        } else if (cell === C_BURST || cell === C_BURST + 1) {
          // starburst: uneven tongues radiating from a small core; the gaps between them are empty
          const ang = (Math.atan2(v, u) / TAU + 0.5);
          const P = cell === C_BURST ? 9 : 13;
          const a1 = pnoise(ang * P, 0.5, P, seed), a2 = pnoise(ang * P * 3, 1.5, P * 3, seed + 7);
          const len = 0.2 + 0.72 * Math.pow(a1, 1.6);                      // how far this direction's tongue reaches
          const spike = Math.pow(clamp01(1 - Math.abs(a2 - 0.5) * 2.6), 2.2); // thin bright spines
          const q = clamp01(1 - r / len);
          const core = Math.exp(-r * r * 46);
          d = clamp01(Math.pow(q, 1.3) * (0.16 + 1.25 * spike) * (0.55 + 0.6 * a1) + core) * (1 - sstep(0.82, 0.98, r));
          h = clamp01(q * 1.2 + core);
        } else if (cell === C_HOLLOW) {
          // hollow fireball shell: bright ragged rim, dim centre
          const n = fbm(u * 3.1 + 2.2, v * 3.1 + 7.7, seed);
          const rw = r / (0.62 + (n - 0.5) * 0.3);
          const rim = Math.exp(-Math.pow((rw - 1) * 3.2, 2));
          d = clamp01((rim * (0.4 + 1.1 * n) + 0.16 * (1 - sstep(0.2, 0.7, r))) * (1 - sstep(0.8, 0.98, r)));
          h = clamp01(rim * n * 1.6);
        }
        dens[y * CELL + x] = d;
        heat[y * CELL + x] = h;
      }
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const d = dens[y * CELL + x];
        const o = ((cy + y) * W + cx + x) * 4;
        if (isSmoke) {
          // normal from the density height field, rounded by the puff's overall sphere shape
          const xa = Math.max(0, x - 3), xb = Math.min(CELL - 1, x + 3), ya = Math.max(0, y - 3), yb = Math.min(CELL - 1, y + 3);
          const gx = dens[y * CELL + xb] - dens[y * CELL + xa], gy = dens[yb * CELL + x] - dens[ya * CELL + x];
          const u = ((x + 0.5) / CELL) * 2 - 1, v = ((y + 0.5) / CELL) * 2 - 1;
          let nx = -gx * 1.5 + u * 0.8, ny = -gy * 1.5 + v * 0.8;
          const nz = 0.55, l = Math.hypot(nx, ny, nz);
          nx /= l; ny /= l;
          data[o] = Math.round((nx * 0.5 + 0.5) * 255); data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255); data[o + 2] = 255;
        } else {
          const h8 = Math.round(heat[y * CELL + x] * 255);
          data[o] = h8; data[o + 1] = h8; data[o + 2] = h8;
        }
        data[o + 3] = Math.round(d * 255);
      }
    }
  }
  return { data, width: W, height: H };
}

/* ------------------------------- shaders ---------------------------------- */

const INV_COLS = (1 / ATLAS_COLS).toFixed(6), INV_ROWS = (1 / ATLAS_ROWS).toFixed(6);

// Camera-facing textured sprite (fire / smoke). STRETCH: align to the projected velocity and elongate.
const SPRITE_VS = /* glsl */`
attribute vec4 iPos;           // xyz, size (world units)
attribute vec4 iCol;
attribute vec4 iMisc;          // rotation, atlas cell, aux (fire: stretch, smoke: heat), life fraction
#ifdef STRETCH
attribute vec3 iVel;
#endif
uniform vec2 uNearFade;
varying vec4 vColor;
varying vec2 vUv;
varying vec2 vCell;
varying vec2 vAx;
varying vec4 vFx;              // life fraction, isFlame, phase, aux
varying vec2 vOcc;             // fire: how much the body hides what is behind it, curl direction
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  float size = iPos.w;
  vColor = iCol;
  vUv = position.xy + 0.5;
  float cell = floor(iMisc.y + 0.001);     // the fraction carries the occlusion
  vOcc = vec2(iMisc.y - cell, mod(float(gl_InstanceID), 2.0) * 2.0 - 1.0);
  vCell = vec2(mod(cell, ${ATLAS_COLS}.0), floor(cell / ${ATLAS_COLS}.0));
  vec2 ax = vec2(cos(iMisc.x), sin(iMisc.x));
  float st = 0.0;
#ifdef STRETCH
  if (iMisc.z > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    float l = length(vv.xy);
    if (l > 1e-3) { ax = vv.xy / l; st = iMisc.z * l / max(length(vv), 1e-3); }
  }
#endif
  vAx = ax;
  float fl = (cell > 3.5 && cell < 7.5) || (cell > 12.5 && cell < 15.5) ? 1.0 : 0.0;
  vFx = vec4(iMisc.w, fl, fract(float(gl_InstanceID) * 0.6180339) * 7.0 + iMisc.w * 0.45, iMisc.z);
  if (size <= 0.0 || mv.z > -1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 off = ax * position.x * (1.0 + st) + vec2(-ax.y, ax.x) * position.y;
  mv.xy += off * size;
  vColor.a *= smoothstep(uNearFade.x, uNearFade.y, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

// Fire. Output is premultiplied (blend ONE, ONE_MINUS_SRC_ALPHA): glows and flashes write alpha 0 (pure add),
// flame bodies write some alpha, so a stack of flames shadows itself instead of summing to a white disc,
// and each flame ends its life as a wisp of dark soot (the hand-over to the smoke pool).
const FIRE_FS = /* glsl */`
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform vec3 uSoot;
varying vec4 vColor;
varying vec2 vUv;
varying vec2 vCell;
varying vec2 vAx;
varying vec4 vFx;
varying vec2 vOcc;
void main() {
  float fl = vFx.y, t = vFx.x;
  // rolling: the body curls around its centre as it ages (more in the middle than at the rim)
  vec2 p = vUv - 0.5;
  float r = length(p);
  float sw = fl * (1.0 - step(0.001, vFx.w)) * (1.0 - smoothstep(0.0, 0.5, r)) * (0.2 + 1.5 * t) * vOcc.y;
  float cs = cos(sw), sn = sin(sw);
  vec2 uv = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y) + 0.5;
  // turbulence: warp the lookup with scrolling noise so no two frames of a flame match
  vec2 w = texture2D(uNoise, uv * 0.55 + vec2(vFx.z, vFx.z * 1.7)).rg - 0.5;
  vec2 q = clamp(uv + w * (0.15 + 0.13 * t) * fl, 0.008, 0.992);
  vec4 tx = texture2D(uAtlas, (vCell + q) * vec2(${INV_COLS}, ${INV_ROWS}));
  // flames erode from their thin parts as they age instead of fading uniformly
  float e = (0.04 + t * t * 0.8) * fl;
  float d = tx.a * smoothstep(e, e + 0.38, tx.a);
  // fine structure: a second, finer noise breaks the body into filaments and embers so a flame is never a flat shape
  float n2 = texture2D(uNoise, uv * 1.9 + vec2(vFx.z * 0.7, -vFx.z * 1.3)).g;
  float n3 = texture2D(uNoise, uv * 4.3 - vec2(vFx.z, vFx.z * 0.4)).b;
  d *= mix(1.0, (0.3 + 1.25 * n2) * (0.75 + 0.5 * n3), fl);
  vec3 c = vColor.rgb;
  float a = vColor.a * d;
  if (fl < 0.5) {
    if (a < 0.002) discard;
    gl_FragColor = vec4(c * a, 0.0);
  } else {
    float heat = clamp(tx.r * (0.6 + 0.8 * n2), 0.0, 1.0);
    float warm = clamp((c.r - c.b) / max(c.r, 1e-3), 0.0, 1.0);
    // the glow cools from the outside in: young = lit all through, old = only the hot pockets still burn
    float cool = smoothstep(0.2, 0.9, t);
    vec3 edge = mix(vec3(1.0), vec3(1.0, 0.4, 0.13), warm * (1.0 - heat));
    float em = mix(0.3 + 0.8 * heat, heat * heat * 1.2, cool);
    // the body: thin and transparent where it is hottest, sooty at the cool rim; it outlives the glow
    float occ = d * vOcc.x * mix(0.55 + 0.45 * (1.0 - heat), 1.0, cool) * (1.0 - smoothstep(0.62, 1.0, t));
    occ = min(occ, 0.96);
    if (a < 0.002 && occ < 0.004) discard;
    gl_FragColor = vec4(c * edge * em * a + uSoot * (0.5 + n3) * occ * cool, occ);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SMOKE_FS = /* glsl */`
uniform sampler2D uAtlas;
uniform vec3 uSunView;
uniform vec3 uHeatCol;
uniform vec3 uKeyCol;
uniform vec3 uShadeCol;
varying vec4 vColor;
varying vec2 vUv;
varying vec2 vCell;
varying vec2 vAx;
varying vec4 vFx;
void main() {
  vec4 t = texture2D(uAtlas, (vCell + clamp(vUv, 0.008, 0.992)) * vec2(${INV_COLS}, ${INV_ROWS}));
  float e = vFx.x * vFx.x * 0.42;
  float d = t.a * smoothstep(e, e + 0.55, t.a);
  float a = vColor.a * d;
  if (a < 0.003) discard;
  vec2 n2 = t.rg * 2.0 - 1.0;
  vec3 n = vec3(vAx * n2.x + vec2(-vAx.y, vAx.x) * n2.y, sqrt(max(0.0, 1.0 - dot(n2, n2))));
  float key = dot(n, uSunView);
  float lit = smoothstep(-0.35, 0.8, key);
  vec3 rgb = vColor.rgb * mix(uShadeCol, uKeyCol, lit) * (0.72 + 0.28 * t.a);
  // young smoke glows from inside: strongest on the side the sun does not reach
  rgb += uHeatCol * vFx.w * (0.22 + 0.78 * (1.0 - lit)) * (0.35 + 0.65 * t.a);
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Camera-facing capsule between two world points (sparks, lightning, tracers).
const STREAK_VS = /* glsl */`
attribute vec4 iHead;   // xyz, width (world units)
attribute vec4 iTail;   // xyz, core strength
attribute vec4 iColH;   // rgb, intensity
attribute vec4 iColT;
uniform float uPxPerUnit;
uniform float uMinPx;
varying vec2 vP;
varying float vL;
varying float vCore;
varying vec4 vColH;
varying vec4 vColT;
varying float vPx;
void main() {
  vec3 h = (modelViewMatrix * vec4(iHead.xyz, 1.0)).xyz;
  vec3 t = (modelViewMatrix * vec4(iTail.xyz, 1.0)).xyz;
  vec3 d = h - t;
  float len = length(d);
  vec3 dir = len > 1e-4 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 c = mix(t, h, position.x);
  float w = iHead.w;
  float wu = max(w, uMinPx * max(-c.z, 1.0) / uPxPerUnit);
  float hw = wu * 0.5;
  vPx = wu * uPxPerUnit / max(-c.z, 1.0);
  vec3 side = cross(dir, normalize(c));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  float e = position.x * 2.0 - 1.0;
  c += dir * e * hw + side * position.y * hw;
  vL = len / hw;
  vP = vec2(position.x * vL + e, position.y);
  vCore = iTail.w;
  float fade = w > 0.0 ? max(w / wu, 0.3) : 0.0;
  vColH = vec4(iColH.rgb, iColH.a * fade);
  vColT = vec4(iColT.rgb, iColT.a * fade);
  if (w <= 0.0 || c.z > -1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * vec4(c, 1.0);
}`;

const STREAK_FS = /* glsl */`
varying vec2 vP;
varying float vL;
varying float vCore;
varying vec4 vColH;
varying vec4 vColT;
varying float vPx;
void main() {
  float a = vP.x;
  float dd = length(vec2(a - clamp(a, 0.0, vL), vP.y));
  float f = vL > 1e-3 ? clamp(a / vL, 0.0, 1.0) : 1.0;
  float glow = max(1.0 - dd, 0.0);
  glow *= glow;
  float core = smoothstep(0.5, 0.05, dd);
  vec4 col = mix(vColT, vColH, f * f);
  vec3 rgb = col.rgb * col.a * (glow + core * vCore);
  // hair-thin streaks may not be much brighter than the bloom threshold: a 1-2 px HDR spike is what gives
  // the bloom pyramid its boxy halo. Wide ones (lightning, tracers seen close) keep their full punch.
  float cap = mix(1.9, 9.0, smoothstep(1.7, 5.5, vPx));
  rgb *= min(1.0, cap / max(max(rgb.r, max(rgb.g, rgb.b)), 1e-3));
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Oriented ring (shockwaves, warp-in, pickups, shield ripples).
const RING_VS = /* glsl */`
attribute vec4 iPosR;   // xyz, radius
attribute vec4 iCol;    // rgb, intensity
attribute vec4 iAxis;   // plane normal xyz, style (0 crisp energy ring, 1 faint wide distortion ring)
attribute vec2 iPar;    // thickness (world units), seed
uniform float uPxPerUnit;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vPar;      // thickness as a fraction of the radius, style, seed
void main() {
  vCol = iCol;
  vec3 n = iAxis.xyz;
  vec3 tx = abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 tz = cross(tx, n);
  float R = iPosR.w * 1.3;
  vUv = position.xz * 1.3;
  vec3 p = iPosR.xyz + (tx * position.x + tz * position.z) * R;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float minW = 1.3 * max(-mv.z, 1.0) / uPxPerUnit;
  vPar = vec3(max(iPar.x, minW) / max(iPosR.w, 1e-3), iAxis.w, iPar.y);
  if (iPosR.w <= 0.0 || iCol.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * mv;
}`;

const RING_FS = /* glsl */`
uniform sampler2D uNoise;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vPar;
void main() {
  float r = length(vUv);
  float w = min(vPar.x, 0.45);
  float ang = atan(vUv.y, vUv.x) * 0.159155;
  float n = texture2D(uNoise, vec2(ang * 2.0 + vPar.z, vPar.z * 3.7)).r;
  float g;
  if (vPar.y < 0.5) {
    // crisp front with a razor edge outside and a short soft falloff inside
    float x = (r - 1.0) / w;
    float front = x > 0.0 ? exp(-x * x * 5.0) : exp(-x * x * 0.55);
    float inner = pow(clamp(1.0 - (1.0 - r) / max(w * 7.0, 0.12), 0.0, 1.0), 3.0) * step(r, 1.0) * 0.22;
    g = front * (0.72 + 0.56 * n) * 1.15 + inner * 0.6;
  } else {
    // wide, faint, broken-up band: reads as a pressure/heat distortion front
    float x = (r - 1.0) / min(w, 0.11);
    g = exp(-x * x) * (0.05 + 0.95 * n * n) * 0.22;
  }
  if (r > 1.29 || g < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * vCol.a * g, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Energy bolts: camera-facing needles. A pin-bright core, a tight halo and a long tapering tail that
// shortens to nothing when the bolt flies at the camera (so head-on it is a small point, never a disc).
// Premultiplied output: alpha > 0 (enemy kinds) darkens what is behind, so enemy
// bullets keep a dark rim and never dissolve into fire or explosions.
const BOLT_VS = /* glsl */`
attribute vec4 iPos;    // xyz, scale
attribute vec4 iDir;    // dirX, dirZ, kind, seed
uniform float uPxPerUnit;
uniform vec4 uDim[5];   // quad half-width, tail length, core radius, min half-width px (at a 720 px tall view)
uniform float uMinK;    // viewport height / 720 x tuning
varying vec2 vP;        // x along (0 = head centre, negative = behind), y across; in quad half-widths
varying vec4 vK;        // tail length, core radius (both in half-widths), kind, seed
varying float vFar;     // 0 = drawn at true size .. 1 = far away, held at the minimum on-screen size
void main() {
  int k = int(iDir.z + 0.5);
  vec4 dim = uDim[k];
  vec3 c = (modelViewMatrix * vec4(iPos.xyz, 1.0)).xyz;
  vec3 d = normalize((modelViewMatrix * vec4(iDir.x, 0.0, iDir.y, 0.0)).xyz);
  vec3 v = normalize(c);
  vec3 dp = d - v * dot(d, v);
  float f = length(dp);
  vec3 u = f > 1e-3 ? dp / f : vec3(1.0, 0.0, 0.0);
  vec3 s = cross(v, u);
  float hw0 = dim.x * iPos.w;
  float hw = max(hw0, dim.w * uMinK * max(-c.z, 1.0) / uPxPerUnit);
  vFar = clamp(1.0 - hw0 / hw, 0.0, 1.0);
  float tail = dim.y * iPos.w * f / hw;
  float px = mix(-(tail + 0.6), 1.0, position.x);
  vP = vec2(px, position.y);
  vK = vec4(tail, dim.z / dim.x, iDir.z, iDir.w);
  if (iPos.w <= 0.0 || c.z > -4.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * vec4(c + (u * px + s * position.y) * hw, 1.0);
}`;

const BOLT_FS = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uCore[5];
uniform vec3 uHalo[5];
varying vec2 vP;
varying vec4 vK;
varying float vFar;
void main() {
  int k = int(vK.z + 0.5);
  vec3 coreC = uCore[k], haloC = uHalo[k];
  float tl = max(vK.x, 1e-3), rc = vK.y, seed = vK.w, T = uTime;
  vec2 p = vP;
  float back = max(-p.x, 0.0), nose = max(p.x, 0.0);
  float s = clamp(back / tl, 0.0, 1.0);                 // 0 at the head .. 1 at the end of the tail
  float border = 1.0 - smoothstep(0.8, 1.0, max(abs(p.y), p.x));
  vec3 rgb; float a = 0.0;
  if (k < 3) {
    // streaks of brightness racing down the tail
    float n = texture2D(uNoise, vec2(p.x * 0.035 + T * 2.6 + seed * 9.0, seed * 5.0)).r;
    float fall = pow(1.0 - s, 1.7) * (0.72 + 0.56 * n);
    float y = p.y;
    float w = rc * mix(1.0, 0.2, pow(s, 0.55));         // needle: thins towards the tail
    float dn = length(vec2(nose * 0.45, y));            // pointed nose
    float q = dn / w, qh = length(vec2(nose, y)) / w;   // the halo stays round ahead of the head
    float core = exp(-q * q) * fall;
    float halo = exp(-qh * qh * 0.12) * fall;
    float head = exp(-dot(p, p) / (rc * rc * 3.0));
    rgb = haloC * (halo * 0.62 + head * 0.5) + coreC * (core * 1.15 + head * 0.55);
    if (k == 1) {
      // hot rounds shed a pair of faint slipstream lines
      float sl = exp(-pow((abs(y) - rc * 2.1 * (1.0 - s * 0.6)) / (rc * 0.45), 2.0)) * pow(1.0 - s, 2.5) * step(p.x, 0.0) * smoothstep(0.0, 0.08, s);
      rgb += haloC * sl * 0.5;
    } else if (k == 2) {
      // plasma: two clean energy filaments wound around the needle like a double helix (the strand on the
      // far side is dimmer), opening just behind the head and closing towards the tail; a breathing head
      float ph = p.x * 1.9 + T * 30.0 + seed * 6.2832;
      float env = rc * 1.9 * smoothstep(0.0, 0.16, s) * pow(1.0 - s, 0.7);
      float hy = env * sin(ph), dep = cos(ph);
      float lw = rc * 0.34;
      float f1 = exp(-pow((y - hy) / lw, 2.0)) * (0.62 + 0.38 * dep);
      float f2 = exp(-pow((y + hy) / lw, 2.0)) * (0.62 - 0.38 * dep);
      float fil = (f1 + f2) * pow(1.0 - s, 1.1) * step(p.x, 0.0);
      float pulse = 0.88 + 0.12 * sin(T * 41.0 + seed * 40.0);
      rgb = rgb * pulse + haloC * fil * 0.6 + coreC * fil * 0.22;
    }
  } else {
    // enemy: white-hot teardrop, saturated skin, thin dark rim, short hairline tail
    // (far away the bolt is held at a minimum size: there the halo, the dark rim and the pulse all get stronger)
    float pulse = 1.0 - (0.12 + 0.2 * vFar) * (0.5 - 0.5 * sin(T * 21.0 + seed * 40.0));
    float L = rc * 3.1;                                 // the body tapers to a point this far behind the head
    float bw = rc * (1.0 - pow(clamp(back / L, 0.0, 1.0), 1.6));
    float e = back > L ? length(vec2(back - L, p.y)) : (p.x > 0.0 ? length(vec2(nose * 0.8, p.y)) - rc : abs(p.y) - bw);
    e /= rc;                                            // signed distance to the body, in core radii
    float core = 1.0 - smoothstep(-0.8, -0.34, e);
    float skin = smoothstep(-0.72, -0.3, e) * (1.0 - smoothstep(-0.06, 0.26, e));
    float glow = (exp(-max(e, 0.0) * max(e, 0.0) * 2.6) * 0.42 + exp(-max(e, 0.0) * 1.5) * 0.14) * step(0.0, e) * (1.0 + 1.5 * vFar) * mix(1.0, pulse, vFar);
    float ww = rc * mix(0.42, 0.1, s);
    float wk = exp(-(p.y * p.y) / (ww * ww)) * pow(1.0 - s, 1.5) * step(p.x, 0.0);
    rgb = coreC * core * (0.94 + 0.06 * pulse) + haloC * (skin * 1.35 * pulse + glow + wk * 0.8);
    a = (1.0 - smoothstep(0.12, 0.78 + 0.7 * vFar, e)) * (0.9 + 0.08 * vFar);
    a = max(a, wk * 0.3);
  }
  rgb *= border; a *= border;
  if (a < 0.003 && max(rgb.r, max(rgb.g, rgb.b)) < 0.003) discard;
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Beams and engine plumes: camera-facing ribbon between two points (kind 5 lies flat on the play plane).
const BEAM_VS = /* glsl */`
attribute vec4 iA;      // x0, y0, z0, quad half-width (world units)
attribute vec4 iB;      // x1, y1, z1, kind
attribute vec4 iCol;    // rgb, alpha
attribute vec4 iPar;    // seed, flag (marker: hot, plume: boost), p2, p3
uniform float uPxPerUnit;
varying vec2 vUv;       // x: world units along from A, y: -1..1 across
varying vec4 vCol;
varying vec4 vPar;
varying vec3 vInfo;     // length, half-width, kind
void main() {
  float kind = iB.w, hw = iA.w;
  vCol = iCol; vPar = iPar;
  float e = position.x * 2.0 - 1.0;
  if (kind > 4.5 && kind < 5.5) {
    vec3 dW = iB.xyz - iA.xyz;
    float len = max(length(dW), 1e-3);
    vec3 dirW = dW / len;
    vec3 pw = mix(iA.xyz, iB.xyz, position.x) + vec3(-dirW.z, 0.0, dirW.x) * position.y * hw;
    vUv = vec2(position.x * len, position.y);
    vInfo = vec3(len, hw, kind);
    gl_Position = hw > 0.0 ? projectionMatrix * modelViewMatrix * vec4(pw, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (kind > 6.5) {
    // engine disc: a quad square to the exhaust axis (iB.xyz = unit axis). Seen from behind it is the glowing
    // ring of the nozzle (and of the plume's cross-sections further down); from the side it is edge-on and gone.
    vec3 ax = iB.xyz;
    vec3 t1 = normalize(cross(ax, abs(ax.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(ax, t1);
    vec3 cv = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
    vec3 av = normalize((modelViewMatrix * vec4(ax, 0.0)).xyz);
    float facing = dot(av, -normalize(cv));
    vCol.a *= smoothstep(0.1, 0.5, facing);
    vUv = vec2(e, position.y);
    vInfo = vec3(1.0, hw, kind);
    gl_Position = hw > 0.0 && vCol.a > 0.001 ? projectionMatrix * modelViewMatrix * vec4(iA.xyz + (t1 * e + t2 * position.y) * hw, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 a = (modelViewMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(iB.xyz, 1.0)).xyz;
  float len = max(length(b - a), 1e-3);
  vec3 d = (b - a) / len;
  float zn = -8.0, s0 = 0.0, s1 = len;
  // clip against the near plane so beams passing the camera do not explode
  if (a.z > zn && b.z <= zn) s0 = (zn - a.z) / (b.z - a.z) * len;
  if (b.z > zn && a.z <= zn) s1 = (zn - a.z) / (b.z - a.z) * len;
  float s = mix(s0, s1, position.x);
  vec3 c = a + d * s;
  vec3 side = cross(d, normalize(c));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  float hwE = max(hw, 1.5 * max(-c.z, 1.0) / uPxPerUnit);
  vCol.a *= hw / hwE;
  // a plume seen (nearly) along its axis: the ribbon thins out and the engine discs take over
  if (kind > 5.5) { hwE *= mix(0.5, 1.0, smoothstep(0.15, 0.75, sl)); vCol.a *= smoothstep(0.06, 0.4, sl); }
  c += d * e * hwE + side * position.y * hwE;
  vUv = vec2(s + e * hwE, position.y);
  vInfo = vec3(len, hwE, kind);
  if (hw <= 0.0 || (a.z > zn && b.z > zn)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * vec4(c, 1.0);
}`;

const BEAM_FS = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
varying vec3 vInfo;
void main() {
  float len = vInfo.x, hw = vInfo.y, kind = vInfo.z;
  float x = vUv.x, y = vUv.y, T = uTime, seed = vPar.x;
  float dx = max(max(-x, x - len), 0.0) / hw;      // beyond the ends, in half-widths
  float r = length(vec2(dx, y));
  vec3 col = vCol.rgb, rgb = vec3(0.0);
  if (kind < 0.5) {
    // player laser: needle-thin white core, coloured sheath, energy racing along it
    float n1 = texture2D(uNoise, vec2(x * 0.0032 - T * 2.4 + seed, y * 0.22 + seed * 1.7)).r;
    float n2 = texture2D(uNoise, vec2(x * 0.011 - T * 6.0, y * 0.5 + seed)).g;
    float rw = length(vec2(dx, y + (n1 - 0.5) * 0.09));
    float core = exp(-rw * rw * 150.0);
    float sheath = exp(-rw * rw * 18.0) * (0.5 + 1.1 * n2);
    float halo = exp(-r * r * 3.5) * 0.16;
    float fy = (y - (n2 - 0.5) * 0.5) * 9.0;
    float fil = exp(-fy * fy) * n1 * 0.9 * step(dx, 0.001);
    rgb = col * (sheath * 1.15 + halo + fil * 0.8) + vec3(1.0) * core * 1.35 * (0.85 + 0.3 * n1);
  } else if (kind < 1.5) {
    // boss death ray: boiling edge, pulses running down the beam, electric filaments
    float n1 = texture2D(uNoise, vec2(x * 0.0022 - T * 1.6 + seed, y * 0.3)).r;
    float n2 = texture2D(uNoise, vec2(x * 0.007 - T * 4.5, y * 0.6 + seed)).g;
    float n3 = texture2D(uNoise, vec2(x * 0.0016 - T * 3.4, y * 1.7 + seed * 2.0)).g;
    float q = r / (1.0 + (n1 - 0.5) * 0.7);
    float core = exp(-q * q * 95.0);
    float sheath = exp(-q * q * 9.0) * (0.35 + 1.2 * n2);
    float pulse = 0.75 + 0.25 * sin(x * 0.045 - T * 38.0);
    float arcs = smoothstep(0.58, 0.9, n3) * exp(-q * q * 7.0) * 1.3;
    float halo = exp(-r * r * 2.4) * 0.2;
    rgb = col * (sheath * 1.2 * pulse + arcs + halo) + vec3(1.0, 0.9, 0.7) * core * 1.5 * (0.8 + 0.4 * n1);
  } else if (kind < 2.5) {
    // telegraph: marching dashes, slow pulse, no hot core -> obviously not live yet
    float ph = fract(x / 44.0 - T * 1.2);
    float dash = smoothstep(0.0, 0.07, ph) * (1.0 - smoothstep(0.5, 0.57, ph));
    float line = exp(-r * r * 7.0);
    float pulse = 0.5 + 0.5 * sin(T * 9.0 + seed);
    rgb = col * line * (dash * (0.55 + 0.45 * pulse) + 0.12) * step(dx, 0.001);
  } else if (kind < 3.5) {
    // sniper aim line: steady hairline with pips sliding towards the target
    float ph = fract(x / 130.0 - T * 0.9);
    float pip = smoothstep(0.9, 1.0, 1.0 - abs(ph - 0.5) * 2.0);
    rgb = col * exp(-r * r * 6.0) * (0.75 + 1.4 * pip);
  } else if (kind < 4.5) {
    // gun-line guide: barely there, finely dashed, dies out with distance
    float fade = pow(1.0 - clamp(x / len, 0.0, 1.0), 1.3);
    float dash = 0.55 + 0.45 * step(0.5, fract(x / 26.0));
    rgb = col * exp(-r * r * 6.0) * fade * dash * 0.5;
  } else if (kind < 5.5) {
    // flat impact marker on the play plane; vPar.y = hot (collision course)
    float hot = vPar.y, u = clamp(x / len, 0.0, 1.0), ay = abs(y);
    float body = 1.0 - smoothstep(0.62, 1.0, ay);
    float rail = exp(-pow((ay - 0.8) * 13.0, 2.0));
    float ch = fract(x / (hw * 2.4) + ay * 0.55 - T * mix(0.7, 3.2, hot));
    float stripe = smoothstep(0.3, 0.42, ch) * (1.0 - smoothstep(0.78, 0.9, ch));
    float ends = smoothstep(0.0, 0.07, u) * (1.0 - smoothstep(0.93, 1.0, u));
    float blink = mix(0.8 + 0.2 * sin(T * 3.0 + seed), 0.55 + 0.45 * step(0.5, fract(T * 5.5)), hot);
    rgb = col * (body * (0.14 + mix(0.32, 0.6, hot) * stripe) + rail * mix(0.6, 1.3, hot)) * ends * blink * mix(0.75, 1.0, hot);
  } else if (kind > 6.5) {
    // engine disc (vPar.y: 1 = the nozzle itself, 0 = a cross-section of the plume further down)
    float rr = length(vUv), hot = vPar.y;
    float fl = 0.86 + 0.14 * sin(T * 43.0 + seed * 9.0) * sin(T * 17.0 + seed * 5.0);
    float ring = exp(-pow((rr - 0.6) / mix(0.2, 0.07, hot), 2.0));
    float well = exp(-rr * rr * 9.0);
    float m = max(col.r, max(col.g, col.b));
    vec3 hotC = (col / max(m, 1e-3) + vec3(1.2)) * 0.6;
    rgb = (col * (ring * mix(0.4, 0.95, hot) + exp(-rr * rr * 2.4) * 0.16) + hotC * (ring * 0.3 + well * 0.34) * hot) * fl * vPar.z * (1.0 - smoothstep(0.88, 1.0, rr));
  } else {
    // engine plume: tapering cone, bright core with shock diamonds, flicker scrolling downstream
    float u = clamp(x / len, 0.0, 1.0), boost = vPar.y;
    float n1 = texture2D(uNoise, vec2(x / hw * 0.05 - T * 5.0 + seed, y * 0.25 + seed)).r;
    float n2 = texture2D(uNoise, vec2(x / hw * 0.13 - T * 11.0, y * 0.5 + seed * 3.0)).g;
    float rad = mix(0.50, 0.15, pow(u, 0.7)) * (0.9 + 0.3 * (n1 - 0.5));
    float w = abs(y) / rad;
    float body = exp(-w * w * 1.8) * pow(1.0 - u, 1.35) * (0.8 + 0.6 * n2 * (0.3 + u));
    float coreLen = 0.42 + 0.2 * boost;
    float cu = clamp(u / coreLen, 0.0, 1.0);
    float cw = abs(y) / (0.20 * (1.0 - cu * 0.75));
    float dia = 0.5 + 0.5 * cos(u * len / hw * 9.0 - 0.6);
    float core = exp(-cw * cw * 2.4) * (1.0 - cu) * (0.72 + 0.5 * dia * dia);
    float start = smoothstep(-0.22, 0.04, x / hw) * step(x, len);
    float m = max(col.r, max(col.g, col.b));
    vec3 hotC = (col / max(m, 1e-3) + vec3(2.0)) * 0.62;
    rgb = (col * body * 1.25 + hotC * core * (0.9 + 0.5 * boost)) * start * vPar.z;
  }
  rgb *= vCol.a * (1.0 - smoothstep(0.86, 1.0, abs(y)));
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Immediate-mode glow sprites: soft glow, aura with orbiting motes, star flare, lens streak.
const GLOW_VS = /* glsl */`
attribute vec4 iPos;    // xyz, half-size (world units)
attribute vec4 iCol;    // rgb, intensity
attribute vec4 iPar;    // kind, seed, rotation, aux
uniform vec2 uNearFade;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
varying vec3 vN;        // shield impact: direction centre -> hit point, in view space
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  vUv = position.xy * 2.0;
  vCol = iCol; vPar = iPar;
  vN = iPar.x > 3.5 ? normalize((modelViewMatrix * vec4(iPar.z, 0.0, iPar.w, 0.0)).xyz) : vec3(0.0, 0.0, 1.0);
  if (iPos.w <= 0.0 || mv.z > -1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vCol.a *= smoothstep(uNearFade.x, uNearFade.y, -mv.z);
  mv.xy += position.xy * 2.0 * iPos.w;
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FS = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
varying vec3 vN;
float rip(float th, float front, float w) {
  float x = (th - front) / w;
  return x > 0.0 ? exp(-x * x * 4.0) : exp(-x * x);     // sharp leading edge, soft wake
}
void main() {
  float r = length(vUv), kind = vPar.x, seed = vPar.y, T = uTime;
  vec3 col = vCol.rgb, rgb;
  if (kind < 0.5) {
    // soft glow; aux = 1 drops the white pin-point in the middle (engine haze)
    float g = exp(-r * r * 7.0) * 0.5 + exp(-r * r * 42.0) * 0.8 * (1.0 - 0.6 * vPar.w);
    float m = max(col.r, max(col.g, col.b));
    rgb = col * g + vec3(m) * exp(-r * r * 170.0) * 0.55 * (1.0 - vPar.w);
  } else if (kind < 1.5) {
    // aura: a breath of glow and three hair-thin arcs orbiting on tilted ellipses, each led by a mote.
    // The half of an orbit that passes behind the ship is dimmed, so the ship is wrapped, never covered.
    float m = max(col.r, max(col.g, col.b));
    float body = exp(-r * r * 4.5) * 0.05 + exp(-pow((r - 0.6) * 4.5, 2.0)) * 0.03 * (0.7 + 0.3 * sin(T * 2.3 + seed * 6.0));
    float arcs = 0.0, motes = 0.0;
    float lw = max(0.013, fwidth(r) * 1.1);
    for (int i = 0; i < 3; i++) {
      float fi = float(i), sg = i == 1 ? -1.0 : 1.0;
      float tilt = fi * 2.0944 + seed * 6.2832 + T * 0.17 * sg;
      float ct = cos(tilt), st = sin(tilt);
      vec2 q = vec2(ct * vUv.x + st * vUv.y, -st * vUv.x + ct * vUv.y);
      float A = 0.72, B = 0.2 + 0.09 * fi;
      vec2 e = vec2(q.x / A, q.y / B);
      float er = length(e);
      float ang = atan(e.y, e.x);
      // distance to the ellipse (first order): |er - 1| / |grad er|
      float dist = abs(er - 1.0) * er / max(length(vec2(e.x / A, e.y / B)), 1e-3);
      float head = sg * T * (2.3 + 0.55 * fi) + fi * 2.1 + seed * 9.0;
      float lag = fract(sg * (head - ang) * 0.159155);
      float back = mix(1.0, 0.22, smoothstep(-0.25, 0.25, sin(ang)));
      arcs += exp(-pow(dist / lw, 2.0)) * pow(1.0 - lag, 4.5) * back;
      vec2 dd = q - vec2(A * cos(head), B * sin(head));
      motes += (exp(-dot(dd, dd) * 2600.0) + exp(-dot(dd, dd) * 260.0) * 0.12) * mix(1.0, 0.3, smoothstep(-0.25, 0.25, sin(head)));
    }
    rgb = col * (body + arcs * 0.85) + mix(col, vec3(m), 0.55) * motes * 1.25;
  } else if (kind < 2.5) {
    float cr = cos(vPar.z), sr = sin(vPar.z);
    vec2 p = vec2(cr * vUv.x - sr * vUv.y, sr * vUv.x + cr * vUv.y);
    float sp = exp(-abs(p.y) * 60.0) * pow(max(0.0, 1.0 - abs(p.x)), 2.4) + exp(-abs(p.x) * 60.0) * pow(max(0.0, 1.0 - abs(p.y)), 2.4);
    rgb = col * (sp * 0.9 + exp(-r * r * 40.0) + exp(-r * r * 7.0) * 0.22);
  } else if (kind < 3.5) {
    float line = exp(-abs(vUv.y) * 42.0) * pow(max(0.0, 1.0 - abs(vUv.x)), 1.8);
    rgb = col * (line + exp(-r * r * 30.0) * 0.4);
  } else {
    // shield impact, drawn ON the bubble (sphere impostor, radius 0.8 of the sprite): ripples run over the
    // surface away from the hit point; the far hemisphere shows through dimmer; the limb is brighter (fresnel)
    vec2 p = vUv / 0.8;
    float r2 = dot(p, p);
    rgb = vec3(0.0);
    if (r2 < 1.0) {
      float z = sqrt(1.0 - r2), t = seed;
      float th = acos(clamp(dot(vec3(p, z), vN), -1.0, 1.0)), tb = acos(clamp(dot(vec3(p, -z), vN), -1.0, 1.0));
      float front = 0.1 + 2.5 * (1.0 - (1.0 - t) * (1.0 - t)), w = 0.07 + 0.09 * t;
      float k = 1.0 - t;
      float n = texture2D(uNoise, p * 0.9 + vec2(t * 0.15, 0.0)).b;
      float fres = 0.3 + 0.7 * pow(1.0 - z, 1.4);
      float g = rip(th, front, w) + 0.6 * rip(th, front * 0.66, w) + 0.32 * rip(th, front * 0.36, w);
      float gb = rip(tb, front, w) + 0.6 * rip(tb, front * 0.66, w);
      float hot = exp(-th * th * 7.0) * k * k * k;                        // the struck patch itself
      float sheen = exp(-th * 1.3) * (0.25 + 0.75 * n) * fres * k * k * 0.35; // the bubble lights up around it
      float m = max(col.r, max(col.g, col.b));
      rgb = col * ((g * (0.55 + 0.45 * fres) + gb * 0.3 * fres) * k * sqrt(k) * (0.75 + 0.5 * n) + sheen) + mix(col, vec3(m), 0.6) * hot * 0.9;
      rgb *= 1.0 - smoothstep(0.93, 1.0, r2);
    }
  }
  rgb *= vCol.a * (1.0 - smoothstep(0.84, 1.0, r));
  if (max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------------- */
/* Sprite pool (fire / smoke): fixed slots, particles never move between slots */
/* so alpha-blended draw order is stable for a particle's whole life.          */
/* ------------------------------------------------------------------------- */

class SpritePool {
  constructor(THREE, cap, material, lut, stretch) {
    this.cap = cap;
    this.lut = lut;
    this.alphaMul = 1;
    this.stretch = stretch;
    this.hi = 0;            // one past the highest slot in use
    this.live = 0;
    this.cursor = 0;        // steal cursor when full
    this.free = new Int32Array(cap);
    this.alive = new Uint8Array(cap);
    this.ramp = new Uint8Array(cap);
    const f = () => new Float32Array(cap);
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.s0 = f(); this.s1 = f(); this.spin = f();
    this.tr = f(); this.tg = f(); this.tb = f(); this.ta = f();
    this.drag = f(); this.wx = f(); this.wy = f(); this.turb = f(); this.seed = f();
    this.aux = f();         // fire: stretch along the velocity, smoke: heat (inner glow)

    this.pos = new Float32Array(cap * 4);
    this.col = new Float32Array(cap * 4);
    this.misc = new Float32Array(cap * 4);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = ia(this.pos, 4); this.aCol = ia(this.col, 4); this.aMisc = ia(this.misc, 4);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iMisc', this.aMisc);
    this.rPos = { start: 0, count: 0 }; this.rCol = { start: 0, count: 0 }; this.rMisc = { start: 0, count: 0 };
    if (stretch) {
      this.vel = new Float32Array(cap * 3);
      this.aVel = ia(this.vel, 3);
      geo.setAttribute('iVel', this.aVel);
      this.rVel = { start: 0, count: 0 };
    }
    geo.instanceCount = 0;
    this.geo = geo;
    this.points = new THREE.Mesh(geo, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.clear();
  }

  clear() {
    const cap = this.cap;
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i; // pop -> lowest index first
    this.nFree = cap;
    this.alive.fill(0);
    this.pos.fill(0);
    this.misc.fill(0);
    this.col.fill(0);
    this.hi = 0; this.live = 0;
    this._sync(cap);
  }

  // upload only the used prefix; range objects are persistent (no allocations)
  _sync(n) {
    const m = Math.max(1, n);
    touch(this.aPos, this.rPos, m * 4);
    touch(this.aCol, this.rCol, m * 4);
    touch(this.aMisc, this.rMisc, m * 4);
    if (this.stretch) touch(this.aVel, this.rVel, m * 3);
    this.geo.instanceCount = this.hi;
    this.points.visible = this.hi > 0;
  }

  // Returns the slot index; callers may tweak drag/wx/wy/turb/spin/ta/aux right after.
  spawn(x, y, z, vx, vy, vz, life, s0, s1, ramp, r, g, b, cell) {
    let i;
    if (this.nFree > 0) { i = this.free[--this.nFree]; this.live++; }
    else { i = this.cursor; this.cursor = (this.cursor + 1) % this.cap; }
    this.alive[i] = 1;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life > 0.005 ? life : 0.005;
    this.s0[i] = s0; this.s1[i] = s1;
    this.spin[i] = 0; this.ramp[i] = ramp;
    this.tr[i] = r; this.tg[i] = g; this.tb[i] = b; this.ta[i] = 1;
    this.drag[i] = 0; this.wx[i] = 0; this.wy[i] = 0; this.turb[i] = 0; this.aux[i] = 0;
    this.seed[i] = rnd() * 100;
    const m = i * 4, l = ramp * RAMP_N * 4, lut = this.lut;
    this.pos[m] = x; this.pos[m + 1] = y; this.pos[m + 2] = z; this.pos[m + 3] = s0;
    this.col[m] = lut[l] * r; this.col[m + 1] = lut[l + 1] * g; this.col[m + 2] = lut[l + 2] * b;
    this.col[m + 3] = lut[l + 3] * this.alphaMul;
    this.misc[m] = rnd() * TAU; this.misc[m + 1] = cell; this.misc[m + 2] = 0; this.misc[m + 3] = 0;
    if (this.stretch) { const p = i * 3; this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz; }
    if (i >= this.hi) this.hi = i + 1;
    this._sync(this.hi);
    return i;
  }

  // start invisible and frozen for `d` seconds
  delay(i, d) { this.age[i] = -d; this.pos[i * 4 + 3] = 0; }
  rot(i, a) { this.misc[i * 4] = a; }
  // fire only: 0 = pure glow (default), up to 0.95 = a flame body that hides what is behind it
  occ(i, v) { const m = i * 4 + 1; this.misc[m] = Math.floor(this.misc[m] + 0.001) + (v < 0 ? 0 : v > 0.95 ? 0.95 : v); }

  update(dt) {
    const n = this.hi;
    if (n === 0) return;
    const { alive, age, life, vx, vy, vz, pos, col, misc, lut, ramp, s0, s1, spin, tr, tg, tb, ta, drag, wx, wy, turb, seed, free, aux, vel } = this;
    const am = this.alphaMul, stretch = this.stretch;
    let hi = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (!alive[i]) continue;
      const a = age[i] + dt;
      age[i] = a;
      const m = i * 4;
      if (a < 0) { if (hi === 0) hi = i + 1; continue; }
      const t = a / life[i];
      if (t >= 1) {
        alive[i] = 0; pos[m + 3] = 0; col[m + 3] = 0;
        free[this.nFree++] = i; this.live--;
        continue;
      }
      if (hi === 0) hi = i + 1;
      const k = 1 / (1 + drag[i] * dt);
      let ux = wx[i] + (vx[i] - wx[i]) * k;
      let uy = wy[i] + (vy[i] - wy[i]) * k;
      let uz = vz[i] * k;
      const tb_ = turb[i];
      if (tb_ > 0) {
        const ph = seed[i] + a * 3.1, s = tb_ * dt;
        ux += s * Math.sin(ph + pos[m + 2] * 0.031);
        uy += s * 0.6 * Math.sin(ph * 1.3 + pos[m] * 0.027);
        uz += s * Math.sin(ph * 0.7 + pos[m + 1] * 0.033 + 1.7);
      }
      vx[i] = ux; vy[i] = uy; vz[i] = uz;
      pos[m] += ux * dt; pos[m + 1] += uy * dt; pos[m + 2] += uz * dt;
      // colour over life
      const f = t * (RAMP_N - 1), i0 = f | 0, fr = f - i0;
      const l = (ramp[i] * RAMP_N + i0) * 4;
      col[m] = (lut[l] + (lut[l + 4] - lut[l]) * fr) * tr[i];
      col[m + 1] = (lut[l + 1] + (lut[l + 5] - lut[l + 1]) * fr) * tg[i];
      col[m + 2] = (lut[l + 2] + (lut[l + 6] - lut[l + 2]) * fr) * tb[i];
      col[m + 3] = (lut[l + 3] + (lut[l + 7] - lut[l + 3]) * fr) * ta[i] * am;
      // size over life: fast at first, settling (ease-out)
      const e = 1 - (1 - t) * (1 - t);
      pos[m + 3] = s0[i] + (s1[i] - s0[i]) * e;
      misc[m] += spin[i] * dt;
      misc[m + 3] = t;
      if (stretch) {
        const p = i * 3;
        vel[p] = ux; vel[p + 1] = uy; vel[p + 2] = uz;
        misc[m + 2] = aux[i] * (1 - t * 0.6);
      } else {
        const h = 1 - t * 2.6;
        misc[m + 2] = h > 0 ? aux[i] * h * h : 0;
      }
    }
    this.hi = hi;
    this._sync(n);
  }
}

function touch(attr, range, count) {
  range.count = count;
  if (attr.updateRanges.length === 0) attr.updateRanges.push(range);
  attr.needsUpdate = true;
}

/* ------------------------------------------------------------------------- */

const SP = 18; // spark stride: px py pz vx vy vz age life width r g b drag grav stretch flick cool core
const SH = 28; // shrapnel stride: px py pz vx vy vz age life ax ay az ang angVel sx sy sz r g b heat drag grav cool shape trail trailDist glint size
const RG = 18; // ring stride: x y z maxR age life r g b style nx ny nz thick seed mode r0 gain
const SHAPES = 6; // shard, chunk, plate, strut, sliver, bolt
const SHAPE_ID = { shard: 0, chunk: 1, plate: 2, strut: 3, sliver: 4, bolt: 5 };
const AR = 14; // lightning segment stride: x0 y0 z0 x1 y1 z1 width age life r g b seed core
const TL = 12; // timed light stride: x y z r g b peak(rel) age life radius shape _
const LC = 10; // light candidate stride: x y z r g b intensity(rel) radius score fresh
const LIGHT_DATA_MAX = 16;
const IMM_LIGHTS = 96, TIMED_LIGHTS = 32;
const GRID_X = 18, GRID_Z = 10, GRID_CELL = 160; // bolt-light clustering grid, centred on the field
const CAND_MAX = IMM_LIGHTS + TIMED_LIGHTS + 64;

export class Fx3D {
  constructor(THREE, scene, opts = {}) {
    this.THREE = THREE;
    this.scene = scene;
    const q = this.quality = Math.min(2, Math.max(0.25, opts.quality ?? 1));
    this.palette = opts.palette || FX_PALETTE;
    this.tuning = opts.tuning || FX_TUNING;
    const capK = Math.min(1.5, Math.max(0.5, q));
    const ro = opts.renderOrder ?? 20;
    this._dt = 0;
    this._c = new THREE.Color();
    this._ca = [1, 1, 1];
    this._cam = null;
    this._committed = true;
    this._clock = 0;                               // seconds of fx time (never wraps within a session)
    this.exS = new Float32Array(16 * 4).fill(-1e3); // recent blasts: x, z, energy, birth time
    this.shS = new Float32Array(8 * 12);           // shield ripples: cx cy cz R nx nz age life r g b _
    this.shN = 0;
    this.rkS = new Float32Array(24 * 4).fill(-1e3); // rocket smoke trails: last x, last z, frame seen, distance flown
    this._frame = 0;
    this.lut = buildRamps(this.palette);
    const pal = this.palette;

    // ---- textures ----
    const at = buildAtlas();
    const tex = new THREE.DataTexture(at.data, at.width, at.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this.atlas = tex;
    const nz = buildNoise();
    const ntex = new THREE.DataTexture(nz.data, nz.size, nz.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    ntex.wrapS = ntex.wrapT = THREE.RepeatWrapping;
    ntex.magFilter = THREE.LinearFilter;
    ntex.minFilter = THREE.LinearMipmapLinearFilter;
    ntex.generateMipmaps = true;
    ntex.needsUpdate = true;
    this.noise = ntex;

    // ---- shared uniforms ----
    this.uPxPerUnit = { value: 1000 };
    this.uTime = { value: 0 };
    this.uMinK = { value: 1 };
    this.uNearFade = { value: new THREE.Vector2(this.tuning.nearFade0, this.tuning.nearFade1) };
    this.uAtlas = { value: tex };
    this.uNoise = { value: ntex };
    this.uSunView = { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() };
    this._sun = new THREE.Vector3().fromArray(opts.sunDir || [-0.45, 1, 0.55]).normalize();
    this.uHeatCol = { value: new THREE.Color().fromArray(pal.shrapnelHeat) };
    this.uSmokeHeat = { value: new THREE.Color().fromArray(pal.smokeHeat) };
    this.uSmokeKey = { value: new THREE.Color().fromArray(pal.smokeKey) };
    this.uSmokeShade = { value: new THREE.Color().fromArray(pal.smokeShade) };
    this.uSoot = { value: new THREE.Color().fromArray(pal.soot || [0.05, 0.036, 0.03]) };
    this.uBoltCore = { value: new Float32Array(15) };
    this.uBoltHalo = { value: new Float32Array(15) };
    this._readBoltColours();

    const quad = (geo) => {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
    };
    // position.x: 0 tail .. 1 head, position.y: -1..1 across
    const ribbon = (geo) => {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
    };
    const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    const rng = () => ({ start: 0, count: 0 });
    const mesh = (geo, mat, order) => {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = order;
      scene.add(m);
      return m;
    };

    // ---- smoke (alpha blended, drawn first) ----
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: this.uAtlas, uNearFade: this.uNearFade, uSunView: this.uSunView,
        uHeatCol: this.uSmokeHeat, uKeyCol: this.uSmokeKey, uShadeCol: this.uSmokeShade,
      },
      vertexShader: SPRITE_VS, fragmentShader: SMOKE_FS,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
    });
    this.smoke = new SpritePool(THREE, Math.ceil(1152 * capK), this.smokeMat, this.lut, false);
    this.smoke.alphaMul = this.tuning.smokeAlpha;
    this.smoke.points.renderOrder = ro;
    scene.add(this.smoke.points);

    // ---- rings ----
    {
      const cap = this.ringCap = 48;
      this.ringS = new Float32Array(cap * RG);
      this.ringN = 0;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      this.ringPosR = new Float32Array(cap * 4);
      this.ringCol = new Float32Array(cap * 4);
      this.ringAxis = new Float32Array(cap * 4);
      this.ringPar = new Float32Array(cap * 2);
      this.aRingPosR = ia(this.ringPosR, 4); this.aRingCol = ia(this.ringCol, 4);
      this.aRingAxis = ia(this.ringAxis, 4); this.aRingPar = ia(this.ringPar, 2);
      geo.setAttribute('iPosR', this.aRingPosR);
      geo.setAttribute('iCol', this.aRingCol);
      geo.setAttribute('iAxis', this.aRingAxis);
      geo.setAttribute('iPar', this.aRingPar);
      geo.instanceCount = 0;
      this.ringMat = new THREE.ShaderMaterial({
        uniforms: { uNoise: this.uNoise, uPxPerUnit: this.uPxPerUnit },
        vertexShader: RING_VS, fragmentShader: RING_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.ringMesh = mesh(geo, this.ringMat, ro + 1);
    }

    // ---- fire / glow sprites (additive) ----
    this.fireMat = new THREE.ShaderMaterial({
      defines: { STRETCH: 1 },
      uniforms: { uAtlas: this.uAtlas, uNoise: this.uNoise, uNearFade: this.uNearFade, uSoot: this.uSoot },
      vertexShader: SPRITE_VS, fragmentShader: FIRE_FS,
      transparent: true, depthWrite: false, depthTest: true, premultipliedAlpha: true, blending: THREE.NormalBlending,
    });
    this.fire = new SpritePool(THREE, Math.ceil(3072 * capK), this.fireMat, this.lut, true);
    this.fire.points.renderOrder = ro + 2;
    scene.add(this.fire.points);

    // ---- beams + engine plumes (immediate) ----
    {
      const cap = this.beamCap = opts.beamCapacity ?? 512;
      const geo = new THREE.InstancedBufferGeometry();
      ribbon(geo);
      this.bmA = new Float32Array(cap * 4); this.bmB = new Float32Array(cap * 4);
      this.bmCol = new Float32Array(cap * 4); this.bmPar = new Float32Array(cap * 4);
      this.aBmA = ia(this.bmA, 4); this.aBmB = ia(this.bmB, 4); this.aBmCol = ia(this.bmCol, 4); this.aBmPar = ia(this.bmPar, 4);
      geo.setAttribute('iA', this.aBmA); geo.setAttribute('iB', this.aBmB);
      geo.setAttribute('iCol', this.aBmCol); geo.setAttribute('iPar', this.aBmPar);
      geo.instanceCount = 0;
      this.rBm = [rng(), rng(), rng(), rng()];
      this.beamN = 0; this.plumeN = 0;
      this.beamMat = new THREE.ShaderMaterial({
        uniforms: { uNoise: this.uNoise, uTime: this.uTime, uPxPerUnit: this.uPxPerUnit },
        vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.beamGeo = geo;
      this.beamMesh = mesh(geo, this.beamMat, ro + 3);
    }

    // ---- glow sprites (immediate) ----
    {
      const cap = this.glowCap = opts.glowCapacity ?? 384;
      const geo = new THREE.InstancedBufferGeometry();
      quad(geo);
      this.glPos = new Float32Array(cap * 4); this.glCol = new Float32Array(cap * 4); this.glPar = new Float32Array(cap * 4);
      this.aGlPos = ia(this.glPos, 4); this.aGlCol = ia(this.glCol, 4); this.aGlPar = ia(this.glPar, 4);
      geo.setAttribute('iPos', this.aGlPos); geo.setAttribute('iCol', this.aGlCol); geo.setAttribute('iPar', this.aGlPar);
      geo.instanceCount = 0;
      this.rGl = [rng(), rng(), rng()];
      this.glowN = 0;
      this.glowMat = new THREE.ShaderMaterial({
        uniforms: { uNoise: this.uNoise, uTime: this.uTime, uNearFade: this.uNearFade },
        vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.glowGeo = geo;
      this.glowMesh = mesh(geo, this.glowMat, ro + 4);
    }

    // ---- streaks: sparks [0, sparkN), lightning segments, then this frame's tracers ----
    {
      const sc = this.sparkCap = Math.ceil(3072 * capK);
      const ac = this.arcCap = 512;
      const tc = this.tracerCap = opts.tracerCapacity ?? 1280;
      const cap = sc + ac + tc;
      this.sparkS = new Float32Array(sc * SP);
      this.sparkN = 0; this.sparkCursor = 0;
      this.arcS = new Float32Array(ac * AR);
      this.arcN = 0;
      this.tracerN = 0; this.tracerBase = 0;
      const geo = new THREE.InstancedBufferGeometry();
      ribbon(geo);
      this.stHead = new Float32Array(cap * 4); this.stTail = new Float32Array(cap * 4);
      this.stColH = new Float32Array(cap * 4); this.stColT = new Float32Array(cap * 4);
      this.aStHead = ia(this.stHead, 4); this.aStTail = ia(this.stTail, 4);
      this.aStColH = ia(this.stColH, 4); this.aStColT = ia(this.stColT, 4);
      geo.setAttribute('iHead', this.aStHead); geo.setAttribute('iTail', this.aStTail);
      geo.setAttribute('iColH', this.aStColH); geo.setAttribute('iColT', this.aStColT);
      geo.instanceCount = 0;
      this.rSt = [rng(), rng(), rng(), rng()];
      this.streakMat = new THREE.ShaderMaterial({
        uniforms: { uPxPerUnit: this.uPxPerUnit, uMinPx: { value: opts.minStreakPx ?? 1.6 } },
        vertexShader: STREAK_VS, fragmentShader: STREAK_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      this.streakGeo = geo;
      this.streakMesh = mesh(geo, this.streakMat, ro + 5);
    }

    // ---- bolts (immediate) ----
    {
      const cap = this.boltCap = opts.boltCapacity ?? 1536;
      const geo = new THREE.InstancedBufferGeometry();
      ribbon(geo);
      this.btPos = new Float32Array(cap * 4); this.btDir = new Float32Array(cap * 4);
      this.aBtPos = ia(this.btPos, 4); this.aBtDir = ia(this.btDir, 4);
      geo.setAttribute('iPos', this.aBtPos); geo.setAttribute('iDir', this.aBtDir);
      geo.instanceCount = 0;
      this.rBt = [rng(), rng()];
      this.boltN = 0;
      this.boltMat = new THREE.ShaderMaterial({
        uniforms: {
          uNoise: this.uNoise, uTime: this.uTime, uPxPerUnit: this.uPxPerUnit, uMinK: this.uMinK,
          uDim: { value: new Float32Array(BOLT_DIM) }, uCore: this.uBoltCore, uHalo: this.uBoltHalo,
        },
        vertexShader: BOLT_VS, fragmentShader: BOLT_FS,
        transparent: true, premultipliedAlpha: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
      });
      this.boltGeo = geo;
      this.boltMesh = mesh(geo, this.boltMat, ro + 6);
      // light clustering grid
      const g = GRID_X * GRID_Z;
      this.gW = new Float32Array(g); this.gX = new Float32Array(g); this.gZ = new Float32Array(g); this.gY = new Float32Array(g);
      this.gR = new Float32Array(g); this.gG = new Float32Array(g); this.gB = new Float32Array(g);
      this.gDirty = new Int16Array(g); this.gDirtyN = 0;
    }

    // ---- shrapnel: ONE InstancedMesh holding 6 jagged shapes (the vertex shader keeps the instance's shape
    //      and collapses the others), lit, per-instance colour + emissive heat ----
    {
      const mat = this.shrapMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.55, flatShading: true });
      const uHeatCol = this.uHeatCol;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uHeatCol = uHeatCol;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aSid;\nattribute vec2 aHeat;\nvarying float vHeat;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat.x;\ntransformed *= step(abs(aSid - aHeat.y), 0.5);');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uHeatCol;\nvarying float vHeat;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uHeatCol * vHeat * (0.1 + 0.9 * pow(1.0 - abs(normal.z), 2.2));')
          // debris is dark metal: however hard a fireball lights it, the lit part is compressed under a knee, so a
          // piece next to a fresh blast is a dark silhouette with glowing hot edges and never a pale peach flake
          .replace('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
            'vec3 fxLit = totalDiffuse + totalSpecular;\nfloat fxLm = max(fxLit.r, max(fxLit.g, fxLit.b));\nfxLit *= 1.0 / (1.0 + fxLm * 4.0);\nvec3 outgoingLight = fxLit + totalEmissiveRadiance;');
      };
      mat.customProgramCacheKey = () => 'fx3d-shrapnel-4';
      const cap = Math.ceil(640 * capK);
      const geo = shrapnelGeo(THREE);
      const heat = new Float32Array(cap * 2);
      const aHeat = new THREE.InstancedBufferAttribute(heat, 2).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aHeat', aHeat);
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      scene.add(m);
      // (an array for backward compatibility: there used to be one pool per shape)
      this.shrap = [{ mesh: m, geo, cap, n: 0, cursor: 0, S: new Float32Array(cap * SH), heat, aHeat }];
    }

    // ---- dynamic lights: always in the scene, shared out to the strongest sources each frame ----
    {
      const n = opts.lights ?? (q < 1 ? 4 : 8);
      this.lights = [];
      for (let i = 0; i < n; i++) {
        const light = new THREE.PointLight(0xffffff, 0, 0, 2);
        light.position.set(0, -1e5, 0);
        scene.add(light);
        this.lights.push({ light, cur: 0, tgt: 0, x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, rad: 400, m: -1, on: false });
      }
      this.tlS = new Float32Array(TIMED_LIGHTS * TL);
      this.tlN = 0;
      this.imS = new Float32Array(IMM_LIGHTS * LC);
      this.imN = 0;
      this.cand = new Float32Array(CAND_MAX * LC);
      this.candUsed = new Uint8Array(CAND_MAX);
      this.topIdx = new Int16Array(LIGHT_DATA_MAX);
      this.topTaken = new Int8Array(LIGHT_DATA_MAX);
      /** Frame light list: 8 floats per entry (x,y,z, r,g,b, radius, intensity 0..1), strongest first. */
      this.lightData = new Float32Array(LIGHT_DATA_MAX * 8);
      this.lightCount = 0;
      this._focus = [0, 0];
    }

    this._stats = {
      smoke: 0, smokeCap: this.smoke.cap, fire: 0, fireCap: this.fire.cap,
      sparks: 0, sparkCap: this.sparkCap, tracers: 0, tracerCap: this.tracerCap,
      arcs: 0, arcCap: this.arcCap,
      shrapnel: 0, shrapnelCap: this.shrap[0].cap, rings: 0, ringCap: this.ringCap,
      bolts: 0, boltCap: this.boltCap, beams: 0, beamCap: this.beamCap, glows: 0, glowCap: this.glowCap,
      lights: 0, lightCap: this.lights.length, lightsTimed: 0, lightsNow: 0, lightCount: 0,
      drawCalls: 0,
    };
  }

  /* ----------------------------------------------------------------------- */

  _readBoltColours() {
    const pc = this.palette.boltCore, ph = this.palette.boltHalo, c = this.uBoltCore.value, h = this.uBoltHalo.value;
    for (let i = 0; i < 5; i++) for (let k = 0; k < 3; k++) { c[i * 3 + k] = pc[i][k]; h[i * 3 + k] = ph[i][k]; }
  }

  /** Re-read FX_PALETTE after editing it at runtime. */
  rebuildRamps() {
    const pal = this.palette;
    this.lut.set(buildRamps(pal));
    this.uHeatCol.value.fromArray(pal.shrapnelHeat);
    this.uSmokeHeat.value.fromArray(pal.smokeHeat);
    this.uSmokeKey.value.fromArray(pal.smokeKey);
    this.uSmokeShade.value.fromArray(pal.smokeShade);
    if (pal.soot) this.uSoot.value.fromArray(pal.soot);
    this._readBoltColours();
  }

  /** Live counts (the same object is reused every call). */
  stats() {
    const s = this._stats;
    s.smoke = this.smoke.live; s.fire = this.fire.live;
    s.sparks = this.sparkN; s.tracers = this.tracerN; s.rings = this.ringN; s.arcs = this.arcN;
    s.shrapnel = this.shrap[0].n;
    s.bolts = this.boltN; s.beams = this.beamN; s.glows = this.glowN;
    let l = 0;
    for (let i = 0; i < this.lights.length; i++) if (this.lights[i].light.intensity > 0) l++;
    s.lights = l; s.lightsTimed = this.tlN; s.lightsNow = this.imN; s.lightCount = this.lightCount;
    let d = 0;
    if (this.smoke.points.visible) d++;
    if (this.fire.points.visible) d++;
    if (this.ringMesh.visible) d++;
    if (this.beamMesh.visible) d++;
    if (this.glowMesh.visible) d++;
    if (this.streakMesh.visible) d++;
    if (this.boltMesh.visible) d++;
    if (this.shrap[0].mesh.visible) d++;
    s.drawCalls = d;
    return s;
  }

  // stochastic rounding of a quality-scaled count, so tiny rates still average out
  _n(c) {
    c *= this.quality;
    const f = Math.floor(c);
    return f + (rnd() < c - f ? 1 : 0);
  }

  // resolve a colour option to an [r,g,b] array without allocating
  _col(c, def) {
    if (c == null) return def;
    if (typeof c === 'string') {
      if (c === 'player') return this.palette.muzzlePlayer;
      if (c === 'enemy') return this.palette.muzzleEnemy;
    } else if (typeof c !== 'number' && c.length >= 3) return c;
    this._c.set(c);
    const a = this._ca;
    a[0] = this._c.r; a[1] = this._c.g; a[2] = this._c.b;
    return a;
  }

  /* ------------------------------ update --------------------------------- */

  update(dtMs, camera, viewportHeightPx) {
    // lights of the frame that just ended, if the caller did not commit() them itself
    if (!this._committed) this.commit();

    let dt = dtMs / 1000;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._dt = dt;
    this.uTime.value = (this.uTime.value + dt) % 3600;
    this._clock += dt;

    if (camera) {
      this._cam = camera;
      if (viewportHeightPx > 0) {
        const fov = camera.isPerspectiveCamera ? camera.fov : 40;
        this.uPxPerUnit.value = viewportHeightPx / (2 * Math.tan((fov * Math.PI) / 360));
        this.uMinK.value = Math.max(0.6, viewportHeightPx / 720) * (this.tuning.boltMinPx ?? 1);
      }
      // sun direction in view space, for the smoke shading
      const e = camera.matrixWorldInverse.elements, s = this._sun, v = this.uSunView.value;
      v.set(e[0] * s.x + e[4] * s.y + e[8] * s.z, e[1] * s.x + e[5] * s.y + e[9] * s.z, e[2] * s.x + e[6] * s.y + e[10] * s.z);
      const l = v.length();
      if (l > 1e-4) v.multiplyScalar(1 / l); else v.set(-0.4, 0.6, 0.7).normalize();
    }
    this.smoke.alphaMul = this.tuning.smokeAlpha;

    this.smoke.update(dt);
    this.fire.update(dt);
    this._updateSparks(dt);
    this._updateArcs(dt);
    this._updateShrapnel(dt);
    this._updateRings(dt);
    this._updateTimedLights(dt);

    // immediate-mode things start empty every frame
    this.boltN = 0; this.boltGeo.instanceCount = 0; this.boltMesh.visible = false;
    this.beamN = 0; this.plumeN = 0; this.beamGeo.instanceCount = 0; this.beamMesh.visible = false;
    this.glowN = 0; this.glowGeo.instanceCount = 0; this.glowMesh.visible = false;
    this.imN = 0;
    if (dt > 0) this._frame++;
    // shield ripples are timed, but drawn through the immediate glow pool
    {
      const S = this.shS;
      let n = this.shN;
      for (let i = 0; i < n;) {
        const o = i * 12, age = S[o + 6] + dt;
        if (age >= S[o + 7]) { n--; if (i !== n) S.copyWithin(o, n * 12, n * 12 + 12); continue; }
        S[o + 6] = age;
        this._glow(S[o], S[o + 1], S[o + 2], S[o + 3] / 0.8, S[o + 8], S[o + 9], S[o + 10], 1, G_SHIELD, age / S[o + 7], S[o + 4], S[o + 5]);
        i++;
      }
      this.shN = n;
    }
    const gd = this.gDirty, gw = this.gW;
    for (let i = 0; i < this.gDirtyN; i++) gw[gd[i]] = 0;
    this.gDirtyN = 0;
    this._committed = false;
  }

  _updateSparks(dt) {
    const S = this.sparkS, H = this.stHead, T = this.stTail, CH = this.stColH, CT = this.stColT;
    let n = this.sparkN;
    for (let i = 0; i < n;) {
      const o = i * SP;
      const age = S[o + 6] + dt, t = age / S[o + 7];
      if (t >= 1) {
        n--;
        if (i !== n) S.copyWithin(o, n * SP, n * SP + SP);
        continue;
      }
      S[o + 6] = age;
      if (age < 0) { // delayed: parked and invisible
        const m = i * 4;
        H[m] = S[o]; H[m + 1] = S[o + 1]; H[m + 2] = S[o + 2]; H[m + 3] = 0;
        T[m] = S[o]; T[m + 1] = S[o + 1]; T[m + 2] = S[o + 2]; T[m + 3] = 0;
        CH[m + 3] = 0; CT[m + 3] = 0;
        i++;
        continue;
      }
      const k = 1 / (1 + S[o + 12] * dt);
      const vx = S[o + 3] * k, vy = S[o + 4] * k - S[o + 13] * dt, vz = S[o + 5] * k;
      S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
      const x = S[o] += vx * dt, y = S[o + 1] += vy * dt, z = S[o + 2] += vz * dt;
      const st = Math.min(S[o + 14], Math.max(age, 0.004));
      const kk = 1 - t;
      let inten = kk * Math.sqrt(kk);
      const fl = S[o + 15];
      if (fl > 0) inten *= 0.55 + 0.45 * Math.sin(age * 38 + fl * 7);
      else if (fl < 0) { // glint: a tumbling fleck that is dim most of the time and flashes when it catches the light
        const g = Math.sin(age * (11 - fl * 5) - fl * 9);
        inten *= g > 0.55 ? 0.35 + 1.5 * (g - 0.55) * (g - 0.55) * 4.94 : 0.35;
      }
      const cool = S[o + 16];
      const r = S[o + 9], g = S[o + 10] * (1 - cool * 0.65 * t), b = S[o + 11] * (1 - cool * (1 - kk * kk));
      const m = i * 4;
      H[m] = x; H[m + 1] = y; H[m + 2] = z; H[m + 3] = S[o + 8] * (0.6 + 0.4 * kk);
      T[m] = x - vx * st; T[m + 1] = y - vy * st; T[m + 2] = z - vz * st; T[m + 3] = S[o + 17];
      CH[m] = r; CH[m + 1] = g; CH[m + 2] = b; CH[m + 3] = inten;
      CT[m] = r; CT[m + 1] = g * 0.6; CT[m + 2] = b * 0.35; CT[m + 3] = 0;
      i++;
    }
    this.sparkN = n;
  }

  // lightning segments are copied behind the sparks every frame; a whole arc flickers as one
  _updateArcs(dt) {
    const S = this.arcS, H = this.stHead, T = this.stTail, CH = this.stColH, CT = this.stColT;
    let n = this.arcN;
    const base = this.sparkN;
    for (let i = 0; i < n;) {
      const o = i * AR;
      const age = S[o + 7] + dt, t = age / S[o + 8];
      if (t >= 1) {
        n--;
        if (i !== n) S.copyWithin(o, n * AR, n * AR + AR);
        continue;
      }
      S[o + 7] = age;
      const k = 1 - t, seed = S[o + 12];
      const fl = Math.sin(age * 95 + seed * 13) > -0.25 ? 1 : 0.28;
      const inten = age < 0 ? 0 : Math.sqrt(k) * k * fl;
      const m = (base + i) * 4;
      H[m] = S[o]; H[m + 1] = S[o + 1]; H[m + 2] = S[o + 2]; H[m + 3] = age < 0 ? 0 : S[o + 6] * (0.55 + 0.45 * k);
      T[m] = S[o + 3]; T[m + 1] = S[o + 4]; T[m + 2] = S[o + 5]; T[m + 3] = S[o + 13];
      CH[m] = S[o + 9]; CH[m + 1] = S[o + 10]; CH[m + 2] = S[o + 11]; CH[m + 3] = inten;
      CT[m] = S[o + 9]; CT[m + 1] = S[o + 10]; CT[m + 2] = S[o + 11]; CT[m + 3] = inten;
      i++;
    }
    this.arcN = n;
    this.tracerBase = base + n;
    this.tracerN = 0;
    this._syncStreaks();
  }

  _syncStreaks() {
    const n = this.tracerBase + this.tracerN;
    const c = Math.max(1, n) * 4, r = this.rSt;
    touch(this.aStHead, r[0], c); touch(this.aStTail, r[1], c);
    touch(this.aStColH, r[2], c); touch(this.aStColT, r[3], c);
    this.streakGeo.instanceCount = n;
    this.streakMesh.visible = n > 0;
  }

  _updateShrapnel(dt) {
    const P = this.shrap[0];
    let n = P.n;
    if (n === 0) { if (P.mesh.visible) { P.mesh.visible = false; P.mesh.count = 0; } return; }
    const S = P.S, M = P.mesh.instanceMatrix.array, C = P.mesh.instanceColor.array, heat = P.heat;
    const trailK = this.quality < 1 ? 1.8 : 1;
    for (let i = 0; i < n;) {
      const o = i * SH;
      const age = S[o + 6] + dt, t = age / S[o + 7];
      if (t >= 1) {
        n--;
        if (i !== n) S.copyWithin(o, n * SH, n * SH + SH);
        continue;
      }
      S[o + 6] = age;
      if (age < 0) { // delayed: parked, zero scale
        const m = i * 16;
        M.fill(0, m, m + 16); M[m + 15] = 1; M[m + 12] = S[o]; M[m + 13] = S[o + 1]; M[m + 14] = S[o + 2];
        heat[i * 2] = 0; heat[i * 2 + 1] = S[o + 23];
        i++;
        continue;
      }
      const k = 1 / (1 + S[o + 20] * dt);
      const vx = S[o + 3] * k, vy = S[o + 4] * k - S[o + 21] * dt, vz = S[o + 5] * k;
      S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
      const x = S[o] += vx * dt, y = S[o + 1] += vy * dt, z = S[o + 2] += vz * dt;
      // tumbling slows a little as the piece loses energy
      const av = S[o + 12] *= 1 / (1 + 0.35 * dt);
      const ang = S[o + 11] += av * dt;
      // shrink out over the last quarter of life, pop in over the first 40 ms
      let sc = t > 0.75 ? (1 - t) * 4 : 1;
      if (age < 0.04) sc *= age / 0.04;
      const ax = S[o + 8], ay = S[o + 9], az = S[o + 10];
      const c = Math.cos(ang), sn = Math.sin(ang), ic = 1 - c;
      const sx = S[o + 13] * sc, sy = S[o + 14] * sc, sz = S[o + 15] * sc;
      const m = i * 16;
      M[m] = (c + ax * ax * ic) * sx; M[m + 1] = (ay * ax * ic + az * sn) * sx; M[m + 2] = (az * ax * ic - ay * sn) * sx; M[m + 3] = 0;
      M[m + 4] = (ax * ay * ic - az * sn) * sy; M[m + 5] = (c + ay * ay * ic) * sy; M[m + 6] = (az * ay * ic + ax * sn) * sy; M[m + 7] = 0;
      M[m + 8] = (ax * az * ic + ay * sn) * sz; M[m + 9] = (ay * az * ic - ax * sn) * sz; M[m + 10] = (c + az * az * ic) * sz; M[m + 11] = 0;
      M[m + 12] = x; M[m + 13] = y; M[m + 14] = z; M[m + 15] = 1;
      // specular flicker: a face swings through the light once per turn
      // dark silhouettes against the fireball at first, then lit normally
      let gl = age < 0.36 ? 0.2 + age * 2.2 : 1;
      const glint = S[o + 26];
      if (glint > 0 && c > 0.82) { const g = (c - 0.82) * 5.56; gl *= 1 + glint * g * g * 2.6; }
      const c3 = i * 3;
      C[c3] = S[o + 16] * gl; C[c3 + 1] = S[o + 17] * gl; C[c3 + 2] = S[o + 18] * gl;
      const h = S[o + 19] / (1 + S[o + 22] * age * age);
      heat[i * 2] = h; heat[i * 2 + 1] = S[o + 23];
      // burning chunks leave a thin thread of smoke (and fire while they are still hot)
      if (S[o + 24] > 0 && dt > 0) {
        const d = S[o + 25] + Math.hypot(vx, vy, vz) * dt, size = S[o + 27];
        if (d >= (size * 1.5 + 4) * trailK) {
          S[o + 25] = 0;
          this._chunkTrail(x, y, z, vx, vy, vz, size, h, 1 - t);
        } else S[o + 25] = d;
      }
      i++;
    }
    P.n = n;
    P.mesh.count = n;
    P.mesh.visible = n > 0;
    P.mesh.instanceMatrix.needsUpdate = true;
    P.mesh.instanceColor.needsUpdate = true;
    P.aHeat.needsUpdate = true;
  }

  _chunkTrail(x, y, z, vx, vy, vz, size, heat, k) {
    const K = this.smoke, F = this.fire, tn = this.tuning, g = this.palette.smokeGrey;
    const s1 = size * rr(2.2, 3.6), sh = rr(0.8, 1.25);
    let i = K.spawn(x, y, z, vx * 0.06 + rr(-6, 6), vy * 0.06 + rr(2, 10), vz * 0.06 + rr(-6, 6),
      rr(0.5, 1.0), s1 * 0.35, s1, R_SMOKE, g[0] * sh, g[1] * sh, g[2] * sh, rnd() < 0.6 ? wispCell() : C_SMOKE0 + ((rnd() * 4) | 0));
    K.drag[i] = 1.5; K.turb[i] = 34; K.spin[i] = rr(-1.6, 1.6);
    K.wx[i] = tn.worldDriftX * 0.7; K.wy[i] = tn.smokeRise * 0.5;
    K.ta[i] = 0.75 * Math.min(1, k * 2); K.aux[i] = Math.min(1.2, heat * 0.6);
    if (heat > 0.25) {
      const s0 = size * rr(1.3, 2.1);
      i = F.spawn(x, y, z, vx * 0.3 + rr(-10, 10), vy * 0.3 + rr(0, 14), vz * 0.3 + rr(-10, 10),
        rr(0.1, 0.24), s0, s0 * 0.35, R_FIRE, 0.9, 0.9, 0.9, rnd() < 0.5 ? C_DOT : flameCell());
      F.drag[i] = 2; F.ta[i] = Math.min(1, heat * 0.7); F.occ(i, 0.4);
    }
  }

  _updateRings(dt) {
    const S = this.ringS;
    let n = this.ringN;
    if (n === 0) { this.ringMesh.visible = false; this.ringMesh.geometry.instanceCount = 0; return; }
    const PR = this.ringPosR, C = this.ringCol, AX = this.ringAxis, PA = this.ringPar;
    for (let i = 0; i < n;) {
      const o = i * RG;
      const age = S[o + 4] + dt, t = age / S[o + 5];
      if (t >= 1) {
        n--;
        if (i !== n) S.copyWithin(o, n * RG, n * RG + RG);
        continue;
      }
      S[o + 4] = age;
      const m = i * 4;
      PR[m] = S[o]; PR[m + 1] = S[o + 1]; PR[m + 2] = S[o + 2];
      AX[m] = S[o + 10]; AX[m + 1] = S[o + 11]; AX[m + 2] = S[o + 12]; AX[m + 3] = S[o + 9];
      PA[i * 2] = S[o + 13]; PA[i * 2 + 1] = S[o + 14];
      C[m] = S[o + 6]; C[m + 1] = S[o + 7]; C[m + 2] = S[o + 8];
      if (age < 0) { PR[m + 3] = 0; C[m + 3] = 0; i++; continue; }
      const k = 1 - t, r0 = S[o + 16], R = S[o + 3];
      if (S[o + 15] > 0.5) {
        // collapsing (warp-in): accelerates inward, brightens as it closes
        PR[m + 3] = Math.max(0.5, r0 + (R - r0) * t * t);
        C[m + 3] = S[o + 17] * Math.min(1, t * 4) * (0.35 + 0.65 * t);
      } else {
        PR[m + 3] = r0 + (R - r0) * (1 - k * k * k);
        C[m + 3] = S[o + 17] * k * k;
      }
      i++;
    }
    this.ringN = n;
    this.ringMesh.geometry.instanceCount = n;
    this.ringMesh.visible = n > 0;
    this.aRingPosR.needsUpdate = true; this.aRingCol.needsUpdate = true;
    this.aRingAxis.needsUpdate = true; this.aRingPar.needsUpdate = true;
  }

  _updateTimedLights(dt) {
    const S = this.tlS;
    let n = this.tlN;
    for (let i = 0; i < n;) {
      const o = i * TL;
      const age = S[o + 7] + dt;
      if (age >= S[o + 8]) {
        n--;
        if (i !== n) S.copyWithin(o, n * TL, n * TL + TL);
        continue;
      }
      S[o + 7] = age;
      i++;
    }
    this.tlN = n;
  }

  /* ------------------------------- lights -------------------------------- */

  /**
   * Rank this frame's lights (timed + lightNow + beams + bolt clusters), hand the best to the real
   * PointLights with smoothed intensity, and fill fx.lightData / fx.lightCount.
   * Call once per frame after all fx calls and before rendering. Idempotent within a frame.
   */
  commit() {
    if (this._committed) return;
    this._committed = true;
    const tn = this.tuning, C = this.cand, dt = this._dt;
    let n = 0;

    // camera focus = where the view axis meets the play plane
    let fx = 0, fz = 0;
    const cam = this._cam;
    if (cam) {
      const e = cam.matrixWorld.elements;
      const ox = e[12], oy = e[13], oz = e[14], dx = -e[8], dy = -e[9], dz = -e[10];
      let t = dy < -0.05 ? -oy / dy : 600;
      if (t > 1600) t = 1600;
      fx = ox + dx * t; fz = oz + dz * t;
    }
    this._focus[0] = fx; this._focus[1] = fz;
    const fr2 = tn.lightFocusRadius * tn.lightFocusRadius;

    // timed lights
    const TS = this.tlS;
    for (let i = 0; i < this.tlN; i++) {
      const o = i * TL, age = TS[o + 7];
      if (age < 0) continue;
      const t = age / TS[o + 8], k = 1 - t;
      let f, fresh = 0;
      if (TS[o + 10] > 0.5) { // swell, then flash at 70 %
        if (t < 0.7) { const a = t / 0.7; f = 0.3 * a * a; } else { const a = k / 0.3; f = a * a; fresh = t < 0.78 ? 1 : 0; }
      } else {
        f = 0.8 * k * k * k + 0.2 * k;
        fresh = age <= dt * 1.5 + 1e-4 ? 1 : 0;
      }
      const c = n++ * LC;
      C[c] = TS[o]; C[c + 1] = TS[o + 1]; C[c + 2] = TS[o + 2];
      C[c + 3] = TS[o + 3]; C[c + 4] = TS[o + 4]; C[c + 5] = TS[o + 5];
      C[c + 6] = TS[o + 6] * f; C[c + 7] = TS[o + 9]; C[c + 9] = fresh;
    }
    // immediate lights
    const IS = this.imS;
    for (let i = 0; i < this.imN; i++) {
      const o = i * LC, c = n++ * LC;
      for (let k = 0; k < LC; k++) C[c + k] = IS[o + k];
    }
    // clusters of bolts
    const gd = this.gDirty, gW = this.gW, gX = this.gX, gY = this.gY, gZ = this.gZ, gR = this.gR, gG = this.gG, gB = this.gB;
    const bl = tn.boltLight;
    if (bl > 0) {
      for (let i = 0; i < this.gDirtyN && n < CAND_MAX; i++) {
        const g = gd[i], w = gW[g];
        if (w <= 0) continue;
        const iw = 1 / w, c = n++ * LC;
        const r = gR[g] * iw, gg = gG[g] * iw, b = gB[g] * iw, m = Math.max(r, gg, b, 1e-3);
        const I = 0.1 * (1 - Math.exp(-w / 0.1)) * bl;
        C[c] = gX[g] * iw; C[c + 1] = gY[g] * iw + 45; C[c + 2] = gZ[g] * iw;
        C[c + 3] = r / m; C[c + 4] = gg / m; C[c + 5] = b / m;
        C[c + 6] = I; C[c + 7] = 150 + 420 * Math.sqrt(I); C[c + 9] = 0;
      }
    }
    // score = intensity x closeness to what the camera is looking at
    for (let i = 0; i < n; i++) {
      const c = i * LC, ddx = C[c] - fx, ddz = C[c + 2] - fz;
      C[c + 8] = C[c + 6] * (0.2 + 0.8 / (1 + (ddx * ddx + ddz * ddz) / fr2));
    }
    // top K by score
    const used = this.candUsed, top = this.topIdx, LD = this.lightData;
    used.fill(0, 0, n);
    let K = 0;
    const gain = tn.lightDataGain;
    for (; K < LIGHT_DATA_MAX; K++) {
      let best = -1, bs = 1e-5;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const s = C[i * LC + 8];
        if (s > bs) { bs = s; best = i; }
      }
      if (best < 0) break;
      used[best] = 1; top[K] = best;
      const c = best * LC, d = K * 8;
      LD[d] = C[c]; LD[d + 1] = C[c + 1]; LD[d + 2] = C[c + 2];
      LD[d + 3] = C[c + 3] * gain; LD[d + 4] = C[c + 4] * gain; LD[d + 5] = C[c + 5] * gain;
      LD[d + 6] = C[c + 7];
      const I = Math.sqrt(C[c + 6]);
      LD[d + 7] = I > 1 ? 1 : I;
    }
    this.lightCount = K;
    for (let d = K * 8; d < LIGHT_DATA_MAX * 8; d++) LD[d] = 0;
    // exposure budget for whatever glows from this list (fog, mist): a pile of blasts shares a fixed total,
    // so a boss finale tints the haze around it instead of washing the whole frame out
    {
      let tot = 0;
      for (let k = 0; k < K; k++) tot += LD[k * 8 + 7];
      const bud = tn.lightDataBudget ?? 1.6;
      if (tot > bud) { const f = bud / tot; for (let k = 0; k < K; k++) LD[k * 8 + 7] *= f; }
    }

    // real PointLights: keep following the same source where possible, fade instead of popping
    const L = this.lights, nL = L.length, want = K < nL ? K : nL, taken = this.topTaken;
    for (let j = 0; j < want; j++) taken[j] = -1;
    for (let s = 0; s < nL; s++) {
      const P = L[s];
      P.m = -1;
      if (!P.on) continue;
      let bj = -1, bd = 130 * 130;
      for (let j = 0; j < want; j++) {
        if (taken[j] >= 0) continue;
        const c = top[j] * LC, ax = C[c] - P.x, ay = C[c + 1] - P.y, az = C[c + 2] - P.z;
        const d2 = ax * ax + ay * ay + az * az;
        if (d2 < bd) { bd = d2; bj = j; }
      }
      if (bj >= 0) { taken[bj] = s; P.m = bj; }
    }
    for (let j = 0; j < want; j++) {
      if (taken[j] >= 0) continue;
      const c = top[j] * LC, I = C[c + 6];
      let bs = -1, bc = Infinity;
      for (let s = 0; s < nL; s++) if (L[s].m < 0 && L[s].cur < bc) { bc = L[s].cur; bs = s; }
      if (bs < 0 || (bc > 0.004 && bc > 0.3 * I)) continue; // still fading something comparable: wait
      const P = L[bs];
      P.m = j; taken[j] = bs; P.on = true;
      P.x = C[c]; P.y = C[c + 1]; P.z = C[c + 2]; P.r = C[c + 3]; P.g = C[c + 4]; P.b = C[c + 5]; P.rad = C[c + 7];
      if (bc > 0.3 * I) P.cur = 0;
    }
    const up = dt > 0 ? 1 - Math.exp(-dt / tn.lightAttack) : 0, down = dt > 0 ? 1 - Math.exp(-dt / tn.lightRelease) : 0;
    const follow = dt > 0 ? 1 - Math.exp(-dt / 0.035) : 0;
    const ref = tn.lightRef;
    for (let s = 0; s < nL; s++) {
      const P = L[s];
      if (!P.on) continue;
      if (P.m >= 0) {
        const c = top[P.m] * LC;
        P.tgt = C[c + 6];
        if (C[c + 9] > 0.5) { // a brand new flash: no easing, it is supposed to pop
          P.x = C[c]; P.y = C[c + 1]; P.z = C[c + 2]; P.r = C[c + 3]; P.g = C[c + 4]; P.b = C[c + 5]; P.rad = C[c + 7];
          if (P.cur < P.tgt) P.cur = P.tgt;
        } else {
          P.x += (C[c] - P.x) * follow; P.y += (C[c + 1] - P.y) * follow; P.z += (C[c + 2] - P.z) * follow;
          P.r += (C[c + 3] - P.r) * follow; P.g += (C[c + 4] - P.g) * follow; P.b += (C[c + 5] - P.b) * follow;
          P.rad += (C[c + 7] - P.rad) * follow;
        }
      } else P.tgt = 0;
      P.cur += (P.tgt - P.cur) * (P.tgt > P.cur ? up : down);
      if (P.tgt === 0) P.cur -= dt * 0.08; // linear tail so a released light actually reaches zero
      const lt = P.light;
      if (P.cur < 0.0015 && P.tgt === 0) {
        P.cur = 0; P.on = false; lt.intensity = 0;
        continue;
      }
      lt.position.set(P.x, P.y, P.z);
      lt.color.setRGB(P.r, P.g, P.b);
      lt.intensity = P.cur * ref;
      lt.distance = P.rad * 1.7;
    }
  }

  // Local exposure budget. Returns the gain (0..1] for a new blast of `energy` (= its scale) at (x,z), given the
  // fresh blasts already burning nearby, and records it. 16 fixed slots, the oldest is overwritten.
  _exposure(x, z, energy) {
    const S = this.exS, tn = this.tuning, now = this._clock, R2 = tn.exposureRadius * tn.exposureRadius;
    let load = 0, old = 0, oldT = Infinity;
    for (let i = 0; i < 16; i++) {
      const o = i * 4, t0 = S[o + 3];
      if (t0 < oldT) { oldT = t0; old = i; }
      const age = now - t0;
      if (age > 2 || age < 0) continue;
      const dx = S[o] - x, dz = S[o + 1] - z;
      load += S[o + 2] * Math.exp(-age / tn.exposureDecay) / (1 + (dx * dx + dz * dz) / R2);
    }
    const o = old * 4;
    S[o] = x; S[o + 1] = z; S[o + 2] = energy; S[o + 3] = now;
    return 1 / (1 + tn.exposureLoad * load);
  }

  // push one immediate light candidate (relative intensity, colour normalised to max channel 1)
  _lightNow(x, y, z, r, g, b, rel, radius) {
    if (!(rel > 0)) return;
    const S = this.imS;
    let i = this.imN;
    if (i >= IMM_LIGHTS) {
      // full: overwrite the weakest if this one is stronger
      let w = 0, wi = S[6];
      for (let k = 1; k < IMM_LIGHTS; k++) if (S[k * LC + 6] < wi) { wi = S[k * LC + 6]; w = k; }
      if (wi >= rel) return;
      i = w;
    } else this.imN = i + 1;
    const m = Math.max(r, g, b);
    if (m > 1) { const k = 1 / m; r *= k; g *= k; b *= k; }
    const o = i * LC;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = r; S[o + 4] = g; S[o + 5] = b;
    S[o + 6] = rel; S[o + 7] = radius > 0 ? radius : 150 + 420 * Math.min(1.5, Math.sqrt(rel));
    S[o + 8] = 0; S[o + 9] = 0;
  }

  // push one timed light (relative intensity). shape 0 = flash and decay, 1 = swell then flash
  _lightTimed(x, y, z, r, g, b, rel, life, radius, shape, delay) {
    if (!(rel > 0)) return false;
    const S = this.tlS;
    let i = this.tlN;
    if (i >= TIMED_LIGHTS) {
      let w = 0, wi = Infinity;
      for (let k = 0; k < TIMED_LIGHTS; k++) {
        const o = k * TL, kk = 1 - S[o + 7] / S[o + 8], v = S[o + 6] * kk * kk;
        if (v < wi) { wi = v; w = k; }
      }
      if (wi >= rel) return false;
      i = w;
    } else this.tlN = i + 1;
    const m = Math.max(r, g, b);
    if (m > 1) { const k = 1 / m; r *= k; g *= k; b *= k; }
    const o = i * TL;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = r; S[o + 4] = g; S[o + 5] = b;
    S[o + 6] = rel; S[o + 7] = -(delay || 0); S[o + 8] = Math.max(0.02, life);
    S[o + 9] = radius > 0 ? radius : 150 + 420 * Math.min(1.5, Math.sqrt(rel));
    S[o + 10] = shape || 0; S[o + 11] = 0;
    return true;
  }

  /**
   * Timed light (flash that decays over lifeMs). `intensity` is in candela like a THREE.PointLight
   * (FX_TUNING.lightRef = 3e4 is a scale-1 explosion). HDR colours are folded into the intensity.
   * Returns false only when the timed list is full of stronger lights.
   */
  light(x, y, z, color, intensity, lifeMs = 300, steal = true) {
    const c = this._col(color, this.palette.explosionLight);
    const m = Math.max(c[0], c[1], c[2], 1);
    if (!steal && this.tlN >= TIMED_LIGHTS) return false;
    return this._lightTimed(x, y, z, c[0], c[1], c[2], (intensity * m) / this.tuning.lightRef, lifeMs / 1000, 0, 0, 0);
  }

  /**
   * Immediate-mode light for THIS frame only (muzzle glow, bolts near ships, beams, afterburners...).
   * `intensity` is relative: 1 = a scale-1 explosion flash, 0.1 = a muzzle flash, 0.03 = one bolt.
   * `radius` (world units, optional) is where the light has faded out; derived from intensity by default.
   * Colour only gives the hue: it is normalised to max channel 1.
   */
  lightNow(x, y, z, color, intensity = 0.1, radius) {
    const c = this._col(color, this.palette.explosionLight);
    this._lightNow(x, y, z, c[0], c[1], c[2], intensity, radius || 0);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  clear() {
    this.smoke.clear();
    this.fire.clear();
    this.sparkN = 0; this.arcN = 0; this.tracerN = 0; this.tracerBase = 0;
    this._syncStreaks();
    for (let s = 0; s < this.shrap.length; s++) {
      const P = this.shrap[s];
      P.n = 0; P.cursor = 0; P.mesh.count = 0; P.mesh.visible = false;
    }
    this.ringN = 0;
    this.ringMesh.geometry.instanceCount = 0; this.ringMesh.visible = false;
    this.boltN = 0; this.boltGeo.instanceCount = 0; this.boltMesh.visible = false;
    this.beamN = 0; this.plumeN = 0; this.beamGeo.instanceCount = 0; this.beamMesh.visible = false;
    this.glowN = 0; this.glowGeo.instanceCount = 0; this.glowMesh.visible = false;
    this.tlN = 0; this.imN = 0; this.lightCount = 0;
    this.exS.fill(-1e3); this.shN = 0; this.rkS.fill(-1e3);
    this.lightData.fill(0);
    for (let i = 0; i < this.gDirtyN; i++) this.gW[this.gDirty[i]] = 0;
    this.gDirtyN = 0;
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      L.on = false; L.cur = 0; L.tgt = 0; L.light.intensity = 0;
    }
  }

  dispose() {
    const sc = this.scene;
    sc.remove(this.smoke.points, this.fire.points, this.streakMesh, this.ringMesh, this.beamMesh, this.glowMesh, this.boltMesh);
    this.smoke.geo.dispose(); this.fire.geo.dispose();
    this.streakGeo.dispose(); this.ringMesh.geometry.dispose();
    this.beamGeo.dispose(); this.glowGeo.dispose(); this.boltGeo.dispose();
    this.smokeMat.dispose(); this.fireMat.dispose(); this.streakMat.dispose(); this.ringMat.dispose();
    this.beamMat.dispose(); this.glowMat.dispose(); this.boltMat.dispose();
    for (let s = 0; s < this.shrap.length; s++) {
      const P = this.shrap[s];
      sc.remove(P.mesh);
      P.geo.dispose();
      P.mesh.dispose();
    }
    this.shrapMat.dispose();
    for (let i = 0; i < this.lights.length; i++) { sc.remove(this.lights[i].light); this.lights[i].light.dispose(); }
    this.atlas.dispose();
    this.noise.dispose();
  }

  /* --------------------------- low-level spawners ------------------------ */

  _spark(x, y, z, vx, vy, vz, life, width, r, g, b, drag, grav, stretch, flick, cool, core) {
    let i;
    if (this.sparkN < this.sparkCap) i = this.sparkN++;
    else { i = this.sparkCursor; this.sparkCursor = (this.sparkCursor + 1) % this.sparkCap; }
    const S = this.sparkS, o = i * SP;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
    S[o + 6] = 0; S[o + 7] = life > 0.005 ? life : 0.005; S[o + 8] = width;
    S[o + 9] = r; S[o + 10] = g; S[o + 11] = b;
    S[o + 12] = drag; S[o + 13] = grav; S[o + 14] = stretch; S[o + 15] = flick; S[o + 16] = cool; S[o + 17] = core;
    return o;
  }

  // ring in the plane with normal (nx,ny,nz). style 0 = crisp, 1 = soft distortion. mode 1 = collapse r0 -> maxR
  _ring(x, y, z, maxR, life, r, g, b, style, thick, nx, ny, nz, mode, r0, gain, delay) {
    let i;
    if (this.ringN < this.ringCap) i = this.ringN++;
    else i = 0; // steal the first (they are short-lived)
    const S = this.ringS, o = i * RG;
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = maxR; S[o + 4] = -(delay || 0); S[o + 5] = Math.max(0.03, life);
    S[o + 6] = r; S[o + 7] = g; S[o + 8] = b; S[o + 9] = style || 0;
    S[o + 10] = nx || 0; S[o + 11] = nx || nz ? (ny || 0) : (ny ?? 1); S[o + 12] = nz || 0;
    if (S[o + 10] === 0 && S[o + 11] === 0 && S[o + 12] === 0) S[o + 11] = 1;
    S[o + 13] = thick; S[o + 14] = rnd() * 10; S[o + 15] = mode || 0; S[o + 16] = r0 || 0; S[o + 17] = gain ?? 1;
    this.ringMesh.visible = true;
  }

  _glow(x, y, z, half, r, g, b, inten, kind, seed, rot, aux) {
    const i = this.glowN;
    if (i >= this.glowCap || !(inten > 0)) return;
    const m = i * 4, P = this.glPos, C = this.glCol, A = this.glPar;
    P[m] = x; P[m + 1] = y; P[m + 2] = z; P[m + 3] = half;
    C[m] = r; C[m + 1] = g; C[m + 2] = b; C[m + 3] = inten;
    A[m] = kind; A[m + 1] = seed; A[m + 2] = rot; A[m + 3] = aux;
    const n = this.glowN = i + 1, rg = this.rGl;
    touch(this.aGlPos, rg[0], n * 4); touch(this.aGlCol, rg[1], n * 4); touch(this.aGlPar, rg[2], n * 4);
    this.glowGeo.instanceCount = n;
    this.glowMesh.visible = true;
  }

  _beam(x0, y0, z0, x1, y1, z1, hw, kind, r, g, b, a, seed, flag, p2) {
    const i = this.beamN;
    if (i >= this.beamCap) return false;
    const m = i * 4, A = this.bmA, B = this.bmB, C = this.bmCol, P = this.bmPar;
    A[m] = x0; A[m + 1] = y0; A[m + 2] = z0; A[m + 3] = hw;
    B[m] = x1; B[m + 1] = y1; B[m + 2] = z1; B[m + 3] = kind;
    C[m] = r; C[m + 1] = g; C[m + 2] = b; C[m + 3] = a;
    P[m] = seed; P[m + 1] = flag; P[m + 2] = p2; P[m + 3] = 0;
    const n = this.beamN = i + 1, rg = this.rBm;
    touch(this.aBmA, rg[0], n * 4); touch(this.aBmB, rg[1], n * 4); touch(this.aBmCol, rg[2], n * 4); touch(this.aBmPar, rg[3], n * 4);
    this.beamGeo.instanceCount = n;
    this.beamMesh.visible = true;
    return true;
  }

  /* ------------------------------ one-shots ------------------------------ */

  /**
   * Multi-stage explosion. opts: tint [r,g,b] (multiplies the fire ramp, e.g. blue plasma),
   * smoke (0..1+ amount), sparks (amount), shrapnel (count | false), shockwave (false to skip),
   * light (false to skip), lightColor, debrisColor, vx/vz (inherited drift, units/s).
   */
  explosion(x, y, z, scale = 1, opts) {
    const o = opts || EMPTY, pal = this.palette, tn = this.tuning;
    const s = Math.max(0.2, scale);
    const sz = Math.pow(s, 0.8);             // sizes grow slower than counts (fill-rate)
    const ls = 0.75 + 0.25 * s;              // lifetimes stretch a little with scale
    const tint = o.tint || WHITE;
    const ivx = o.vx || 0, ivz = o.vz || 0;
    const F = this.fire, K = this.smoke;

    // local exposure budget: a blast on top of other fresh blasts (boss death chain) or a very big one
    // gets a dimmer flash / light / ring, so the pile keeps colour and form instead of washing out to white
    const ex = this._exposure(x, z, s);
    const fk = ex / (1 + tn.exposureScale * Math.max(0, s - 1));
    const occ = tn.fireOcclusion;

    // 1. flash with structure: a tight hot core that is a spiky radial burst from its very first frame,
    //    a hairline star and a brief anamorphic streak. All of it is gone within ~120 ms.
    // (a tinted blast, e.g. blue plasma, starts from a neutral flash so the tint decides the hue)
    const fl = o.tint ? FLASH_NEUTRAL : pal.explosionFlash, fs = pal.explosionStreak, ft = o.tint ? FLASH_NEUTRAL : pal.explosionTongue;
    let i = F.spawn(x, y + 2, z, 0, 0, 0, 0.07 * ls, 14 * sz, 38 * sz, R_FLASH, fl[0] * fk * tint[0], fl[1] * fk * tint[1], fl[2] * fk * tint[2], C_DOT);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.11 * ls, 70 * sz, 215 * sz, R_FLASH, ft[0] * 0.8 * fk * tint[0], ft[1] * 0.8 * fk * tint[1], ft[2] * 0.8 * fk * tint[2], C_BURST);
    F.spin[i] = rr(-1.2, 1.2);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.16 * ls, 95 * sz, 300 * sz, R_FLASH, ft[0] * 0.55 * fk * tint[0], ft[1] * 0.5 * fk * tint[1], ft[2] * 0.42 * fk * tint[2], C_BURST + 1);
    F.spin[i] = rr(-0.8, 0.8);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.12 * ls, 110 * sz, 270 * sz, R_FLASH, fl[0] * 0.5 * fk * tint[0], fl[1] * 0.5 * fk * tint[1], fl[2] * 0.5 * fk * tint[2], C_FLARE);
    F.spin[i] = rr(-0.8, 0.8);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.11 * ls, 230 * sz, 470 * sz, R_FLASH, fs[0] * 0.8 * fk * tint[0], fs[1] * 0.8 * fk * tint[1], fs[2] * 0.8 * fk * tint[2], C_STREAK);
    F.rot(i, 0);

    // 2. the core breaks into tongues of flame shooting outward
    let n = Math.max(4, this._n(12 * s));
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = rr(280, 680) * sz, s1 = rr(30, 60) * sz;
      i = F.spawn(x + DX * 6 * sz, y + DY * 4 * sz + 3, z + DZ * 6 * sz, DX * sp + ivx, DY * sp * 0.6 + 20, DZ * sp + ivz,
        rr(0.2, 0.42) * ls, s1 * 0.55, s1, R_FIRE, tint[0], tint[1], tint[2], C_LICK0 + (k & 1));
      F.drag[i] = 5.5; F.aux[i] = rr(1.4, 2.8); F.turb[i] = 60 * sz; F.occ(i, occ * 0.85);
    }

    // 3. fireball: turbulent, rolling, slightly flattened, biased upward. Bodies shadow each other,
    //    the later (outer, cooler) ones partly hiding the hot ones underneath.
    n = Math.max(4, this._n(11 * s));
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = rr(35, 190) * sz, off = rr(0, 12) * sz;
      const s1 = rr(64, 112) * sz;
      i = F.spawn(x + DX * off, y + DY * off * 0.6 + 3, z + DZ * off,
        DX * sp + ivx, DY * sp * 0.7 + 18 * sz, DZ * sp + ivz,
        rr(0.5, 1.05) * ls, s1 * 0.3, s1, R_FIRE, tint[0], tint[1], tint[2], flameCell());
      F.drag[i] = 3.4; F.turb[i] = 130 * sz; F.spin[i] = rr(-1.3, 1.3);
      F.wx[i] = tn.worldDriftX * 0.4; F.wy[i] = 22; F.occ(i, occ);
    }
    // hollow shell: gives the fireball a ragged bright rim as it opens up
    i = F.spawn(x, y + 3, z, ivx, 14, ivz, 0.5 * ls, 50 * sz, 190 * sz, R_FIRE, tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7, C_HOLLOW);
    F.spin[i] = rr(-0.6, 0.6); F.wx[i] = tn.worldDriftX * 0.4; F.occ(i, occ * 0.3);
    // big ones: a few delayed secondary pops
    if (s >= 1.5) {
      n = this._n(2 + s);
      for (let k = 0; k < n; k++) {
        randSphere();
        const off = rr(34, 84) * sz, d = rr(0.07, 0.34), s1 = rr(46, 80) * sz;
        const px = x + DX * off, py = y + Math.abs(DY) * off * 0.4 + 3, pz = z + DZ * off;
        for (let j = 0; j < 3; j++) {
          i = F.spawn(px + rr(-8, 8), py + rr(-4, 6), pz + rr(-8, 8), rr(-50, 50) + ivx, rr(0, 50), rr(-50, 50) + ivz,
            rr(0.34, 0.6) * ls, s1 * 0.35, s1, R_FIRE, tint[0], tint[1], tint[2], flameCell());
          F.drag[i] = 3; F.turb[i] = 90; F.spin[i] = rr(-1.5, 1.5); F.occ(i, occ);
          F.delay(i, d);
        }
        i = F.spawn(px, py, pz, 0, 0, 0, 0.07, 14 * sz, 30 * sz, R_FLASH, fl[0] * fk * tint[0], fl[1] * fk * tint[1], fl[2] * fk * tint[2], C_DOT);
        F.delay(i, d);
        i = F.spawn(px, py, pz, 0, 0, 0, 0.1, 40 * sz, 110 * sz, R_FLASH, ft[0] * 0.8 * fk * tint[0], ft[1] * 0.8 * fk * tint[1], ft[2] * 0.8 * fk * tint[2], C_BURST + (k & 1));
        F.delay(i, d); F.spin[i] = rr(-2, 2);
        const mc = pal.microSpark, m2 = this._n(12);
        for (let j = 0; j < m2; j++) {
          randSphere();
          const sp = rr(120, 720);
          const so = this._spark(px, py, pz, DX * sp + ivx, DY * sp * 0.7 + 20, DZ * sp + ivz, rr(0.12, 0.5), rr(0.9, 1.9),
            mc[0] * tint[0], mc[1] * tint[1], mc[2] * tint[2], 3.6, 140, 0.03, 0, 1, 1.4);
          this.sparkS[so + 6] = -d;
        }
        this._lightTimed(px, py + 40, pz, fl[0], fl[1], fl[2], 0.1 * s * fk, 0.16, 0, 0, d);
      }
    }

    // 3b. flamelets: many small tongues thrown further than the fireball, so the edge is lace, not a blob
    n = this._n(12 * s);
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = rr(180, 520) * sz, s1 = rr(12, 30) * sz;
      i = F.spawn(x + DX * 8 * sz, y + DY * 5 * sz + 3, z + DZ * 8 * sz, DX * sp + ivx, DY * sp * 0.6 + 24, DZ * sp + ivz,
        rr(0.22, 0.6) * ls, s1, s1 * 0.45, R_FIRE, tint[0], tint[1], tint[2], k & 1 ? C_LICK0 + ((k >> 1) & 1) : flameCell());
      F.drag[i] = 4.2; F.turb[i] = 110 * sz; F.spin[i] = rr(-3, 3); F.aux[i] = k & 1 ? rr(0.6, 1.4) : 0; F.occ(i, occ * 0.6);
    }

    // 4. smoke: fewer, smaller rolling puffs than a blob would need + thin curling wisps around them
    const sm = o.smoke ?? 1;
    if (sm > 0) {
      const g = pal.smokeGrey;
      n = this._n(6 * s * sm);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(20, 85) * sz, off = rr(4, 22) * sz;
        const s1 = rr(70, 125) * sz, sh = rr(0.75, 1.25);
        i = K.spawn(x + DX * off, y + Math.abs(DY) * off * 0.7 + 4, z + DZ * off,
          DX * sp + ivx, Math.abs(DY) * sp * 0.6 + 10, DZ * sp + ivz,
          rr(1.1, 2.1) * ls, s1 * 0.3, s1, R_SMOKE, g[0] * sh, g[1] * sh, g[2] * sh, C_SMOKE0 + ((rnd() * 4) | 0));
        K.drag[i] = 1.7; K.turb[i] = 55; K.spin[i] = rr(-0.9, 0.9);
        K.wx[i] = tn.worldDriftX; K.wy[i] = tn.smokeRise * rr(0.7, 1.5);
        K.aux[i] = rr(0.7, 1.2); K.ta[i] = 0.85;
        K.delay(i, rr(0.03, 0.22));
      }
      n = this._n(11 * s * sm);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(60, 300) * sz, off = rr(6, 26) * sz;
        const s1 = rr(34, 84) * sz, sh = rr(0.8, 1.5);
        i = K.spawn(x + DX * off, y + Math.abs(DY) * off * 0.6 + 4, z + DZ * off,
          DX * sp + ivx, Math.abs(DY) * sp * 0.5 + 8, DZ * sp + ivz,
          rr(0.9, 2.4) * ls, s1 * 0.4, s1, R_SMOKE, g[0] * sh, g[1] * sh, g[2] * sh, wispCell());
        K.drag[i] = 2.6; K.turb[i] = 80; K.spin[i] = rr(-1.5, 1.5);
        K.wx[i] = tn.worldDriftX; K.wy[i] = tn.smokeRise * rr(0.5, 1.3);
        K.aux[i] = rr(0.5, 1.1); K.ta[i] = 0.7;
        K.delay(i, rr(0.02, 0.3));
      }
      // brief expanding haze of fine dust
      const hz = pal.haze;
      for (let k = 0; k < 2; k++) {
        i = K.spawn(x + rr(-8, 8) * sz, y + 3, z + rr(-8, 8) * sz, ivx, 6, ivz, rr(0.55, 0.9) * ls, 50 * sz, rr(190, 250) * sz,
          R_DUST, hz[0], hz[1], hz[2], C_SMOKE0 + ((rnd() * 4) | 0));
        K.spin[i] = rr(-0.5, 0.5); K.wx[i] = tn.worldDriftX * 0.5; K.ta[i] = 0.3 * Math.min(1, sm);
      }
    }

    // 5. small bright things, in layers of speed and lifetime
    const sa = o.sparks ?? 1;
    if (sa > 0) {
      const c = pal.spark, e = pal.ember, mc = pal.microSpark, vs = 0.7 + 0.3 * s, w = Math.pow(s, 0.4);
      const cr = c[0] * tint[0], cg = c[1] * tint[1], cb = c[2] * tint[2];
      // fast streaks
      n = this._n(22 * s * sa);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(260, 900) * vs;
        this._spark(x, y, z, DX * sp + ivx, DY * sp * 0.65 + 40, DZ * sp + ivz,
          rr(0.35, 0.95), rr(1.5, 3.1) * w, cr, cg, cb, 2.3, 230, 0.05, 0, 1, 1.2);
      }
      // micro-sparks: a dense, very fast, very short-lived spray
      n = this._n(46 * s * sa);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(140, 1250) * vs;
        this._spark(x + DX * 5, y + DY * 4, z + DZ * 5, DX * sp + ivx, DY * sp * 0.7 + 30, DZ * sp + ivz,
          rr(0.09, 0.38), rr(0.8, 1.5) * w, mc[0] * tint[0], mc[1] * tint[1], mc[2] * tint[2], 4.5, 120, 0.028, 0, 1, 1.5);
      }
      // shock front: an even ring of very fast, very short sparks racing out along the play plane
      n = this._n(26 * s * sa);
      for (let k = 0; k < n; k++) {
        const a = rnd() * TAU, ca = Math.cos(a), sa2 = Math.sin(a), sp = rr(560, 700) * vs, r0 = rr(10, 20) * sz;
        this._spark(x + ca * r0, y + 2, z + sa2 * r0, ca * sp + ivx, rr(-0.06, 0.1) * sp, sa2 * sp + ivz,
          rr(0.14, 0.26), rr(1.0, 1.7) * w, mc[0] * tint[0], mc[1] * tint[1], mc[2] * tint[2], 1.4, 0, 0.032, 0, 1, 1.4);
      }
      // embers: slow, flickering, the last things to go out
      n = this._n(16 * s * sa);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(40, 280) * vs;
        this._spark(x + DX * 8, y + DY * 6, z + DZ * 8, DX * sp + ivx + tn.worldDriftX * 0.3, DY * sp * 0.7 + 30, DZ * sp + ivz,
          rr(0.9, 2.6), rr(1.6, 3.4) * w, e[0], e[1], e[2], 1.2, 38, 0.012, 1 + rnd() * 5, 1, 0.8);
      }
      // dust motes: dim specks carried by the blast, lit by it
      const dm = pal.dustMote;
      n = this._n(20 * s * sa);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(50, 380) * vs;
        this._spark(x + DX * 10, y + DY * 6, z + DZ * 10, DX * sp + ivx, DY * sp * 0.6 + 14, DZ * sp + ivz,
          rr(0.5, 1.7), rr(1.0, 2.0) * w, dm[0], dm[1], dm[2], 3.2, 8, 0.004, 0, 0, 0.35);
      }
    }

    // 6. debris: glinting flecks, small dark hull bits, paint chips, a few big burning chunks that trail smoke
    if (o.shrapnel !== false && o.shrapnel !== 0) {
      const dk = typeof o.shrapnel === 'number' ? o.shrapnel / (7 * s) : 1;
      const vs = 0.7 + 0.3 * s, w = Math.pow(s, 0.4), fc = pal.fleck, hull = pal.hull;
      n = this._n(18 * s * dk);
      for (let k = 0; k < n; k++) {
        randSphere();
        const sp = rr(60, 460) * vs;
        this._spark(x + DX * 6, y + DY * 5, z + DZ * 6, DX * sp + ivx, DY * sp * 0.7 + 26, DZ * sp + ivz,
          rr(0.7, 2.3), rr(1.1, 2.2) * w, fc[0], fc[1], fc[2], 1.7, 34, 0.005, -(1 + rnd() * 5), 0, 1.5);
      }
      const dc = o.debrisColor != null ? this._col(o.debrisColor, hull) : null;
      const d0 = dc ? dc[0] : 0, d1 = dc ? dc[1] : 0, d2 = dc ? dc[2] : 0;
      const sq = Math.sqrt(s);
      // bits
      this._chunks(x, y, z, 15 * s * dk, 330 * vs, 0.9, 2.3, 1.5, hull[0], hull[1], hull[2], 0.3, 0.3, 0, -1, ivx, ivz, 0);
      // mid pieces
      this._chunks(x, y, z, 5 * s * dk, 250 * vs, 2.4 * sq, 4.6 * sq, 1.5, hull[0] * 1.6, hull[1] * 1.6, hull[2] * 1.6, 0.5, 0.35, 0, -1, ivx, ivz, 0);
      // paint chips: plates and slivers in the hull's colour
      if (dc) this._chunks(x, y, z, 7 * s * dk, 290 * vs, 1.2, 3.2 * sq, 1.7, d0, d1, d2, 0.1, 0.7, 0, rnd() < 0.5 ? 2 : 4, ivx, ivz, 0);
      // big burning chunks, each trailing a thread of smoke and fire
      this._chunks(x, y, z, Math.min(7, 1.6 + 1.3 * s) * dk, 300 * vs, 3.4 * sq, 6.2 * sq, 1.9,
        hull[0] * 1.3, hull[1] * 1.3, hull[2] * 1.3, 1, 0.25, 1, -1, ivx, ivz, 0);
      // big ones keep shedding: a second, delayed handful of bits from the secondary pops
      if (s >= 1.5) this._chunks(x, y, z, 6 * s * dk, 240 * vs, 1.0, 3.0, 1.4, hull[0], hull[1], hull[2], 0.6, 0.3, 0, -1, ivx, ivz, 0.22);
    }

    // 7. shockwave: thin fast energy ring + a faint wide distortion front just behind it
    if (o.shockwave !== false) {
      const c = pal.shockwave, c2 = pal.shockwaveSoft;
      // (inside a pile of fresh blasts the rings would only add clutter: the thin one dims, the soft one is dropped)
      this._ring(x, y + 1, z, 210 * sz, 0.34 * ls, c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], 0, 2.4 * Math.sqrt(s), 0, 1, 0, 0, 12 * sz, ex * ex, 0);
      if (ex > 0.7) this._ring(x, y + 1, z, 175 * sz, 0.5 * ls, c2[0], c2[1], c2[2], 1, 9 * sz, 0, 1, 0, 0, 6 * sz, 1, 0.02);
    }

    // 8. dynamic light: hard flash, then the fireball's glow
    if (o.light !== false) {
      const c = this._col(o.lightColor, pal.explosionLight);
      // (the lamp sits well above the blast: a hull or rock right next to it is lit, not bleached)
      this._lightTimed(x, y + tn.lightHeight * (1 + 0.8 * sz), z, c[0], c[1], c[2], (tn.explosionLightPeak * Math.pow(s, 1.5) * ex * 0.6) / tn.lightRef,
        (420 + 130 * s) / 1000, 320 + 100 * s, 0, 0);
    }
  }

  /**
   * Bullet hits armour. (dirX,dirZ) = direction the sparks fly (away from the surface).
   * opts: color, count, scale, light (false to skip), chips (count of tiny hot chips, default 2; 0 = none), flash (false to skip)
   */
  impact(x, y, z, dirX, dirZ, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.impact);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const sc = o.scale ?? 1;
    const cool = c0 >= c2 ? 1 : 0;
    const cnt = o.count ?? 7;
    // main fan
    let n = this._n(cnt);
    for (let k = 0; k < n; k++) {
      randCone(dirX, dirZ, 0.8, 0.7);
      const sp = rr(170, 560) * sc;
      this._spark(x, y, z, DX * sp, DY * sp + 25, DZ * sp, rr(0.14, 0.4), rr(1.3, 2.4) * sc,
        c0, c1, c2, 3.2, 200, 0.04, 0, cool, 1.1);
    }
    // micro-sparks: tighter along the normal and faster, plus a few that skitter sideways
    n = this._n(cnt * 1.8);
    for (let k = 0; k < n; k++) {
      randCone(dirX, dirZ, k & 3 ? 0.5 : 1.45, 0.8);
      const sp = rr(260, 980) * sc;
      this._spark(x, y, z, DX * sp, DY * sp + 20, DZ * sp, rr(0.06, 0.22), rr(0.7, 1.3) * sc,
        c0 * 1.15, c1 * 1.15, c2 * 1.15, 5, 120, 0.024, 0, cool, 1.5);
    }
    const ch = o.chips ?? 2;
    if (ch > 0) this._chips(x, y, z, dirX, dirZ, ch, 210 * sc, sc);
    if (o.flash !== false) this._hitFlash(x, y, z, dirX, dirZ, c0, c1, c2, sc);
    if (o.light !== false) this._lightTimed(x, y + 36, z, c0, c1, c2, 0.05 * sc * sc, 0.09, 0, 0, 0);
  }

  // 1-2 frame flash where a round lands: pin-point core, hairline star, a lick along the normal
  _hitFlash(x, y, z, dirX, dirZ, c0, c1, c2, sc) {
    const F = this.fire;
    let i = F.spawn(x, y + 1, z, 0, 0, 0, 0.045, 9 * sc, 22 * sc, R_FLASH, c0 * 0.9, c1 * 0.9, c2 * 0.9, C_DOT);
    i = F.spawn(x, y + 1, z, 0, 0, 0, 0.07, 34 * sc, 80 * sc, R_FLASH, c0 * 0.5, c1 * 0.5, c2 * 0.5, C_SPARKLE);
    F.spin[i] = rr(-2, 2);
    const l = Math.hypot(dirX, dirZ);
    if (l > 1e-5) {
      const dx = dirX / l, dz = dirZ / l;
      i = F.spawn(x + dx * 5 * sc, y + 1, z + dz * 5 * sc, dx * 260 * sc, 0, dz * 260 * sc, 0.06, 15 * sc, 8 * sc, R_FLASH, c0 * 0.7, c1 * 0.7, c2 * 0.7, C_LICK0 + (rnd() < 0.5 ? 1 : 0));
      F.drag[i] = 7; F.aux[i] = 1.3;
    }
  }

  // a few tiny hot chips knocked off the armour
  _chips(x, y, z, dirX, dirZ, count, speed, sc) {
    const hull = this.palette.hull;
    const n = this._n(count);
    for (let k = 0; k < n; k++) {
      randCone(dirX, dirZ, 1.1, 0.8);
      const sp = speed * rr(0.35, 1.1), size = rr(0.8, 1.8) * sc;
      this._chunk(x, y, z, DX * sp, DY * sp * 0.8 + 24, DZ * sp, rr(0.45, 0.95), size, hull[0] * 1.5, hull[1] * 1.5, hull[2] * 1.5,
        rnd() < 0.7 ? rr(1.2, 2.6) : 0, rnd() < 0.4 ? 1 : 0, 0, -1, 1.2, 60, 0);
    }
  }

  /**
   * Generic spark spray. Zero direction = omnidirectional.
   * opts: spread (rad), speed, color, life (ms), width, gravity, drag, embers (0..1 fraction), light (false to skip),
   *       micro (fine sparks per main spark, default 1.5; 0 = none), chips (chance per call of a tiny hot chip, default 0.3),
   *       flash (false = no pin-point hit flash; by default small directional sprays get one)
   */
  sparks(x, y, z, count, dirX, dirZ, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.spark);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const spread = o.spread ?? 0.7, speed = o.speed ?? 420;
    const life = (o.life ?? 450) / 1000, width = o.width ?? 2.2;
    const grav = o.gravity ?? 220, drag = o.drag ?? 2.4, emb = o.embers ?? 0.15;
    const cool = c0 >= c2 ? 1 : 0;
    const cnt = count ?? 8;
    let n = this._n(cnt);
    for (let k = 0; k < n; k++) {
      randCone(dirX || 0, dirZ || 0, spread, 0.7);
      if (rnd() < emb) {
        const sp = speed * rr(0.12, 0.45);
        this._spark(x, y, z, DX * sp, DY * sp + 20, DZ * sp, life * rr(1.6, 3.2), width * rr(1.0, 1.6),
          c0 * 0.7, c1 * 0.5, c2 * 0.4, drag * 0.5, grav * 0.25, 0.012, 1 + rnd() * 5, cool, 0.8);
      } else {
        const sp = speed * rr(0.4, 1.25);
        this._spark(x, y, z, DX * sp, DY * sp + 25, DZ * sp, life * rr(0.6, 1.4), width * rr(0.7, 1.3),
          c0, c1, c2, drag, grav, 0.045, 0, cool, 1.1);
      }
    }
    // fine spray riding along: faster, thinner, shorter-lived, a little wider
    const micro = o.micro ?? 1.5;
    n = micro > 0 ? this._n(cnt * micro) : 0;
    for (let k = 0; k < n; k++) {
      randCone(dirX || 0, dirZ || 0, spread * 1.35, 0.8);
      const sp = speed * rr(0.5, 2.0);
      this._spark(x, y, z, DX * sp, DY * sp + 18, DZ * sp, life * rr(0.2, 0.6), width * rr(0.3, 0.55),
        c0 * 1.1, c1 * 1.1, c2 * 1.1, drag * 1.8, grav * 0.5, 0.026, 0, cool, 1.5);
    }
    const directed = (dirX || 0) !== 0 || (dirZ || 0) !== 0;
    const chips = o.chips ?? 0.3;
    if (chips > 0 && rnd() < chips * Math.min(3, cnt * 0.5)) this._chips(x, y, z, dirX || 0, dirZ || 0, 1, speed * 0.5, 1);
    if (o.flash !== false && directed && cnt <= 6 && rnd() < 0.5) this._hitFlash(x, y, z, 0, 0, c0, c1, c2, 0.55 + 0.1 * cnt);
    // a big burst lights its surroundings for a moment
    if (cnt >= 8 && o.light !== false) this._lightTimed(x, y + 40, z, c0, c1, c2, Math.min(0.2, cnt * 0.006), life * 0.5, 0, 0, 0);
  }

  /** Muzzle flash. opts: color ('player' | 'enemy' | [r,g,b]), scale, light (false to skip), sparks (count) */
  muzzle(x, y, z, dirX, dirZ, opts) {
    const o = opts || EMPTY, pal = this.palette;
    const c = this._col(o.color, pal.muzzlePlayer);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const sc = o.scale ?? 1;
    let l = Math.hypot(dirX, dirZ);
    if (l < 1e-5) { dirX = 1; dirZ = 0; l = 1; }
    const dx = dirX / l, dz = dirZ / l;
    const F = this.fire;
    // forward tongue of flame + two side licks (the classic muzzle star)
    let i = F.spawn(x + dx * 10 * sc, y, z + dz * 10 * sc, dx * 300 * sc, 0, dz * 300 * sc, rr(0.05, 0.075), 30 * sc, 20 * sc, R_FLASH, c0 * 0.9, c1 * 0.9, c2 * 0.9, C_LICK0);
    F.drag[i] = 6; F.aux[i] = 1.4;
    for (let k = -1; k <= 1; k += 2) {
      const ax = dx * 0.45 - dz * k * 0.9, az = dz * 0.45 + dx * k * 0.9;
      i = F.spawn(x + ax * 5 * sc, y, z + az * 5 * sc, ax * 190 * sc, 0, az * 190 * sc, rr(0.04, 0.06), 18 * sc, 12 * sc, R_FLASH, c0 * 0.7, c1 * 0.7, c2 * 0.7, C_LICK0 + 1);
      F.drag[i] = 8; F.aux[i] = 0.8;
    }
    // hot dot + thin star at the muzzle
    F.spawn(x, y, z, 0, 0, 0, 0.05, 14 * sc, 22 * sc, R_FLASH, c0 * 0.8, c1 * 0.8, c2 * 0.8, C_DOT);
    i = F.spawn(x, y, z, 0, 0, 0, 0.06, 60 * sc, 110 * sc, R_FLASH, c0 * 0.5, c1 * 0.5, c2 * 0.5, C_SPARKLE);
    // a couple of sparks
    const n = this._n(o.sparks ?? 2);
    const cool = c0 >= c2 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      randCone(dx, dz, 0.38, 0.6);
      const sp = rr(420, 900) * (0.6 + 0.4 * sc);
      this._spark(x, y, z, DX * sp, DY * sp, DZ * sp, rr(0.1, 0.24), rr(1.4, 2.2) * sc, c0, c1, c2, 3.5, 120, 0.035, 0, cool, 1);
    }
    if (o.light !== false) {
      const tn = this.tuning;
      this._lightTimed(x + dx * 12, y + tn.lightHeight * 0.5, z + dz * 12, c0, c1, c2, (tn.muzzleLightPeak * sc * sc) / tn.lightRef, 0.08, 0, 0, 0);
    }
  }

  // one debris piece. shape < 0 = random (small pieces favour slivers/shards/bolts, large ones plates/chunks/struts)
  _chunk(x, y, z, vx, vy, vz, life, size, r, g, b, heat, glint, trail, shape, drag, grav, delay) {
    const P = this.shrap[0];
    let i;
    if (P.n < P.cap) i = P.n++;
    else { i = P.cursor; P.cursor = (P.cursor + 1) % P.cap; }
    const S = P.S, o = i * SH;
    if (shape < 0) {
      const u = rnd();
      shape = size < 2.2 ? (u < 0.34 ? 4 : u < 0.62 ? 0 : u < 0.8 ? 5 : u < 0.92 ? 2 : 1) : (u < 0.3 ? 2 : u < 0.52 ? 1 : u < 0.72 ? 3 : u < 0.88 ? 0 : 4);
    }
    S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = vx; S[o + 4] = vy; S[o + 5] = vz;
    S[o + 6] = -(delay || 0); S[o + 7] = life;
    randSphere();
    S[o + 8] = DX; S[o + 9] = DY; S[o + 10] = DZ;
    // small pieces spin fast, big ones lumber
    S[o + 11] = rnd() * TAU; S[o + 12] = rr(5, 20) / (0.6 + size * 0.22) * (rnd() < 0.5 ? -1 : 1);
    S[o + 13] = size * rr(0.75, 1.3); S[o + 14] = size * rr(0.55, 1.15); S[o + 15] = size * rr(0.75, 1.3);
    const sh = rr(0.6, 1.3);
    S[o + 16] = r * sh; S[o + 17] = g * sh; S[o + 18] = b * sh;
    S[o + 19] = heat; S[o + 20] = drag; S[o + 21] = grav; S[o + 22] = rr(2.5, 7) / (0.5 + size * 0.2); // big pieces stay hot longer
    S[o + 23] = shape; S[o + 24] = trail; S[o + 25] = 0; S[o + 26] = glint; S[o + 27] = size;
    P.mesh.visible = true;
  }

  // a population of pieces thrown out from a point; sizes are skewed towards the small end
  _chunks(x, y, z, count, speed, size0, size1, life, r, g, b, hot, glint, trail, shape, ivx, ivz, delay) {
    const n = trail ? Math.round(count * Math.min(1, this.quality)) : this._n(count);
    for (let k = 0; k < n; k++) {
      randSphere();
      const u = rnd(), size = size0 + (size1 - size0) * u * u;
      const sp = speed * rr(0.3, 1.0) * (trail ? 1 : 1.25 - 0.5 * u);
      const dx = DX, dy = DY, dz = DZ;
      this._chunk(x + dx * size * 2, y + dy * size * 2, z + dz * size * 2, dx * sp + ivx, dy * sp * 0.75 + 20, dz * sp + ivz,
        life * rr(0.6, 1.4), size, r, g, b,
        rnd() < hot ? rr(0.7, 1.9) * (trail ? 1.5 : 1) : 0, rnd() < glint ? rr(0.4, 1) : 0, trail, shape, 0.9, 45, delay ? delay * rr(0.5, 1.5) : 0);
    }
  }

  /**
   * Tumbling lit metal pieces: plates, struts, slivers, shards, chunks, bolts.
   * opts: color, speed, size (the LARGEST typical piece; most are much smaller), life (ms), hot (0..1 fraction glowing),
   *       gravity, drag, up, vx/vy/vz, shape ('shard' | 'chunk' | 'plate' | 'strut' | 'sliver' | 'bolt'; default mixed),
   *       glint (0..1 fraction that flash as they tumble, default 0.3), trail (number of pieces that trail smoke/fire, default 0),
   *       uniform (true = the old even size spread instead of many-small-few-large)
   */
  shrapnel(x, y, z, count, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.metal);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const speed = o.speed ?? 220, size = o.size ?? 5;
    const life = (o.life ?? 1300) / 1000, hot = o.hot ?? 0.45;
    const grav = o.gravity ?? 45, drag = o.drag ?? 0.9, up = o.up ?? 0.75;
    const ivx = o.vx || 0, ivy = o.vy || 0, ivz = o.vz || 0;
    const glint = o.glint ?? 0.3, shape = o.shape != null ? (typeof o.shape === 'number' ? o.shape : SHAPE_ID[o.shape] ?? -1) : -1;
    let trail = o.trail | 0;
    // many small, few large: the count is topped up with fine bits so the total mass reads the same
    const n = this._n((count ?? 6) * (o.uniform ? 1 : 1.8));
    for (let k = 0; k < n; k++) {
      randSphere();
      const u = rnd();
      const sz = o.uniform ? size * rr(0.55, 1.4) : size * (0.22 + 1.2 * u * u * u);
      const sp = speed * rr(0.3, 1.0) * (o.uniform ? 1 : 1.3 - 0.5 * u);
      const tr = trail > 0 && sz > size * 0.7 ? 1 : 0;
      if (tr) trail--;
      const dx = DX, dy = DY, dz = DZ;
      this._chunk(x + dx * size, y + dy * size, z + dz * size, dx * sp + ivx, dy * sp * up + 20 + ivy, dz * sp + ivz,
        life * rr(0.65, 1.35), sz, c0, c1, c2, rnd() < hot || tr ? rr(0.7, 2.0) : 0, rnd() < glint ? rr(0.4, 1) : 0, tr, shape, drag, grav, 0);
    }
  }

  /** One soft smoke puff. opts: dark 0..1, life (ms), vx/vy/vz (units/s), alpha, hot (true = fire-lit start), color [r,g,b], drift (false = no world drift) */
  smokePuff(x, y, z, size, opts) {
    const o = opts || EMPTY, tn = this.tuning;
    if (this.quality < 1 && rnd() > 0.5 + 0.5 * this.quality) return;
    const dark = o.dark ?? 0.6;
    const g = 0.5 - 0.44 * dark;
    const c = o.color;
    const sh = rr(0.85, 1.15);
    const K = this.smoke;
    const i = K.spawn(x, y, z, o.vx ?? rr(-12, 12), o.vy ?? rr(6, 20), o.vz ?? rr(-12, 12),
      (o.life ?? 1100) / 1000 * rr(0.85, 1.15), size * 0.38, size, o.hot ? R_SMOKE : R_SMOKE_PLAIN,
      (c ? c[0] : g) * sh, (c ? c[1] : g) * sh, (c ? c[2] : g * 1.03) * sh, C_SMOKE0 + ((rnd() * 4) | 0));
    K.drag[i] = 1.2; K.turb[i] = 30; K.spin[i] = rr(-0.9, 0.9);
    if (o.drift !== false) { K.wx[i] = tn.worldDriftX; K.wy[i] = tn.smokeRise * 0.6; }
    K.ta[i] = o.alpha ?? 1;
    if (o.hot) K.aux[i] = typeof o.hot === 'number' ? o.hot : 0.8;
  }

  /** Rock dust burst. opts: count, color [r,g,b], speed, life (ms), chips (extra rock shrapnel count) */
  dust(x, y, z, size, opts) {
    const o = opts || EMPTY, tn = this.tuning;
    const c = this._col(o.color, this.palette.dust);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const speed = o.speed ?? 110, life = (o.life ?? 1000) / 1000;
    const K = this.smoke;
    const n = Math.max(1, this._n(o.count ?? 10));
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = speed * rr(0.3, 1.4), off = size * rr(0.05, 0.3), sh = rr(0.75, 1.2);
      const s1 = size * rr(0.6, 1.1);
      const i = K.spawn(x + DX * off, y + DY * off * 0.5, z + DZ * off, DX * sp, DY * sp * 0.5 + 8, DZ * sp,
        life * rr(0.7, 1.3), s1 * 0.3, s1, R_DUST, c0 * sh, c1 * sh, c2 * sh, C_SMOKE0 + ((rnd() * 4) | 0));
      K.drag[i] = 2.6; K.turb[i] = 25; K.spin[i] = rr(-1.2, 1.2);
      K.wx[i] = tn.worldDriftX * 0.6; K.wy[i] = 6;
    }
    if (o.chips) {
      CHIP_COL[0] = c0; CHIP_COL[1] = c1; CHIP_COL[2] = c2;
      CHIP_OPTS.color = CHIP_COL; CHIP_OPTS.speed = speed * 1.6; CHIP_OPTS.size = Math.max(2.5, size * 0.07);
      this.shrapnel(x, y, z, o.chips, CHIP_OPTS);
    }
  }

  /**
   * Expanding energy ring on the XZ plane (thin crisp front, soft inner falloff).
   * opts: color, life (ms), thickness (world units), soft (false = no faint distortion ring), gain
   */
  shockwave(x, y, z, maxRadius, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.shockwave);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const life = (o.life ?? 420) / 1000;
    // callers historically pass dim colours (the old ring was a fat disc): lift them into the glow range
    const m = Math.max(c0, c1, c2, 1e-3), g = (o.gain ?? 1) * (m < 1.0 ? 1.0 / m : 1);
    this._ring(x, y, z, maxRadius, life, c0, c1, c2, 0, o.thickness ?? Math.max(1.8, maxRadius * 0.014), 0, 1, 0, 0, maxRadius * 0.06, g, 0);
    if (o.soft !== false) this._ring(x, y, z, maxRadius * 0.86, life * 1.35, c0, c1, c2, 1, maxRadius * 0.05, 0, 1, 0, 0, 0, g * 0.5, 0.02);
  }

  /**
   * Enemy materialises: rings collapse onto the spot, sparks are sucked in, then a flash.
   * size = the ship's length. opts: color, life (ms, default 380), light (false to skip)
   */
  warpIn(x, y, z, size, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.warp);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const life = (o.life ?? 380) / 1000;
    const R = size * 1.5, F = this.fire;
    this._ring(x, y + 1, z, 2, life, c0, c1, c2, 0, 2.2, 0, 1, 0, 1, R, 1.1, 0);
    this._ring(x, y + 1, z, 2, life * 0.75, c0, c1, c2, 0, 1.6, 0, 1, 0, 1, R * 0.7, 0.8, life * 0.25);
    this._ring(x, y + 1, z, 2, life, c0, c1, c2, 1, R * 0.08, 0, 1, 0, 1, R * 1.25, 0.9, 0);
    // sparks falling into the centre: they arrive as the flash goes off
    const n = this._n(16);
    for (let k = 0; k < n; k++) {
      const a = rnd() * TAU, d = R * rr(0.7, 1.25), t = life * rr(0.75, 1.0), sp = d / t;
      const ca = Math.cos(a), sa = Math.sin(a), h = rr(-0.25, 0.4) * d;
      this._spark(x + ca * d, y + h, z + sa * d, -ca * sp, -h / t, -sa * sp, t, rr(1.8, 3), c0 * 1.5, c1 * 1.5, c2 * 1.5, 0, 0, 0.05, 0, 0, 1.2);
    }
    // arrival flash: dot, tall star, lens streak
    let i = F.spawn(x, y + 2, z, 0, 0, 0, 0.14, size * 0.5, size * 1.5, R_FLASH, c0 * 1.3, c1 * 1.3, c2 * 1.3, C_DOT);
    F.delay(i, life * 0.9);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.22, size * 2.2, size * 5, R_FLASH, c0 * 0.8, c1 * 0.8, c2 * 0.8, C_FLARE);
    F.delay(i, life * 0.9); F.rot(i, 0);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.18, size * 4, size * 8, R_FLASH, c0 * 0.7, c1 * 0.7, c2 * 0.7, C_STREAK);
    F.delay(i, life * 0.9); F.rot(i, 0);
    // a few sparks thrown out by the arrival
    const m = this._n(8);
    for (let k = 0; k < m; k++) {
      randSphere();
      const sp = rr(160, 420);
      i = this.sparkN;
      this._spark(x, y, z, DX * sp, DY * sp * 0.5 + 20, DZ * sp, rr(0.2, 0.45), rr(1.6, 2.6), c0 * 1.5, c1 * 1.5, c2 * 1.5, 2.5, 60, 0.04, 0, 0, 1.2);
      // hold them back until the flash
      if (i < this.sparkCap) this.sparkS[i * SP + 6] = -life * 0.9;
    }
    if (o.light !== false) this._lightTimed(x, y + 40, z, c0, c1, c2, 0.45, life / 0.7 * 0.92, 0, 1, 0);
  }

  /** Power-up collected: ring, rising sparkles, twinkles, soft flash. color: [r,g,b] | hex | css */
  pickup(x, y, z, color) {
    const c = this._col(color, this.palette.pickup);
    const m = Math.max(c[0], c[1], c[2], 1e-3), k0 = 1.8 / m; // normalise: css colours come in at <= 1
    const c0 = c[0] * k0, c1 = c[1] * k0, c2 = c[2] * k0;
    const F = this.fire;
    this._ring(x, y + 2, z, 78, 0.36, c0, c1, c2, 0, 2.0, 0, 1, 0, 0, 10, 0.9, 0);
    this._ring(x, y + 14, z, 46, 0.5, c0, c1, c2, 0, 1.5, 0, 1, 0, 0, 6, 0.6, 0.06);
    let i = F.spawn(x, y + 2, z, 0, 0, 0, 0.16, 26, 80, R_FLASH, c0 * 0.6, c1 * 0.6, c2 * 0.6, C_DOT);
    i = F.spawn(x, y + 2, z, 0, 0, 0, 0.24, 90, 210, R_FLASH, c0 * 0.6, c1 * 0.6, c2 * 0.6, C_FLARE);
    F.rot(i, 0);
    let n = this._n(14);
    for (let k = 0; k < n; k++) {
      const a = rnd() * TAU, d = rr(4, 26), sp = rr(20, 90);
      this._spark(x + Math.cos(a) * d, y + rr(-4, 8), z + Math.sin(a) * d, Math.cos(a) * sp, rr(90, 300), Math.sin(a) * sp,
        rr(0.35, 0.8), rr(1.6, 2.8), c0, c1, c2, 1.6, -60, 0.035, 1 + rnd() * 5, 0, 1.3);
    }
    n = this._n(7);
    for (let k = 0; k < n; k++) {
      const a = rnd() * TAU, d = rr(8, 44), s1 = rr(16, 34);
      i = F.spawn(x + Math.cos(a) * d, y + rr(0, 30), z + Math.sin(a) * d, Math.cos(a) * 20, rr(30, 90), Math.sin(a) * 20,
        rr(0.25, 0.5), s1, s1 * 0.4, R_FLASH, c0, c1, c2, C_SPARKLE);
      F.spin[i] = rr(-3, 3);
      F.delay(i, rr(0, 0.22));
    }
    // glitter: fine glinting specks thrown outward and upward, settling slowly
    n = this._n(26);
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = rr(60, 330);
      this._spark(x + DX * 8, y + 4, z + DZ * 8, DX * sp, Math.abs(DY) * sp * 0.8 + 40, DZ * sp, rr(0.45, 1.3), rr(1.0, 1.9),
        c0 * 0.9 + 0.5, c1 * 0.9 + 0.5, c2 * 0.9 + 0.5, 3.2, 30, 0.005, -(1 + rnd() * 5), 0, 1.6);
    }
    this._lightTimed(x, y + 35, z, c0, c1, c2, 0.3, 0.26, 0, 0, 0);
  }

  /**
   * Something hits a shield bubble. (x,y,z) = bubble centre, (dirX,dirZ) = direction from the centre
   * to the hit point, radius = bubble radius. Ripples spread over the bubble from the hit point.
   */
  shieldHit(x, y, z, dirX, dirZ, radius, color) {
    const c = this._col(color, this.palette.shield);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    let l = Math.hypot(dirX, dirZ);
    if (l < 1e-5) { dirX = 1; dirZ = 0; l = 1; }
    const dx = dirX / l, dz = dirZ / l;
    const hx = x + dx * radius, hz = z + dz * radius, F = this.fire;
    // ripples that run over the bubble's surface (a sphere impostor in the glow pool, see G_SHIELD)
    {
      const S = this.shS;
      let k = this.shN;
      if (k >= 8) { k = 0; for (let j = 1; j < 8; j++) if (S[j * 12 + 6] / S[j * 12 + 7] > S[k * 12 + 6] / S[k * 12 + 7]) k = j; } else this.shN = k + 1;
      const o = k * 12;
      S[o] = x; S[o + 1] = y; S[o + 2] = z; S[o + 3] = radius * 1.04; S[o + 4] = dx; S[o + 5] = dz;
      S[o + 6] = 0; S[o + 7] = 0.55; S[o + 8] = c0; S[o + 9] = c1; S[o + 10] = c2;
      this._glow(x, y, z, radius * 1.04 / 0.8, c0, c1, c2, 1, G_SHIELD, 0, dx, dz);
    }
    let i = F.spawn(hx, y, hz, 0, 0, 0, 0.09, radius * 0.22, radius * 0.55, R_FLASH, c0 * 0.9, c1 * 0.9, c2 * 0.9, C_DOT);
    i = F.spawn(hx, y, hz, 0, 0, 0, 0.12, radius * 0.9, radius * 1.8, R_FLASH, c0 * 0.5, c1 * 0.5, c2 * 0.5, C_SPARKLE);
    F.spin[i] = rr(-2, 2);
    // sparks skitter along the surface (tangent) and out
    const n = this._n(9);
    for (let k = 0; k < n; k++) {
      const sgn = rnd() < 0.5 ? -1 : 1, t = rr(0.5, 1.0), out = rr(0.1, 0.6), sp = rr(180, 460);
      const vx = (-dz * sgn * t + dx * out) * sp, vz = (dx * sgn * t + dz * out) * sp;
      this._spark(hx, y, hz, vx, rr(-0.5, 0.5) * sp, vz, rr(0.14, 0.34), rr(1.5, 2.6), c0 * 1.6, c1 * 1.6, c2 * 1.6, 4, 0, 0.04, 0, 0, 1.2);
    }
    this._lightTimed(hx, y + 40, hz, c0, c1, c2, 0.14, 0.14, 0, 0, 0);
  }

  /**
   * Short-lived jagged electric arc from (x0,y0,z0) to (x1,y1,z1), with branches and end flashes.
   * opts: color, width (default 4), life (ms, default 170), branches (default 3), jitter (0..1, default 1), light (false to skip)
   */
  lightningBolt(x0, y0, z0, x1, y1, z1, opts) {
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.lightning);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const width = o.width ?? 4, life = (o.life ?? 170) / 1000, jit = o.jitter ?? 1;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz);
    if (len < 1) return;
    const seed = rnd() * 100;
    const segs = Math.max(4, Math.min(16, Math.round(len / 34)));
    // perpendicular (mostly in-plane) and vertical offset axes
    const hl = Math.hypot(dx, dz) || 1, px = -dz / hl, pz = dx / hl;
    const amp = len * 0.085 * jit;
    let ax = x0, ay = y0, az = z0, off = 0, offY = 0;
    const nb = this.quality < 1 ? Math.min(1, o.branches ?? 3) : (o.branches ?? 3);
    for (let k = 1; k <= segs; k++) {
      const t = k / segs, env = Math.sin(t * Math.PI);
      off = off * 0.45 + (rnd() - 0.5) * 2 * amp; offY = offY * 0.45 + (rnd() - 0.5) * amp * 0.7;
      const bx = x0 + dx * t + px * off * env, by = y0 + dy * t + offY * env, bz = z0 + dz * t + pz * off * env;
      this._arc(ax, ay, az, bx, by, bz, width, life, c0, c1, c2, seed, 2.2);
      // branch: a shorter, thinner fork leaving the main channel
      if (k < segs && rnd() < nb / segs) {
        const sgn = rnd() < 0.5 ? -1 : 1, ang = rr(0.35, 0.9) * sgn, bl = len * rr(0.12, 0.3), bs = 3 + ((rnd() * 3) | 0);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const fdx = (dx * ca - dz * sa) / len, fdz = (dz * ca + dx * sa) / len;
        let cx = bx, cy = by, cz = bz, bo = 0;
        for (let j = 1; j <= bs; j++) {
          bo = bo * 0.4 + (rnd() - 0.5) * bl * 0.22;
          const ex = bx + fdx * bl * (j / bs) - fdz * bo, ey = by + (rnd() - 0.5) * bl * 0.2, ez = bz + fdz * bl * (j / bs) + fdx * bo;
          this._arc(cx, cy, cz, ex, ey, ez, width * 0.55 * (1 - 0.5 * j / bs), life * 0.75, c0, c1, c2, seed, 1.4);
          cx = ex; cy = ey; cz = ez;
        }
      }
      ax = bx; ay = by; az = bz;
    }
    // flashes at both ends + a few sparks where it lands
    const F = this.fire, gs = width * 9;
    F.spawn(x0, y0, z0, 0, 0, 0, life * 0.7, gs * 0.7, gs * 1.2, R_FLASH, c0 * 0.6, c1 * 0.6, c2 * 0.6, C_DOT);
    F.spawn(x1, y1, z1, 0, 0, 0, life * 0.8, gs, gs * 1.8, R_FLASH, c0 * 0.7, c1 * 0.7, c2 * 0.7, C_DOT);
    const i = F.spawn(x1, y1, z1, 0, 0, 0, life * 0.8, gs * 2.5, gs * 5, R_FLASH, c0 * 0.5, c1 * 0.5, c2 * 0.5, C_SPARKLE);
    F.spin[i] = rr(-3, 3);
    const n = this._n(5);
    for (let k = 0; k < n; k++) {
      randSphere();
      const sp = rr(120, 380);
      this._spark(x1, y1, z1, DX * sp, DY * sp * 0.6 + 20, DZ * sp, rr(0.15, 0.35), rr(1.4, 2.4), c0, c1, c2, 3, 80, 0.035, 0, 0, 1.2);
    }
    if (o.light !== false) {
      const rel = 0.3 * Math.min(2, width / 4);
      this._lightTimed((x0 + x1) / 2, (y0 + y1) / 2 + 35, (z0 + z1) / 2, c0, c1, c2, rel, life * 1.2, Math.max(260, len * 0.8), 0, 0);
      if (len > 320) this._lightTimed(x1, y1 + 30, z1, c0, c1, c2, rel * 0.7, life * 1.2, 0, 0, 0);
    }
  }

  _arc(x0, y0, z0, x1, y1, z1, width, life, r, g, b, seed, core) {
    if (this.arcN >= this.arcCap) return;
    const o = this.arcN++ * AR, S = this.arcS;
    S[o] = x0; S[o + 1] = y0; S[o + 2] = z0; S[o + 3] = x1; S[o + 4] = y1; S[o + 5] = z1;
    S[o + 6] = width; S[o + 7] = 0; S[o + 8] = life; S[o + 9] = r; S[o + 10] = g; S[o + 11] = b; S[o + 12] = seed; S[o + 13] = core;
  }

  /* --------------------------- continuous emitters ----------------------- */
  // Called every frame per source. Particle emission = rate x (dt of the last update()),
  // stochastically rounded, so density is fps-independent and no particle is emitted while paused.

  /**
   * Engine plume. (dirX,dirZ) = direction the exhaust travels. size = plume width at the nozzle.
   * The plume itself is an immediate-mode shader ribbon (drawn even while paused); wisps are particles.
   * opts: color ('player' | 'enemy' | [r,g,b]), boost (0..1+ or true), vx/vz (ship velocity, units/s),
   *       intensity, length (multiplier), seed (stable flicker phase per nozzle), light (false = no afterburner light)
   */
  exhaust(x, y, z, dirX, dirZ, size, opts) {
    const dt = this._dt;
    const o = opts || EMPTY, pal = this.palette, tn = this.tuning;
    const boost = o.boost === true ? 1 : (o.boost || 0);
    let l = Math.hypot(dirX, dirZ);
    if (l < 1e-5) { dirX = -1; dirZ = 0; l = 1; }
    const dx = dirX / l, dz = dirZ / l;
    let ramp = R_EXH_PLAYER, r = 1, g = 1, b = 1, pc = pal.plumePlayer;
    const col = o.color;
    if (col === 'enemy') { ramp = R_EXH_ENEMY; pc = pal.plumeEnemy; }
    else if (col != null && col !== 'player') { const c = this._col(col, WHITE); ramp = R_TINT; r = c[0]; g = c[1]; b = c[2]; pc = c; }
    const p0 = pc[0], p1 = pc[1], p2 = pc[2];
    const a = o.intensity ?? 1;
    const seed = o.seed ?? (this.plumeN++ * 0.731) % 7;
    // how squarely the camera looks into the nozzle: 0 = from the side or the front, 1 = straight up the exhaust
    const cam = this._cam;
    let facing = 0;
    if (cam) {
      const e = cam.matrixWorld.elements, vx = e[12] - x, vy = e[13] - y, vz = e[14] - z;
      facing = (dx * vx + dz * vz) / (Math.hypot(vx, vy, vz) || 1);
      if (facing < 0) facing = 0;
    }
    // seen from behind the plume is foreshortened: it is drawn longer, so it keeps about the same length on screen
    const len = size * tn.plumeLength * (o.length ?? 1) * (1 + 0.8 * boost) * (1 + 1.1 * facing * facing);
    const hw = size * (0.95 + 0.25 * boost);
    this._beam(x, y, z, x + dx * len, y, z + dz * len, hw, K_PLUME, p0, p1, p2, 1, seed, boost, a * (1 + 0.5 * facing));
    // Seen from behind (the camera looks into the nozzle) the ribbon alone would be a flat smear: there the engine
    // is drawn as what it is, a glowing ring with a hot well, plus two fainter cross-sections of the plume further
    // down, so the exhaust reads as a short cone from any angle. Edge-on they vanish (the vertex shader fades them).
    if (facing > 0.1) {
      const b1 = 1 + 0.25 * boost;
      this._beam(x + dx * size * 0.22, y, z + dz * size * 0.22, dx, 0, dz, size * 0.8 * b1, K_NOZZLE, p0, p1, p2, 1, seed, 1, a * (0.9 + 0.4 * boost));
      this._beam(x + dx * len * 0.2, y, z + dz * len * 0.2, dx, 0, dz, size * 0.62 * b1, K_NOZZLE, p0, p1, p2, 1, seed + 1.3, 0, a * (0.5 + 0.3 * boost));
      this._beam(x + dx * len * 0.42, y, z + dz * len * 0.42, dx, 0, dz, size * 0.44 * b1, K_NOZZLE, p0, p1, p2, 1, seed + 2.6, 0, a * (0.3 + 0.25 * boost));
    }
    // soft coloured haze around the nozzle (no white pin-point: seen from behind that was a round white blob)
    this._glow(x + dx * size * 0.25, y, z + dz * size * 0.25, size * (1.4 + 0.8 * boost), p0, p1, p2, a * (0.3 + 0.24 * boost), G_SOFT, seed, 0, 1);
    if (boost > 0.3 && o.light !== false) this._lightNow(x + dx * len * 0.35, y + 40, z + dz * len * 0.35, p0, p1, p2, 0.03 * boost * a * Math.min(2, size / 12), 0);
    if (dt <= 0) return;
    const n = this._n(tn.exhaustRate * (1 + 1.2 * boost) * dt);
    const F = this.fire;
    const speed = size * 20 * (1 + 0.6 * boost);
    const ivx = o.vx || 0, ivz = o.vz || 0;
    const jit = size * 2.6;
    for (let k = 0; k < n; k++) {
      const sp = speed * rr(0.6, 1.1);
      const vx = dx * sp + rr(-jit, jit) + ivx, vz = dz * sp + rr(-jit, jit) + ivz, vy = rr(-jit, jit) * 0.6;
      const d0 = rr(0.3, 0.9) * len;
      const s0 = size * rr(0.5, 0.9) * (1 + 0.2 * boost);
      const i = F.spawn(x + dx * d0, y, z + dz * d0, vx, vy, vz, rr(0.14, 0.3) * (1 + 0.4 * boost), s0, s0 * 1.8, ramp, r, g, b, C_GLOW);
      F.drag[i] = 2.2; F.ta[i] = a * 0.11; F.aux[i] = 1.6;
    }
    // afterburner: tiny bright specks spat down the plume
    if (boost > 0.3 && o.specks !== false) {
      const m = this._n(34 * boost * dt * Math.min(1.6, size / 9));
      for (let k = 0; k < m; k++) {
        const sp = speed * rr(1.0, 2.2), j = size * 4.5;
        this._spark(x + dx * size * rr(0.2, 1.2), y + rr(-0.2, 0.2) * size, z + dz * size * rr(0.2, 1.2),
          dx * sp + rr(-j, j) + ivx, rr(-j, j) * 0.6, dz * sp + rr(-j, j) + ivz,
          rr(0.12, 0.34), rr(0.7, 1.3) * Math.min(1.6, 0.6 + size * 0.05), p0 * 1.6 + 0.9, p1 * 1.6 + 0.9, p2 * 1.6 + 0.9, 2.5, 0, 0.02, 0, 0, 1.5);
      }
    }
  }

  /**
   * Rocket: needle-thin white-hot core, a fine thread of smoke that corkscrews behind it, a spit of sparks.
   * opts: scale, color (flame tint ramp), smoke (0..1), dark, light (false to skip)
   */
  rocketTrail(x, y, z, dirX, dirZ, opts) {
    const dt = this._dt;
    const o = opts || EMPTY, tn = this.tuning, pal = this.palette;
    const sc = o.scale ?? 1;
    let l = Math.hypot(dirX, dirZ);
    if (l < 1e-5) { dirX = -1; dirZ = 0; l = 1; }
    const dx = dirX / l, dz = dirZ / l;
    const F = this.fire, K = this.smoke;
    let ramp = R_EXH_ENEMY, r = 1, g = 1, b = 1, pc = pal.plumeEnemy;
    if (o.color === 'player') { ramp = R_EXH_PLAYER; pc = pal.plumePlayer; }
    else if (o.color != null && o.color !== 'enemy') { const c = this._col(o.color, WHITE); ramp = R_TINT; r = c[0]; g = c[1]; b = c[2]; pc = c; }
    const p0 = pc[0], p1 = pc[1], p2 = pc[2];
    const T = this.uTime.value, seed = (this.plumeN++ * 0.531) % 7;
    // motor (immediate, also while paused): short hard plume, hairline core streak, tight glow
    this._beam(x, y, z, x + dx * 26 * sc, y, z + dz * 26 * sc, 4.6 * sc, K_PLUME, p0, p1, p2, 1, seed, 0.6, 1.1);
    const fl = 0.85 + 0.15 * Math.sin(T * 61 + seed * 11);
    if (this.tracerN < this.tracerCap) {
      const m = (this.tracerBase + this.tracerN++) * 4, H = this.stHead, TT = this.stTail, CH = this.stColH, CT = this.stColT;
      const tl = 46 * sc * fl;
      H[m] = x; H[m + 1] = y; H[m + 2] = z; H[m + 3] = 2.2 * sc;
      TT[m] = x + dx * tl; TT[m + 1] = y; TT[m + 2] = z + dz * tl; TT[m + 3] = 1.6;
      CH[m] = p0 + 1.1; CH[m + 1] = p1 + 1.1; CH[m + 2] = p2 + 1.1; CH[m + 3] = 1;
      CT[m] = p0; CT[m + 1] = p1 * 0.6; CT[m + 2] = p2 * 0.5; CT[m + 3] = 0;
      this._syncStreaks();
    }
    this._glow(x, y, z, 10 * sc, p0, p1, p2, 0.75 * fl, G_SOFT, 0, 0, 0);
    if (o.light !== false) this._lightNow(x + dx * 10, y + 34, z + dz * 10, p0, p1, p2, 0.04 * sc, 0);
    if (dt <= 0) return;
    // small licks of flame just behind the nozzle
    let n = this._n(40 * dt);
    for (let k = 0; k < n; k++) {
      const sp = rr(110, 200) * sc, pre = rnd() * dt;
      const vx = dx * sp + rr(-10, 10), vz = dz * sp + rr(-10, 10), vy = rr(-8, 8);
      const s0 = rr(5, 8) * sc;
      const i = F.spawn(x + vx * pre, y + vy * pre, z + vz * pre, vx, vy, vz, rr(0.08, 0.17), s0, s0 * 0.4, ramp, r, g, b, C_LICK0 + (k & 1));
      F.drag[i] = 3; F.aux[i] = 1.1;
    }
    // Smoke trail: a continuous ribbon. Puffs are laid at a fixed spacing along the path the rocket actually flew
    // since its last frame (found again by position: the API has no rocket ids), so there are no per-frame beads
    // whatever the speed or frame rate. They sit on a corkscrew whose phase follows the distance flown, drift
    // outward along it, widen and thin out; the youngest are lit from inside by the motor.
    const sm = o.smoke ?? 1;
    {
      const RS = this.rkS, fr = this._frame;
      let slot = -1, bd = 110 * 110, stale = 0, st = Infinity;
      for (let k = 0; k < 24; k++) {
        const q = k * 4, f = RS[q + 2];
        if (f < st) { st = f; stale = k; }
        if (f !== fr - 1) continue;
        const ex = RS[q] - x, ez = RS[q + 1] - z, d2 = ex * ex + ez * ez;
        if (d2 < bd) { bd = d2; slot = k; }
      }
      let px = x, pz = z, dist = rnd() * 100;
      if (slot >= 0) { px = RS[slot * 4]; pz = RS[slot * 4 + 1]; dist = RS[slot * 4 + 3]; } else slot = stale;
      const seg = Math.hypot(x - px, z - pz), q = slot * 4;
      RS[q] = x; RS[q + 1] = z; RS[q + 2] = fr; RS[q + 3] = dist + seg;
      if (sm > 0) {
        const c = pal.rocketSmoke, d = 1 - 0.6 * (o.dark ?? 0);
        const step = tn.rocketSmokeStep * sc / Math.min(1, this.quality);
        n = seg > 0.01 ? this._n(seg / step / this.quality * sm) : this._n(30 * sm * dt);
        if (n > 40) n = 40;
        for (let k = 0; k < n; k++) {
          const u = (k + rnd()) / n, bx = px + (x - px) * u, bz = pz + (z - pz) * u;
          const ph = (dist + seg * u) * 0.052, cu = Math.sin(ph), cv = Math.cos(ph);
          const sh = rr(0.85, 1.15) * d, s1 = rr(30, 44) * sc, sp = rr(6, 20) * sc;
          const vx = dx * sp - dz * cu * 15 * sc + rr(-3, 3), vy = cv * 11 * sc + rr(-2, 4), vz = dz * sp + dx * cu * 15 * sc + rr(-3, 3);
          const i = K.spawn(bx + dx * 4 * sc - dz * cu * 1.6 * sc, y + cv * 1.6 * sc, bz + dz * 4 * sc + dx * cu * 1.6 * sc, vx, vy, vz,
            rr(0.6, 1.0), s1 * 0.5, s1, R_TRAIL, c[0] * sh, c[1] * sh, c[2] * sh, C_SMOKE0 + ((rnd() * 4) | 0));
          K.drag[i] = 2.2; K.turb[i] = 26; K.spin[i] = rr(-1.4, 1.4);
          K.wx[i] = tn.worldDriftX * 0.6; K.wy[i] = tn.smokeRise * 0.3;
          K.ta[i] = 0.4; K.aux[i] = 0.9;
          K.age[i] = (1 - u) * dt;          // the ones laid first this frame are already that much older
        }
      }
    }
    // sparks spat out of the nozzle + the odd slow ember
    n = this._n(26 * dt);
    for (let k = 0; k < n; k++) {
      randCone(dx, dz, 0.3, 0.7);
      const sp = rr(160, 420) * sc;
      this._spark(x, y, z, DX * sp, DY * sp, DZ * sp, rr(0.1, 0.3), rr(0.7, 1.3) * sc, p0 + 1.4, p1 + 1.1, p2 + 0.6, 3, 40, 0.022, 0, 1, 1.5);
    }
    if (rnd() < 9 * dt * this.quality) {
      const c = pal.ember;
      randCone(dx, dz, 0.5, 0.6);
      const sp = rr(60, 180);
      this._spark(x, y, z, DX * sp, DY * sp, DZ * sp, rr(0.3, 0.8), rr(1.2, 2.0) * sc, c[0], c[1], c[2], 2, 50, 0.012, 1 + rnd() * 5, 1, 0.8);
    }
  }

  /** Burning debris / falling wreck: flames + smoke left behind. opts: scale, smoke (0..1), vx/vy/vz (source velocity), light (false to skip) */
  fireTrail(x, y, z, opts) {
    const dt = this._dt;
    const o = opts || EMPTY, tn = this.tuning, pal = this.palette;
    const sc = o.scale ?? 1;
    if (o.light !== false) {
      const c = pal.explosionLight;
      this._lightNow(x, y + 40, z, c[0], c[1], c[2], 0.06 * sc * (0.8 + 0.4 * Math.sin(this.uTime.value * 31 + x * 0.1)), 0);
    }
    if (dt <= 0) return;
    const ivx = (o.vx || 0) * 0.3, ivy = (o.vy || 0) * 0.3, ivz = (o.vz || 0) * 0.3;
    const F = this.fire, K = this.smoke;
    let n = this._n(38 * dt);
    for (let k = 0; k < n; k++) {
      const s1 = rr(22, 38) * sc;
      const lick = rnd() < 0.4;
      const i = F.spawn(x + rr(-5, 5) * sc, y + rr(-3, 5) * sc, z + rr(-5, 5) * sc,
        rr(-28, 28) + ivx + (lick ? tn.worldDriftX * 1.2 : 0), rr(10, 45) + ivy + (lick ? 50 : 0), rr(-28, 28) + ivz,
        rr(0.28, 0.55), s1 * 0.45, s1, R_FIRE, 0.8, 0.8, 0.8, lick ? C_LICK0 + (k & 1) : flameCell());
      F.drag[i] = 2.5; F.turb[i] = 70; F.spin[i] = rr(-2, 2);
      F.wx[i] = tn.worldDriftX * 0.8; F.wy[i] = 40;
      F.ta[i] = 0.8; F.occ(i, tn.fireOcclusion * 0.8);
      if (lick) F.aux[i] = 0.9;
    }
    const sm = o.smoke ?? 1;
    if (sm > 0) {
      const g = pal.smokeGrey;
      n = this._n(20 * sm * dt);
      for (let k = 0; k < n; k++) {
        const s1 = rr(42, 68) * sc, sh = rr(0.8, 1.2);
        const i = K.spawn(x + rr(-4, 4) * sc, y + rr(2, 8) * sc, z + rr(-4, 4) * sc,
          rr(-16, 16) + ivx, rr(8, 30) + ivy, rr(-16, 16) + ivz,
          rr(1.0, 1.7), s1 * 0.28, s1, R_SMOKE, g[0] * sh, g[1] * sh, g[2] * sh, C_SMOKE0 + ((rnd() * 4) | 0));
        K.drag[i] = 1.5; K.turb[i] = 40; K.spin[i] = rr(-1, 1);
        K.wx[i] = tn.worldDriftX; K.wy[i] = tn.smokeRise;
        K.aux[i] = 0.7;
        K.delay(i, rr(0.02, 0.12));
      }
    }
    n = this._n(16 * dt);
    for (let k = 0; k < n; k++) {
      const c = pal.ember;
      randSphere();
      const sp = rr(40, 190);
      this._spark(x + DX * 6 * sc, y, z + DZ * 6 * sc, DX * sp + ivx + tn.worldDriftX * 0.5, Math.abs(DY) * sp + 30 + ivy, DZ * sp + ivz, rr(0.5, 1.6), rr(1.2, 2.8) * sc,
        c[0], c[1], c[2], 1.2, 30, 0.012, 1 + rnd() * 5, 1, 0.8);
    }
    // fine sparks crackling off the burning metal
    n = this._n(22 * dt);
    for (let k = 0; k < n; k++) {
      const c = pal.microSpark;
      randSphere();
      const sp = rr(120, 480);
      this._spark(x + DX * 5 * sc, y, z + DZ * 5 * sc, DX * sp + ivx, DY * sp * 0.7 + 30 + ivy, DZ * sp + ivz, rr(0.1, 0.32), rr(0.7, 1.3) * sc,
        c[0], c[1], c[2], 4, 160, 0.026, 0, 1, 1.5);
    }
    // a dying hull shorts out now and then
    if (o.arcs !== false && rnd() < 2.2 * dt * this.quality) this._arcBurst(x, y, z, 20 * sc, pal.arc[0], pal.arc[1], pal.arc[2], 1.5);
  }

  /**
   * Tiny electric arcs crawling over a hull (dying ships, EMP, overloads). Call every frame; emission is rate x dt.
   * (x,y,z) = hull centre, radius = roughly half the hull's length.
   * opts: color, rate (arcs per second, default 12), width (default 1.6), sparks (false to skip), light (false to skip)
   */
  arcs(x, y, z, radius, opts) {
    const dt = this._dt;
    if (dt <= 0) return;
    const o = opts || EMPTY;
    const c = this._col(o.color, this.palette.arc);
    const c0 = c[0], c1 = c[1], c2 = c[2];
    const n = this._n((o.rate ?? 12) * dt);
    for (let k = 0; k < n; k++) this._arcBurst(x, y, z, radius, c0, c1, c2, o.width ?? 1.6, o.sparks === false, o.light === false);
  }

  // one short jagged arc between two random points on a flattened shell of the given radius
  _arcBurst(x, y, z, radius, c0, c1, c2, width, noSparks, noLight) {
    randSphere();
    const ax = x + DX * radius, ay = y + DY * radius * 0.35 + 2, az = z + DZ * radius * 0.7;
    const a0 = DX, a2 = DZ;
    randSphere();
    // the far end stays on the same side of the hull: arcs hug the surface instead of cutting through it
    const bx = x + (a0 * 0.55 + DX * 0.65) * radius, by = y + DY * radius * 0.35 + 2, bz = z + (a2 * 0.55 + DZ * 0.65) * radius * 0.7;
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 2) return;
    const segs = 3 + ((rnd() * 3) | 0), seed = rnd() * 100, life = rr(0.05, 0.12), amp = len * 0.2;
    let px = ax, py = ay, pz = az;
    for (let j = 1; j <= segs; j++) {
      const t = j / segs, e = j < segs ? 1 : 0;
      const qx = ax + dx * t + (rnd() - 0.5) * amp * e, qy = ay + dy * t + (rnd() - 0.5) * amp * e, qz = az + dz * t + (rnd() - 0.5) * amp * e;
      this._arc(px, py, pz, qx, qy, qz, width, life, c0, c1, c2, seed, 2.4);
      px = qx; py = qy; pz = qz;
    }
    const F = this.fire;
    F.spawn(bx, by, bz, 0, 0, 0, life, width * 3, width * 7, R_FLASH, c0 * 0.6, c1 * 0.6, c2 * 0.6, C_DOT);
    if (!noSparks) {
      const m = this._n(3);
      for (let j = 0; j < m; j++) {
        randSphere();
        const sp = rr(90, 300);
        this._spark(bx, by, bz, DX * sp, DY * sp * 0.6 + 20, DZ * sp, rr(0.1, 0.28), rr(0.7, 1.2), c0 * 1.3, c1 * 1.3, c2 * 1.3, 3.5, 80, 0.024, 0, 0, 1.5);
      }
    }
    if (!noLight) this._lightTimed(bx, by + 30, bz, c0, c1, c2, 0.035, life * 1.5, 0, 0, 0);
  }

  /* --------------------------- immediate geometry ------------------------ */
  // Everything below lasts ONE frame: call it every frame, after update() and before commit()/render.

  /**
   * Glowing streak for THIS frame only (cleared at the start of the next update()).
   * (x0,y0,z0) = head (the bullet), (x1,y1,z1) = tail end. Colours are [r,g,b] linear HDR.
   * The tail fades to nothing; colorTail is the hue it passes through on the way.
   */
  tracer(x0, y0, z0, x1, y1, z1, colorHead, colorTail, width = 5) {
    if (this.tracerN >= this.tracerCap) return;
    const m = (this.tracerBase + this.tracerN++) * 4;
    const H = this.stHead, T = this.stTail, CH = this.stColH, CT = this.stColT;
    const ch = colorHead || WHITE, ct = colorTail || ch;
    H[m] = x0; H[m + 1] = y0; H[m + 2] = z0; H[m + 3] = width;
    T[m] = x1; T[m + 1] = y1; T[m + 2] = z1; T[m + 3] = 1.5;
    CH[m] = ch[0]; CH[m + 1] = ch[1]; CH[m + 2] = ch[2]; CH[m + 3] = 1;
    CT[m] = ct[0]; CT[m + 1] = ct[1]; CT[m + 2] = ct[2]; CT[m + 3] = 0.12;
    this._syncStreaks();
  }

  /**
   * One energy bolt (bullet) for this frame. (dirX,dirZ) = travel direction.
   * opts: a kind string, or { kind, scale, light }.
   *   kind: 'player' (cyan-white) | 'playerHot' (golden) | 'playerPlasma' (violet, larger, crackling)
   *       | 'enemy' (red-orange orb with a dark rim: always readable) | 'enemyHeavy' (bigger, magenta)
   *   scale: size multiplier (default 1);  light: false = this bolt casts no light
   * Reuse one opts object per kind: nothing is allocated here.
   */
  bolt(x, y, z, dirX, dirZ, opts) {
    const i = this.boltN;
    if (i >= this.boltCap) return;
    let kind = 0, sc = 1, lit = true;
    if (opts) {
      if (typeof opts === 'string') kind = BOLT_KIND[opts] | 0;
      else {
        kind = BOLT_KIND[opts.kind] | 0;
        if (opts.scale != null) sc = opts.scale;
        if (opts.light === false) lit = false;
      }
    }
    let l = Math.hypot(dirX, dirZ);
    if (l < 1e-6) { dirX = kind >= 3 ? -1 : 1; dirZ = 0; l = 1; }
    const m = i * 4, P = this.btPos, D = this.btDir;
    P[m] = x; P[m + 1] = y; P[m + 2] = z; P[m + 3] = sc;
    D[m] = dirX / l; D[m + 1] = dirZ / l; D[m + 2] = kind; D[m + 3] = (i * 0.7548776662) % 1;
    const n = this.boltN = i + 1;
    touch(this.aBtPos, this.rBt[0], n * 4); touch(this.aBtDir, this.rBt[1], n * 4);
    this.boltGeo.instanceCount = n;
    this.boltMesh.visible = true;
    if (lit) {
      // accumulate into a coarse grid: each occupied cell becomes one light candidate in commit()
      let gx = ((x / GRID_CELL) | 0) + (x < 0 ? -1 : 0) + (GRID_X >> 1), gz = ((z / GRID_CELL) | 0) + (z < 0 ? -1 : 0) + (GRID_Z >> 1);
      if (gx >= 0 && gx < GRID_X && gz >= 0 && gz < GRID_Z) {
        const g = gz * GRID_X + gx, w = BOLT_LIGHT[kind] * sc, h = this.uBoltHalo.value, k3 = kind * 3;
        if (this.gW[g] === 0) {
          this.gDirty[this.gDirtyN++] = g;
          this.gX[g] = 0; this.gY[g] = 0; this.gZ[g] = 0; this.gR[g] = 0; this.gG[g] = 0; this.gB[g] = 0;
        }
        this.gW[g] += w; this.gX[g] += x * w; this.gY[g] += y * w; this.gZ[g] += z * w;
        this.gR[g] += h[k3] * w; this.gG[g] += h[k3 + 1] * w; this.gB[g] += h[k3 + 2] * w;
      }
    }
  }

  /**
   * Beam between two points on the play plane, for this frame.
   * opts.kind: 'laser' (player piercing beam, cyan) | 'boss' (thick red-orange death ray)
   *          | 'telegraph' (dashed pulsing warning, not dangerous yet) | 'aim' (hairline sniper sight)
   *          | 'guide' (very faint gun-line) | 'marker' (flat warning bar on the play plane; opts.hot = collision course)
   * opts: width (world units), color, alpha (0..1), y, hot (marker), seed (stable flicker phase),
   *       flare ('origin' | 'impact' | 'both' | 'none'; default 'origin' for laser/boss), light (false to skip)
   */
  beam(x0, z0, x1, z1, opts) {
    const o = opts || EMPTY, pal = this.palette;
    const kind = BEAM_KIND[o.kind] | 0, D = BEAM_DEF[kind];
    const hot = o.hot ? 1 : 0;
    const c = this._col(o.color, kind === 5 && hot ? pal.markerHot : pal[D.col]);
    let c0 = c[0], c1 = c[1], c2 = c[2];
    if (kind === 5 && hot && o.color != null) { // a custom-coloured marker still has to look more alarming when hot
      const m = Math.max(c0, c1, c2, 1e-3), k = 1.9 / m;
      c0 *= k; c1 *= k; c2 *= k;
    }
    const a = o.alpha ?? 1;
    if (!(a > 0)) return;
    const y = o.y ?? D.y;
    let width = o.width ?? D.width;
    const seed = o.seed ?? (this.beamN * 0.37) % 5;
    if (kind < 2) width *= 1 + 0.07 * Math.sin(this.uTime.value * 53 + seed * 9) + 0.04 * Math.sin(this.uTime.value * 131 + seed * 5);
    if (!this._beam(x0, y, z0, x1, y, z1, width * D.hwK, kind, c0, c1, c2, a, seed, hot, 0)) return;
    if (kind < 2) {
      const flare = o.flare ?? 'origin';
      const fs = width * (kind === 1 ? 2.6 : 3.4), rot = this.uTime.value * 1.3 + seed;
      const fi = a * (0.75 + 0.25 * Math.sin(this.uTime.value * 47 + seed * 3));
      if (flare === 'origin' || flare === 'both') {
        this._glow(x0, y, z0, fs, c0, c1, c2, fi * 0.7, G_SOFT, seed, 0, 0);
        this._glow(x0, y, z0, fs * 2.4, c0, c1, c2, fi * 0.5, G_STAR, seed, rot, 0);
      }
      if (flare === 'impact' || flare === 'both') {
        this._glow(x1, y, z1, fs * 1.2, c0, c1, c2, fi * 0.8, G_SOFT, seed, 0, 0);
        this._glow(x1, y, z1, fs * 3.0, c0, c1, c2, fi * 0.55, G_STAR, seed, -rot, 0);
        // heat flecks boiling off the impact point, thrown back along the beam
        const dt = this._dt;
        if (dt > 0 && o.flecks !== false) {
          const bl = Math.hypot(x0 - x1, z0 - z1) || 1, bx = (x0 - x1) / bl, bz = (z0 - z1) / bl;
          const m = this._n((kind === 1 ? 90 : 55) * a * dt);
          for (let k = 0; k < m; k++) {
            randCone(bx, bz, 1.2, 0.9);
            const sp = rr(120, 620);
            if (k & 1) this._spark(x1, y, z1, DX * sp, DY * sp + 20, DZ * sp, rr(0.1, 0.34), rr(0.7, 1.4), c0 + 1.3, c1 + 1.3, c2 + 1.3, 4, 90, 0.024, 0, 0, 1.5);
            else this._spark(x1, y, z1, DX * sp * 0.5, DY * sp * 0.5 + 24, DZ * sp * 0.5, rr(0.3, 0.9), rr(1.0, 2.0), c0 * 1.4 + 0.3, c1 * 1.4 + 0.3, c2 * 1.4 + 0.3, 2, 30, 0.01, 1 + rnd() * 5, 0, 1);
          }
        }
      }
      if (o.light !== false) {
        // a few light samples along the visible part of the beam
        const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
        const n = Math.max(1, Math.min(5, Math.ceil(len / 280)));
        const rel = D.light * a * Math.min(2, width / D.width);
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          this._lightNow(x0 + dx * t, y + 45, z0 + dz * t, c0, c1, c2, rel, 0);
        }
      }
    }
  }

  /**
   * Soft energy aura with orbiting motes, for this frame (OVERDRIVE, elites, power-ups).
   * radius = world radius of the bubble. intensity ~1. Casts a small light.
   */
  aura(x, y, z, radius, color, intensity = 1) {
    const c = this._col(color, this.palette.shield);
    const m = Math.max(c[0], c[1], c[2], 1e-3), k = 1 / m; // hue only: brightness comes from intensity
    const c0 = c[0] * k, c1 = c[1] * k, c2 = c[2] * k;
    const seed = ((x * 0.013 + z * 0.017) % 1 + 1) % 1;
    this._glow(x, y, z, radius * 1.35, c0, c1, c2, intensity, G_AURA, (this.glowN * 0.37) % 1, 0, 0);
    this._lightNow(x, y + radius * 0.6 + 30, z, c0, c1, c2, 0.04 * intensity * Math.min(2, radius / 50) * (0.9 + 0.1 * Math.sin(this.uTime.value * 9 + seed * 6)), 0);
  }

  /**
   * Soft additive glow sprite for this frame (engines, mine LEDs, lamps...). size = visible diameter.
   * Casts no light by itself: pair it with fx.lightNow when it should.
   */
  heatGlow(x, y, z, size, color, intensity = 1) {
    const c = this._col(color, this.palette.explosionLight);
    this._glow(x, y, z, size, c[0], c[1], c[2], intensity, G_SOFT, 0, 0, 0);
  }
}

const EMPTY = Object.freeze({});
const WHITE = [1, 1, 1];
const FLASH_NEUTRAL = [1.8, 1.7, 1.6];
const CHIP_COL = [1, 1, 1];
const CHIP_OPTS = { color: null, speed: 150, size: 3, hot: 0, life: 1100 };

/* ----------------------------- shrapnel shapes ----------------------------- */

// All six shapes in one non-indexed geometry; aSid tells the vertex shader which shape a vertex belongs to.
function shrapnelGeo(THREE) {
  const parts = [];
  let total = 0;
  for (let kind = 0; kind < SHAPES; kind++) {
    let g;
    if (kind === 0) g = new THREE.TetrahedronGeometry(1, 0);              // shard
    else if (kind === 1) g = new THREE.OctahedronGeometry(0.95, 0);       // chunk
    else if (kind === 2) { // plate: a torn, uneven sheet — a perfect dark rectangle read as a glitchy "black square"
      g = new THREE.CylinderGeometry(1, 0.86, 0.2, 5, 1).scale(0.95, 1, 0.62);
      const pp = g.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const a = Math.atan2(pp.getZ(i), pp.getX(i)), k = 1 + 0.28 * Math.sin(a * 2.3 + 1.1) + 0.16 * Math.sin(a * 5.1);
        pp.setXYZ(i, pp.getX(i) * k, pp.getY(i), pp.getZ(i) * k);
      }
      g.computeVertexNormals();
    }
    else if (kind === 3) g = new THREE.BoxGeometry(2.6, 0.26, 0.3);       // strut
    else if (kind === 4) g = new THREE.TetrahedronGeometry(1, 0);         // sliver
    else g = new THREE.CylinderGeometry(0.34, 0.4, 1.25, 5, 1);           // bolt / rivet
    if (g.index) { const ni = g.toNonIndexed(); g.dispose(); g = ni; }
    const p = g.attributes.position.array;
    const amt = kind === 2 ? 0.2 : kind === 3 ? 0.1 : kind === 5 ? 0.08 : 0.36;
    for (let i = 0; i < p.length; i += 3) {
      // perturb by a hash of the (shared) corner position so faces stay welded
      const kx = Math.round(p[i] * 50), ky = Math.round(p[i + 1] * 50), kz = Math.round(p[i + 2] * 50);
      const s = 7 + kind * 13;
      p[i] += (hash2(kx, ky * 3 + kz, s) - 0.5) * 2 * amt * (kind === 3 ? 3 : 1);
      p[i + 1] += (hash2(ky, kz * 3 + kx, s + 1) - 0.5) * 2 * amt * (kind === 2 ? 0.35 : 1);
      p[i + 2] += (hash2(kz, kx * 3 + ky, s + 2) - 0.5) * 2 * amt;
    }
    if (kind === 0) g.scale(1.5, 0.55, 0.8);
    else if (kind === 4) g.scale(2.3, 0.16, 0.42);
    parts.push(g);
    total += p.length / 3;
  }
  const pos = new Float32Array(total * 3), sid = new Float32Array(total);
  let o = 0;
  for (let kind = 0; kind < SHAPES; kind++) {
    const p = parts[kind].attributes.position.array;
    pos.set(p, o * 3);
    sid.fill(kind, o, o + p.length / 3);
    o += p.length / 3;
    parts[kind].dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSid', new THREE.BufferAttribute(sid, 1));
  geo.computeVertexNormals();
  return geo;
}
