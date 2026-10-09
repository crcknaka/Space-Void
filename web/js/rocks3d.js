// rocks3d.js — procedural asteroids + fracture debris for the three.js view.
//
// Self-contained: imports nothing, receives THREE from the caller.
//   const rocks = new Rocks3D(THREE, scene, { fx });
//   const obj = rocks.create(variantIndex, volcanic, sizeHint);   // diameter-1 mesh, shared geometry/material
//   rocks.shatter({...}); rocks.chip({...}); rocks.update(dtMs);
//
// Rocks: a geodesic sphere per LOD (1.3k / 5k / 16k / 46k triangles) is displaced per variant by a
// seeded shape function — domain-warped lumps, lobes, hard fracture planes, ridges, gullies, strata
// terraces and sharp-rimmed craters of three size classes (central peaks, ejecta rays). The relief
// also leans sideways the higher it stands, so ledges and rims overhang, and closed shells are welded
// on: boulders, big angular blocks, clusters of six-sided crystal spires. Albedo, cavity/AO, a
// "crease" weight (flat shading on fracture planes, smooth on eroded areas) and a per-family mask
// (magma province / frost / bare metal / ore, > 1 = a real crystal) are baked per vertex and uploaded
// packed (28 bytes per vertex); the CPU copies are dropped once they are on the GPU.
// The fragment shader adds relief that fades out near pixel size: three octaves of warped gradient
// noise, a fine Voronoi mosaic of tilted grains, round pits and wandering cracks; then cavity
// darkening, crystals cut like gems (parallax glow inside, HDR glints), frost, light bleeding through
// ice, Voronoi basalt plates with magma in the joints, a body shadow (the game has no shadow maps),
// a view fill and a night-side rim so a rock reads as an obstacle from every camera, and up to four
// impact scars per rock (real dents: the vertex shader carves the same bowl).
// Geometry is built lazily in time slices from update(): create() hands out the best LOD that is
// ready (the 1.3k one is built on the spot, ~1 ms) and swaps the mesh's geometry when the wanted
// one is done, so the first huge rock never hitches a frame.
//
// Breaking: every LOD has a fracture mesh cut from that very surface (so the hand-over is seamless):
// a 3D Voronoi diagram of 90 … 330 seeds scattered through the volume, every cell a closed solid —
// the rock's own skin outside (clipped along the planar cuts), flat fresh fracture faces inside, all
// the way to the core. shatter() draws it as one GPU-animated instance: the body dilates and its
// cracks open and flash (~50 ms), clusters push apart, by ~120 ms every cluster is in pieces, and
// each piece crumbles to its own final size — never more than a quarter of the parent's diameter —
// tumbling, then shrinking away. On top of that: CPU-driven instanced pools of mid chunks, shards
// and grit in the rock's palette. Debris pools are fixed-capacity typed arrays — no per-frame allocation.

/* ------------------------------- tunables -------------------------------- */

const TUNE = {
  roughness: 1.0,         // multiplies every variant's roughness
  brightness: 0.9,        // multiplies every baked albedo (material.color)
  bump: 1.0,              // master multiplier of the shader relief
  ambient: 0.8,           // how much hemisphere/environment fill the rocks accept (1 = like any other mesh)
  bodyShadow: 0.8,        // strength of the night-side body shadow (0 = off)
  fill: 0.1,              // view-aligned fill: whatever faces the camera never goes black (irradiance, x fillColor)
  fillColor: [0.72, 0.82, 1.0],
  rim: 0.55,              // cool rim light on the night-side limb, so the silhouette reads against the sky
  rimColor: [0.55, 0.72, 1.0],
  hotCap: 2.6,            // HDR ceiling of glowing fracture faces / debris (shared out when several volcanic rocks break at once)
  sparkle: 1.0,           // crystal / ice glint multiplier (HDR)
  magma: 1.0,             // magma emissive multiplier (HDR, feeds bloom)
  crackFreq: 5.2,         // basalt plates per rock diameter
  crackWidth: 0.036,      // magma joint half-width (plate units)
  hot: 4.0,               // peak emissive of glowing debris (HDR)
  speed: 1.0,             // debris launch speed multiplier
  life: 1.0,              // debris lifetime multiplier
  drag: 0.0016,           // debris velocity decay per ms
  impactHeat: 0.3,        // glow of freshly opened fissures on NON-volcanic rocks (0 = off)
  maxFragFrac: 0.2,       // largest pooled fragment / parent diameter
  fxExplosionPerSize: 0.01, // fx.explosion scale per unit of rock diameter (volcanic shatter)
  meshScale: 1.2,         // the caller draws a rock of gameplay size S at scale S * meshScale
  crackMs: 85,            // length of the "cracking apart" beat before the burst
  lodSmall: 34,           // sizeHint below this → LOD 0
  lodMedium: 80,          // below this → LOD 1
  lodHuge: 150,           // at/above this → LOD 3 (else 2)
  buildBudgetMs: 3.5,     // per update() while a visible rock waits for its geometry
  idleBudgetMs: 1.2,      // per update() for background pre-building
  maxHugeFracture: 4,     // fracture meshes of huge (LOD 3) rocks kept at a time; the least recently used go
};

const LOD_FREQ = [8, 16, 28, 48]; // geodesic frequency → 1280 / 5120 / 15680 / 46080 triangles (+ boulders)
const FRAC_CELLS = [90, 150, 240, 330];   // Voronoi cells of the fracture mesh cut from surface LOD 0..3
const FRAC_CLUSTERS = [6, 9, 12, 15];     // clusters the cells are grouped into (they separate first)
const FRAC_LIMIT = 0.2;                   // largest piece once the pieces are apart, mesh units (= 24 % of the gameplay diameter at meshScale 1.2)
const MAX_BURSTS = 24;
const FLASH_COL = [1, 0.82, 0.6];

/* -------------------------------- helpers -------------------------------- */

const nowMs = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// Seeded 3D gradient (Perlin) noise, output roughly [-1, 1].
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const g = GRAD3;
  return function (x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx; y -= fy; z -= fz;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const A = perm[X] + Y, B = perm[X + 1] + Y;
    const AA = perm[A] + Z, AB = perm[A + 1] + Z, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    let h;
    h = (perm[AA] % 12) * 3; const n000 = g[h] * x + g[h + 1] * y + g[h + 2] * z;
    h = (perm[BA] % 12) * 3; const n100 = g[h] * (x - 1) + g[h + 1] * y + g[h + 2] * z;
    h = (perm[AB] % 12) * 3; const n010 = g[h] * x + g[h + 1] * (y - 1) + g[h + 2] * z;
    h = (perm[BB] % 12) * 3; const n110 = g[h] * (x - 1) + g[h + 1] * (y - 1) + g[h + 2] * z;
    h = (perm[AA + 1] % 12) * 3; const n001 = g[h] * x + g[h + 1] * y + g[h + 2] * (z - 1);
    h = (perm[BA + 1] % 12) * 3; const n101 = g[h] * (x - 1) + g[h + 1] * y + g[h + 2] * (z - 1);
    h = (perm[AB + 1] % 12) * 3; const n011 = g[h] * x + g[h + 1] * (y - 1) + g[h + 2] * (z - 1);
    h = (perm[BB + 1] % 12) * 3; const n111 = g[h] * (x - 1) + g[h + 1] * (y - 1) + g[h + 2] * (z - 1);
    const x00 = n000 + u * (n100 - n000), x10 = n010 + u * (n110 - n010);
    const x01 = n001 + u * (n101 - n001), x11 = n011 + u * (n111 - n011);
    const y0 = x00 + v * (x10 - x00), y1 = x01 + v * (x11 - x01);
    return y0 + w * (y1 - y0);
  };
}

function sstep(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function hash1(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function hex(h) {
  return [srgbToLinear(((h >> 16) & 255) / 255), srgbToLinear(((h >> 8) & 255) / 255), srgbToLinear((h & 255) / 255)];
}

// airborne dust tone for fx.dust(): the rock's hue at a fixed brightness
function dustTone(base, high, level) {
  const c = [(base[0] + high[0]) / 2, (base[1] + high[1]) / 2, (base[2] + high[2]) / 2];
  const k = level / Math.max(c[0], c[1], c[2], 1e-4);
  return [c[0] * k, c[1] * k, c[2] * k];
}

function randUnit(rnd, out) {
  const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
  out[0] = r * Math.cos(a); out[1] = z; out[2] = r * Math.sin(a);
  return out;
}

// any unit vector perpendicular to (x,y,z)
function perp(x, y, z, out) {
  let ax = 0, ay = 1, az = 0;
  if (Math.abs(y) > 0.8) { ax = 1; ay = 0; }
  let px = ay * z - az * y, py = az * x - ax * z, pz = ax * y - ay * x;
  const l = Math.hypot(px, py, pz) || 1;
  out[0] = px / l; out[1] = py / l; out[2] = pz / l;
  return out;
}

/* ---------------------------- geodesic sphere ----------------------------- */

// Unit geodesic sphere (icosahedron, every edge split into `freq` segments) with shared vertices
// and CSR adjacency. Topology is shared by every variant.
const geoCache = new Map();
function getGeodesic(freq) {
  let G = geoCache.get(freq);
  if (G) return G;
  const t = (1 + Math.sqrt(5)) / 2;
  const cv = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  for (let i = 0; i < cv.length; i += 3) {
    const l = Math.hypot(cv[i], cv[i + 1], cv[i + 2]);
    cv[i] /= l; cv[i + 1] /= l; cv[i + 2] /= l;
  }
  const cf = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const n = freq, nv = 10 * n * n + 2, nt = 20 * n * n;
  const dirs = new Float32Array(nv * 3);
  const index = nv > 65535 ? new Uint32Array(nt * 3) : new Uint16Array(nt * 3);
  const map = new Map();
  const local = new Int32Array((n + 1) * (n + 1));
  let vc = 0, ic = 0;
  for (let f = 0; f < 20; f++) {
    const a = cf[f * 3] * 3, b = cf[f * 3 + 1] * 3, c = cf[f * 3 + 2] * 3;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const w0 = n - i - j;
        let x = cv[a] * w0 + cv[b] * i + cv[c] * j, y = cv[a + 1] * w0 + cv[b + 1] * i + cv[c + 1] * j, z = cv[a + 2] * w0 + cv[b + 2] * i + cv[c + 2] * j;
        const l = Math.hypot(x, y, z);
        x /= l; y /= l; z /= l;
        const key = ((Math.round(x * 8192) + 8192) * 16385 + Math.round(y * 8192) + 8192) * 16385 + Math.round(z * 8192) + 8192;
        let id = map.get(key);
        if (id === undefined) {
          id = vc++;
          map.set(key, id);
          dirs[id * 3] = x; dirs[id * 3 + 1] = y; dirs[id * 3 + 2] = z;
        }
        local[i * (n + 1) + j] = id;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        const p0 = local[i * (n + 1) + j], p1 = local[(i + 1) * (n + 1) + j], p2 = local[i * (n + 1) + j + 1];
        index[ic++] = p0; index[ic++] = p1; index[ic++] = p2;
        if (j < n - 1 - i) {
          index[ic++] = p1; index[ic++] = local[(i + 1) * (n + 1) + j + 1]; index[ic++] = p2;
        }
      }
    }
  }
  // adjacency (closed manifold → every directed edge appears exactly once)
  const deg = new Uint16Array(vc);
  for (let i = 0; i < ic; i += 3) { deg[index[i]]++; deg[index[i + 1]]++; deg[index[i + 2]]++; }
  const start = new Uint32Array(vc + 1);
  for (let i = 0; i < vc; i++) start[i + 1] = start[i] + deg[i];
  const fill = new Uint32Array(vc);
  const nbr = new Uint32Array(start[vc]);
  for (let i = 0; i < ic; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    nbr[start[a] + fill[a]++] = b;
    nbr[start[b] + fill[b]++] = c;
    nbr[start[c] + fill[c]++] = a;
  }
  G = { freq, count: vc, dirs, index, start, nbr, edge: 1.18 / freq };
  geoCache.set(freq, G);
  return G;
}

/* ------------------------------- variants -------------------------------- */

//           base      dusty highs  crevices   warm patch  cool patch  fresh break
const PAL = {
  ash:      [0x7a756e, 0xaaa296, 0x2c2825, 0x8a735f, 0x5f6975, 0xa39c91],
  lunar:    [0x8a8781, 0xbfbaaf, 0x363432, 0x9c8d79, 0x727b86, 0xcdc9be],
  sand:     [0x8c6a4a, 0xba9c70, 0x33231a, 0xa35a34, 0x6f6450, 0xc8a97f],
  rust:     [0x87503a, 0xb27f5e, 0x321a13, 0xa3452a, 0x6b564e, 0xbd8e6c],
  iron:     [0x4c4c51, 0x7b7a80, 0x161619, 0x70391f, 0x39414d, 0xa2a3ac],
  ice:      [0x56788f, 0xa9c6d6, 0x16242f, 0x6fa3bd, 0x40566b, 0xc4dfee],
  carbon:   [0x3a3734, 0x5c5750, 0x100f0f, 0x4a3b30, 0x2c323a, 0x9a9386],
  crystal:  [0x4a5754, 0x76867d, 0x18201f, 0x5e6a48, 0x3a4859, 0x93a79e],
  basaltA:  [0x3a3230, 0x5c4f46, 0x120e0d, 0x52301f, 0x2e3139, 0x6c5c52],
  basaltB:  [0x353030, 0x554946, 0x110d0e, 0x562b1c, 0x33333d, 0x685a56],
  basaltC:  [0x40352d, 0x635140, 0x15100c, 0x59341c, 0x2c2e34, 0x70604e],
};

const SPEC_DEF = {
  axes: [1, 1, 1], lump: 0.4, ridge: 0.1, gully: 0, fine: 1, inflate: 0, facets: 2, facetCut: [0.74, 0.9], lobes: 0, waist: 0,
  strata: 0, strataFreq: 10, cratersBig: 1, cratersMid: 4, cratersSmall: 12, craterMax: 0.5, craterDepth: 0.44, rays: 0.3,
  boulders: 16, boulderSize: [0.03, 0.07], crisp: 0.12, special: '',
  overhang: 0.45, shearBias: 0,                   // sideways lean of the relief (overhangs); bias = share of one fixed direction (ledges)
  megas: 0, megaSize: [0.2, 0.3],                 // big blocks welded onto the body
  spires: 0, spireLen: [0.07, 0.19], spireRad: [0.014, 0.03], // clusters of crystal prisms
  // shader
  rough: 0.95, metal: 0, bump: [0.9, 0.05, 0.42], freq: [13, 2.7, 72], cell: [20, 0, 0.05, 0.4], cavDark: 0.6, cobble: 0, cobbleFreq: 3.2,
  ore: 0, frost: 0, sparkle: 0, oreColor: 0xffffff, volcanic: false,
  // fresh fracture faces: conchoidal ripples, striations along the bedding, banding, dark core
  brk: [0.5, 0.25, 0.25, 0.4],
  fracStretch: 1,   // > 1: breaks into slabs across the bedding axis, < 1: into shards along it
};

const NORMAL_SPECS = [
  // 0 rubble pile: lumpy, littered with boulders
  { name: 'rubble', seed: 101, pal: 'ash', axes: [1.26, 0.88, 0.98], lump: 0.36, ridge: 0, fine: 1.0, lobes: 2, facets: 1, cratersBig: 0, cratersMid: 2, cratersSmall: 7, rays: 0.2,
    boulders: 60, boulderSize: [0.03, 0.105], crisp: 0.2, megas: 3, megaSize: [0.2, 0.32], overhang: 0.35, brk: [0.2, 0.2, 0.35, 0.35], cell: [16, 0.015, 0.07, 0.4], cobble: 0.12, cobbleFreq: 3.0 },
  // 1 lunar: saturated with craters, bright rays
  { name: 'cratered', seed: 202, pal: 'lunar', axes: [1.06, 0.94, 1.0], lump: 0.28, ridge: 0.05, fine: 0.8, facets: 1, facetCut: [0.8, 0.92], cratersBig: 3, cratersMid: 10, cratersSmall: 34, craterMax: 0.6,
    rays: 0.9, boulders: 16, crisp: 0.06, megas: 1, megaSize: [0.15, 0.2], overhang: 0.3, cell: [24, 0, 0.05, 0.3] },
  // 2 layered sedimentary slab
  { name: 'layered', seed: 303, pal: 'sand', axes: [1.3, 0.66, 1.05], lump: 0.32, ridge: 0.03, fine: 1.0, facets: 5, facetCut: [0.62, 0.84], strata: 0.05, strataFreq: 11, cratersBig: 1, cratersMid: 3, cratersSmall: 8,
    craterMax: 0.42, boulders: 12, crisp: 0.3, overhang: 1.0, shearBias: 1.8, brk: [0.15, 0.9, 0.7, 0.3], fracStretch: 2.0 },
  // 3 contact binary
  { name: 'binary', seed: 404, pal: 'rust', axes: [1.42, 0.82, 0.86], lump: 0.3, ridge: 0.03, fine: 0.9, facets: 8, facetCut: [0.7, 0.94], waist: 0.34, cratersBig: 1, cratersMid: 5, cratersSmall: 14,
    craterMax: 0.4, rays: 0.5, boulders: 26, crisp: 0.12, megas: 2, megaSize: [0.2, 0.3], overhang: 0.5 },
  // 4 dense iron: polyhedral, pitted, half-polished metal with rust
  { name: 'iron', seed: 505, pal: 'iron', axes: [1.12, 0.92, 0.9], lump: 0.26, ridge: 0.06, fine: 0.7, inflate: 0.14, facets: 15, facetCut: [0.6, 0.88], cratersBig: 0, cratersMid: 2, cratersSmall: 6,
    craterMax: 0.36, rays: 0, boulders: 0, crisp: 0.6, overhang: 0.3, brk: [0.7, 0.5, 0.1, 0.15], special: 'metal', rough: 0.5, metal: 1, bump: [0.5, 0.09, 0.35], freq: [9, 2.7, 40], cell: [9, 0, 0.05, 0.35], cavDark: 0.7 },
  // 5 ice shard: glassy facets, frosted ridges
  { name: 'ice', seed: 606, pal: 'ice', axes: [1.32, 0.76, 0.84], lump: 0.3, ridge: 0.05, fine: 0.7, inflate: 0.06, facets: 10, facetCut: [0.56, 0.84], cratersBig: 0, cratersMid: 2, cratersSmall: 5,
    craterMax: 0.34, rays: 0.6, boulders: 6, crisp: 0.5, overhang: 0.4, spires: 7, spireLen: [0.1, 0.26], spireRad: [0.018, 0.044], brk: [1.0, 0.15, 0.1, 0.0], fracStretch: 0.6, special: 'frost', rough: 0.34, bump: [0.5, 0.03, 0.4], freq: [13, 2.7, 46], cell: [10, 0.03, 0.06, 0.5], cavDark: 0.4, frost: 1, ore: 0.25, sparkle: 0.9, oreColor: 0xe6f6ff },
  // 6 carbonaceous: very dark, crumbly, fresh bright craters
  { name: 'carbon', seed: 707, pal: 'carbon', axes: [1.14, 0.9, 1.04], lump: 0.44, ridge: 0.03, gully: 0.05, fine: 1.2, lobes: 2, facets: 5, facetCut: [0.72, 0.95], cratersBig: 1, cratersMid: 4, cratersSmall: 16, craterMax: 0.46,
    rays: 1.0, boulders: 32, boulderSize: [0.03, 0.085], crisp: 0.14, megas: 2, megaSize: [0.18, 0.28], overhang: 0.55, brk: [0.25, 0.25, 0.3, 0.3], rough: 1.0, cell: [22, 0.02, 0.07, 0.4], cobble: 0.05, cobbleFreq: 4.2, cavDark: 0.6 },
  // 7 crystalline: ridged host rock shot through with glinting veins
  { name: 'crystalline', seed: 808, pal: 'crystal', axes: [1.22, 0.82, 0.94], lump: 0.36, ridge: 0.05, gully: 0.04, fine: 1.0, lobes: 1, facets: 10, facetCut: [0.64, 0.92], cratersBig: 1, cratersMid: 3,
    cratersSmall: 8, craterMax: 0.4, boulders: 12, crisp: 0.36, megas: 1, megaSize: [0.18, 0.24], spires: 8, brk: [0.8, 0.3, 0.3, 0.3], fracStretch: 0.7, special: 'ore', rough: 0.85, cell: [14, 0.012, 0.08, 0.5], ore: 1, sparkle: 1.3, oreColor: 0x8ff2dc },
];

const VOLCANIC_SPECS = [
  { name: 'basaltCrag', seed: 911, pal: 'basaltA', axes: [1.2, 0.88, 0.96], lump: 0.44, ridge: 0.16, fine: 1.1, lobes: 1, facets: 5, facetCut: [0.66, 0.86], cratersBig: 0, cratersMid: 2, cratersSmall: 5, craterMax: 0.4,
    rays: 0, boulders: 10, crisp: 0.3, megas: 1, megaSize: [0.2, 0.28], overhang: 0.5, brk: [0.6, 0.3, 0.2, 0.5], special: 'glow', rough: 0.86, volcanic: true },
  { name: 'basaltBlock', seed: 922, pal: 'basaltB', axes: [1.1, 0.92, 0.9], lump: 0.34, ridge: 0.14, fine: 1.1, inflate: 0.06, facets: 9, facetCut: [0.62, 0.86], cratersBig: 0, cratersMid: 1, cratersSmall: 4, craterMax: 0.36,
    rays: 0, boulders: 6, crisp: 0.45, overhang: 0.5, brk: [0.6, 0.3, 0.2, 0.5], special: 'glow', rough: 0.82, volcanic: true },
  { name: 'basaltLump', seed: 933, pal: 'basaltC', axes: [1.3, 0.8, 1.0], lump: 0.52, ridge: 0.16, gully: 0.05, fine: 1.1, lobes: 2, facets: 2, facetCut: [0.7, 0.88], cratersBig: 1, cratersMid: 2, cratersSmall: 6, craterMax: 0.44,
    rays: 0, boulders: 14, crisp: 0.25, megas: 2, megaSize: [0.2, 0.3], overhang: 0.5, brk: [0.6, 0.3, 0.2, 0.5], special: 'glow', rough: 0.88, volcanic: true },
];

// Per-variant shape description shared by every LOD (so all LODs are the same rock).
function prepareVariant(specIn, id) {
  const spec = Object.assign({}, SPEC_DEF, specIn);
  const rnd = mulberry32(spec.seed * 7919 + 13);
  const v = [0, 0, 0], t1 = [0, 0, 0];
  const craters = [];
  const addCrater = (k, cls) => {
    randUnit(rnd, v);
    perp(v[0], v[1], v[2], t1);
    const rad = spec.craterMax * k;
    const young = cls === 0 ? rnd() * 0.5 : rnd() < 0.4 ? 0.6 + rnd() * 0.4 : rnd() * 0.3;
    const rays = cls < 2 && spec.rays > 0 && young * spec.rays > 0.25 ? 9 + ((rnd() * 9) | 0) : 0;
    craters.push({
      x: v[0], y: v[1], z: v[2], ux: t1[0], uy: t1[1], uz: t1[2],
      wx: v[1] * t1[2] - v[2] * t1[1], wy: v[2] * t1[0] - v[0] * t1[2], wz: v[0] * t1[1] - v[1] * t1[0],
      rad, depth: rad * spec.craterDepth * (0.8 + rnd() * 0.4), rim: 0.2 + rnd() * 0.16, peak: cls === 0 && rnd() < 0.6,
      young: young * (spec.rays > 0 ? 1 : 0.3), rays, raySeed: rnd() * 50, cosLimit: Math.cos(Math.min(3.1, rad * (rays ? 3.4 : 1.9))),
    });
  };
  for (let i = 0; i < spec.cratersBig; i++) addCrater(0.72 + rnd() * 0.28, 0);
  for (let i = 0; i < spec.cratersMid; i++) addCrater(0.26 + rnd() * 0.26, 1);
  for (let i = 0; i < spec.cratersSmall; i++) addCrater(0.075 + rnd() * rnd() * 0.15, 2);
  const facets = [];
  for (let i = 0; i < spec.facets; i++) {
    randUnit(rnd, v);
    facets.push({ x: v[0], y: v[1], z: v[2], h: spec.facetCut[0] + rnd() * (spec.facetCut[1] - spec.facetCut[0]), s: rnd() * 30, tone: 0.86 + rnd() * 0.28 });
  }
  const lobes = [];
  for (let i = 0; i < spec.lobes; i++) {
    randUnit(rnd, v);
    lobes.push({ x: v[0], y: v[1], z: v[2], amp: 0.16 + rnd() * 0.16, k: 2.2 + rnd() * 2.5 });
  }
  randUnit(rnd, v);
  const strataAxis = [v[0], v[1], v[2]];
  perp(v[0], v[1], v[2], t1);
  const shearDir = [t1[0], t1[1], t1[2]];
  const off = [rnd() * 40, rnd() * 40, rnd() * 40];
  const seedVec = [rnd() * 20, rnd() * 20, rnd() * 20];
  // boulders: some scattered, some thrown out around the bigger craters
  const boulders = [];
  const brnd = mulberry32(spec.seed * 31 + 7);
  const bigC = craters.filter((c) => c.rad > 0.12);
  for (let i = 0; i < spec.boulders; i++) {
    let dx, dy, dz;
    if (bigC.length && brnd() < 0.4) {
      const C = bigC[(brnd() * bigC.length) | 0];
      const a = brnd() * Math.PI * 2, ang = C.rad * (1.0 + brnd() * 0.5);
      const ca = Math.cos(a), sa = Math.sin(a), cg = Math.cos(ang), sg = Math.sin(ang);
      dx = C.x * cg + (C.ux * ca + C.wx * sa) * sg; dy = C.y * cg + (C.uy * ca + C.wy * sa) * sg; dz = C.z * cg + (C.uz * ca + C.wz * sa) * sg;
    } else { randUnit(brnd, v); dx = v[0]; dy = v[1]; dz = v[2]; }
    const k = brnd();
    boulders.push({
      x: dx, y: dy, z: dz, size: spec.boulderSize[0] + k * k * (spec.boulderSize[1] - spec.boulderSize[0]),
      seed: (brnd() * 1e9) | 0, sink: 0.15 + brnd() * 0.3, tone: 0.8 + brnd() * 0.4,
    });
  }
  boulders.sort((a, b) => b.size - a.size);
  // big attached blocks (kept apart from each other)
  const megas = [], mrnd = mulberry32(spec.seed * 53 + 3);
  for (let i = 0; i < spec.megas; i++) {
    let best = -2, bx = 0, by = 1, bz = 0;
    for (let t = 0; t < 8; t++) {
      randUnit(mrnd, v);
      let near = -2;
      for (const M of megas) near = Math.max(near, v[0] * M.x + v[1] * M.y + v[2] * M.z);
      if (-near > best) { best = -near; bx = v[0]; by = v[1]; bz = v[2]; }
    }
    randUnit(mrnd, v);
    let ux = bx + v[0] * 0.35, uy = by + v[1] * 0.35, uz = bz + v[2] * 0.35;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const cuts = [];
    for (let c = 0, nc = 2 + ((mrnd() * 3) | 0); c < nc; c++) { randUnit(mrnd, v); cuts.push({ x: v[0], y: v[1], z: v[2], h: 0.6 + mrnd() * 0.26, tone: 0.9 + mrnd() * 0.25 }); }
    megas.push({ x: bx, y: by, z: bz, ux, uy, uz, size: spec.megaSize[0] + mrnd() * (spec.megaSize[1] - spec.megaSize[0]), so: mrnd() * 40,
      sink: 0.3 + mrnd() * 0.3, tone: 0.85 + mrnd() * 0.3, roll: mrnd() * 6.283, sq: [0.85 + mrnd() * 0.45, 0.7 + mrnd() * 0.4, 0.8 + mrnd() * 0.4], cuts });
  }
  // crystal spires, longest first (coarse LODs keep only those)
  const spires = [], srnd = mulberry32(spec.seed * 71 + 9);
  for (let i = 0; i < spec.spires; i++) {
    randUnit(srnd, v);
    const cx = v[0], cy = v[1], cz = v[2], big = 0.55 + srnd() * 0.45;
    for (let k = 0, nk = 3 + ((srnd() * 4) | 0); k < nk; k++) {
      randUnit(srnd, t1);
      const j = k === 0 ? 0 : 0.05 + srnd() * 0.06, tl = k === 0 ? 0.25 : 0.55 + srnd() * 0.5;
      let px = cx + t1[0] * j, py = cy + t1[1] * j, pz = cz + t1[2] * j;
      const pl = Math.hypot(px, py, pz);
      px /= pl; py /= pl; pz /= pl;
      let ax = cx + t1[0] * tl, ay = cy + t1[1] * tl, az = cz + t1[2] * tl;
      const al = Math.hypot(ax, ay, az);
      const kk = (k === 0 ? 1 : 0.35 + srnd() * 0.5) * big;
      spires.push({ x: px, y: py, z: pz, ax: ax / al, ay: ay / al, az: az / al, len: spec.spireLen[0] + kk * (spec.spireLen[1] - spec.spireLen[0]),
        rad: spec.spireRad[0] + kk * (0.6 + srnd() * 0.4) * (spec.spireRad[1] - spec.spireRad[0]), roll: srnd() * 6.283, shoulder: 0.62 + srnd() * 0.24,
        tipU: (srnd() - 0.5) * 0.9, tipV: (srnd() - 0.5) * 0.9, tone: 0.85 + srnd() * 0.3 });
    }
  }
  spires.sort((a, b) => b.len - a.len);
  const p = PAL[spec.pal].map(hex);
  return {
    id, spec, craters, facets, lobes, boulders, megas, spires, strataAxis, shearDir, off, seedVec,
    pal: { base: p[0], high: p[1], low: p[2], tintA: p[3], tintB: p[4], fresh: p[5] },
    data: [null, null, null, null],   // per-LOD surface data (typed arrays)
    geo: [null, null, null, null],    // per-LOD BufferGeometry
    sh: [null, null, null, null],     // per-LOD fracture mesh { geo, mat, tex, mesh, burst, imp, n, clusters, … }
    jobs: [null, null, null, null, null, null, null, null],
    norm: null, surf: null, mat: null, shMat: null,
    dustColor: dustTone(p[0], p[1], spec.volcanic ? 0.2 : spec.pal === 'carbon' ? 0.22 : 0.42),
  };
}

// The shape function: direction → radius (+ feature masks). One closure per variant.
function makeSurface(vr) {
  const spec = vr.spec, nz = makeNoise(spec.seed), o = vr.off;
  const craters = vr.craters, facets = vr.facets, lobes = vr.lobes, sa = vr.strataAxis;
  const S = { r: 1, rl: 1, rb: 1, fl: 0, rm: 0, ray: 0, fm: 0, tone: 1, band: 0, gul: 0, wx: 0, wy: 0, wz: 0 };
  const TWO_PI = Math.PI * 2;
  function ev(dx, dy, dz, edge) {
    // domain warp so features are not aligned with the noise lattice
    const wx = dx + 0.35 * nz(dx * 1.3 + o[0], dy * 1.3 + o[1] + 7.1, dz * 1.3 + o[2]);
    const wy = dy + 0.35 * nz(dx * 1.3 + o[0] + 13.7, dy * 1.3 + o[1], dz * 1.3 + o[2] + 3.3);
    const wz = dz + 0.35 * nz(dx * 1.3 + o[0], dy * 1.3 + o[1] + 21.9, dz * 1.3 + o[2] + 9.4);
    let r = 1 + spec.inflate + spec.lump * nz(wx * 1.15 + o[1], wy * 1.15 + o[2], wz * 1.15 + o[0])
      + spec.lump * 0.5 * nz(wx * 2.4 + o[2], wy * 2.4 + o[0], wz * 2.4 + o[1]);
    for (let k = 0; k < lobes.length; k++) {
      const L = lobes[k];
      r += L.amp * Math.exp(-L.k * (1 - (dx * L.x + dy * L.y + dz * L.z)));
    }
    if (spec.waist) r -= spec.waist * Math.exp(-(dx * dx) / 0.07) * (0.75 + 0.25 * nz(dy * 3 + o[0], dz * 3 + o[1], o[2]));
    if (r < 0.45) r = 0.45;

    // fracture planes: hard clip → crisp creases where planes meet
    let fm = 0, tone = 1;
    for (let k = 0; k < facets.length; k++) {
      const F = facets[k];
      const dn = dx * F.x + dy * F.y + dz * F.z;
      if (dn > 0.08) {
        const cut = (F.h / dn) * (1 + 0.012 * nz(dx * 7 + F.s, dy * 7, dz * 7 + F.s));
        if (r > cut) {
          const m = sstep(0, 0.035, r - cut);
          if (m >= fm) { fm = m; tone = F.tone; }
          r = cut;
        }
      }
    }
    const soft = 1 - 0.85 * fm, rl = r;

    // ridges, gullies, strata terraces
    const rid = 1 - Math.abs(nz(wx * 3.1 + o[0] + 5, wy * 3.1 + o[1] + 5, wz * 3.1 + o[2] + 5)) * 2.2;
    if (rid > 0) r += spec.ridge * (rid * rid * (3 - 2 * rid) * 0.8 - 0.3) * soft; else r -= spec.ridge * 0.3 * soft;
    let gul = 0;
    if (spec.gully) {
      gul = 1 - sstep(0, 0.085, Math.abs(nz(wx * 2.3 + o[2] + 11, wy * 2.3 + o[0] + 11, wz * 2.3 + o[1] + 11)));
      r -= spec.gully * gul * soft;
    }
    let band = 0;
    if (spec.strata) {
      const s = (dx * sa[0] + dy * sa[1] + dz * sa[2]) * r * spec.strataFreq + 0.7 * nz(dx * 2.1 + o[0], dy * 2.1 + o[1], dz * 2.1 + o[2]);
      band = Math.floor(s);
      const t = s - band;
      r += spec.strata * (sstep(0, 0.16, t) - t - 0.42) * (1 - 0.5 * fm);
    }
    if (spec.cobble) {
      // a pile of cobbles: Worley bumps with dark joints between them
      const e = worley(dx * spec.cobbleFreq + o[0], dy * spec.cobbleFreq + o[1], dz * spec.cobbleFreq + o[2]);
      const j = 1 - sstep(0, 0.16, e);
      r += spec.cobble * (sstep(0, 0.34, e) - 0.6) * soft;
      if (j > gul) gul = j * 0.8;
    }
    const rb = r;

    // craters: steep bowl, sharp raised rim, central peak in the big ones, ejecta rays
    let fl = 0, rm = 0, ray = 0, delta = 0;
    const wob = 1 + 0.13 * nz(dx * 4.5 + o[2], dy * 4.5 + o[0], dz * 4.5 + o[1]);
    const minRad = edge * 1.6;
    for (let k = 0; k < craters.length; k++) {
      const C = craters[k];
      if (C.rad < minRad) continue;
      const c = dx * C.x + dy * C.y + dz * C.z;
      if (c < C.cosLimit) continue;
      const t = (Math.acos(c > 1 ? 1 : c) / C.rad) * wob;
      if (t < 1) {
        const b = 1 - t * t * t;
        delta -= C.depth * b;
        if (b > fl) fl = b;
        if (C.peak) delta += C.depth * 0.42 * Math.exp(-(t * t) / 0.03);
      }
      const q = (t - 1) / (t < 1 ? 0.085 : 0.3);
      const rimv = Math.exp(-q * q);
      delta += C.depth * C.rim * rimv;
      const rv = rimv * (0.45 + 0.55 * C.young);
      if (rv > rm) rm = rv;
      if (C.rays && t > 0.9 && t < 3.3) {
        const ang = Math.atan2(dx * C.wx + dy * C.wy + dz * C.wz, dx * C.ux + dy * C.uy + dz * C.uz);
        const R = C.rays / TWO_PI;
        let rn = nz(Math.cos(ang) * R + C.raySeed, Math.sin(ang) * R + 3.1, C.raySeed * 1.7) * 2.3 - 0.1;
        if (rn > 0) {
          rn = Math.min(1, rn * rn) * Math.exp(-(t - 1) * 1.05) * sstep(0.9, 1.2, t) * C.young;
          if (rn > ray) ray = rn;
          delta += C.depth * 0.1 * rn;
        }
      }
    }
    r *= 1 + delta;
    if (fl > 0 || rm > 0.3) fm *= 1 - Math.max(fl, rm);

    // fine fbm relief, each octave dropped once the mesh cannot carry it
    const fa = 0.045 * spec.fine * (1 - fm);
    let f = 6.3, a = fa;
    for (let k = 0; k < 3; k++) {
      const w = clamp((1 / (f * edge) - 1.3) / 1.4, 0, 1);
      if (w <= 0) break;
      r += a * w * nz(wx * f + o[k % 3], wy * f + o[(k + 1) % 3], wz * f + o[(k + 2) % 3]);
      f *= 2.05; a *= 0.4;
    }
    if (r < 0.28) r = 0.28;
    S.r = r; S.rl = rl; S.rb = rb; S.fl = fl; S.rm = rm; S.ray = ray; S.fm = fm; S.tone = tone; S.band = band; S.gul = gul;
    S.wx = wx; S.wy = wy; S.wz = wz;
    return S;
  }
  return { ev, nz };
}

// CPU Worley noise: F2 - F1 (0 on the joints between cells)
function worley(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  let d1 = 9, d2 = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = fx + i, cy = fy + j, cz = fz + k;
    let h = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177); const a = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    h = Math.imul(h ^ (h >>> 15), 2246822519); const b = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    h = Math.imul(h ^ (h >>> 15), 3266489917); const c = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    const dx = cx + a - x, dy = cy + b - y, dz = cz + c - z, d = dx * dx + dy * dy + dz * dz;
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return Math.sqrt(d2) - Math.sqrt(d1);
}

// One fixed centre + scale per variant so every LOD (and the fracture mesh) is the same rock:
// centred on the vertex centroid, mean radius 0.5, nothing beyond 0.56.
function ensureNorm(vr) {
  if (vr.norm) return;
  if (!vr.surf) vr.surf = makeSurface(vr);
  const G = getGeodesic(LOD_FREQ[0]), n = G.count, d = G.dirs, ax = vr.spec.axes, ev = vr.surf.ev;
  const p = new Float32Array(n * 3);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const r = ev(d[i * 3], d[i * 3 + 1], d[i * 3 + 2], 0.06).r;
    cx += (p[i * 3] = d[i * 3] * r * ax[0]); cy += (p[i * 3 + 1] = d[i * 3 + 1] * r * ax[1]); cz += (p[i * 3 + 2] = d[i * 3 + 2] * r * ax[2]);
  }
  cx /= n; cy /= n; cz /= n;
  let mean = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(p[i * 3] - cx, p[i * 3 + 1] - cy, p[i * 3 + 2] - cz);
    mean += l; if (l > max) max = l;
  }
  mean /= n;
  vr.norm = { cx, cy, cz, sc: Math.min(0.5 / mean, 0.56 / max) };
}

// Generator: builds the surface data of one LOD in small steps (yield = a safe point to stop for
// this frame). Returns { pos, nor, col, rock, index, count, baseCount } — the displaced geodesic
// body first, then everything welded onto it (boulders, big attached blocks, crystal spires), each a
// closed shell of its own.
function* genRock(vr, lod) {
  ensureNorm(vr);
  yield;
  const spec = vr.spec, G = getGeodesic(LOD_FREQ[lod]);
  yield;
  const n = G.count, dirs = G.dirs, edge = G.edge, ev = vr.surf.ev, nz = vr.surf.nz;
  const o = vr.off, ax = spec.axes, N = vr.norm, P = vr.pal;

  // parts this LOD carries
  const bl = [], megas = vr.megas, spires = [];
  if (lod > 0) {
    const minSize = lod === 1 ? 0.058 : lod === 2 ? 0.04 : 0;
    for (const b of vr.boulders) if (b.size >= minSize) bl.push(b);
  }
  {
    const keep = Math.ceil(vr.spires.length * [0.22, 0.55, 1, 1][lod]);
    for (let i = 0; i < keep; i++) spires.push(vr.spires[i]);
  }
  let extraV = 0, extraT = 0;
  const bFreq = new Uint8Array(bl.length), mFreq = [2, 4, 6, 9][lod];
  for (let i = 0; i < bl.length; i++) {
    bFreq[i] = lod === 1 || (lod === 2 && bl[i].size < 0.06) ? 1 : 2;
    const g = getGeodesic(bFreq[i]);
    extraV += g.count; extraT += g.index.length / 3;
  }
  { const g = getGeodesic(mFreq); extraV += megas.length * g.count; extraT += megas.length * g.index.length / 3; }
  extraV += spires.length * 14; extraT += spires.length * 24;
  const total = n + extraV;
  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), rock = new Float32Array(total * 4), nor = new Float32Array(total * 3);
  const R = new Float32Array(n), RB = new Float32Array(n), FL = new Float32Array(n), RM = new Float32Array(n), RAY = new Float32Array(n),
    FM = new Float32Array(n), TONE = new Float32Array(n), BAND = new Float32Array(n), GUL = new Float32Array(n);

  // direction + evaluated surface → final position. Relief is not only pushed out along the radius: it also
  // leans sideways (more the higher it stands), so ridges, terraces and crater rims overhang.
  const ohK = spec.overhang, sb = vr.shearDir, sbK = spec.shearBias;
  const place = (dx, dy, dz, s, out, i3) => {
    let px = dx * s.r, py = dy * s.r, pz = dz * s.r;
    if (ohK) {
      let tx = 2.6 * nz(dx * 1.7 + o[0] + 61, dy * 1.7 + o[1] + 17, dz * 1.7 + o[2] + 5) + sb[0] * sbK;
      let ty = 2.6 * nz(dx * 1.7 + o[1] + 29, dy * 1.7 + o[2] + 43, dz * 1.7 + o[0] + 71) + sb[1] * sbK;
      let tz = 2.6 * nz(dx * 1.7 + o[2] + 83, dy * 1.7 + o[0] + 37, dz * 1.7 + o[1] + 11) + sb[2] * sbK;
      const dn = tx * dx + ty * dy + tz * dz;
      tx -= dx * dn; ty -= dy * dn; tz -= dz * dn;
      const tl = Math.hypot(tx, ty, tz), k = (tl > 1 ? 1 / tl : 1) * ohK * clamp(s.rb - s.rl + 0.35 * (s.r - s.rb), -0.2, 0.2);
      px += tx * k; py += ty * k; pz += tz * k;
    }
    out[i3] = (px * ax[0] - N.cx) * N.sc; out[i3 + 1] = (py * ax[1] - N.cy) * N.sc; out[i3 + 2] = (pz * ax[2] - N.cz) * N.sc;
  };

  for (let i = 0; i < n; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    const s = ev(dx, dy, dz, edge);
    R[i] = s.r; RB[i] = s.rb; FL[i] = s.fl; RM[i] = s.rm; RAY[i] = s.ray; FM[i] = s.fm; TONE[i] = s.tone; BAND[i] = s.band; GUL[i] = s.gul;
    place(dx, dy, dz, s, pos, i * 3);
    if ((i & 127) === 127) yield;
  }

  // footprints of boulders and blocks darken the ground they sit on
  const nFoot = bl.length + megas.length;
  const bCos = new Float32Array(nFoot), bAng = new Float32Array(nFoot);
  for (let k = 0; k < nFoot; k++) {
    const B = k < bl.length ? bl[k] : megas[k - bl.length];
    bAng[k] = B.size * (k < bl.length ? 1.25 : 1.05); bCos[k] = Math.cos(Math.min(3.1, bAng[k] * 1.9));
  }

  const start = G.start, nbr = G.nbr, kind = spec.special;
  // overall faceting only where triangles are big enough to read as facets (on dense meshes it would show the weave)
  const crispK = [1, 0.7, 0.12, 0][lod];
  const convK = [1, 1, 0.75, 0.4][lod]; // on dense meshes vertex-scale convexity is noise, not form
  // baked speckle only as far as the vertices can carry it (the shader takes over from there)
  const spk1 = clamp((1 / (21 * edge) - 1.3) / 1.4, 0, 1), spk2 = 0.6 * clamp((1 / (43 * edge) - 1.3) / 1.4, 0, 1);
  for (let i = 0; i < n; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    let avg = 0;
    const e = start[i + 1];
    for (let k = start[i]; k < e; k++) avg += R[nbr[k]];
    avg /= e - start[i];
    const conv = clamp((R[i] - avg) / (edge * 0.3), -1, 1) * convK; // + = convex edge / peak, − = crease / pit
    const relief = clamp((R[i] - RB[i]) / 0.09, -1, 1);          // features against the base shape
    const fl = FL[i], rm = RM[i], fm = FM[i], ray = RAY[i], gul = GUL[i];

    const pa = sstep(0.0, 0.36, nz(dx * 1.6 + o[1] + 50, dy * 1.6 + o[2] + 50, dz * 1.6 + o[0] + 50));
    const pb = sstep(0.05, 0.42, nz(dx * 2.3 + o[2] + 90, dy * 2.3 + o[0] + 90, dz * 2.3 + o[1] + 90));
    const speck = spk1 * nz(dx * 21 + o[0], dy * 21 + o[1], dz * 21 + o[2]) + (spk2 ? spk2 * nz(dx * 43 + o[1], dy * 43 + o[2], dz * 43 + o[0]) : 0);

    let r = P.base[0], g = P.base[1], b = P.base[2], k;
    k = pa * 0.45; r += (P.tintA[0] - r) * k; g += (P.tintA[1] - g) * k; b += (P.tintA[2] - b) * k;
    k = pb * 0.35; r += (P.tintB[0] - r) * k; g += (P.tintB[1] - g) * k; b += (P.tintB[2] - b) * k;
    let m = 1 + 0.16 * speck;
    if (spec.strata) {
      // alternating beds: tone + a warm/cool drift from layer to layer
      const h = hash1(BAND[i] * 3.7 + spec.seed);
      m *= 0.74 + 0.5 * h;
      k = (hash1(BAND[i] * 9.1 + 4) - 0.35) * 0.7;
      if (k > 0) { r += (P.tintA[0] - r) * k; g += (P.tintA[1] - g) * k; b += (P.tintA[2] - b) * k; }
    }
    // freshly broken planes: lighter, each plane its own tone
    k = fm * 0.42; r += (P.fresh[0] - r) * k; g += (P.fresh[1] - g) * k; b += (P.fresh[2] - b) * k;
    m *= 1 + fm * (TONE[i] - 1);
    // dust on highs and old rims
    k = clamp(sstep(0.15, 0.9, relief) * 0.45 + rm * (1 - fl) * 0.35, 0, 0.8);
    r += (P.high[0] - r) * k; g += (P.high[1] - g) * k; b += (P.high[2] - b) * k;
    // bright ejecta rays
    k = ray * 0.75; r += (P.fresh[0] * 1.1 - r) * k; g += (P.fresh[1] * 1.1 - g) * k; b += (P.fresh[2] * 1.1 - b) * k;
    // dark crevices, gullies and crater floors
    k = clamp(sstep(0.05, 0.95, -relief) * 0.45 + fl * 0.5 + gul * 0.55 + Math.max(0, -conv) * 0.3, 0, 0.9);
    r += (P.low[0] - r) * k; g += (P.low[1] - g) * k; b += (P.low[2] - b) * k;
    // worn convex edges catch the light
    m *= 1 + 0.3 * sstep(0.25, 1, conv) - 0.22 * sstep(0.2, 1, -conv);

    let contact = 0;
    for (let q = 0; q < nFoot; q++) {
      const B = q < bl.length ? bl[q] : megas[q - bl.length], c = dx * B.x + dy * B.y + dz * B.z;
      if (c < bCos[q]) continue;
      const t = Math.acos(c > 1 ? 1 : c) / bAng[q];
      const s = 1 - sstep(0.7, 1.9, t);
      if (s > contact) contact = s;
    }
    m *= 1 - 0.4 * contact;

    const ao = clamp(1 - 0.45 * Math.max(0, -conv) - 0.4 * fl - 0.3 * gul - 0.22 * Math.max(0, -relief) - 0.35 * contact + 0.08 * Math.max(0, conv), 0.22, 1);
    m *= 0.72 + 0.28 * ao;
    col[i * 3] = clamp(r * m, 0, 0.86); col[i * 3 + 1] = clamp(g * m, 0, 0.86); col[i * 3 + 2] = clamp(b * m, 0, 0.86);

    let sp = 0;
    if (kind === 'glow') {
      // where the magma shows through: broad hot provinces, stronger in pits and crater floors
      const hot = sstep(-0.3, 0.3, nz(dx * 1.45 + o[2] + 70, dy * 1.45 + o[1] + 70, dz * 1.45 + o[0] + 70));
      sp = clamp(0.16 + 0.84 * hot + 0.3 * Math.max(0, -conv) + 0.3 * fl + 0.3 * gul - 0.25 * fm, 0.06, 1.25);
    } else if (kind === 'frost') {
      sp = clamp(0.3 + 0.3 * conv + 0.35 * relief + 0.5 * rm + 0.5 * ray - 0.5 * fm + 0.45 * nz(dx * 2.6 + o[0] + 30, dy * 2.6 + o[1] + 30, dz * 2.6 + o[2] + 30), 0, 1);
    } else if (kind === 'metal') {
      sp = clamp(1.05 - 1.25 * pa - 0.5 * fl + 0.25 * fm + 0.2 * conv, 0, 1);
    } else if (kind === 'ore') {
      sp = sstep(0.0, 0.36, nz(dx * 1.7 + o[0] + 30, dy * 1.7 + o[1] + 30, dz * 1.7 + o[2] + 30));
    }
    rock[i * 4] = clamp(fm + spec.crisp * crispK * (1 - 0.6 * fl), 0, 1);
    rock[i * 4 + 1] = ao;
    rock[i * 4 + 2] = sp;
    rock[i * 4 + 3] = 0;
    if ((i & 255) === 255) yield;
  }

  const index = total > 65535 ? new Uint32Array(G.index.length + extraT * 3) : new Uint16Array(G.index.length + extraT * 3);
  index.set(G.index);
  let vo = n, io = G.index.length;
  const up = [0, 0, 0], ta = [0, 0, 0], bp = [0, 0, 0];
  const partSp = kind === 'glow' ? 0.05 : kind === 'metal' ? 0.5 : kind === 'frost' ? 0.7 : 0.3;

  // boulders: small faceted rocks sunk into the surface
  for (let q = 0; q < bl.length; q++) {
    const B = bl[q], g = getGeodesic(bFreq[q]), rnd = mulberry32(B.seed);
    place(B.x, B.y, B.z, ev(B.x, B.y, B.z, edge), bp, 0);
    const px = bp[0], py = bp[1], pz = bp[2];
    up[0] = B.x; up[1] = B.y; up[2] = B.z;
    perp(B.x, B.y, B.z, ta);
    const a = rnd() * Math.PI * 2, ca = Math.cos(a), sn = Math.sin(a);
    const bx = up[1] * ta[2] - up[2] * ta[1], by = up[2] * ta[0] - up[0] * ta[2], bz = up[0] * ta[1] - up[1] * ta[0];
    const t1x = ta[0] * ca + bx * sn, t1y = ta[1] * ca + by * sn, t1z = ta[2] * ca + bz * sn;
    const t2x = up[1] * t1z - up[2] * t1y, t2y = up[2] * t1x - up[0] * t1z, t2z = up[0] * t1y - up[1] * t1x;
    const sx = 0.5 * B.size * (0.8 + rnd() * 0.5), sy = 0.5 * B.size * (0.55 + rnd() * 0.45), sz = 0.5 * B.size * (0.7 + rnd() * 0.5);
    const sink = B.sink * B.size * 0.5;
    const k = 0.3 + rnd() * 0.5;
    const cr = (P.base[0] + (P.high[0] - P.base[0]) * k) * B.tone, cg = (P.base[1] + (P.high[1] - P.base[1]) * k) * B.tone, cb = (P.base[2] + (P.high[2] - P.base[2]) * k) * B.tone;
    for (let i = 0; i < g.count; i++) {
      const jr = 0.66 + rnd() * 0.5;
      const lx = g.dirs[i * 3] * jr * sx, ly = g.dirs[i * 3 + 1] * jr * sy, lz = g.dirs[i * 3 + 2] * jr * sz;
      const w = vo + i;
      pos[w * 3] = px + t1x * lx + up[0] * (ly - sink) + t2x * lz;
      pos[w * 3 + 1] = py + t1y * lx + up[1] * (ly - sink) + t2y * lz;
      pos[w * 3 + 2] = pz + t1z * lx + up[2] * (ly - sink) + t2z * lz;
      const h = clamp(0.5 + 0.5 * g.dirs[i * 3 + 1], 0, 1), sh = (0.5 + 0.62 * h) * (0.9 + rnd() * 0.2);
      col[w * 3] = clamp(cr * sh, 0, 0.86); col[w * 3 + 1] = clamp(cg * sh, 0, 0.86); col[w * 3 + 2] = clamp(cb * sh, 0, 0.86);
      rock[w * 4] = 1; rock[w * 4 + 1] = 0.45 + 0.55 * h; rock[w * 4 + 2] = partSp; rock[w * 4 + 3] = 0;
    }
    const gi = g.index;
    for (let i = 0; i < gi.length; i++) index[io++] = gi[i] + vo;
    vo += g.count;
    if ((q & 7) === 7) yield;
  }
  yield;

  // big attached blocks: angular lumps with a few broken faces, half sunk — real overhangs where they meet the body.
  // Their shape is a function of direction, so every LOD shows the same block.
  for (let q = 0; q < megas.length; q++) {
    const B = megas[q], g = getGeodesic(mFreq), so = B.so;
    place(B.x, B.y, B.z, ev(B.x, B.y, B.z, edge), bp, 0);
    const px = bp[0], py = bp[1], pz = bp[2];
    up[0] = B.ux; up[1] = B.uy; up[2] = B.uz;
    perp(up[0], up[1], up[2], ta);
    const ca = Math.cos(B.roll), sn = Math.sin(B.roll);
    const bx = up[1] * ta[2] - up[2] * ta[1], by = up[2] * ta[0] - up[0] * ta[2], bz = up[0] * ta[1] - up[1] * ta[0];
    const t1x = ta[0] * ca + bx * sn, t1y = ta[1] * ca + by * sn, t1z = ta[2] * ca + bz * sn;
    const t2x = up[1] * t1z - up[2] * t1y, t2y = up[2] * t1x - up[0] * t1z, t2z = up[0] * t1y - up[1] * t1x;
    const sx = 0.5 * B.size * B.sq[0], sy = 0.5 * B.size * B.sq[1], sz = 0.5 * B.size * B.sq[2], sink = B.sink * B.size * 0.5;
    const flat = mFreq <= 4 ? 1 : 0.2;
    for (let i = 0; i < g.count; i++) {
      const dx = g.dirs[i * 3], dy = g.dirs[i * 3 + 1], dz = g.dirs[i * 3 + 2];
      let rr = 0.86 + 0.24 * nz(dx * 1.4 + so, dy * 1.4 + so * 0.7, dz * 1.4 + 3.1) + 0.1 * nz(dx * 3.6 + so, dy * 3.6 + 1.7, dz * 3.6 + so * 0.3);
      if (mFreq > 4) rr += 0.035 * nz(dx * 9 + so, dy * 9 + 5.5, dz * 9 + so);
      let cutM = 0, tone = 1;
      for (let c = 0; c < B.cuts.length; c++) {
        const C = B.cuts[c], dn = dx * C.x + dy * C.y + dz * C.z;
        if (dn > 0.1) { const cut = C.h / dn; if (rr > cut) { cutM = sstep(0, 0.04, rr - cut); tone = C.tone; rr = cut; } }
      }
      const lx = dx * rr * sx, ly = dy * rr * sy, lz = dz * rr * sz, w = vo + i;
      pos[w * 3] = px + t1x * lx + up[0] * (ly - sink) + t2x * lz;
      pos[w * 3 + 1] = py + t1y * lx + up[1] * (ly - sink) + t2y * lz;
      pos[w * 3 + 2] = pz + t1z * lx + up[2] * (ly - sink) + t2z * lz;
      const h = clamp((ly - sink) / sy * 0.5 + 0.5, 0, 1);
      const pa = sstep(-0.1, 0.4, nz(dx * 2.2 + so + 9, dy * 2.2 + 4, dz * 2.2 + so));
      const speck = nz(dx * 13 + so, dy * 13 + o[1], dz * 13 + o[2]);
      let r = P.base[0] + (P.tintA[0] - P.base[0]) * pa * 0.4, gg = P.base[1] + (P.tintA[1] - P.base[1]) * pa * 0.4, b = P.base[2] + (P.tintA[2] - P.base[2]) * pa * 0.4;
      let k = clamp(0.5 * sstep(0.45, 1, h) + cutM * 0.35, 0, 0.8);
      const hi = cutM > 0.5 ? P.fresh : P.high;
      r += (hi[0] - r) * k; gg += (hi[1] - gg) * k; b += (hi[2] - b) * k;
      const ao = clamp(0.3 + 1.1 * h, 0.3, 1);
      const m = B.tone * (1 + 0.14 * speck) * (0.6 + 0.4 * ao) * (1 + cutM * (tone - 1));
      col[w * 3] = clamp(r * m, 0, 0.86); col[w * 3 + 1] = clamp(gg * m, 0, 0.86); col[w * 3 + 2] = clamp(b * m, 0, 0.86);
      rock[w * 4] = Math.max(cutM, flat, spec.crisp); rock[w * 4 + 1] = ao; rock[w * 4 + 2] = kind === 'glow' ? 0.25 + 0.5 * pa : kind === 'ore' ? pa : partSp; rock[w * 4 + 3] = 0;
    }
    const gi = g.index;
    for (let i = 0; i < gi.length; i++) index[io++] = gi[i] + vo;
    vo += g.count;
    yield;
  }

  // crystal spires: six-sided prisms with a pointed tip, in clusters fanning out of the rock
  if (spires.length) {
    const oc = hex(spec.oreColor);
    for (let q = 0; q < spires.length; q++) {
      const Sp = spires[q];
      place(Sp.x, Sp.y, Sp.z, ev(Sp.x, Sp.y, Sp.z, edge), bp, 0);
      const axx = Sp.ax, axy = Sp.ay, axz = Sp.az;
      const bx0 = bp[0] - axx * Sp.len * 0.22, by0 = bp[1] - axy * Sp.len * 0.22, bz0 = bp[2] - axz * Sp.len * 0.22; // rooted in the rock
      perp(axx, axy, axz, ta);
      const ux = ta[0], uy = ta[1], uz = ta[2], vx = axy * uz - axz * uy, vy = axz * ux - axx * uz, vz = axx * uy - axy * ux;
      const L = Sp.len * 1.22, Ls = L * Sp.shoulder;
      for (let k = 0; k < 6; k++) {
        const a = Sp.roll + k * Math.PI / 3, c = Math.cos(a), s = Math.sin(a), rk = Sp.rad * (0.86 + 0.28 * hash1(Sp.roll * 7 + k * 3.3));
        const ox = (ux * c + vx * s) * rk, oy = (uy * c + vy * s) * rk, oz = (uz * c + vz * s) * rk;
        let w = vo + k;
        pos[w * 3] = bx0 + ox * 1.15; pos[w * 3 + 1] = by0 + oy * 1.15; pos[w * 3 + 2] = bz0 + oz * 1.15;
        w = vo + 6 + k;
        pos[w * 3] = bx0 + axx * Ls + ox * 0.9; pos[w * 3 + 1] = by0 + axy * Ls + oy * 0.9; pos[w * 3 + 2] = bz0 + axz * Ls + oz * 0.9;
      }
      const tx = (ux * Sp.tipU + vx * Sp.tipV) * Sp.rad, ty = (uy * Sp.tipU + vy * Sp.tipV) * Sp.rad, tz = (uz * Sp.tipU + vz * Sp.tipV) * Sp.rad;
      pos[(vo + 12) * 3] = bx0 + axx * L + tx; pos[(vo + 12) * 3 + 1] = by0 + axy * L + ty; pos[(vo + 12) * 3 + 2] = bz0 + axz * L + tz;
      pos[(vo + 13) * 3] = bx0 - axx * Sp.rad * 0.5; pos[(vo + 13) * 3 + 1] = by0 - axy * Sp.rad * 0.5; pos[(vo + 13) * 3 + 2] = bz0 - axz * Sp.rad * 0.5;
      for (let k = 0; k < 14; k++) {
        const w = vo + k, t = k < 6 ? 0.18 : k < 12 ? 0.75 : k === 12 ? 1 : 0, m = Sp.tone * (0.34 + 0.4 * t);
        col[w * 3] = clamp((P.base[0] * 0.25 + oc[0] * 0.75) * m, 0, 0.86); col[w * 3 + 1] = clamp((P.base[1] * 0.25 + oc[1] * 0.75) * m, 0, 0.86); col[w * 3 + 2] = clamp((P.base[2] * 0.25 + oc[2] * 0.75) * m, 0, 0.86);
        rock[w * 4] = 1; rock[w * 4 + 1] = 0.5 + 0.5 * t; rock[w * 4 + 2] = 1.25; rock[w * 4 + 3] = 0;
      }
      for (let k = 0; k < 6; k++) {
        const k1 = (k + 1) % 6, a = vo + k, b = vo + k1, c = vo + 6 + k, d = vo + 6 + k1;
        index[io++] = a; index[io++] = b; index[io++] = d; index[io++] = a; index[io++] = d; index[io++] = c;
        index[io++] = c; index[io++] = d; index[io++] = vo + 12;
        index[io++] = b; index[io++] = a; index[io++] = vo + 13;
      }
      vo += 14;
    }
    yield;
  }

  // smooth vertex normals (area weighted)
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nzz = e1x * e2y - e1y * e2x;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nzz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nzz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nzz;
    if (i % 24576 === 24573) yield;
  }
  yield;
  for (let i = 0; i < total * 3; i += 3) {
    const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]);
    if (l > 1e-20) { nor[i] /= l; nor[i + 1] /= l; nor[i + 2] /= l; } else {
      const pl = Math.hypot(pos[i], pos[i + 1], pos[i + 2]) || 1;
      nor[i] = pos[i] / pl; nor[i + 1] = pos[i + 1] / pl; nor[i + 2] = pos[i + 2] / pl;
    }
  }
  return { pos, nor, col, rock, index, count: total, baseCount: n };
}

// Static vertex data goes to the GPU packed (normals int16, colours uint16, masks uint8: 28 instead
// of 52 bytes per vertex) and the CPU copy is dropped as soon as it has been uploaded.
function packNor(a) { const n = a.length, o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = Math.round(clamp(a[i], -1, 1) * 32767); return o; }
function packCol(a) { const n = a.length, o = new Uint16Array(n); for (let i = 0; i < n; i++) o[i] = Math.round(clamp(a[i], 0, 1) * 65535); return o; }
// aRock = crease, occlusion, family mask (0..1.25, stored * 0.8), fresh-face flag
function packRock(a) { const n = a.length, o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Math.round(clamp((i & 3) === 2 ? a[i] * 0.8 : a[i], 0, 1) * 255); return o; }
function dropArray() { this.array = null; }
function staticAttr(THREE, arr, size, norm, keep) {
  const a = new THREE.BufferAttribute(arr, size, norm);
  if (!keep) a.onUpload(dropArray);
  return a;
}

function rockGeometry(THREE, d, keep) {
  const geo = new THREE.BufferGeometry();
  geo.setIndex(staticAttr(THREE, d.index, 1, false, keep));
  geo.setAttribute('position', staticAttr(THREE, d.pos, 3, false, keep));
  geo.setAttribute('normal', staticAttr(THREE, packNor(d.nor), 3, true, keep));
  geo.setAttribute('color', staticAttr(THREE, packCol(d.col), 3, true, keep));
  geo.setAttribute('aRock', staticAttr(THREE, packRock(d.rock), 4, true, keep));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/* ---------------------------- fracture geometry --------------------------- */

// Signed crossing count of the ray p → +z through a soup of closed, outward-wound shells (the rock
// body plus everything welded onto it): > 0 = inside at least one of them. Triangles are binned in xy.
function* genInsideTest(pos, index) {
  const nt = index.length / 3, nv = pos.length / 3;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < nv; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const G = clamp(Math.round(Math.sqrt(nt / 5)), 10, 72);
  const sx = G / (x1 - x0 + 1e-6), sy = G / (y1 - y0 + 1e-6);
  const start = new Uint32Array(G * G + 1), bb = new Uint8Array(nt * 4);
  for (let t = 0; t < nt; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ax = pos[a], bx = pos[b], cx = pos[c], ay = pos[a + 1], by = pos[b + 1], cy = pos[c + 1];
    const i0 = clamp(Math.floor((Math.min(ax, bx, cx) - x0) * sx), 0, G - 1), i1 = clamp(Math.floor((Math.max(ax, bx, cx) - x0) * sx), 0, G - 1);
    const j0 = clamp(Math.floor((Math.min(ay, by, cy) - y0) * sy), 0, G - 1), j1 = clamp(Math.floor((Math.max(ay, by, cy) - y0) * sy), 0, G - 1);
    bb[t * 4] = i0; bb[t * 4 + 1] = i1; bb[t * 4 + 2] = j0; bb[t * 4 + 3] = j1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * G + i + 1]++;
    if ((t & 8191) === 8191) yield;
  }
  for (let i = 0; i < G * G; i++) start[i + 1] += start[i];
  const fill = start.slice(0, G * G), list = new Uint32Array(start[G * G]);
  for (let t = 0; t < nt; t++) {
    for (let j = bb[t * 4 + 2]; j <= bb[t * 4 + 3]; j++) for (let i = bb[t * 4]; i <= bb[t * 4 + 1]; i++) list[fill[j * G + i]++] = t;
    if ((t & 8191) === 8191) yield;
  }
  return function (x, y, z) {
    const bi = Math.floor((x - x0) * sx), bj = Math.floor((y - y0) * sy);
    if (bi < 0 || bj < 0 || bi >= G || bj >= G) return 0;
    let w = 0;
    const e = start[bj * G + bi + 1];
    for (let k = start[bj * G + bi]; k < e; k++) {
      const t = list[k] * 3, a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
      const ax = pos[a] - x, ay = pos[a + 1] - y, bx = pos[b] - x, by = pos[b + 1] - y, cx = pos[c] - x, cy = pos[c + 1] - y;
      const e0 = ax * by - ay * bx, e1 = bx * cy - by * cx, e2 = cx * ay - cy * ax;
      if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) {
        const area = e0 + e1 + e2;
        if (area === 0) continue;
        if ((e1 * pos[a + 2] + e2 * pos[b + 2] + e0 * pos[c + 2]) / area > z) w += area > 0 ? 1 : -1;
      }
    }
    return w;
  };
}

// nearest seed through a coarse grid of candidate lists
function* genNearest(S, N, lo, hi) {
  const G = N > 150 ? 9 : N > 60 ? 6 : 4;
  const sx = G / (hi[0] - lo[0] + 1e-6), sy = G / (hi[1] - lo[1] + 1e-6), sz = G / (hi[2] - lo[2] + 1e-6);
  const hd = Math.hypot(1 / sx, 1 / sy, 1 / sz);
  const start = new Uint32Array(G * G * G + 1), tmp = [], dd = new Float64Array(N);
  for (let k = 0; k < G; k++) for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    if (i === 0 && (j & 3) === 0) yield;
    const cx = lo[0] + (i + 0.5) / sx, cy = lo[1] + (j + 0.5) / sy, cz = lo[2] + (k + 0.5) / sz;
    let dm = 1e9;
    for (let s = 0; s < N; s++) { const d = Math.hypot(S[s * 3] - cx, S[s * 3 + 1] - cy, S[s * 3 + 2] - cz); dd[s] = d; if (d < dm) dm = d; }
    for (let s = 0; s < N; s++) if (dd[s] <= dm + hd) tmp.push(s);
    start[(k * G + j) * G + i + 1] = tmp.length;
  }
  const list = Uint16Array.from(tmp);
  return function (x, y, z) {
    const i = clamp(Math.floor((x - lo[0]) * sx), 0, G - 1), j = clamp(Math.floor((y - lo[1]) * sy), 0, G - 1), k = clamp(Math.floor((z - lo[2]) * sz), 0, G - 1);
    const b = (k * G + j) * G + i, e = start[b + 1];
    let best = 1e9, bi = 0;
    for (let q = start[b]; q < e; q++) {
      const s = list[q], dx = S[s * 3] - x, dy = S[s * 3 + 1] - y, dz = S[s * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bi = s; }
    }
    return bi;
  };
}

// keep the part of a flat polygon with n·x <= d; crossing points are also pushed to `cap`
function clipFlat(p, nx, ny, nz, d, cap) {
  const m = p.length / 3;
  let anyIn = false, anyOut = false;
  for (let k = 0; k < m; k++) { if (p[k * 3] * nx + p[k * 3 + 1] * ny + p[k * 3 + 2] * nz - d > 0) anyOut = true; else anyIn = true; }
  if (!anyOut) return p;
  if (!anyIn) return [];
  const out = [];
  let px = p[(m - 1) * 3], py = p[(m - 1) * 3 + 1], pz = p[(m - 1) * 3 + 2], pd = px * nx + py * ny + pz * nz - d;
  for (let k = 0; k < m; k++) {
    const cx = p[k * 3], cy = p[k * 3 + 1], cz = p[k * 3 + 2], cd = cx * nx + cy * ny + cz * nz - d;
    if ((pd <= 0) !== (cd <= 0)) {
      const t = pd / (pd - cd), ix = px + (cx - px) * t, iy = py + (cy - py) * t, iz = pz + (cz - pz) * t;
      out.push(ix, iy, iz); cap.push(ix, iy, iz);
    }
    if (cd <= 0) out.push(cx, cy, cz);
    px = cx; py = cy; pz = cz; pd = cd;
  }
  return out;
}

// order coplanar points (normal n) by angle around their centroid, dropping duplicates
function sortRing(pts, nx, ny, nz, tol) {
  const m = pts.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < m; k++) { cx += pts[k * 3]; cy += pts[k * 3 + 1]; cz += pts[k * 3 + 2]; }
  cx /= m; cy /= m; cz /= m;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ny) > 0.8) { ux = 1; uy = 0; }
  let d = ux * nx + uy * ny + uz * nz;
  ux -= nx * d; uy -= ny * d; uz -= nz * d;
  d = Math.hypot(ux, uy, uz); ux /= d; uy /= d; uz /= d;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const ord = [];
  for (let k = 0; k < m; k++) {
    const x = pts[k * 3] - cx, y = pts[k * 3 + 1] - cy, z = pts[k * 3 + 2] - cz;
    ord.push({ a: Math.atan2(x * vx + y * vy + z * vz, x * ux + y * uy + z * uz), k });
  }
  ord.sort((p, q) => p.a - q.a);
  const out = [];
  for (let i = 0; i < m; i++) {
    const k = ord[i].k * 3, n = out.length;
    if (n && (pts[k] - out[n - 3]) ** 2 + (pts[k + 1] - out[n - 2]) ** 2 + (pts[k + 2] - out[n - 1]) ** 2 < tol) continue;
    out.push(pts[k], pts[k + 1], pts[k + 2]);
  }
  const n = out.length;
  if (n > 3 && (out[0] - out[n - 3]) ** 2 + (out[1] - out[n - 2]) ** 2 + (out[2] - out[n - 1]) ** 2 < tol) out.length = n - 3;
  out.cx = cx; out.cy = cy; out.cz = cz;
  return out;
}

// Voronoi cell of seed i as a convex polyhedron: [{ j: neighbour seed (or < 0 = bounding box), p: flat polygon }]
function voronoiCell(i, S, order, B) {
  const sx = S[i * 3], sy = S[i * 3 + 1], sz = S[i * 3 + 2];
  let faces = [
    { j: -1, p: [-B, -B, -B, -B, -B, B, -B, B, B, -B, B, -B] }, { j: -1, p: [B, -B, -B, B, B, -B, B, B, B, B, -B, B] },
    { j: -1, p: [-B, -B, -B, B, -B, -B, B, -B, B, -B, -B, B] }, { j: -1, p: [-B, B, -B, -B, B, B, B, B, B, B, B, -B] },
    { j: -1, p: [-B, -B, -B, -B, B, -B, B, B, -B, B, -B, -B] }, { j: -1, p: [-B, -B, B, B, -B, B, B, B, B, -B, B, B] },
  ];
  let maxR2 = 12 * B * B;
  for (let oi = 0; oi < order.length; oi++) {
    const j = order[oi];
    if (j === i) continue;
    const dx = S[j * 3] - sx, dy = S[j * 3 + 1] - sy, dz = S[j * 3 + 2] - sz, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 4 * maxR2) break; // its bisector lies beyond the farthest corner
    const dd = dx * (sx + S[j * 3]) * 0.5 + dy * (sy + S[j * 3 + 1]) * 0.5 + dz * (sz + S[j * 3 + 2]) * 0.5;
    const cap = [], nf = [];
    let cut = false;
    for (let f = 0; f < faces.length; f++) {
      const F = faces[f], out = clipFlat(F.p, dx, dy, dz, dd, cap);
      if (out !== F.p) cut = true;
      if (out.length >= 9) nf.push(out === F.p ? F : { j: F.j, p: out });
    }
    if (!cut) continue;
    if (cap.length >= 9) { const cp = sortRing(cap, dx, dy, dz, 1e-14); if (cp.length >= 9) nf.push({ j, p: cp }); }
    faces = nf;
    maxR2 = 0;
    for (let f = 0; f < faces.length; f++) {
      const p = faces[f].p;
      for (let k = 0; k < p.length; k += 3) { const r2 = (p[k] - sx) ** 2 + (p[k + 1] - sy) ** 2 + (p[k + 2] - sz) ** 2; if (r2 > maxR2) maxR2 = r2; }
    }
  }
  return faces;
}

// drop ring points that sit (almost) on the chord between their neighbours — a dense skin cut needs no more
function thinRing(r, tol) {
  let n = r.length / 3;
  if (n <= 6) return r;
  const out = [], t2 = tol * tol;
  let ax = r[(n - 1) * 3], ay = r[(n - 1) * 3 + 1], az = r[(n - 1) * 3 + 2];
  for (let k = 0; k < n; k++) {
    const bx = r[k * 3], by = r[k * 3 + 1], bz = r[k * 3 + 2], q = ((k + 1) % n) * 3;
    const ex = r[q] - ax, ey = r[q + 1] - ay, ez = r[q + 2] - az, el = ex * ex + ey * ey + ez * ez;
    const px = bx - ax, py = by - ay, pz = bz - az;
    const t = el > 1e-16 ? clamp((px * ex + py * ey + pz * ez) / el, 0, 1) : 0;
    const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
    if (dx * dx + dy * dy + dz * dz < t2 && el < 0.0036) continue; // dropped: the chord from the last kept point stands in for it
    out.push(bx, by, bz); ax = bx; ay = by; az = bz;
  }
  out.cx = r.cx; out.cy = r.cy; out.cz = r.cz;
  return out.length >= 9 ? out : r;
}

function growArr(a, n) { const g = new a.constructor(n); g.set(a); return g; }

// Cuts a surface LOD (the very mesh the rock is drawn with, boulders and all) into the cells of a
// 3D Voronoi diagram of seeds scattered through its volume. Every cell is a closed convex-ish solid:
// the rock's own skin where it reaches the surface (triangles clipped along the planar cuts, so the
// cracks are straight, not triangle-edge zigzags) and flat fresh fracture faces everywhere else, all
// the way to the core. Cells are grouped into clusters that separate first and split a moment later.
// Per vertex: aCid = cell index; per cell (float texture): centroid + random, cluster centroid + random
// (+1 = splits a little later), final scale (so that nothing stays larger than FRAC_LIMIT) + tone.
function* genFracture(vr, d, level) {
  const spec = vr.spec, P = d.pos, idx = d.index, nV = d.count, nT = idx.length / 3, pal = vr.pal;
  const rnd = mulberry32(spec.seed * 131 + level * 977 + 5);
  const inside = yield* genInsideTest(P, idx);
  yield;

  // fracture space q = p + fk (p·a) a: isotropic cells there are slabs (fk > 0) or shards (fk < 0) here
  const fa = vr.strataAxis, fk = spec.fracStretch - 1, fki = -fk / (1 + fk);
  let Q = P;
  if (fk) {
    Q = new Float32Array(nV * 3);
    for (let i = 0; i < nV; i++) {
      const s = fk * (P[i * 3] * fa[0] + P[i * 3 + 1] * fa[1] + P[i * 3 + 2] * fa[2]);
      Q[i * 3] = P[i * 3] + s * fa[0]; Q[i * 3 + 1] = P[i * 3 + 1] + s * fa[1]; Q[i * 3 + 2] = P[i * 3 + 2] + s * fa[2];
    }
  }
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], plo = [1e9, 1e9, 1e9], phi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < nV * 3; i++) {
    const k = i % 3;
    if (Q[i] < lo[k]) lo[k] = Q[i]; if (Q[i] > hi[k]) hi[k] = Q[i];
    if (P[i] < plo[k]) plo[k] = P[i]; if (P[i] > phi[k]) phi[k] = P[i];
  }

  // seeds: random points inside the rock, best of a few candidates (even enough to bound the cell size,
  // irregular enough to give a range of chunk sizes)
  const want = FRAC_CELLS[level];
  const S = new Float64Array(want * 3);
  let N = 0, guard = 0;
  while (N < want && guard < want * 600) {
    let best = -1, bx = 0, by = 0, bz = 0;
    for (let t = 0; t < 7; t++) {
      let x = 0, y = 0, z = 0, ok = false;
      for (let k = 0; k < 60 && !ok; k++) {
        guard++;
        x = plo[0] + rnd() * (phi[0] - plo[0]); y = plo[1] + rnd() * (phi[1] - plo[1]); z = plo[2] + rnd() * (phi[2] - plo[2]);
        ok = inside(x + 1.3e-7, y + 2.9e-7, z) > 0;
      }
      if (!ok) continue;
      const s = fk * (x * fa[0] + y * fa[1] + z * fa[2]);
      x += s * fa[0]; y += s * fa[1]; z += s * fa[2];
      let near = 1e9;
      for (let k = 0; k < N; k++) { const dd = (S[k * 3] - x) ** 2 + (S[k * 3 + 1] - y) ** 2 + (S[k * 3 + 2] - z) ** 2; if (dd < near) near = dd; }
      if (near > best) { best = near; bx = x; by = y; bz = z; }
    }
    if (best < 0) break;
    S[N * 3] = bx; S[N * 3 + 1] = by; S[N * 3 + 2] = bz; N++;
    if ((N & 15) === 15) yield;
  }

  // Voronoi polyhedra
  const B = 2.5 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const faces = new Array(N), dist = new Float64Array(N), ordAll = [];
  for (let i = 0; i < N; i++) ordAll.push(i);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) dist[j] = (S[j * 3] - S[i * 3]) ** 2 + (S[j * 3 + 1] - S[i * 3 + 1]) ** 2 + (S[j * 3 + 2] - S[i * 3 + 2]) ** 2;
    faces[i] = voronoiCell(i, S, ordAll.slice().sort((a, b) => dist[a] - dist[b]), B);
    if ((i & 3) === 3) yield;
  }

  // vertex → cell
  const nearest = yield* genNearest(S, N, lo, hi);
  const vCell = new Uint16Array(nV);
  for (let v = 0; v < nV; v++) {
    vCell[v] = nearest(Q[v * 3], Q[v * 3 + 1], Q[v * 3 + 2]);
    if ((v & 1023) === 1023) yield;
  }
  // skin that is buried inside another shell (the sunk part of a boulder, the ground under it) is dropped
  let buried = null;
  if (d.count > d.baseCount) {
    buried = new Uint8Array(nV);
    const N3 = d.nor;
    for (let v = 0; v < nV; v++) {
      if (inside(P[v * 3] + N3[v * 3] * 0.006 + 1.3e-7, P[v * 3 + 1] + N3[v * 3 + 1] * 0.006 + 2.9e-7, P[v * 3 + 2] + N3[v * 3 + 2] * 0.006) > 0) buried[v] = 1;
      if ((v & 511) === 511) yield;
    }
  }

  // output, grown on demand
  let cap = nV * 4 + 8192, vc = 0, icap = nT * 9 + 8192, ic = 0;
  let oP = new Float32Array(cap * 3), oN = new Float32Array(cap * 3), oC = new Float32Array(cap * 3), oR = new Float32Array(cap * 4), oI = new Uint16Array(cap), oX = new Uint32Array(icap);
  const addV = (x, y, z, nx, ny, nz, r, g, b, r0, r1, r2, r3, c) => {
    if (vc === cap) { cap *= 2; oP = growArr(oP, cap * 3); oN = growArr(oN, cap * 3); oC = growArr(oC, cap * 3); oR = growArr(oR, cap * 4); oI = growArr(oI, cap); }
    const w = vc++;
    oP[w * 3] = x; oP[w * 3 + 1] = y; oP[w * 3 + 2] = z; oN[w * 3] = nx; oN[w * 3 + 1] = ny; oN[w * 3 + 2] = nz;
    oC[w * 3] = r; oC[w * 3 + 1] = g; oC[w * 3 + 2] = b; oR[w * 4] = r0; oR[w * 4 + 1] = r1; oR[w * 4 + 2] = r2; oR[w * 4 + 3] = r3; oI[w] = c;
    return w;
  };
  const tri = (a, b, c) => {
    if (ic + 3 > icap) { icap *= 2; oX = growArr(oX, icap); }
    oX[ic++] = a; oX[ic++] = b; oX[ic++] = c;
  };
  const dN = d.nor, dC = d.col, dR = d.rock;
  const vmap = new Map(), emap = new Map(), facePts = new Map();
  const vs = new Int32Array(nV * 4).fill(-1); // per vertex: (cell, copy) x 2, further copies in the Map
  const shared = (c, v) => {
    const o = v * 4;
    if (vs[o] === c) return vs[o + 1];
    if (vs[o + 2] === c) return vs[o + 3];
    const slot = vs[o] < 0 ? o : vs[o + 2] < 0 ? o + 2 : -1, key = c * nV + v;
    let w = slot < 0 ? vmap.get(key) : undefined;
    if (w === undefined) {
      w = addV(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], dN[v * 3], dN[v * 3 + 1], dN[v * 3 + 2], dC[v * 3], dC[v * 3 + 1], dC[v * 3 + 2], dR[v * 4], dR[v * 4 + 1], dR[v * 4 + 2], 0, c);
      if (slot >= 0) { vs[slot] = c; vs[slot + 1] = w; } else vmap.set(key, w);
    }
    return w;
  };
  const rec = (c, j, x, y, z) => {
    const key = c * 4096 + j;
    let a = facePts.get(key);
    if (!a) facePts.set(key, a = []);
    a.push(x, y, z);
  };

  // skin: whole triangles where all three corners are in one cell (cells are convex), clipped otherwise
  const bufA = new Float64Array(24 * 9), bufB = new Float64Array(24 * 9);
  const cand = [], cstamp = new Int32Array(N).fill(-1);
  // polygon stride 9: barycentrics (3), fracture-space position (3), up to three cut planes it lies on (neighbour ids, -1 = none)
  const clipPoly = (src, n, dst, nx, ny, nz, dd, tag) => {
    let m = 0, po = (n - 1) * 9, pd = src[po + 3] * nx + src[po + 4] * ny + src[po + 5] * nz - dd;
    for (let k = 0; k < n; k++) {
      const co = k * 9, cd = src[co + 3] * nx + src[co + 4] * ny + src[co + 5] * nz - dd;
      if ((pd <= 0) !== (cd <= 0) && m < 23) {
        const t = pd / (pd - cd), o = m * 9;
        for (let q = 0; q < 6; q++) dst[o + q] = src[po + q] + (src[co + q] - src[po + q]) * t;
        // planes shared by both ends, then this one
        let nt = 0;
        for (let q = 6; q < 9; q++) {
          const tg = src[po + q];
          if (tg >= 0 && (tg === src[co + 6] || tg === src[co + 7] || tg === src[co + 8]) && nt < 2) dst[o + 6 + nt++] = tg;
        }
        dst[o + 6 + nt++] = tag;
        while (nt < 3) dst[o + 6 + nt++] = -1;
        m++;
      }
      if (cd <= 0 && m < 23) { const o = m * 9; for (let q = 0; q < 9; q++) dst[o + q] = src[co + q]; m++; }
      po = co; pd = cd;
    }
    return m;
  };
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (buried && buried[a] && buried[b] && buried[c]) continue;
    const ca = vCell[a], cb = vCell[b], cc = vCell[c];
    if (ca === cb && cb === cc) { tri(shared(ca, a), shared(ca, b), shared(ca, c)); continue; }
    // candidate cells: the corners' cells and their neighbours
    cand.length = 0;
    for (let k = 0; k < 3; k++) {
      const c0 = k === 0 ? ca : k === 1 ? cb : cc;
      if (cstamp[c0] !== t) { cstamp[c0] = t; cand.push(c0); }
      const F = faces[c0];
      for (let f = 0; f < F.length; f++) { const j = F[f].j; if (j >= 0 && cstamp[j] !== t) { cstamp[j] = t; cand.push(j); } }
    }
    const ax = Q[a * 3], ay = Q[a * 3 + 1], az = Q[a * 3 + 2], bx = Q[b * 3], by = Q[b * 3 + 1], bz = Q[b * 3 + 2], cx = Q[c * 3], cy = Q[c * 3 + 1], cz = Q[c * 3 + 2];
    for (let ci = 0; ci < cand.length; ci++) {
      const cell = cand[ci], F = faces[cell], sx = S[cell * 3], sy = S[cell * 3 + 1], sz = S[cell * 3 + 2];
      let src = bufA, dst = bufB, n = 3;
      src[0] = 1; src[1] = 0; src[2] = 0; src[3] = ax; src[4] = ay; src[5] = az; src[6] = -1; src[7] = -1; src[8] = -1;
      src[9] = 0; src[10] = 1; src[11] = 0; src[12] = bx; src[13] = by; src[14] = bz; src[15] = -1; src[16] = -1; src[17] = -1;
      src[18] = 0; src[19] = 0; src[20] = 1; src[21] = cx; src[22] = cy; src[23] = cz; src[24] = -1; src[25] = -1; src[26] = -1;
      for (let f = 0; f < F.length && n >= 3; f++) {
        const j = F[f].j;
        if (j < 0) continue;
        const nx = S[j * 3] - sx, ny = S[j * 3 + 1] - sy, nz = S[j * 3 + 2] - sz;
        const dd = nx * (sx + S[j * 3]) * 0.5 + ny * (sy + S[j * 3 + 1]) * 0.5 + nz * (sz + S[j * 3 + 2]) * 0.5;
        let out = 0;
        for (let k = 0; k < n; k++) if (src[k * 9 + 3] * nx + src[k * 9 + 4] * ny + src[k * 9 + 5] * nz - dd > 0) out++;
        if (out === 0) continue;
        if (out === n) { n = 0; break; }
        n = clipPoly(src, n, dst, nx, ny, nz, dd, j);
        const sw = src; src = dst; dst = sw;
      }
      if (n < 3) continue;
      let i0 = -1, ip = -1;
      for (let k = 0; k < n; k++) {
        const o = k * 9, w0 = src[o], w1 = src[o + 1], w2 = src[o + 2];
        let vi;
        if (w0 > 1 - 1e-7) vi = shared(cell, a); else if (w1 > 1 - 1e-7) vi = shared(cell, b); else if (w2 > 1 - 1e-7) vi = shared(cell, c);
        else {
          const t1 = src[o + 6], t2 = src[o + 7], t3 = src[o + 8];
          let key = -1;
          if (t1 >= 0 && t2 < 0) {
            // a point on one edge of the triangle: shared with the neighbouring triangle
            let e0 = -1, e1 = -1;
            if (w0 < 1e-9) { e0 = b; e1 = c; } else if (w1 < 1e-9) { e0 = a; e1 = c; } else if (w2 < 1e-9) { e0 = a; e1 = b; }
            if (e0 >= 0) { if (e0 > e1) { const s = e0; e0 = e1; e1 = s; } key = ((e0 * nV + e1) * N + cell) * 1024 + t1; }
          }
          vi = key >= 0 ? emap.get(key) : undefined;
          if (vi === undefined) {
            const x = P[a * 3] * w0 + P[b * 3] * w1 + P[c * 3] * w2, y = P[a * 3 + 1] * w0 + P[b * 3 + 1] * w1 + P[c * 3 + 1] * w2, z = P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[c * 3 + 2] * w2;
            let nx = dN[a * 3] * w0 + dN[b * 3] * w1 + dN[c * 3] * w2, ny = dN[a * 3 + 1] * w0 + dN[b * 3 + 1] * w1 + dN[c * 3 + 1] * w2, nz = dN[a * 3 + 2] * w0 + dN[b * 3 + 2] * w1 + dN[c * 3 + 2] * w2;
            const nl = Math.hypot(nx, ny, nz) || 1;
            vi = addV(x, y, z, nx / nl, ny / nl, nz / nl,
              dC[a * 3] * w0 + dC[b * 3] * w1 + dC[c * 3] * w2, dC[a * 3 + 1] * w0 + dC[b * 3 + 1] * w1 + dC[c * 3 + 1] * w2, dC[a * 3 + 2] * w0 + dC[b * 3 + 2] * w1 + dC[c * 3 + 2] * w2,
              dR[a * 4] * w0 + dR[b * 4] * w1 + dR[c * 4] * w2, dR[a * 4 + 1] * w0 + dR[b * 4 + 1] * w1 + dR[c * 4 + 1] * w2, dR[a * 4 + 2] * w0 + dR[b * 4 + 2] * w1 + dR[c * 4 + 2] * w2, 0, cell);
            if (key >= 0) emap.set(key, vi);
            if (t1 >= 0) rec(cell, t1, x, y, z);
            if (t2 >= 0) rec(cell, t2, x, y, z);
            if (t3 >= 0) rec(cell, t3, x, y, z);
          }
        }
        if (k === 0) i0 = vi; else if (k >= 2 && vi !== ip && vi !== i0 && ip !== i0) tri(i0, ip, vi);
        ip = vi;
      }
    }
    if ((t & 255) === 255) yield;
  }
  const skinTris = ic / 3;

  // fresh fracture faces: each Voronoi face, limited to the inside of the rock — the face's corners that
  // are inside plus the points where the skin was cut by this plane, ordered around their centre
  const kind = spec.special;
  const innerSp = kind === 'glow' ? 0.9 : kind === 'metal' ? 0.9 : kind === 'frost' ? 0.15 : 0.6;
  const fr = [(pal.base[0] + pal.fresh[0]) * 0.5, (pal.base[1] + pal.fresh[1]) * 0.5, (pal.base[2] + pal.fresh[2]) * 0.5];
  const pts = [];
  for (let c = 0; c < N; c++) {
    const F = faces[c];
    for (let f = 0; f < F.length; f++) {
      const j = F[f].j;
      if (j < 0) continue;
      const vp = F[f].p, m = vp.length / 3;
      pts.length = 0;
      for (let k = 0; k < m; k++) {
        let x = vp[k * 3], y = vp[k * 3 + 1], z = vp[k * 3 + 2];
        if (fk) { const s = fki * (x * fa[0] + y * fa[1] + z * fa[2]); x += s * fa[0]; y += s * fa[1]; z += s * fa[2]; }
        if (inside(x + 1.3e-7, y + 2.9e-7, z) > 0) pts.push(x, y, z);
      }
      const sk = facePts.get(c * 4096 + j);
      if (sk) for (let k = 0; k < sk.length; k++) pts.push(sk[k]);
      if (pts.length < 9) continue;
      // real-space normal of the cut, pointing out of the cell
      let nx = S[j * 3] - S[c * 3], ny = S[j * 3 + 1] - S[c * 3 + 1], nz = S[j * 3 + 2] - S[c * 3 + 2];
      if (fk) { const s = fk * (nx * fa[0] + ny * fa[1] + nz * fa[2]); nx += s * fa[0]; ny += s * fa[1]; nz += s * fa[2]; }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const ring = thinRing(sortRing(pts, nx, ny, nz, 1e-10), 0.0016), rn = ring.length / 3;
      if (rn < 3) continue;
      const tone = 0.62 + 0.5 * hash1(c * 7.13 + j * 3.71 + spec.seed);
      const cr = clamp(fr[0] * tone, 0, 0.86), cg = clamp(fr[1] * tone, 0, 0.86), cb = clamp(fr[2] * tone, 0, 0.86);
      const v0 = addV(ring.cx, ring.cy, ring.cz, nx, ny, nz, cr, cg, cb, 0, 1, innerSp, 1, c);
      for (let k = 0; k < rn; k++) addV(ring[k * 3], ring[k * 3 + 1], ring[k * 3 + 2], nx, ny, nz, cr, cg, cb, 0, 1, innerSp, 1, c);
      for (let k = 0; k < rn; k++) {
        // a long outer edge may bridge a hollow of the outline (the face is not star-shaped there): skip the wedge if it is outside the rock
        const k1 = (k + 1) % rn, mx = (ring[k * 3] + ring[k1 * 3]) * 0.5, my = (ring[k * 3 + 1] + ring[k1 * 3 + 1]) * 0.5, mz = (ring[k * 3 + 2] + ring[k1 * 3 + 2]) * 0.5;
        if ((ring[k * 3] - ring[k1 * 3]) ** 2 + (ring[k * 3 + 1] - ring[k1 * 3 + 1]) ** 2 + (ring[k * 3 + 2] - ring[k1 * 3 + 2]) ** 2 > 0.0004
          && inside(mx + (ring.cx - mx) * 0.12 + 1.3e-7, my + (ring.cy - my) * 0.12 + 2.9e-7, mz + (ring.cz - mz) * 0.12) <= 0) continue;
        tri(v0, v0 + 1 + k, v0 + 1 + k1);
      }
    }
    if (c & 1) yield;
  }

  // per-cell: centroid, size, final scale
  const cc = new Float64Array(N * 3), cn = new Uint32Array(N), crad = new Float32Array(N);
  for (let w = 0; w < vc; w++) { const c = oI[w]; cc[c * 3] += oP[w * 3]; cc[c * 3 + 1] += oP[w * 3 + 1]; cc[c * 3 + 2] += oP[w * 3 + 2]; cn[c]++; }
  yield;
  for (let c = 0; c < N; c++) if (cn[c]) { cc[c * 3] /= cn[c]; cc[c * 3 + 1] /= cn[c]; cc[c * 3 + 2] /= cn[c]; }
  for (let w = 0; w < vc; w++) {
    const c = oI[w], r = Math.hypot(oP[w * 3] - cc[c * 3], oP[w * 3 + 1] - cc[c * 3 + 1], oP[w * 3 + 2] - cc[c * 3 + 2]);
    if (r > crad[c]) crad[c] = r;
  }
  yield;
  // clusters: a few cells picked far apart, every cell joins the nearest
  const nClus = Math.min(FRAC_CLUSTERS[level], N), ks = new Int32Array(nClus);
  for (let k = 0; k < nClus; k++) {
    let best = -1, bi = 0;
    for (let t = 0; t < (k === 0 ? 1 : 6); t++) {
      const c = (rnd() * N) | 0;
      let near = 1e9;
      for (let q = 0; q < k; q++) { const o = ks[q]; const dd = (cc[c * 3] - cc[o * 3]) ** 2 + (cc[c * 3 + 1] - cc[o * 3 + 1]) ** 2 + (cc[c * 3 + 2] - cc[o * 3 + 2]) ** 2; if (dd < near) near = dd; }
      if (near > best) { best = near; bi = c; }
    }
    ks[k] = bi;
  }
  const clusters = [];
  for (let k = 0; k < nClus; k++) clusters.push({ x: 0, y: 0, z: 0, n: 0, w: 0.02 + rnd() * 0.96, late: false, rad: 0 });
  const cellClus = new Uint16Array(N);
  for (let c = 0; c < N; c++) {
    if (!cn[c]) continue;
    let best = 1e9, bi = 0;
    for (let k = 0; k < nClus; k++) { const o = ks[k]; const dd = (cc[c * 3] - cc[o * 3]) ** 2 + (cc[c * 3 + 1] - cc[o * 3 + 1]) ** 2 + (cc[c * 3 + 2] - cc[o * 3 + 2]) ** 2; if (dd < best) { best = dd; bi = k; } }
    cellClus[c] = bi;
    const K = clusters[bi];
    K.x += cc[c * 3]; K.y += cc[c * 3 + 1]; K.z += cc[c * 3 + 2]; K.n++;
  }
  for (const K of clusters) if (K.n) { K.x /= K.n; K.y /= K.n; K.z /= K.n; }
  const bySize = clusters.filter((K) => K.n > 0).sort((a, b) => b.n - a.n);
  for (let i = 0; i < Math.min(2, bySize.length); i++) bySize[i].late = true;
  const tex = new Float32Array(N * 4 * 4);
  let maxCell = 0, maxPiece = 0, maxClus = 0;
  for (let c = 0; c < N; c++) {
    const K = clusters[cellClus[c]], dia = crad[c] * 2;
    if (!cn[c]) continue;
    const kr = Math.hypot(cc[c * 3] - K.x, cc[c * 3 + 1] - K.y, cc[c * 3 + 2] - K.z) + crad[c];
    if (kr > K.rad) K.rad = kr;
    // nothing stays larger than the limit; below it a spread of sizes
    const u = rnd(), shrink = Math.min(1, FRAC_LIMIT / Math.max(dia, 1e-4)) * (0.34 + 0.66 * Math.pow(u, 1.4));
    if (dia > maxCell) maxCell = dia;
    if (dia * shrink > maxPiece) maxPiece = dia * shrink;
    tex[c * 4] = cc[c * 3]; tex[c * 4 + 1] = cc[c * 3 + 1]; tex[c * 4 + 2] = cc[c * 3 + 2]; tex[c * 4 + 3] = 0.01 + rnd() * 0.98;
    let o = (N + c) * 4;
    tex[o] = K.x; tex[o + 1] = K.y; tex[o + 2] = K.z; tex[o + 3] = K.w + (K.late ? 1 : 0);
    o = (2 * N + c) * 4;
    tex[o] = shrink; tex[o + 1] = rnd(); tex[o + 2] = dia; tex[o + 3] = 0;
  }
  for (const K of clusters) if (K.rad * 2 > maxClus) maxClus = K.rad * 2;
  yield;
  // packed for the GPU here, a buffer per step, so that finishing the job costs nothing
  const pos = oP.slice(0, vc * 3);
  yield;
  const nor = packNor(oN.subarray(0, vc * 3));
  yield;
  const col = packCol(oC.subarray(0, vc * 3));
  yield;
  const rock = packRock(oR.subarray(0, vc * 4));
  yield;
  const index = vc > 65535 ? oX.slice(0, ic) : new Uint16Array(oX.subarray(0, ic));
  yield;
  return {
    pos, nor, col, rock, cid: oI.slice(0, vc), index, count: vc,
    cells: N, tex, clusters: clusters.filter((K) => K.n > 0), maxCell, maxPiece, maxClus, skinTris,
  };
}

/* --------------------------- debris geometries ---------------------------- */

// Angular, flat-shaded lump of freshly split rock, diameter 1. Vertex colour is a grey shade
// (multiplied by the per-instance palette colour); aRock.w marks the freshly cut faces.
function buildFragmentGeometry(THREE, seed, freq, axes, cuts) {
  const G = getGeodesic(freq);
  const rnd = mulberry32(seed);
  const n = G.count, dirs = G.dirs;
  const p = new Float32Array(n * 3);
  const cutMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = 0.6 + rnd() * 0.52;
    p[i * 3] = dirs[i * 3] * r; p[i * 3 + 1] = dirs[i * 3 + 1] * r; p[i * 3 + 2] = dirs[i * 3 + 2] * r;
  }
  const v = [0, 0, 0];
  for (let k = 0; k < cuts; k++) {
    randUnit(rnd, v);
    const h = 0.28 + rnd() * 0.3;
    for (let i = 0; i < n; i++) {
      const d = p[i * 3] * v[0] + p[i * 3 + 1] * v[1] + p[i * 3 + 2] * v[2];
      if (d > h) {
        const e = d - h;
        p[i * 3] -= v[0] * e; p[i * 3 + 1] -= v[1] * e; p[i * 3 + 2] -= v[2] * e;
        cutMask[i] |= 1 << k;
      }
    }
  }
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    p[i * 3] *= axes[0]; p[i * 3 + 1] *= axes[1]; p[i * 3 + 2] *= axes[2];
    cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const x = (p[i * 3] -= cx), y = (p[i * 3 + 1] -= cy), z = (p[i * 3 + 2] -= cz);
    max = Math.max(max, Math.sqrt(x * x + y * y + z * z));
  }
  const sc = 0.5 / max;
  const idx = G.index, tris = idx.length / 3;
  const pos = new Float32Array(tris * 9), nor = new Float32Array(tris * 9), col = new Float32Array(tris * 9), rock = new Float32Array(tris * 12);
  let w = 0;
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ax = p[a * 3] * sc, ay = p[a * 3 + 1] * sc, az = p[a * 3 + 2] * sc;
    const bx = p[b * 3] * sc, by = p[b * 3 + 1] * sc, bz = p[b * 3 + 2] * sc;
    const cx2 = p[c * 3] * sc, cy2 = p[c * 3 + 1] * sc, cz2 = p[c * 3 + 2] * sc;
    let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy2 - ay);
    let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az);
    let nzz = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    const nl = Math.sqrt(nx * nx + ny * ny + nzz * nzz);
    if (nl < 1e-10) continue; // drop faces collapsed by a cut
    nx /= nl; ny /= nl; nzz /= nl;
    const fresh = (cutMask[a] & cutMask[b] & cutMask[c]) !== 0;
    const shade = fresh ? 1.15 + rnd() * 0.35 : 0.58 + rnd() * 0.3;
    pos[w * 9] = ax; pos[w * 9 + 1] = ay; pos[w * 9 + 2] = az;
    pos[w * 9 + 3] = bx; pos[w * 9 + 4] = by; pos[w * 9 + 5] = bz;
    pos[w * 9 + 6] = cx2; pos[w * 9 + 7] = cy2; pos[w * 9 + 8] = cz2;
    for (let k = 0; k < 3; k++) {
      nor[w * 9 + k * 3] = nx; nor[w * 9 + k * 3 + 1] = ny; nor[w * 9 + k * 3 + 2] = nzz;
      col[w * 9 + k * 3] = shade; col[w * 9 + k * 3 + 1] = shade; col[w * 9 + k * 3 + 2] = shade;
      rock[w * 12 + k * 4] = 0; rock[w * 12 + k * 4 + 1] = 1; rock[w * 12 + k * 4 + 2] = 0.4; rock[w * 12 + k * 4 + 3] = fresh ? 1 : 0;
    }
    w++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, w * 9), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, w * 9), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col.slice(0, w * 9), 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rock.slice(0, w * 12), 4));
  geo.computeBoundingSphere();
  return geo;
}

/* -------------------------------- shaders -------------------------------- */

const GLSL_VERT_PARS = /* glsl */ `
attribute vec4 aRock;
varying vec3 vRockPos;
varying vec4 vRock;
varying vec3 vRockMacro;
varying float vRockBodyK;
uniform vec4 uRockScar[ 4 ];   // impact scars: xyz = object-space direction of the hit, w = angular radius (0 = free slot)
#ifdef ROCK_HEAT
  varying float vRockHeat;
#endif
#ifdef ROCK_DEBRIS
  attribute float aHeat;
#endif
#ifdef ROCK_SHATTER
  attribute float aCid;
  attribute vec4 aBurst;
  attribute vec4 aImp;
  uniform sampler2D uRockCells;  // per cell: row 0 centroid + random, row 1 cluster centroid + random (+1 = late), row 2 final scale, random
  varying vec4 vRockCell;
  vec3 rkH3( float n ) { return fract( sin( vec3( n, n + 1.31, n + 2.77 ) * vec3( 127.1, 311.7, 74.7 ) ) * 43758.5453 ); }
  vec3 rkRot( vec3 v, vec3 k, float a ) { float c = cos( a ), s = sin( a ); return v * c + cross( k, v ) * s + k * ( dot( k, v ) * ( 1.0 - c ) ); }
#endif
`;

// Fracture animation, all analytic in time (aBurst = age s, speed diam/s, life s, heat):
// the body dilates and its cracks open (clusters first, hairlines between cells), clusters push
// apart, and within ~120 ms every cluster has come apart into its cells, which crumble to their
// final size as they separate. The cluster part is mirrored on the CPU (Rocks3D._clusterOffset).
const GLSL_VERT_NORMAL = /* glsl */ `
#ifdef ROCK_SHATTER
  ivec2 rkTc = ivec2( int( aCid + 0.5 ), 0 );
  vec4 aCell = texelFetch( uRockCells, rkTc, 0 );
  vec4 aClus = texelFetch( uRockCells, rkTc + ivec2( 0, 1 ), 0 );
  vec4 rkCx = texelFetch( uRockCells, rkTc + ivec2( 0, 2 ), 0 );
  float rkT = aBurst.x;
  float rkOpen = smoothstep( 0.0, 0.075, rkT );
  float rkTm = max( 0.0, rkT - 0.045 );
  float rkGc = ( 1.0 - exp( - 2.1 * rkTm ) ) / 2.1;
  float rkC1 = fract( aClus.w ), rkC2 = fract( rkC1 * 7.31 ), rkC3 = fract( rkC1 * 13.77 );
  float rkLate = step( 1.0, aClus.w );
  float rkCl = length( aClus.xyz );
  vec3 rkCDir = aClus.xyz / max( rkCl, 1e-4 );
  float rkCoreK = clamp( rkCl / 0.3, 0.3, 1.0 );
  vec3 rkCOff = aClus.xyz * ( 0.075 * rkOpen ) + ( rkCDir * ( aBurst.y * ( 0.45 + 0.9 * rkC1 ) * rkCoreK ) + aImp.xyz * ( 0.4 + 0.8 * rkC2 ) ) * rkGc;
  vec3 rkCAxis = normalize( rkH3( rkC1 * 37.1 + 3.0 ) - 0.5 + 1e-4 );
  float rkCAng = ( rkC3 - 0.5 ) * 7.0 * rkGc;
  float rkCw = aCell.w;
  vec3 rkL = rkH3( rkCw * 57.3 + aImp.w );
  float rkTb = 0.05 + 0.045 * rkC2 + rkLate * 0.025;
  float rkTl = max( 0.0, rkT - rkTb );
  float rkGl = ( 1.0 - exp( - 2.4 * rkTl ) ) / 2.4;
  vec3 rkLRel = aCell.xyz - aClus.xyz;
  vec3 rkLDir = normalize( rkLRel + aCell.xyz * 0.4 + ( rkL - 0.5 ) * 0.22 + 1e-4 );
  vec3 rkLOff = rkLRel * ( 0.03 * rkOpen ) + rkLDir * ( aBurst.y * ( 0.3 + 0.7 * rkL.x ) * rkGl );
  vec3 rkLAxis = normalize( rkH3( rkCw * 13.9 + aImp.w + 7.0 ) - 0.5 + 1e-4 );
  float rkLAng = ( rkL.y - 0.5 ) * 18.0 * rkGl;
  float rkLife = aBurst.z * ( 0.45 + 0.55 * rkL.z );
  // pieces crumble to their own final size as they come apart (nothing stays above a quarter of the parent), then shrink away
  float rkShrink = ( 1.0 - smoothstep( rkLife - 0.42, rkLife, rkT ) ) * mix( 1.0, rkCx.x, smoothstep( 0.045, 0.118, rkT ) );
  objectNormal = rkRot( rkRot( objectNormal, rkLAxis, rkLAng ), rkCAxis, rkCAng );
#endif
`;

const GLSL_VERT_MAIN = /* glsl */ `
vRockPos = position;
vRock = aRock * vec4( 1.0, 1.0, 1.25, 1.0 );
vec3 rkMac = normalize( position + vec3( 1e-5 ) );
#ifdef ROCK_SHATTER
  vec3 rkp = aCell.xyz + rkRot( position - aCell.xyz, rkLAxis, rkLAng ) * rkShrink + rkLOff;
  transformed = aClus.xyz + rkRot( rkp - aClus.xyz, rkCAxis, rkCAng ) + rkCOff;
  vRockBodyK = 1.0 - smoothstep( 0.03, 0.2, rkT );
  vRockHeat = aBurst.w * aRock.w;
  vRockCell = vec4( aCell.xyz, rkCx.y );
#elif defined( ROCK_DEBRIS )
  vRockBodyK = 0.0;
  vRockHeat = aHeat * mix( 0.3, 1.0, aRock.w );
#else
  vRockBodyK = 1.0;
  // impact scars are real dents (the fragment shader shades the same bowl)
  for ( int i = 0; i < 4; i ++ ) {
    float sr = uRockScar[ i ].w;
    if ( sr > 0.0 ) {
      float t = acos( clamp( dot( rkMac, uRockScar[ i ].xyz ), -1.0, 1.0 ) ) / sr;
      if ( t < 1.6 ) {
        float bowl = 1.0 - smoothstep( 0.0, 1.0, t );
        float rq = ( t - 1.05 ) / 0.18;
        transformed -= rkMac * ( length( position ) * sr * ( 0.44 * bowl - 0.08 * exp( - rq * rq ) ) );
      }
    }
  }
#endif
#ifdef USE_INSTANCING
  rkMac = mat3( instanceMatrix ) * rkMac;
#endif
vRockMacro = normalMatrix * rkMac;
`;

const GLSL_FRAG_PARS = /* glsl */ `
varying vec3 vRockPos;
varying vec4 vRock;
varying vec3 vRockMacro;
varying float vRockBodyK;
uniform vec4 uRockBump;    // relief slope, pit depth, grain facets, master multiplier
uniform vec3 uRockFreq;    // base frequency (cycles per diameter), lacunarity, grains per diameter
uniform vec4 uRockMat;     // (unused), ambient, body shadow, sparkle gain
uniform vec4 uRockFx;      // ore amount, frost amount, cavity darkening, sparkle
uniform vec3 uRockOre;
uniform vec3 uRockSeed;
uniform vec4 uRockCell;    // grain cells per diameter, crack depth, tone variation, facet tilt
uniform vec3 uRockSun;     // world direction towards the key light
uniform vec3 uRockSunCol;  // its colour * intensity
uniform vec4 uRockFill;    // view-aligned fill colour, strength
uniform vec4 uRockRim;     // night-side rim colour, strength
uniform vec4 uRockBreak;   // fresh fracture faces: conchoidal ripples, striations, banding, dark core
uniform vec3 uRockAxis;    // bedding axis (object space)
uniform vec3 uRockFresh;   // colour of freshly broken rock
uniform vec4 uRockScar[ 4 ];
#ifdef ROCK_SHATTER
  varying vec4 vRockCell;
#endif
#ifdef ROCK_MAGMA
  uniform float uRockPulse;
  uniform float uRockMagma;
  uniform vec3 uRockCrack; // plates per diameter, joint half-width, plate bevel height
#endif
#ifdef ROCK_HEAT
  uniform vec2 uRockHot;   // glow gain, HDR ceiling
  varying float vRockHeat;
#endif

const mat3 rkR1 = mat3( 0.8, 0.36, -0.48, -0.6, 0.48, -0.64, 0.0, 0.8, 0.6 );
const mat3 rkR2 = mat3( 0.36, 0.48, 0.8, -0.8, 0.6, 0.0, -0.48, -0.64, 0.6 );
const mat3 rkR3 = mat3( 0.6, 0.0, 0.8, 0.64, 0.6, -0.48, -0.48, 0.8, 0.36 );

float rkHash( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
vec3 rkHash3( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
// gradient noise + analytic gradient: x = value ~0..1 (mean 0.5), yzw = d/dp
vec4 rkNoiseD( vec3 x ) {
  vec3 i = floor( x );
  vec3 w = fract( x );
  vec3 u = w * w * w * ( w * ( w * 6.0 - 15.0 ) + 10.0 );
  vec3 du = 30.0 * w * w * ( w * ( w - 2.0 ) + 1.0 );
  vec3 ga = rkHash3( i ) * 2.0 - 1.0;
  vec3 gb = rkHash3( i + vec3( 1.0, 0.0, 0.0 ) ) * 2.0 - 1.0;
  vec3 gc = rkHash3( i + vec3( 0.0, 1.0, 0.0 ) ) * 2.0 - 1.0;
  vec3 gd = rkHash3( i + vec3( 1.0, 1.0, 0.0 ) ) * 2.0 - 1.0;
  vec3 ge = rkHash3( i + vec3( 0.0, 0.0, 1.0 ) ) * 2.0 - 1.0;
  vec3 gf = rkHash3( i + vec3( 1.0, 0.0, 1.0 ) ) * 2.0 - 1.0;
  vec3 gg = rkHash3( i + vec3( 0.0, 1.0, 1.0 ) ) * 2.0 - 1.0;
  vec3 gh = rkHash3( i + vec3( 1.0, 1.0, 1.0 ) ) * 2.0 - 1.0;
  float va = dot( ga, w );
  float vb = dot( gb, w - vec3( 1.0, 0.0, 0.0 ) );
  float vc = dot( gc, w - vec3( 0.0, 1.0, 0.0 ) );
  float vd = dot( gd, w - vec3( 1.0, 1.0, 0.0 ) );
  float ve = dot( ge, w - vec3( 0.0, 0.0, 1.0 ) );
  float vf = dot( gf, w - vec3( 1.0, 0.0, 1.0 ) );
  float vg = dot( gg, w - vec3( 0.0, 1.0, 1.0 ) );
  float vh = dot( gh, w - vec3( 1.0, 1.0, 1.0 ) );
  float kxy = va - vb - vc + vd, kyz = va - vc - ve + vg, kzx = va - vb - ve + vf, kxyz = - va + vb + vc - vd + ve - vf - vg + vh;
  float v = va + u.x * ( vb - va ) + u.y * ( vc - va ) + u.z * ( ve - va ) + u.x * u.y * kxy + u.y * u.z * kyz + u.z * u.x * kzx + u.x * u.y * u.z * kxyz;
  vec3 g = ga + u.x * ( gb - ga ) + u.y * ( gc - ga ) + u.z * ( ge - ga ) + u.x * u.y * ( ga - gb - gc + gd ) + u.y * u.z * ( ga - gc - ge + gg ) + u.z * u.x * ( ga - gb - ge + gf )
    + u.x * u.y * u.z * ( - ga + gb + gc - gd + ge - gf - gg + gh )
    + du * ( vec3( vb, vc, ve ) - va + u.yzx * vec3( kxy, kyz, kzx ) + u.zxy * vec3( kzx, kxy, kyz ) + u.yzx * u.zxy * kxyz );
  return vec4( clamp( 0.5 + 0.62 * v, 0.0, 1.0 ), 0.9 * g );
}
// 3D Voronoi: x = F1, y = F2, id = nearest cell, g = gradient of (F2 - F1), r1 = vector to the nearest feature point
vec2 rkVoronoi( vec3 x, out vec3 id, out vec3 g, out vec3 r1 ) {
  vec3 p = floor( x ), f = fract( x );
  float d1 = 8.0, d2 = 8.0;
  vec3 r2 = vec3( 1.0 );
  r1 = vec3( 1.0 );
  id = p;
  for ( int k = -1; k <= 1; k ++ ) for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
    vec3 c = vec3( float( i ), float( j ), float( k ) );
    vec3 r = c + rkHash3( p + c ) - f;
    float d = dot( r, r );
    if ( d < d1 ) { d2 = d1; r2 = r1; d1 = d; r1 = r; id = p + c; } else if ( d < d2 ) { d2 = d; r2 = r; }
  }
  vec2 F = sqrt( vec2( d1, d2 ) );
  g = r1 / max( F.x, 1e-4 ) - r2 / max( F.y, 1e-4 );
  return F;
}
`;

// after <color_fragment>: procedural relief gradient + albedo detail
const GLSL_FRAG_COLOR = /* glsl */ `
vec3 rkP = vRockPos;
vec3 rkPx = dFdx( rkP );
vec3 rkPy = dFdy( rkP );
float rkFw = length( rkPx ) + length( rkPy ) + 1e-7;
vec3 rkG = vec3( 0.0 ), rkW0 = vec3( 0.0 );
float rkCav = 0.0, rkV1 = 0.5, rkN2 = 0.5, rkN3 = 0.5, rkN4 = 0.5, rkCryst = 0.0, rkFrost = 0.0, rkGlow = 0.0, rkScarHot = 0.0;
float rkInner = vRock.w;
#ifdef ROCK_SHATTER
  vec4 rkCellV = vRockCell;
#else
  vec4 rkCellV = vec4( 0.0 );
#endif
{
  // three octaves of gradient noise (broad undulation … grit) with a constant slope per octave; every octave lives
  // on a differently rotated lattice and is warped by the gradient of the one before; each fades out near pixel size
  float f = uRockFreq.x;
  float boost = 1.0 + 0.5 * rkInner;
  vec3 warp = vec3( 0.0 );
  for ( int i = 0; i < 3; i ++ ) {
    float a = 1.0 - smoothstep( 0.2, 0.5, rkFw * f );
    if ( a <= 0.0 ) break;
    vec3 q = i == 0 ? rkP : i == 1 ? rkR1 * rkP : rkR2 * rkP;
    vec4 n = rkNoiseD( q * f + warp + uRockSeed + float( i ) * 7.31 );
    vec3 g = i == 0 ? n.yzw : i == 1 ? n.yzw * rkR1 : n.yzw * rkR2;
    warp = n.yzw * 0.2;
    float w = i == 0 ? 0.3 : i == 1 ? 0.45 : 0.8;
    rkG += ( uRockBump.x * w * a * boost * ( i < 2 ? 1.0 - 0.85 * rkInner : 1.0 ) ) * g;
    if ( i == 0 ) { rkV1 = mix( 0.5, n.x, a ); rkW0 = g * a; }
    else if ( i == 1 ) rkN2 = mix( 0.5, n.x, a );
    else rkN4 = mix( 0.5, n.x, a );
    f *= i == 0 ? uRockFreq.y : uRockFreq.y * 1.7;
  }
}
{
  // grain: a fine Voronoi mosaic — every grain a tilted facet with a bevelled edge and its own tone. This, not
  // smooth noise, is what makes a close-up read as broken stone.
  float fg = uRockFreq.z;
  float ag = 1.0 - smoothstep( 0.2, 0.5, rkFw * fg );
  if ( ag > 0.0 ) {
    vec3 gid, gg, gr1;
    vec2 F = rkVoronoi( rkR3 * rkP * fg + uRockSeed.zxy + rkW0 * 0.25, gid, gg, gr1 );
    vec3 gh = rkHash3( gid + 4.1 );
    float t = clamp( ( F.y - F.x ) / 0.25, 0.0, 1.0 );
    rkG += ( ( gh - 0.5 ) * ( 0.5 + 0.9 * gh.y ) + ( gg * rkR3 ) * ( 0.7 * gh.z * t * ( 1.0 - t ) ) ) * ( uRockBump.z * ag * ( 1.0 + 0.4 * rkInner ) );
    rkN3 = mix( 0.5, gh.x, ag );
    rkCav += ( 1.0 - t ) * ( 1.0 - t ) * 0.1 * gh.z * ag * uRockBump.z;
  }
}
vec3 rkCid = vec3( 0.0 ), rkCr1 = vec3( 0.0 ), rkCh = vec3( 0.5 );
float rkCellA = 0.0;
#ifndef ROCK_MAGMA
{
  // mineral grains: every Voronoi cell is a slightly tilted plane with its own tone; some hold a round pit;
  // in patches the (warped, wandering) joints between cells open into cracks that pinch in and out
  float fc = uRockCell.x;
  float ac = 1.0 - smoothstep( 0.2, 0.5, rkFw * fc );
  if ( ac > 0.0 ) {
    vec3 cg;
    vec2 F = rkVoronoi( rkP * fc + uRockSeed.yzx + rkW0 * ( 0.4 * ( 1.0 - 0.8 * uRockFx.x ) ), rkCid, cg, rkCr1 );
    float e = F.y - F.x;
    rkCh = rkHash3( rkCid + 1.7 );
    rkCellA = ac;
    float skin = ( 1.0 - rkInner ) * ac;
    float cpatch = smoothstep( 0.5, 0.64, rkNoiseD( rkP * 2.1 + uRockSeed.zxy + 3.0 ).x );
    float wv = 0.015 + 0.11 * cpatch * smoothstep( 0.3, 0.62, rkN2 + 0.4 * ( rkV1 - 0.5 ) );
    float t = clamp( e / wv, 0.0, 1.0 );
    float crack = ( 1.0 - t * t * ( 3.0 - 2.0 * t ) ) * cpatch;
    rkG += ( uRockCell.y * skin * cpatch * 6.0 * t * ( 1.0 - t ) / 0.09 ) * cg + ( uRockCell.w * 0.35 * ac * ( 1.0 + rkInner ) ) * ( rkCh - 0.5 );
    rkCav += crack * skin * min( 1.0, uRockCell.y * 12.0 );
    // pits: steep little bowls of random size
    float pr = 0.1 + 0.17 * rkCh.z;
    float pm = step( 0.74, fract( rkCh.x * 7.7 + rkCh.z ) ) * skin;
    float pt = clamp( F.x / pr, 0.0, 1.0 );
    rkG -= rkCr1 * ( pm * uRockBump.y * 26.0 * pt * ( 1.0 - pt * pt ) / max( F.x, 0.02 ) );
    rkCav += pm * ( 1.0 - pt ) * ( 1.0 - pt ) * 0.6;
    diffuseColor.rgb *= 1.0 + uRockCell.z * ac * ( rkCh.x - 0.5 ) * 2.0;
  }
}
#endif
#ifdef ROCK_MAGMA
  float rkMagCore = 0.0, rkMagHalo = 0.0, rkPlate = 0.5, rkBev = 1.0;
  {
    vec3 q = rkP * uRockCrack.x + uRockSeed + rkW0 * 0.1;
    vec3 pid, pg, pr1;
    vec2 F = rkVoronoi( q, pid, pg, pr1 );
    float e = F.y - F.x;
    // joints swell and pinch along their length
    float w = uRockCrack.y * ( 0.55 + 0.9 * smoothstep( 0.3, 0.7, rkN2 ) );
    float ew = max( w, fwidth( e ) * 1.3 );
    rkMagCore = ( 1.0 - smoothstep( 0.0, ew, e ) ) * min( 1.0, 1.4 * w / ew );
    rkMagHalo = 1.0 - smoothstep( 0.0, w * 3.5, e );
    rkBev = smoothstep( 0.0, uRockCrack.y * 4.5, e );
    rkPlate = rkHash( pid + 3.7 );
    { float bt = clamp( e / ( uRockCrack.y * 4.5 ), 0.0, 1.0 ); rkG += ( uRockCrack.z * ( 1.0 - rkInner ) * 6.0 * bt * ( 1.0 - bt ) / ( uRockCrack.y * 4.5 ) ) * pg; }
    diffuseColor.rgb *= mix( 1.0, mix( 0.3, 0.72 + 0.5 * rkPlate, rkBev ), 1.0 - rkInner );
    rkCav += ( 1.0 - rkBev ) * 0.35 * ( 1.0 - rkInner );
  }
#endif
if ( rkInner > 0.01 ) {
  // freshly broken rock: conchoidal ripples spreading from a focus, hackle striations along the bedding,
  // bands of the interior, darker towards the core
  vec3 fo = rkCellV.xyz * 0.5 + ( rkHash3( vec3( rkCellV.w * 91.0, 3.0, 7.0 ) ) - 0.5 ) * 0.3;
  vec3 dv = rkP - fo;
  float dl = length( dv ) + 1e-4;
  float rf = uRockFreq.x * 5.5;
  float ra = ( 1.0 - smoothstep( 0.2, 0.5, rkFw * rf * 0.16 ) ) * rkInner;
  rkG += ( dv / dl ) * ( uRockBreak.x * ra * cos( dl * rf + 6.0 * rkV1 + 2.0 * rkN2 ) * ( 0.35 + 0.9 * rkN2 ) );
  float sa = dot( rkP, uRockAxis ) * uRockFreq.x * 2.6;
  vec4 sn = rkNoiseD( vec3( sa, sa * 0.31 + 5.0, dot( rkP, uRockAxis.yzx ) * 3.0 ) + uRockSeed.zyx );
  rkG += uRockAxis * ( ( sn.y + 0.31 * sn.z ) * uRockBreak.y * ra * 2.2 );
  float core = 1.0 - smoothstep( 0.12, 0.5, length( rkP ) );
  diffuseColor.rgb *= mix( 1.0, ( 1.0 + uRockBreak.z * ( sn.x - 0.5 ) * 3.0 ) * ( 1.0 - uRockBreak.w * core ) * ( 0.74 + 0.4 * rkV1 ), rkInner );
}
#if ! defined( ROCK_SHATTER ) && ! defined( ROCK_DEBRIS )
for ( int i = 0; i < 4; i ++ ) {
  // impact scars: a fresh bowl with a raised, broken lip and a splash of pale ejecta
  float sr = uRockScar[ i ].w;
  if ( sr > 0.0 ) {
    vec3 pn = normalize( rkP );
    float ca = dot( pn, uRockScar[ i ].xyz );
    float t0 = acos( clamp( ca, -1.0, 1.0 ) ) / sr;
    if ( t0 < 2.2 ) {
      float t = t0 * ( 1.0 + 0.34 * ( rkN2 - 0.5 ) + 0.3 * ( rkV1 - 0.5 ) );
      vec3 away = normalize( pn * ca - uRockScar[ i ].xyz + 1e-5 );
      float in1 = step( t, 1.0 );
      float bowl = 1.0 - smoothstep( 0.0, 1.0, t );
      float rq = ( t - 1.05 ) / 0.18;
      float rim = exp( - rq * rq );
      rkG += away * ( 0.44 * 6.0 * t * ( 1.0 - t ) * in1 - 0.08 * rim * 2.0 * rq / 0.18 );
      float fresh = 1.0 - smoothstep( 0.82, 1.08, t );
      float ray = smoothstep( 0.55, 0.8, rkNoiseD( away * 5.0 + uRockScar[ i ].xyz * 9.0 ).x ) * ( 1.0 - smoothstep( 1.0, 2.1, t ) ) * step( 1.0, t );
      diffuseColor.rgb = mix( diffuseColor.rgb, uRockFresh * ( 0.7 + 0.5 * rkN3 ) * ( 1.0 - 0.6 * bowl * bowl ), fresh * 0.92 );
      diffuseColor.rgb = mix( diffuseColor.rgb, uRockFresh * 1.15, max( 0.7 * rim * ( 1.0 - fresh ), 0.6 * ray ) );
      rkCav += bowl * bowl * 0.7;
      rkScarHot = max( rkScarHot, sqrt( bowl ) * ( 0.5 + 0.5 * rkN2 ) );
    }
  }
}
#endif
{
  float dark = clamp( rkCav, 0.0, 1.0 );
  diffuseColor.rgb *= ( 1.0 - uRockFx.z * dark ) * ( 0.89 + 0.22 * rkN3 ) * ( 0.85 + 0.3 * rkN2 ) * ( 0.8 + 0.4 * rkN4 );
}
#ifdef ROCK_ORE
{
  // mineral veins (thin iso-sheets of a slow noise) and crystals: grain cells cut like gems — the upper
  // envelope of a few planes through the cell's centre gives flat facets that each catch the light on
  // their own — with a glow from inside that shifts with the view (parallax into the crystal)
  float gem = smoothstep( 1.06, 1.2, vRock.z );   // a real crystal (spire geometry): clean glassy faces
  float prov = mix( 0.25, 1.0, min( vRock.z, 1.0 ) );
  float vn = rkNoiseD( rkP * 3.4 + uRockSeed + 20.0 ).x;
  float vein = ( 1.0 - smoothstep( 0.0, 0.045 + rkFw * 2.0, abs( vn - 0.5 ) ) ) * uRockFx.x * prov * ( 1.0 - gem );
  float cc = step( 1.0 - ( 0.04 + 0.5 * vein ) * uRockFx.x, rkCh.y ) * rkCellA * ( 1.0 - gem );
  if ( cc > 0.0 ) {
    vec3 best = vec3( 0.0 );
    float bd = -1e9;
    for ( int k = 0; k < 5; k ++ ) {
      vec3 dk = normalize( rkHash3( rkCid + 13.1 + float( k ) * 5.7 ) - 0.5 );
      float v = dot( dk, rkCr1 );
      if ( v > bd ) { bd = v; best = dk; }
    }
    rkG = rkG * ( 1.0 - 0.8 * cc ) + best * ( 1.25 * cc );
    // each facet its own depth of colour
    diffuseColor.rgb *= mix( 1.0, 0.4 + 1.0 * fract( dot( best, vec3( 12.9898, 78.233, 37.719 ) ) * 43.7 ), cc );
  }
  rkG *= 1.0 - 0.94 * gem;
  rkCryst = max( cc, gem );
  if ( rkCryst > 0.0 ) {
    // parallax: where the view ray is, a little way below the surface
    vec3 vv = normalize( vViewPosition ), vn3 = normalize( vNormal );
    vec3 vt = vv - vn3 * dot( vn3, vv );
    vec3 sx = dFdx( vViewPosition ), sy = dFdy( vViewPosition );
    float a11 = dot( sx, sx ), a12 = dot( sx, sy ), a22 = dot( sy, sy ), b1 = dot( vt, sx ), b2 = dot( vt, sy );
    vec2 ab = vec2( a22 * b1 - a12 * b2, a11 * b2 - a12 * b1 ) / max( a11 * a22 - a12 * a12, 1e-12 );
    vec3 ov = ab.x * rkPx + ab.y * rkPy;
    float ndv = max( dot( vn3, vv ), 0.3 );
    vec3 pp = rkP - normalize( ov + 1e-6 ) * ( length( vt ) / ndv * 0.6 / uRockCell.x );
    vec3 d1 = normalize( rkCh - 0.5 + vec3( 0.01, 0.13, -0.07 ) ), d2 = normalize( rkCh.yzx - 0.5 + vec3( 0.02, -0.31, 0.17 ) );
    float l1 = abs( fract( dot( pp, d1 ) * uRockCell.x * 1.6 + rkCh.x ) - 0.5 ), l2 = abs( fract( dot( pp, d2 ) * uRockCell.x * 1.1 + rkCh.z ) - 0.5 );
    rkGlow = rkCryst * ( 0.04 + 0.7 * smoothstep( 0.38, 0.5, l1 ) + 0.5 * smoothstep( 0.42, 0.5, l2 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, uRockOre * ( 0.3 + 0.45 * rkCh.x ), cc * 0.85 * ( 1.0 - 0.5 * uRockFx.y ) );
  }
  rkCryst = max( rkCryst, vein * 0.35 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uRockOre * ( 0.55 + 0.45 * rkCh.x ), vein * 0.3 * ( 1.0 - 0.5 * uRockFx.y ) );
  // frost: powdery white on ridges and rims, clear dark ice between
  rkFrost = uRockFx.y * smoothstep( 0.3, 0.7, vRock.z + 0.5 * ( rkN2 - 0.5 ) + 0.3 * ( rkV1 - 0.5 ) ) * ( 1.0 - gem );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.66, 0.74, 0.80 ), rkFrost * 0.8 * ( 1.0 - 0.7 * rkGlow * rkCryst ) );
}
#endif
`;

const GLSL_FRAG_ROUGH = /* glsl */ `
roughnessFactor = clamp( roughnessFactor * ( 0.86 + 0.28 * rkN2 ) + 0.15 * clamp( rkCav, 0.0, 1.0 ), 0.06, 1.0 );
#ifdef ROCK_ORE
  roughnessFactor = mix( roughnessFactor, 0.85, rkFrost );
  roughnessFactor = mix( roughnessFactor, 0.14, rkCryst * 0.9 );
#endif
`;

const GLSL_FRAG_METAL = /* glsl */ `
#ifdef ROCK_METAL
  metalnessFactor *= clamp( vRock.z * ( 1.0 - clamp( rkCav, 0.0, 1.0 ) ) * ( 0.75 + 0.5 * rkN2 ), 0.0, 1.0 );
#endif
`;

// after <normal_fragment_maps>: creases (derivative normal on fracture planes) + relief
const GLSL_FRAG_NORMAL = /* glsl */ `
{
  vec3 rkFlat = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  normal = normalize( mix( normal, rkFlat, clamp( vRock.x, 0.0, 1.0 ) ) );
  vec3 sx = dFdx( - vViewPosition );
  vec3 sy = dFdy( - vViewPosition );
  float sc = ( length( sx ) + length( sy ) ) / rkFw;
  vec2 dH = vec2( dot( rkG, rkPx ), dot( rkG, rkPy ) ) * ( sc * uRockBump.w );
  vec3 r1 = cross( sy, normal );
  vec3 r2 = cross( normal, sx );
  float det = dot( sx, r1 ) * faceDirection;
  vec3 n2 = abs( det ) * normal - sign( det ) * ( dH.x * r1 + dH.y * r2 );
  float l2 = dot( n2, n2 );
  if ( l2 > 0.0 ) normal = n2 * inversesqrt( l2 );
}
`;

const GLSL_FRAG_EMISSIVE = /* glsl */ `
#ifdef ROCK_MAGMA
{
  float glow = smoothstep( 0.3, 0.85, vRock.z ) * ( 0.35 + 0.65 * vRock.z ) * ( 1.0 - vRock.w );
  float pulse = 0.76 + 0.24 * sin( uRockPulse + rkPlate * 6.2832 + uRockSeed.x );
  float slow = 0.6 + 0.4 * sin( uRockPulse * 0.5 + rkPlate * 17.0 );
  vec3 hot = mix( vec3( 2.0, 0.3, 0.025 ), vec3( 4.2, 1.8, 0.36 ), rkMagCore * rkMagCore );
  vec3 em = ( hot * rkMagCore + vec3( 0.6, 0.07, 0.0 ) * rkMagHalo * rkMagHalo ) * glow * pulse;
  // a few plates are still glowing through their crust
  float hp = smoothstep( 0.93, 0.99, rkPlate + 0.1 * ( glow - 0.7 ) ) * rkBev;
  em += vec3( 0.7, 0.08, 0.005 ) * ( hp * ( 0.35 + 0.65 * rkN2 ) * slow * glow );
  // a scar has torn the crust open
  em = mix( em, vec3( 2.8, 0.7, 0.07 ) * ( 0.35 + 0.65 * rkN3 ) * pulse, rkScarHot * rkScarHot * ( 3.0 - 2.0 * rkScarHot ) );
  totalEmissiveRadiance += em * uRockMagma;
}
#endif
#ifdef ROCK_ORE
  totalEmissiveRadiance += uRockOre * ( rkGlow * 0.3 * uRockFx.w * uRockMat.w );
#endif
#ifdef ROCK_HEAT
{
  // > 0: magma-wet / friction-heated: a dull red sheen with bright veins and a hotter core, soft-clipped so that a
  // screen full of it cannot white out the bloom; < 0: the brief pale flash inside a fissure as it opens
  #ifdef ROCK_MAGMA
    // the magma joints of the crust run on through the interior
    float hv = rkMagCore + 0.3 * rkMagHalo * rkMagHalo;
  #else
    float hv = 1.0 - smoothstep( 0.0, 0.07, abs( rkN2 - 0.5 ) + 0.5 * abs( rkV1 - 0.5 ) );
  #endif
  #ifdef ROCK_SHATTER
    float hc = 1.0 - smoothstep( 0.1, 0.46, length( rkP ) );
    float rh = max( vRockHeat, 0.0 ) * ( 0.025 + 1.7 * hv + 0.45 * hc * hc * hc * ( 0.5 + rkN3 ) );
  #else
    float rh = max( vRockHeat, 0.0 ) * ( 0.22 + 1.2 * hv + 0.5 * rkN3 );
  #endif
  vec3 he = vec3( rh, rh * rh * 0.42, rh * rh * rh * 0.1 ) * uRockHot.x;
  he *= uRockHot.y / ( uRockHot.y + max( he.r, he.g ) );
  totalEmissiveRadiance += he;
  totalEmissiveRadiance += vec3( 1.2, 0.7, 0.34 ) * ( max( - vRockHeat, 0.0 ) * uRockHot.x );
}
#endif
`;

// after <lights_fragment_end>: body shadow, tamed ambient, view fill + night-side rim (a rock is an
// obstacle: it must read against the sky from every camera), crystal glints
const GLSL_FRAG_LIGHTS = /* glsl */ `
{
  vec3 rkLv = normalize( ( viewMatrix * vec4( uRockSun, 0.0 ) ).xyz );
  float body = smoothstep( -0.28, 0.16, dot( normalize( vRockMacro ), rkLv ) );
  float sh = mix( 1.0, body, uRockMat.z * vRockBodyK );
  vec3 sunD = saturate( dot( normal, rkLv ) ) * uRockSunCol * BRDF_Lambert( material.diffuseColor );
  reflectedLight.directDiffuse = max( reflectedLight.directDiffuse - sunD * ( 1.0 - sh ), vec3( 0.0 ) );
  reflectedLight.directSpecular *= mix( 1.0, sh, 0.8 );
  float cavK = 1.0 - 0.5 * clamp( rkCav, 0.0, 1.0 );
  float amb = uRockMat.y * vRock.y * cavK;
  reflectedLight.indirectDiffuse *= amb;
  reflectedLight.indirectSpecular *= mix( amb, 1.0, 0.5 * metalnessFactor );
  vec3 rkVv = normalize( vViewPosition );
  float ndv = saturate( dot( normal, rkVv ) );
  float fres = 1.0 - ndv;
  float occ = vRock.y * cavK;
  reflectedLight.indirectDiffuse += material.diffuseColor * uRockFill.rgb * ( uRockFill.w * ( 0.3 + 0.7 * ndv ) * occ );
  float lim = 1.0 - saturate( dot( normalize( vRockMacro ), rkVv ) );
  reflectedLight.indirectDiffuse += ( material.diffuseColor * 0.75 + 0.03 ) * uRockRim.rgb * ( uRockRim.w * fres * fres * ( 0.35 + 0.65 * lim * lim ) * ( 1.0 - 0.7 * sh * saturate( dot( normal, rkLv ) ) ) * ( 0.4 + 0.6 * occ ) );
  #ifdef ROCK_ORE
  {
    // ice lets the sun through: the shadow side glows a deep blue, strongest when looking towards the light
    float back = saturate( 0.5 - 0.5 * dot( normal, rkLv ) );
    float thru = 0.35 + 0.65 * pow( saturate( dot( rkVv, - rkLv ) ), 2.0 );
    reflectedLight.directDiffuse += uRockSunCol * vec3( 0.16, 0.42, 0.75 ) * ( uRockFx.y * back * thru * 0.2 * ( 1.0 - 0.6 * rkFrost ) );
  }
  if ( rkCryst > 0.0 ) {
    vec3 hv = normalize( rkLv + rkVv );
    float gl = pow( saturate( dot( normal, hv ) ), 180.0 ) * 8.0 + pow( saturate( dot( normal, hv ) ), 24.0 ) * 0.12;
    totalEmissiveRadiance += uRockSunCol * mix( vec3( 1.0 ), uRockOre, 0.5 ) * ( gl * rkCryst * uRockFx.w * uRockMat.w * sh );
  }
  #endif
}
`;

/* ------------------------------ debris pools ------------------------------ */

const STRIDE = 18;
const S_PX = 0, S_PY = 1, S_PZ = 2, S_VX = 3, S_VY = 4, S_VZ = 5, S_AX = 6, S_AY = 7, S_AZ = 8,
  S_ANG = 9, S_SPIN = 10, S_SIZE = 11, S_AGE = 12, S_LIFE = 13, S_HEAT = 14, S_COOL = 15, S_TRAIL = 16;

const POOL_DEFS = [
  { kind: 'chunk', seed: 31, freq: 2, axes: [1.0, 0.80, 0.66], cuts: 3, cap: 72 },
  { kind: 'chunk', seed: 47, freq: 2, axes: [1.0, 0.68, 0.84], cuts: 4, cap: 72 },
  { kind: 'shard', seed: 59, freq: 2, axes: [1.0, 0.44, 0.30], cuts: 3, cap: 224 },
  { kind: 'shard', seed: 71, freq: 1, axes: [1.0, 0.30, 0.52], cuts: 2, cap: 224 },
  { kind: 'grit',  seed: 83, freq: 1, axes: [1.0, 0.62, 0.48], cuts: 2, cap: 384 },
  { kind: 'grit',  seed: 97, freq: 1, axes: [1.0, 0.85, 0.7], cuts: 1, cap: 384 },
];
const CHUNK_POOLS = [0, 1], SHARD_POOLS = [2, 3], GRIT_POOLS = [4, 5];

/* --------------------------------- class --------------------------------- */

export class Rocks3D {
  constructor(THREE, scene, opts = {}) {
    this.THREE = THREE;
    this.scene = scene;
    this.fx = opts.fx || null;
    this.tune = Object.assign({}, TUNE, opts.tune || null);
    this.maxLod = opts.maxLod == null ? 3 : clamp(opts.maxLod | 0, 0, 3);
    this.random = opts.random || Math.random;
    this.sync = !!opts.sync;           // true → create() builds the wanted LOD on the spot (tools, loading screens)
    this.sun = opts.sun || null;       // DirectionalLight for the body shadow (auto-detected in the scene if omitted)
    this.keepArrays = !!opts.keepArrays; // true → keep the CPU copy of every vertex buffer after upload (tools; costs tens of MB)

    this.normal = NORMAL_SPECS.map((s, i) => prepareVariant(s, i));
    this.volcanic = VOLCANIC_SPECS.map((s, i) => prepareVariant(s, NORMAL_SPECS.length + i));
    this._all = this.normal.concat(this.volcanic);
    this.variantCount = this.normal.length;
    this.volcanicVariantCount = this.volcanic.length;
    this.variantNames = this.normal.map((v) => v.spec.name);
    this.volcanicVariantNames = this.volcanic.map((v) => v.spec.name);
    this.lodCount = LOD_FREQ.length;
    this.buildMs = 0;        // accumulated geometry generation time
    this.buildMaxSliceMs = 0; // longest single slice spent building inside update()
    this.buildLog = [];      // { name, kind: 'lod'|'shatter', lod, ms, tris }

    const T = this.tune;
    this._u = {
      uRockMat: { value: new THREE.Vector4(0, T.ambient, T.bodyShadow, T.sparkle) },
      uRockPulse: { value: 0 },
      uRockMagma: { value: T.magma },
      uRockHot: { value: new THREE.Vector2(T.hot, T.hotCap) },
      uRockFill: { value: new THREE.Vector4(T.fillColor[0], T.fillColor[1], T.fillColor[2], T.fill) },
      uRockRim: { value: new THREE.Vector4(T.rimColor[0], T.rimColor[1], T.rimColor[2], T.rim) },
      uRockScar: { value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)] },
      uRockSun: { value: new THREE.Vector3(-0.38, 0.84, 0.46) },
      uRockSunCol: { value: new THREE.Vector3(0, 0, 0) },
    };
    this._bright = T.brightness;
    this._materials = [];
    for (const vr of this._all) {
      vr.uniforms = this._variantUniforms(vr);
      vr.mat = this._material(vr, false);
      vr.shMat = null; // created with the first fracture mesh
    }
    // legacy handles
    this.rockMaterial = this.normal[0].mat;
    this.volcanicMaterials = this.volcanic.map((v) => v.mat);
    this.fragmentMaterial = this._debrisMaterial();
    this.setBrightness(T.brightness);

    this._pools = POOL_DEFS.map((d) => this._makePool(d));
    this.capacity = this._pools.reduce((s, p) => s + p.cap, 0);
    this._tmp = [0, 0, 0];
    this._c3 = [0, 0, 0];
    this._o3 = [0, 0, 0];
    this._dustOpts = { color: this._c3, count: 8, speed: 110, life: 1000 };
    this._sparkOpts = { spread: 0.9, speed: 380, life: 420, color: undefined, light: false };
    this._smokeOpts = { vx: 0, vy: 10, vz: 0, dark: 0.35, life: 1100, alpha: 1, color: this._c3, drift: false };
    this._expOpts = { vx: 0, vz: 0, shrapnel: false, shockwave: false };
    this._trailN = 0;

    this._bursts = [];
    for (let i = 0; i < MAX_BURSTS; i++) {
      this._bursts.push({ active: false, age: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, D: 0, scale: 1, vr: null, volcanic: false,
        qx: 0, qy: 0, qz: 0, qw: 1, ix: 0, iz: 0, hasImpact: false, intensity: 1, burst: false, sm: null, speed: 1, lifeS: 1,
        heat0: 0, heatRate: 1, ox: 0, oy: 0, oz: 0, seed: 0, ev: [-1, -1], evT: [0, 0] });
    }
    this._shMeshes = [];
    this._live = [];       // rocks handed out by create() and not yet released (chip() finds the one that was hit)
    this._queue = [];      // urgent build jobs
    this._idle = null;     // background job list (lazy)
    this._pending = [];    // meshes waiting for a better LOD
    this._sunScan = 0;
    this._tick = 0;
    this._volLoad = 0;     // recent volcanic breaks (decays with a 0.4 s time constant)
    this._disposed = false;

    if (opts.prewarm) this.prewarm(opts.prewarm === true ? [1] : opts.prewarm);
  }

  /* ------------------------------ materials ------------------------------ */

  _variantUniforms(vr) {
    const THREE = this.THREE, s = vr.spec, T = this.tune;
    const ore = hex(s.oreColor);
    return {
      uRockBump: { value: new THREE.Vector4(s.bump[0], s.bump[1], s.bump[2], T.bump) },
      uRockFreq: { value: new THREE.Vector3(s.freq[0], s.freq[1], s.freq[2]) },
      uRockFx: { value: new THREE.Vector4(s.ore, s.frost, s.cavDark, s.sparkle) },
      uRockOre: { value: new THREE.Vector3(ore[0], ore[1], ore[2]) },
      uRockSeed: { value: new THREE.Vector3(vr.seedVec[0], vr.seedVec[1], vr.seedVec[2]) },
      uRockCrack: { value: new THREE.Vector3(T.crackFreq * (0.9 + 0.2 * hash1(s.seed)), T.crackWidth, 0.09) },
      uRockCell: { value: new THREE.Vector4(s.cell[0], s.cell[1], s.cell[2], s.cell[3]) },
      uRockBreak: { value: new THREE.Vector4(s.brk[0], s.brk[1], s.brk[2], s.brk[3]) },
      uRockAxis: { value: new THREE.Vector3(vr.strataAxis[0], vr.strataAxis[1], vr.strataAxis[2]) },
      uRockFresh: { value: new THREE.Vector3(vr.pal.fresh[0], vr.pal.fresh[1], vr.pal.fresh[2]) },
    };
  }

  _inject(mat, uniforms) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + GLSL_VERT_PARS)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + GLSL_VERT_NORMAL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + GLSL_VERT_MAIN);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GLSL_FRAG_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + GLSL_FRAG_COLOR)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + GLSL_FRAG_ROUGH)
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + GLSL_FRAG_METAL)
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + GLSL_FRAG_NORMAL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + GLSL_FRAG_EMISSIVE)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + GLSL_FRAG_LIGHTS);
    };
    mat.customProgramCacheKey = () => 'rocks3d-3';
    this._materials.push(mat);
    return mat;
  }

  _material(vr, shatter, cells, extra) {
    const s = vr.spec;
    const mat = new this.THREE.MeshStandardMaterial({ vertexColors: true, roughness: clamp(s.rough * this.tune.roughness, 0.05, 1), metalness: s.metal });
    mat.userData.rough = s.rough;
    const d = {};
    if (s.volcanic) d.ROCK_MAGMA = '';
    if (s.ore > 0 || s.frost > 0) d.ROCK_ORE = '';
    if (s.metal > 0) d.ROCK_METAL = '';
    if (shatter) { d.ROCK_SHATTER = ''; d.ROCK_HEAT = ''; }
    mat.defines = Object.assign({}, mat.defines, d);
    mat.name = 'rock:' + s.name + (shatter ? ':shatter' : '');
    return this._inject(mat, Object.assign(cells ? { uRockCells: { value: cells } } : {}, this._u, vr.uniforms, extra || null));
  }

  _debrisMaterial() {
    const THREE = this.THREE, T = this.tune;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: clamp(0.92 * T.roughness, 0.05, 1), metalness: 0 });
    mat.userData.rough = 0.92;
    mat.defines = Object.assign({}, mat.defines, { ROCK_DEBRIS: '', ROCK_HEAT: '' });
    mat.name = 'rock:debris';
    this._uDebris = {
      uRockBump: { value: new THREE.Vector4(0.9, 0.05, 0.45, T.bump) },
      uRockFreq: { value: new THREE.Vector3(3.0, 2.6, 13) },
      uRockFx: { value: new THREE.Vector4(0, 0, 0.55, 0) },
      uRockOre: { value: new THREE.Vector3(1, 1, 1) },
      uRockSeed: { value: new THREE.Vector3(3.1, 7.7, 1.3) },
      uRockCrack: { value: new THREE.Vector3(4, 0.05, 0.02) },
      uRockCell: { value: new THREE.Vector4(3.4, 0.05, 0.1, 0.5) },
      uRockBreak: { value: new THREE.Vector4(0.5, 0.3, 0.3, 0) },
      uRockAxis: { value: new THREE.Vector3(0.36, 0.8, 0.48) },
      uRockFresh: { value: new THREE.Vector3(1, 1, 1) },
    };
    return this._inject(mat, Object.assign({}, this._u, this._uDebris));
  }

  /** Multiply every rock/debris albedo (1 = as authored). */
  setBrightness(k) {
    this._bright = k;
    for (const m of this._materials) m.color.setScalar(k);
  }

  /**
   * Live-tune: { bump, ambient, bodyShadow, sparkle, magma, crackFreq, crackWidth, hot, roughness, brightness }
   * plus every debris constant in TUNE (speed, life, drag, impactHeat, crackMs, meshScale, lod*, *BudgetMs …).
   */
  setTune(t) {
    Object.assign(this.tune, t);
    const T = this.tune, u = this._u;
    u.uRockMat.value.set(0, T.ambient, T.bodyShadow, T.sparkle);
    u.uRockMagma.value = T.magma; u.uRockHot.value.set(T.hot, T.hotCap);
    u.uRockFill.value.set(T.fillColor[0], T.fillColor[1], T.fillColor[2], T.fill);
    u.uRockRim.value.set(T.rimColor[0], T.rimColor[1], T.rimColor[2], T.rim);
    for (const vr of this._all) {
      vr.uniforms.uRockBump.value.w = T.bump;
      vr.uniforms.uRockCrack.value.set(T.crackFreq * (0.9 + 0.2 * hash1(vr.spec.seed)), T.crackWidth, 0.09);
    }
    this._uDebris.uRockBump.value.w = T.bump;
    for (const m of this._materials) m.roughness = clamp(m.userData.rough * T.roughness, 0.05, 1);
    if (t.brightness != null) this.setBrightness(T.brightness);
  }

  /** Optional: compile every rock program up front so the first rock / first break never stalls on a shader link. */
  warmup(renderer, camera) {
    if (!renderer || !renderer.compile || this._disposed) return;
    const THREE = this.THREE, sc = new THREE.Scene(), tmp = [];
    sc.environment = this.scene.environment || null;
    for (const c of this.scene.children) if (c.isLight) tmp.push(c);
    const lights = tmp.map((l) => l.clone());
    for (const l of lights) sc.add(l);
    const seen = new Set();
    for (const vr of this._all) {
      const key = Object.keys(vr.mat.defines).sort().join();
      if (seen.has(key)) continue;
      seen.add(key);
      sc.add(new THREE.Mesh(this._geometry(vr, 0), vr.mat));
      const sh = this._shatterMesh(vr, 0, true);
      if (sh) { const m = new THREE.InstancedMesh(sh.geo, sh.mat, 1); sc.add(m); }
    }
    sc.add(new THREE.InstancedMesh(this._pools[0].geo, this.fragmentMaterial, 1));
    try { renderer.compile(sc, camera); } catch (e) { /* best effort */ }
  }

  /* ------------------------------- building ------------------------------ */

  _variant(variantIndex, volcanic) {
    const list = volcanic ? this.volcanic : this.normal;
    const i = ((variantIndex | 0) % list.length + list.length) % list.length;
    return list[i];
  }

  _lodFor(sizeHint) {
    let lod = 1;
    const T = this.tune;
    if (typeof sizeHint === 'number' && sizeHint > 0) lod = sizeHint < T.lodSmall ? 0 : sizeHint < T.lodMedium ? 1 : sizeHint < T.lodHuge ? 2 : 3;
    return Math.min(lod, this.maxLod);
  }

  // job slots: 0..3 = surface LODs, 4..7 = their fracture meshes
  _job(vr, slot) {
    let j = vr.jobs[slot];
    if (!j) {
      j = vr.jobs[slot] = { vr, slot, gen: null, ms: 0, done: false };
    }
    return j;
  }

  _ready(vr, slot) { return slot < 4 ? !!vr.geo[slot] : !!vr.sh[slot - 4]; }

  // advance a job until it finishes or the deadline passes; true when done
  _run(j, deadline) {
    if (j.done) return true;
    const vr = j.vr;
    if (!j.gen) {
      if (j.slot < 4) j.gen = genRock(vr, j.slot);
      else {
        // cut from the surface LOD the rock is drawn with (rebuilt if its CPU copy was already dropped)
        const lod = j.slot - 4;
        if (!vr.data[lod]) {
          const sj = this._job(vr, lod);
          if (sj.done) { sj.done = false; sj.gen = null; sj.ms = 0; }
          if (!this._run(sj, deadline)) return false;
        }
        j.gen = genFracture(vr, vr.data[lod], lod);
      }
    }
    const t1 = nowMs();
    let r;
    do { r = j.gen.next(); } while (!r.done && nowMs() < deadline);
    const dt = nowMs() - t1;
    j.ms += dt; this.buildMs += dt;
    if (!r.done) return false;
    j.done = true; j.gen = null;
    const tg = nowMs();
    if (j.slot < 4) {
      // keep the CPU copy only until this LOD's fracture mesh has been cut from it
      if (!vr.sh[j.slot]) vr.data[j.slot] = r.value;
      if (!vr.geo[j.slot]) {
        vr.geo[j.slot] = rockGeometry(this.THREE, r.value, this.keepArrays);
        this.buildLog.push({ name: vr.spec.name, kind: 'lod', lod: j.slot, ms: j.ms + (nowMs() - tg), tris: r.value.index.length / 3, verts: r.value.count });
      }
    } else {
      const d = r.value, THREE = this.THREE, geo = new THREE.BufferGeometry(), keep = this.keepArrays, lod = j.slot - 4;
      geo.setIndex(staticAttr(THREE, d.index, 1, false, keep));
      geo.setAttribute('position', staticAttr(THREE, d.pos, 3, false, keep));
      geo.setAttribute('normal', staticAttr(THREE, d.nor, 3, true, keep));
      geo.setAttribute('color', staticAttr(THREE, d.col, 3, true, keep));
      geo.setAttribute('aRock', staticAttr(THREE, d.rock, 4, true, keep));
      geo.setAttribute('aCid', staticAttr(THREE, d.cid, 1, false, keep));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
      const tex = new THREE.DataTexture(d.tex, d.cells, 4, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false; tex.flipY = false;
      tex.needsUpdate = true;
      const mat = this._material(vr, true, tex);
      mat.color.setScalar(this._bright);
      if (!vr.shMat) vr.shMat = mat;
      vr.sh[lod] = { geo, mat, tex, mesh: null, burst: null, imp: null, n: 0, lod, clusters: d.clusters, maxChunk: d.maxCell, maxPiece: d.maxPiece, maxClus: d.maxClus,
        cells: d.cells, tris: d.index.length / 3, verts: d.count, cellTex: d.tex };
      vr.data[lod] = null;
      vr.sh[lod].used = this._tick;
      if (lod === 3) this._trimFracture(vr);
      this.buildLog.push({ name: vr.spec.name, kind: 'shatter', lod, ms: j.ms + (nowMs() - tg), tris: d.index.length / 3, verts: d.count, cells: d.cells, maxChunk: d.maxCell, maxPiece: d.maxPiece, maxClus: d.maxClus });
    }
    this.buildMs += nowMs() - tg;
    return true;
  }

  // The fracture meshes of huge rocks are the heavy ones (~4 MB of GPU memory each): keep the few most recently
  // used, drop the rest (they are rebuilt in the background the next time a huge rock of that family shows up).
  _trimFracture(keep) {
    for (;;) {
      let n = 0, old = null;
      for (const vr of this._all) {
        const s = vr.sh[3];
        if (!s) continue;
        n++;
        if (vr === keep || s.n > 0) continue;
        let busy = false;
        for (const b of this._bursts) if (b.active && b.sm === s) { busy = true; break; }
        if (!busy && (!old || s.used < old.sh[3].used)) old = vr;
      }
      if (n <= this.tune.maxHugeFracture || !old) return;
      const s = old.sh[3];
      if (s.mesh) { this.scene.remove(s.mesh); if (s.mesh.dispose) s.mesh.dispose(); const i = this._shMeshes.indexOf(s); if (i >= 0) this._shMeshes.splice(i, 1); }
      s.geo.dispose(); s.tex.dispose(); s.mat.dispose();
      const mi = this._materials.indexOf(s.mat);
      if (mi >= 0) this._materials.splice(mi, 1);
      if (old.shMat === s.mat) old.shMat = null;
      old.sh[3] = null; old.jobs[7] = null;
    }
  }

  _buildNow(vr, slot) {
    if (this._ready(vr, slot)) return;
    this._run(this._job(vr, slot), Infinity);
  }

  _enqueue(vr, slot) {
    if (this._ready(vr, slot)) return;
    const j = this._job(vr, slot);
    if (this._queue.indexOf(j) < 0) this._queue.push(j);
  }

  _geometry(vr, lod) {
    if (!vr.geo[lod]) this._buildNow(vr, lod);
    return vr.geo[lod];
  }

  // run queued builds for at most `budget` ms; resolve meshes waiting for a better LOD
  _pump() {
    const T = this.tune;
    const urgent = this._queue.length > 0;
    if (!urgent) {
      if (!this._idle) {
        // background order: cheap things first. The 46k LOD is only built when a huge rock shows up
        // (it then appears on the 16k one and is upgraded a few frames later).
        this._idle = [];
        // Fracture meshes other than the coarsest are cut on demand (create() queues the one its rock will need):
        // a vertex buffer only leaves the CPU when it is first drawn, so pre-built ones would sit there unused.
        for (const slot of [0, 1, 4, 2]) {
          if ((slot & 3) > this.maxLod) continue;
          for (const vr of this._all) this._idle.push(this._job(vr, slot));
        }
      }
      while (this._idle.length && this._idle[0].done) this._idle.shift();
      if (!this._idle.length) return;
    }
    const t0 = nowMs(), deadline = t0 + (urgent ? T.buildBudgetMs : T.idleBudgetMs);
    let finished = false;
    while (nowMs() < deadline) {
      const j = this._queue.length ? this._queue[0] : this._idle && this._idle.length ? this._idle[0] : null;
      if (!j) break;
      if (!this._run(j, deadline)) break;
      finished = true;
      if (this._queue.length && this._queue[0] === j) this._queue.shift();
      else if (this._idle && this._idle[0] === j) this._idle.shift();
    }
    const dt = nowMs() - t0;
    if (dt > this.buildMaxSliceMs) this.buildMaxSliceMs = dt;
    if (finished) this._resolvePending();
  }

  _resolvePending() {
    const P = this._pending;
    for (let i = P.length - 1; i >= 0; i--) {
      const e = P[i], mesh = e.mesh, info = mesh.userData.rock;
      let drop = !info || info.released;
      if (!drop) {
        // best LOD ready that is not above the wanted one
        for (let l = e.lod; l > info.lod; l--) {
          if (e.vr.geo[l]) { mesh.geometry = e.vr.geo[l]; info.lod = l; break; }
        }
        drop = info.lod >= e.lod;
      }
      if (drop) { P[i] = P[P.length - 1]; P.pop(); }
    }
  }

  /** Build geometries up front (e.g. on a loading screen) so nothing is built during play. `lods`: array of 0..3. */
  prewarm(lods = [1], shatter = true) {
    for (const lod of lods) {
      const l = Math.min(lod, this.maxLod);
      for (const vr of this._all) this._buildNow(vr, l);
    }
    if (shatter) for (const lod of lods) for (const vr of this._all) this._buildNow(vr, 4 + Math.min(lod, this.maxLod));
    this._resolvePending();
  }

  /** Finish every queued (not background) build right now. */
  flushBuilds() {
    while (this._queue.length) { this._run(this._queue[0], Infinity); this._queue.shift(); }
    this._resolvePending();
  }

  /** Number of geometry builds still queued for rocks that are on screen. */
  get pendingBuilds() { return this._queue.length; }

  /**
   * → Mesh of diameter 1 centred on the origin (shared geometry + material; not added to the scene).
   * sizeHint (optional) = the rock's diameter in world units, used only to pick a level of detail.
   * If that LOD is not built yet the mesh starts on a coarser one and is upgraded in place.
   */
  create(variantIndex, volcanic, sizeHint) {
    const vr = this._variant(variantIndex, volcanic);
    const want = this._lodFor(sizeHint);
    let lod = want;
    if (!vr.geo[want]) {
      if (this.sync) this._buildNow(vr, want);
      else {
        lod = -1;
        for (let l = want - 1; l >= 0; l--) if (vr.geo[l]) { lod = l; break; }
        if (lod < 0) { this._buildNow(vr, 0); lod = 0; }
        if (lod !== want) this._enqueue(vr, want);
      }
    }
    const mesh = new this.THREE.Mesh(vr.geo[lod], vr.mat);
    mesh.userData.rock = { variant: variantIndex | 0, volcanic: !!volcanic, lod, wantLod: want, name: vr.spec.name, released: false, vr, scar: null, scars: 0 };
    this._live.push(mesh);
    if (lod !== want) this._pending.push({ mesh, vr, lod: want });
    // have its fracture mesh ready by the time it dies
    if (!vr.sh[want]) { if (this.sync) this._buildNow(vr, 4 + want); else this._enqueue(vr, 4 + want); } else vr.sh[want].used = this._tick;
    return mesh;
  }

  /** Nothing per-instance to free (geometry and material are shared); detaches the mesh if still parented. */
  release(obj) {
    if (!obj) return;
    const info = obj.userData && obj.userData.rock;
    if (info && !info.released) {
      info.released = true;
      if (info.scar) { // hand the scarred material back to its variant's pool
        const sv = info.scar.u.uRockScar.value;
        for (let i = 0; i < 4; i++) sv[i].set(0, 0, 0, 0);
        info.scar.used = false; info.scar = null;
        obj.material = info.vr.mat;
      }
      const L = this._live, i = L.indexOf(obj);
      if (i >= 0) { L[i] = L[L.length - 1]; L.pop(); }
    }
    if (obj.parent) obj.parent.remove(obj);
  }

  /* ------------------------------- debris -------------------------------- */

  _makePool(def) {
    const THREE = this.THREE;
    const geo = buildFragmentGeometry(THREE, def.seed, def.freq, def.axes, def.cuts);
    const heat = new THREE.InstancedBufferAttribute(new Float32Array(def.cap), 1);
    heat.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeat', heat);
    const mesh = new THREE.InstancedMesh(geo, this.fragmentMaterial, def.cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(def.cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.name = 'rockDebris:' + def.kind;
    this.scene.add(mesh);
    return {
      kind: def.kind, cap: def.cap, n: 0, mesh, geo, heat, trail: def.kind === 'chunk',
      st: new Float32Array(def.cap * STRIDE),
      mat: mesh.instanceMatrix.array, col: mesh.instanceColor.array,
      tris: geo.attributes.position.count / 3,
    };
  }

  _spawn(pi, x, y, z, vx, vy, vz, size, life, r, g, b, heat, cool, trail) {
    const p = this._pools[pi], st = p.st, rnd = this.random;
    let i;
    if (p.n < p.cap) i = p.n++;
    else {
      // full: recycle the fragment closest to the end of its life
      i = 0;
      let best = -1;
      for (let k = 0; k < p.cap; k++) {
        const f = st[k * STRIDE + S_AGE] / st[k * STRIDE + S_LIFE];
        if (f > best) { best = f; i = k; }
      }
    }
    const o = i * STRIDE, a = randUnit(rnd, this._tmp);
    st[o + S_PX] = x; st[o + S_PY] = y; st[o + S_PZ] = z;
    st[o + S_VX] = vx; st[o + S_VY] = vy; st[o + S_VZ] = vz;
    st[o + S_AX] = a[0]; st[o + S_AY] = a[1]; st[o + S_AZ] = a[2];
    st[o + S_ANG] = rnd() * 6.2832;
    // small bits tumble faster
    st[o + S_SPIN] = (0.004 + rnd() * 0.012) * clamp(14 / (size + 4), 0.45, 2.4) * (rnd() < 0.5 ? -1 : 1);
    st[o + S_SIZE] = size;
    st[o + S_AGE] = 0;
    st[o + S_LIFE] = life;
    st[o + S_HEAT] = heat;
    st[o + S_COOL] = cool;
    st[o + S_TRAIL] = trail ? 20 + rnd() * 40 : 0;
    p.col[i * 3] = r; p.col[i * 3 + 1] = g; p.col[i * 3 + 2] = b;
    p.colDirty = true;
  }

  // one fragment of `size` leaving point (px,py,pz) relative to the rock centre (cx,cy,cz)
  _fragment(pi, vr, volcanic, cx, cy, cz, ox, oy, oz, vx, vy, vz, size, life, heatChance, trail) {
    const rnd = this.random, P = vr.pal, T = this.tune;
    // palette: the parent's body colours, a good share of fresh-broken faces
    const k = rnd(), m = 0.8 + rnd() * 0.45;
    const A = k < 0.42 ? P.base : k < 0.58 ? P.tintA : k < 0.68 ? P.tintB : k < 0.8 ? P.high : P.fresh;
    const w = 0.35 + rnd() * 0.65;
    const r = (P.base[0] + (A[0] - P.base[0]) * w) * m, g = (P.base[1] + (A[1] - P.base[1]) * w) * m, b = (P.base[2] + (A[2] - P.base[2]) * w) * m;
    let heat = 0, cool = 0;
    if (rnd() < heatChance) {
      if (volcanic) { heat = (0.65 + rnd() * 0.6) / (1 + 0.25 * this._volLoad); cool = (1.6 + rnd() * 1.6) / life; }
      else { heat = T.impactHeat * (0.45 + rnd() * 0.55); cool = (5 + rnd() * 4) / life; }
    }
    this._spawn(pi, cx + ox, cy + oy, cz + oz, vx, vy, vz, size, life * T.life, r, g, b, heat, cool, trail);
  }

  // fracture InstancedMesh of a variant; null when its geometry is not built (and `force` is false)
  _shatterMesh(vr, s, force) {
    let sh = vr.sh[s];
    if (!sh) {
      if (!force) return null;
      this._buildNow(vr, 4 + s);
      sh = vr.sh[s];
      if (!sh) return null;
    }
    if (!sh.mesh) {
      const THREE = this.THREE;
      sh.burst = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 4), 4);
      sh.imp = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BURSTS * 4), 4);
      sh.burst.setUsage(THREE.DynamicDrawUsage); sh.imp.setUsage(THREE.DynamicDrawUsage);
      sh.geo.setAttribute('aBurst', sh.burst);
      sh.geo.setAttribute('aImp', sh.imp);
      const mesh = new THREE.InstancedMesh(sh.geo, sh.mat, MAX_BURSTS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      mesh.name = 'rockShatter:' + vr.spec.name + ':' + s;
      this.scene.add(mesh);
      sh.mesh = mesh;
      this._shMeshes.push(sh);
    }
    return sh;
  }

  // object-space offset of a cluster centre at burst age t (seconds) — mirrors GLSL_VERT_NORMAL
  _clusterOffset(K, t, speed, ix, iy, iz, out) {
    const open = sstep(0, 0.075, t), tm = Math.max(0, t - 0.045), g = (1 - Math.exp(-2.1 * tm)) / 2.1;
    const c1 = K.w, c2 = (c1 * 7.31) % 1;
    const l = Math.hypot(K.x, K.y, K.z), il = 1 / Math.max(l, 1e-4), ck = clamp(l / 0.3, 0.3, 1);
    const v = speed * (0.45 + 0.9 * c1) * ck, im = (0.4 + 0.8 * c2) * g, a = v * g, d = 1 + 0.075 * open;
    out[0] = K.x * d + K.x * il * a + ix * im; out[1] = K.y * d + K.y * il * a + iy * im; out[2] = K.z * d + K.z * il * a + iz * im;
    return out;
  }

  /**
   * The rock at this pose just broke.
   * { x, y, z, size, variant, volcanic, quaternion, vx, vz, byImpact: {dirX, dirZ} | null }
   * vx/vz: the rock's velocity in units per ms. byImpact.dir = travel direction of whatever hit it.
   * Optional: intensity (default 1) scales fragment count and speed; scale = the scale the rock mesh
   * was drawn at (default size * tune.meshScale).
   */
  shatter(o) {
    if (this._disposed) return;
    const rnd = this.random, T = this.tune, fx = this.fx;
    const D = o.size || 60, x = o.x || 0, y = o.y || 0, z = o.z || 0;
    const volcanic = !!o.volcanic;
    const vr = this._variant(o.variant || 0, volcanic);

    // a free burst record (or the oldest)
    let B = null, oldest = -1;
    for (const b of this._bursts) {
      if (!b.active) { B = b; break; }
      const f = b.age / b.life;
      if (f > oldest) { oldest = f; B = b; }
    }
    if (B.active && !B.burst) this._burst(B);
    B.active = true; B.age = 0; B.burst = false;
    B.x = x; B.y = y; B.z = z; B.vx = o.vx || 0; B.vz = o.vz || 0;
    B.D = D; B.scale = o.scale || D * T.meshScale; B.vr = vr; B.volcanic = volcanic;
    B.intensity = o.intensity == null ? 1 : o.intensity;
    const q = o.quaternion;
    B.qx = q ? q.x : 0; B.qy = q ? q.y : 0; B.qz = q ? q.z : 0; B.qw = q ? q.w : 1;
    B.ix = 0; B.iz = 0; B.hasImpact = false;
    if (o.byImpact) {
      const l = Math.hypot(o.byImpact.dirX || 0, o.byImpact.dirZ || 0);
      if (l > 1e-6) { B.ix = o.byImpact.dirX / l; B.iz = o.byImpact.dirZ / l; B.hasImpact = true; }
    }
    const U = (0.14 + 0.0014 * D) * T.speed * (0.75 + 0.25 * B.intensity); // world units per ms
    B.speed = (U * 1000) / B.scale * 1.15;                                 // rock diameters per second
    B.lifeS = clamp(0.9 + 0.003 * D, 0.95, 1.4) * T.life;
    B.life = B.lifeS * 1000;
    // several volcanic rocks going off together share one budget of light (this._volLoad counts the recent ones)
    B.heat0 = volcanic ? 0.62 * (0.55 + 0.45 / (1 + 0.6 * this._volLoad)) : -T.impactHeat * (B.hasImpact ? 1 : 0.6); // negative = dusty flash, not magma
    B.heatRate = volcanic ? 2.4 : 30;
    B.seed = rnd() * 50;
    // impact push in the rock's own frame (inverse rotation of the world direction)
    {
      const p = (U * 1000) / B.scale * 0.55;
      const vx = B.ix * p, vz = B.iz * p, qx = -B.qx, qy = -B.qy, qz = -B.qz, qw = B.qw;
      const tx = 2 * (qy * vz), ty = 2 * (qz * vx - qx * vz), tz = 2 * (-qy * vx);
      B.ox = vx + qw * tx + (qy * tz - qz * ty); B.oy = qw * ty + (qz * tx - qx * tz); B.oz = vz + qw * tz + (qx * ty - qy * tx);
    }
    // fracture mesh: the high one if built, else the low one (built on the spot if need be — a few ms)
    // fracture mesh: the one cut from the LOD the rock was drawn with; if that is not built yet, the best
    // coarser one that is (the coarsest is built on the spot if need be — a few ms)
    B.sm = null;
    for (let l = this._lodFor(D); l >= 0 && !B.sm; l--) B.sm = this._shatterMesh(vr, l, false);
    if (!B.sm) B.sm = this._shatterMesh(vr, 0, true);
    if (B.sm) B.sm.used = this._tick;
    B.ev[0] = B.ev[1] = -1;
    if (B.sm) {
      // the clusters that split late get a puff of grit when they do
      let e = 0;
      const cl = B.sm.clusters;
      for (let k = 0; k < cl.length && e < 2; k++) {
        if (!cl[k].late) continue;
        const c1 = cl[k].w, c2 = (c1 * 7.31) % 1, c3 = (c1 * 13.77) % 1;
        B.ev[e] = k; B.evT[e] = (0.05 + 0.045 * c2 + 0.025 + 0.03 * c3) * 1000; e++;
      }
    } else this._burst(B);

    // the crack beat: sparks and a spit of grit at the struck face, a first breath of dust
    const R = B.scale * 0.5, tmp = this._tmp;
    if (B.hasImpact) {
      const hx = x - B.ix * R * 0.8, hz = z - B.iz * R * 0.8;
      const n = clamp(Math.round(4 + D * 0.05), 5, 12);
      for (let i = 0; i < n; i++) {
        randUnit(rnd, tmp);
        let dx = -B.ix * 1.2 + tmp[0], dy = tmp[1] * 1.1, dz = -B.iz * 1.2 + tmp[2];
        const dl = Math.hypot(dx, dy, dz) || 1, v = U * (0.7 + rnd() * 1.6);
        this._fragment(GRIT_POOLS[i & 1], vr, volcanic, hx, y, hz, tmp[0] * R * 0.15, tmp[1] * R * 0.15, tmp[2] * R * 0.15,
          (dx / dl) * v + B.vx, (dy / dl) * v, (dz / dl) * v + B.vz, 1.5 + rnd() * 1.6 + D * 0.006, 500 + rnd() * 500, volcanic ? 0.8 : 0.5, false);
      }
      if (fx && fx.sparks) fx.sparks(hx, y, hz, Math.round(8 + D * 0.12), -B.ix, -B.iz, this._sparkOpts);
    }
    if (fx && fx.dust) {
      const c = this._c3, dc = vr.dustColor, d = this._dustOpts;
      c[0] = dc[0]; c[1] = dc[1]; c[2] = dc[2];
      d.count = clamp(Math.round(3 + D * 0.03), 3, 8); d.speed = 60; d.life = 700;
      fx.dust(x, y, z, B.scale * 0.8, d);
    }
  }

  // the burst proper: pooled chunks, shards and grit + dust / smoke / fire
  _burst(B) {
    B.burst = true;
    const rnd = this.random, T = this.tune, fx = this.fx, tmp = this._tmp;
    const D = B.D, x = B.x, y = B.y, z = B.z, vr = B.vr, volcanic = B.volcanic, intensity = B.intensity;
    const ix = B.ix, iz = B.iz, hasImpact = B.hasImpact, pvx = B.vx, pvz = B.vz;
    const qx = B.qx, qy = B.qy, qz = B.qz, qw = B.qw;
    const ax = vr.spec.axes, axm = Math.max(ax[0], ax[1], ax[2]);
    const extra = (fx ? 1 : 1.3) * (B.sm ? 1 : 1.5) * intensity;
    const nMid = clamp(Math.round((2 + D * 0.05) * extra), 3, 16);
    const nShard = clamp(Math.round((12 + D * 0.2) * extra), 12, 64);
    const nGrit = clamp(Math.round((20 + D * 0.38) * extra), 22, 120);
    const total = nMid + nShard + nGrit;
    const U = (0.14 + 0.0014 * D) * T.speed * (0.75 + 0.25 * intensity); // units per ms
    const heatChance = volcanic ? 0.65 : hasImpact ? 0.28 : 0.1;
    const body = B.scale / axm;
    let trails = 0;

    for (let i = 0; i < total; i++) {
      let size, speed, life, pool, trail = false;
      if (i < nMid) {
        size = D * (0.07 + rnd() * (T.maxFragFrac - 0.07) * rnd());
        speed = 0.55 + rnd() * 0.75; life = 850 + rnd() * 500;
        pool = CHUNK_POOLS[(rnd() * 2) | 0];
        if (fx && trails < 3 && D >= 50 && rnd() < 0.6) { trail = true; trails++; }
      } else if (i < nMid + nShard) {
        size = Math.max(2.3, D * (0.022 + rnd() * 0.045));
        speed = 0.8 + rnd() * 1.3; life = 700 + rnd() * 650;
        pool = SHARD_POOLS[(rnd() * 2) | 0];
      } else {
        size = 1.3 + rnd() * 1.7 + D * 0.007;
        speed = 0.45 + rnd() * 2.1; life = 900 + rnd() * 1100;
        pool = GRIT_POOLS[(rnd() * 2) | 0];
      }

      // start somewhere inside the parent's (oriented, stretched) body
      randUnit(rnd, tmp);
      const rr = Math.cbrt(rnd()) * 0.46 * body;
      const lx = tmp[0] * rr * ax[0], ly = tmp[1] * rr * ax[1], lz = tmp[2] * rr * ax[2];
      const tx = 2 * (qy * lz - qz * ly), ty = 2 * (qz * lx - qx * lz), tz = 2 * (qx * ly - qy * lx);
      const ox = lx + qw * tx + (qy * tz - qz * ty);
      const oy = ly + qw * ty + (qz * tx - qx * tz);
      const oz = lz + qw * tz + (qx * ty - qy * tx);

      // fly radially outward in 3D, with a random component so the burst is not a perfect shell
      const ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      randUnit(rnd, tmp);
      const dx = ox / ol + tmp[0] * 0.55, dy = oy / ol + tmp[1] * 0.55, dz = oz / ol + tmp[2] * 0.55;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const v = U * speed;
      let vx = (dx / dl) * v, vy = (dy / dl) * v, vz = (dz / dl) * v;
      if (hasImpact) {
        if (i >= nMid && rnd() < 0.2) {
          // back-spray: a few bits spit back toward the shooter
          const b = U * (0.7 + rnd() * 0.9);
          vx -= ix * b; vz -= iz * b;
        } else {
          const b = U * (0.3 + rnd() * 0.55);
          vx += ix * b; vz += iz * b;
        }
      }
      this._fragment(pool, vr, volcanic, x, y, z, ox, oy, oz, vx + pvx, vy, vz + pvz, size, life, heatChance, trail);
    }

    if (fx) {
      // fx works in units per SECOND; debris here in units per ms
      const svx = pvx * 1000, svz = pvz * 1000;
      const c = this._c3, dc = vr.dustColor;
      c[0] = dc[0]; c[1] = dc[1]; c[2] = dc[2];
      if (fx.dust) {
        const d = this._dustOpts;
        d.count = clamp(Math.round(6 + D * 0.085), 7, 22); d.speed = 90 + D * 0.5; d.life = 1000 + D * 2;
        fx.dust(x, y, z, B.scale * 1.05, d);
      }
      if (volcanic) {
        // fireball only: the debris is ours, and the gameplay blast ring belongs to the caller
        const e = this._expOpts; e.vx = svx; e.vz = svz;
        // the second and third fireball of a chain are smaller: three at once must not white out the frame
        if (fx.explosion) fx.explosion(x, y, z, D * T.fxExplosionPerSize / (1 + 0.6 * this._volLoad), e);
        this._volLoad += 1;
      } else {
        if (D >= 110 && fx.smokePuff) {
          const s = this._smokeOpts;
          s.vx = svx; s.vy = 10; s.vz = svz; s.dark = 0.35; s.life = 1100; s.alpha = 1;
          c[0] = dc[0] * 0.8; c[1] = dc[1] * 0.8; c[2] = dc[2] * 0.8;
          fx.smokePuff(x, y, z, B.scale * 0.7, s);
        }
        if (fx.light && D >= 40) fx.light(x, y + 30, z, FLASH_COL, 2200 * (D / 100), 150, false);
      }
    }
  }

  // the live rock a hit at (x, y, z) on a rock of diameter D landed on (null if none fits)
  _findRock(x, y, z, D) {
    const L = this._live, ms = this.tune.meshScale;
    let best = null, bd = 1e9;
    for (let i = 0; i < L.length; i++) {
      const m = L[i];
      if (!m.parent || m.visible === false) continue;
      const d = m.scale.x / ms;
      if (Math.abs(d - D) > 0.3 * D) continue;
      const p = m.position, r = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (r > 0.8 * d) continue;
      const e = Math.abs(r - 0.45 * d) + Math.abs(d - D);
      if (e < bd) { bd = e; best = m; }
    }
    return best;
  }

  // a scar on that rock where the world-space direction (nx, ny, nz) leaves its centre
  _scar(mesh, nx, ny, nz, D) {
    const info = mesh.userData && mesh.userData.rock;
    if (!info || info.released || !info.vr) return;
    const vr = info.vr;
    let S = info.scar;
    if (!S) {
      // a material of its own (same program, own scar uniforms), from the variant's pool
      const pool = vr.scarPool || (vr.scarPool = []);
      for (let i = 0; i < pool.length; i++) if (!pool[i].used) { S = pool[i]; break; }
      if (!S) {
        if (pool.length >= 12) return;
        const THREE = this.THREE, u = { uRockScar: { value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)] } };
        const mat = this._material(vr, false, null, u);
        mat.color.setScalar(this._bright);
        pool.push(S = { mat, u, used: false });
      }
      S.used = true; info.scar = S; info.scars = 0;
      mesh.material = S.mat;
    }
    // into the rock's own frame
    const q = mesh.quaternion, qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const tx = 2 * (qy * nz - qz * ny), ty = 2 * (qz * nx - qx * nz), tz = 2 * (qx * ny - qy * nx);
    let ox = nx + qw * tx + (qy * tz - qz * ty), oy = ny + qw * ty + (qz * tx - qx * tz), oz = nz + qw * tz + (qx * ty - qy * tx);
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    const sv = S.u.uRockScar.value, sr = clamp(30 / (D * 0.6), 0.2, 0.38) * (0.85 + 0.3 * this.random());
    // a hit on an old scar deepens it; otherwise the oldest slot is reused
    for (let i = 0; i < 4; i++) {
      const v = sv[i];
      if (v.w > 0 && v.x * ox + v.y * oy + v.z * oz > Math.cos(0.6 * v.w)) { v.w = Math.min(0.46, v.w * 1.14); return; }
    }
    sv[info.scars++ & 3].set(ox, oy, oz, sr);
  }

  /**
   * A non-fatal hit knocked chips off at this surface point.
   * { x, y, z, size, dirX, dirZ, volcanic } — size = the rock's diameter, dir = travel direction of
   * the projectile (chips spray back out of the surface, i.e. mostly along −dir).
   * Optional: variant (for the palette), vx/vz (rock velocity, units per ms), count.
   * The rock that was hit keeps a scar (a fresh dent with a broken lip): it is found from the hit point, or pass
   * `object` (the mesh from create()). Where the scar goes: the direction centre → (x, y, z); override it with a
   * world-space direction `nx, ny, nz` (centre → impact point) when the hit point is only approximate. `scar: false` = none.
   */
  chip(o) {
    if (this._disposed) return;
    const rnd = this.random, T = this.tune, tmp = this._tmp;
    const D = o.size || 60, x = o.x || 0, y = o.y || 0, z = o.z || 0, volcanic = !!o.volcanic;
    const vr = this._variant(o.variant == null ? (rnd() * 97) | 0 : o.variant, volcanic);
    let ix = o.dirX || 0, iz = o.dirZ || 0;
    const l = Math.hypot(ix, iz);
    if (l > 1e-6) { ix /= l; iz /= l; } else { ix = 0; iz = 0; }
    if (o.scar !== false) {
      const m = o.object || this._findRock(x, y, z, D);
      if (m) {
        let nx = o.nx, ny = o.ny || 0, nz = o.nz;
        if (nx == null || nz == null) {
          nx = x - m.position.x; ny = y - m.position.y; nz = z - m.position.z;
          if (Math.hypot(nx, ny, nz) < 0.05 * D) { nx = -ix; ny = 0; nz = -iz; } // hit point = the centre: the face the shot came in through
        }
        if (nx || ny || nz) this._scar(m, nx, ny, nz, D);
      }
    }
    const pvx = o.vx || 0, pvz = o.vz || 0;
    const n = o.count || clamp(13 + ((rnd() * 6) | 0) + (D > 150 ? 5 : D > 90 ? 2 : 0), 12, 24);
    const U = (0.17 + 0.0006 * D) * T.speed;
    for (let i = 0; i < n; i++) {
      // a tight cone back along the shot, fanned out in 3D; a couple of proper chips, the rest grit
      randUnit(rnd, tmp);
      const sp = i < 4 ? 0.55 : 1.0;
      const dx = -ix * 1.25 + tmp[0] * sp, dy = tmp[1] * sp * 1.15, dz = -iz * 1.25 + tmp[2] * sp;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const v = U * (0.4 + rnd() * 1.5);
      const j = D * 0.04;
      let pool, size, life;
      if (i === 0 && D > 100) { pool = CHUNK_POOLS[(rnd() * 2) | 0]; size = clamp(D * (0.04 + rnd() * 0.03), 5, 12); life = 600 + rnd() * 400; }
      else if (i < 8) { pool = SHARD_POOLS[(rnd() * 2) | 0]; size = clamp(D * (0.026 + rnd() * 0.034), 2.6, 10); life = 600 + rnd() * 500; }
      else { pool = GRIT_POOLS[i & 1]; size = 1.5 + rnd() * 1.8 + D * 0.005; life = 600 + rnd() * 800; }
      this._fragment(pool, vr, volcanic, x, y, z, tmp[0] * j, tmp[1] * j, tmp[2] * j,
        (dx / dl) * v + pvx, (dy / dl) * v, (dz / dl) * v + pvz, size, life, volcanic ? 0.8 : 0.5, false);
    }
    const fx = this.fx;
    if (fx) {
      if (fx.dust) {
        const c = this._c3, dc = vr.dustColor, d = this._dustOpts;
        c[0] = dc[0]; c[1] = dc[1]; c[2] = dc[2];
        d.count = 5; d.speed = 80; d.life = 700;
        fx.dust(x, y, z, clamp(D * 0.32, 14, 64), d);
      }
      if (fx.sparks) fx.sparks(x, y, z, volcanic ? 10 : 7, -ix, -iz, this._sparkOpts);
    }
  }

  /** Advance debris + magma pulse + background geometry builds. dtMs = simulation dt (0 while paused). */
  update(dtMs) {
    if (this._disposed) return;
    const dt = dtMs > 0 ? (dtMs > 100 ? 100 : dtMs) : 0;
    const T = this.tune, fx = this.fx;
    const u = this._u.uRockPulse;
    u.value = (u.value + dt * 0.0021) % 12.566370614359172;

    // key light for the body shadow
    if (!this.sun || --this._sunScan < 0) {
      this._sunScan = 120;
      if (!this.sun || !this.sun.parent) {
        this.sun = null;
        const ch = this.scene.children;
        for (let i = 0; i < ch.length; i++) if (ch[i].isDirectionalLight) { this.sun = ch[i]; break; }
      }
    }
    const sun = this.sun, sc = this._u.uRockSunCol.value;
    if (sun && sun.visible !== false) {
      const sd = this._u.uRockSun.value, p = sun.position, tp = sun.target ? sun.target.position : null;
      const lx = p.x - (tp ? tp.x : 0), ly = p.y - (tp ? tp.y : 0), lz = p.z - (tp ? tp.z : 0), ll = Math.hypot(lx, ly, lz) || 1;
      sd.set(lx / ll, ly / ll, lz / ll);
      sc.set(sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity);
    } else sc.set(0, 0, 0);

    if ((++this._tick & 255) === 0) this._trimFracture(null);
    this._pump();

    this._volLoad *= Math.exp(-dt / 400);
    this._u.uRockHot.value.y = T.hotCap / (1 + 0.45 * this._volLoad);

    // fracture instances
    const SM = this._shMeshes;
    for (let i = 0; i < SM.length; i++) SM[i].n = 0;
    const pdamp = Math.exp(-0.0011 * dt), off = this._o3;
    for (let bi = 0; bi < MAX_BURSTS; bi++) {
      const B = this._bursts[bi];
      if (!B.active) continue;
      B.age += dt;
      B.vx *= pdamp; B.vz *= pdamp;
      B.x += B.vx * dt; B.z += B.vz * dt;
      if (!B.burst && B.age >= T.crackMs) this._burst(B);
      if (B.age >= B.life) { B.active = false; continue; }
      const sm = B.sm;
      if (!sm) { if (B.burst) B.active = false; continue; }
      const qx = B.qx, qy = B.qy, qz = B.qz, qw = B.qw, s = B.scale;
      // late cluster breaks: grit + dust where the cluster is right now
      for (let e = 0; e < 2; e++) {
        if (B.ev[e] < 0 || B.age < B.evT[e]) continue;
        const K = sm.clusters[B.ev[e]];
        B.ev[e] = -1;
        this._clusterOffset(K, B.age / 1000, B.speed, B.ox, B.oy, B.oz, off);
        const lx = off[0] * s, ly = off[1] * s, lz = off[2] * s;
        const tx = 2 * (qy * lz - qz * ly), ty = 2 * (qz * lx - qx * lz), tz = 2 * (qx * ly - qy * lx);
        const wx = B.x + lx + qw * tx + (qy * tz - qz * ty), wy = B.y + ly + qw * ty + (qz * tx - qx * tz), wz = B.z + lz + qw * tz + (qx * ty - qy * tx);
        const rnd = this.random, tmp = this._tmp, n = clamp(Math.round(5 + B.D * 0.05), 6, 14), U = 0.1 + 0.0007 * B.D;
        const kvx = (wx - B.x) / Math.max(B.age, 1) * 0.5, kvy = (wy - B.y) / Math.max(B.age, 1) * 0.5, kvz = (wz - B.z) / Math.max(B.age, 1) * 0.5;
        for (let i = 0; i < n; i++) {
          randUnit(rnd, tmp);
          const v = U * (0.4 + rnd() * 1.4), r = B.D * 0.08;
          this._fragment(i < 3 ? SHARD_POOLS[i & 1] : GRIT_POOLS[i & 1], B.vr, B.volcanic, wx, wy, wz, tmp[0] * r, tmp[1] * r, tmp[2] * r,
            tmp[0] * v + kvx, tmp[1] * v + kvy, tmp[2] * v + kvz, i < 3 ? Math.max(2.3, B.D * (0.02 + rnd() * 0.025)) : 1.3 + rnd() * 1.6, 500 + rnd() * 600, B.volcanic ? 0.7 : 0.2, false);
        }
        if (fx && fx.dust) {
          const c = this._c3, dc = B.vr.dustColor, d = this._dustOpts;
          c[0] = dc[0]; c[1] = dc[1]; c[2] = dc[2];
          d.count = 3; d.speed = 50; d.life = 600;
          fx.dust(wx, wy, wz, B.D * 0.35, d);
        }
      }
      const i = sm.n++, m = sm.mesh.instanceMatrix.array, e = i * 16;
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
      m[e] = (1 - (yy + zz)) * s; m[e + 1] = (xy + wz) * s; m[e + 2] = (xz - wy) * s; m[e + 3] = 0;
      m[e + 4] = (xy - wz) * s; m[e + 5] = (1 - (xx + zz)) * s; m[e + 6] = (yz + wx) * s; m[e + 7] = 0;
      m[e + 8] = (xz + wy) * s; m[e + 9] = (yz - wx) * s; m[e + 10] = (1 - (xx + yy)) * s; m[e + 11] = 0;
      m[e + 12] = B.x; m[e + 13] = B.y; m[e + 14] = B.z; m[e + 15] = 1;
      const ba = sm.burst.array, ia = sm.imp.array, t = B.age / 1000;
      ba[i * 4] = t; ba[i * 4 + 1] = B.speed; ba[i * 4 + 2] = B.lifeS; ba[i * 4 + 3] = B.heat0 * Math.exp(-B.heatRate * t);
      ia[i * 4] = B.ox; ia[i * 4 + 1] = B.oy; ia[i * 4 + 2] = B.oz; ia[i * 4 + 3] = B.seed;
    }
    for (let i = 0; i < SM.length; i++) {
      const sm = SM[i], n = sm.n;
      sm.mesh.count = n;
      sm.mesh.visible = n > 0;
      if (n > 0) { sm.mesh.instanceMatrix.needsUpdate = true; sm.burst.needsUpdate = true; sm.imp.needsUpdate = true; }
    }

    // pooled debris
    this._trailN = 0;
    const damp = Math.exp(-T.drag * dt);
    const pools = this._pools;
    for (let pi = 0; pi < pools.length; pi++) {
      const p = pools[pi];
      if (p.n === 0) {
        if (p.mesh.visible) { p.mesh.visible = false; p.mesh.count = 0; }
        continue;
      }
      const st = p.st, m = p.mat, col = p.col, heat = p.heat.array, trails = p.trail && fx && fx.smokePuff;
      let n = p.n;
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        const age = (st[o + S_AGE] += dt);
        const life = st[o + S_LIFE];
        if (age >= life) {
          // swap-remove: move the last live fragment into this slot and revisit it
          n--;
          if (i !== n) {
            const s = n * STRIDE;
            for (let k = 0; k < STRIDE; k++) st[o + k] = st[s + k];
            col[i * 3] = col[n * 3]; col[i * 3 + 1] = col[n * 3 + 1]; col[i * 3 + 2] = col[n * 3 + 2];
            p.colDirty = true;
          }
          i--;
          continue;
        }
        const vx = (st[o + S_VX] *= damp), vy = (st[o + S_VY] *= damp), vz = (st[o + S_VZ] *= damp);
        const px = (st[o + S_PX] += vx * dt), py = (st[o + S_PY] += vy * dt), pz = (st[o + S_PZ] += vz * dt);
        const ang = (st[o + S_ANG] += st[o + S_SPIN] * dt);
        const h = st[o + S_HEAT];
        if (h > 0) st[o + S_HEAT] = h * Math.exp(-st[o + S_COOL] * dt);
        heat[i] = h;

        // hold full size, then shrink away over the last 40% of life
        let t = (age / life - 0.6) / 0.4;
        t = t < 0 ? 0 : t;
        const s = st[o + S_SIZE] * (1 - t * t * (3 - 2 * t) * 0.999);

        // a few chunks drag a thread of dust behind them
        if (trails && st[o + S_TRAIL] > 0 && dt > 0 && (st[o + S_TRAIL] -= dt) <= 0 && this._trailN++ < 3) {
          st[o + S_TRAIL] = t < 0.7 ? 45 + s * 2 : 0;
          const c = this._c3, so = this._smokeOpts;
          c[0] = col[i * 3] * 1.3; c[1] = col[i * 3 + 1] * 1.3; c[2] = col[i * 3 + 2] * 1.3;
          so.vx = vx * 180; so.vy = vy * 180; so.vz = vz * 180; so.dark = 0.3; so.life = 520; so.alpha = 0.55 * (1 - t);
          fx.smokePuff(px, py, pz, s * 1.7, so);
        }

        const ax = st[o + S_AX], ay = st[o + S_AY], az = st[o + S_AZ];
        const c = Math.cos(ang), sn = Math.sin(ang), ic = 1 - c;
        const e = i * 16;
        m[e] = (ic * ax * ax + c) * s;
        m[e + 1] = (ic * ax * ay + sn * az) * s;
        m[e + 2] = (ic * ax * az - sn * ay) * s;
        m[e + 3] = 0;
        m[e + 4] = (ic * ax * ay - sn * az) * s;
        m[e + 5] = (ic * ay * ay + c) * s;
        m[e + 6] = (ic * ay * az + sn * ax) * s;
        m[e + 7] = 0;
        m[e + 8] = (ic * ax * az + sn * ay) * s;
        m[e + 9] = (ic * ay * az - sn * ax) * s;
        m[e + 10] = (ic * az * az + c) * s;
        m[e + 11] = 0;
        m[e + 12] = px; m[e + 13] = py; m[e + 14] = pz; m[e + 15] = 1;
      }
      p.n = n;
      p.mesh.count = n;
      p.mesh.visible = n > 0;
      if (n > 0) {
        p.mesh.instanceMatrix.needsUpdate = true;
        p.heat.needsUpdate = true;
        if (p.colDirty) { p.mesh.instanceColor.needsUpdate = true; p.colDirty = false; }
      }
    }
  }

  /** Number of live pooled debris fragments (all pools). */
  get liveFragments() {
    let n = 0;
    for (let i = 0; i < this._pools.length; i++) n += this._pools[i].n;
    return n;
  }

  /** Number of rocks currently breaking apart (fracture-mesh instances). */
  get liveBursts() {
    let n = 0;
    for (let i = 0; i < MAX_BURSTS; i++) if (this._bursts[i].active) n++;
    return n;
  }

  /** { fragments, bursts, drawCalls, tris, pendingBuilds, buildMs, buildMaxSliceMs } of the debris right now. */
  stats() {
    let draws = 0, tris = 0;
    for (const p of this._pools) if (p.n) { draws++; tris += p.n * p.tris; }
    for (const s of this._shMeshes) if (s.n) { draws++; tris += s.n * s.tris; }
    return { fragments: this.liveFragments, bursts: this.liveBursts, drawCalls: draws, tris, pendingBuilds: this._queue.length, buildMs: this.buildMs, buildMaxSliceMs: this.buildMaxSliceMs };
  }

  /** Remove all debris (rocks created with create() belong to the caller). */
  clear() {
    for (const p of this._pools) { p.n = 0; p.mesh.count = 0; p.mesh.visible = false; }
    for (const b of this._bursts) b.active = false;
    for (const s of this._shMeshes) { s.n = 0; s.mesh.count = 0; s.mesh.visible = false; }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const p of this._pools) {
      this.scene.remove(p.mesh);
      p.geo.dispose();
      if (p.mesh.dispose) p.mesh.dispose();
    }
    for (const vr of this._all) {
      for (let i = 0; i < vr.geo.length; i++) if (vr.geo[i]) { vr.geo[i].dispose(); vr.geo[i] = null; }
      for (let i = 0; i < vr.sh.length; i++) {
        const s = vr.sh[i];
        if (!s) continue;
        if (s.mesh) { this.scene.remove(s.mesh); if (s.mesh.dispose) s.mesh.dispose(); }
        s.geo.dispose(); s.tex.dispose();
        vr.sh[i] = null;
      }
      vr.data = [null, null, null, null];
      vr.jobs = [null, null, null, null, null, null, null, null];
      vr.shMat = null; vr.scarPool = null;
    }
    for (const m of this._materials) m.dispose();
    this._pools.length = 0;
    this._shMeshes.length = 0;
    this._live.length = 0;
    this._queue.length = 0;
    this._pending.length = 0;
    this._idle = null;
    for (const b of this._bursts) b.active = false;
  }
}
