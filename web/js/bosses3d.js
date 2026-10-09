// bosses3d.js — the capital ships, built entirely in code.
//
// Six hull classes share one modelling kit and one design language with the
// rest of the hostile fleet (enemies3d.js), scaled up to set-piece size:
//
//   dreadnought   stepped battleship, sponson batteries, citadel tower
//   lance         spinal-laser ship: forked prow, capacitor rings, radiators
//   carrier       flat-top with bow hangar mouths and an offset island   (level % 3)
//   ram           armoured plough prow, tusks, oversized engine block    (level % 4)
//   leviathan     asymmetric living hull: carapace, scythe arm, maw
//   citadel       MEGA (level % 5): armoured shell around a reactor core
//
// The level seeds everything else: palette (the same hue walk as bossgen.js),
// livery, towers, engine count, greebles. A boss is built in bossgen's model
// units around the same bounding box, with a mount exactly on every
// gen.turrets[i].pivot, so the integrator keeps bossgen's fit and aim maths.
//
// Rendering: two shader programs for everything in this file.
//   hull  — MeshStandardMaterial patched with a procedural capital-ship surface
//           (plating, lit window rows, wear), progressive battle damage (scorch →
//           torn plating → burning decks seen through the holes), emissive
//           channels and a small vertex animation track (doors, plates, peel);
//   glow  — additive HDR pass for plumes, halos and charge glows.
// Hulls are pre-cut into major sections at build time, so the death sequence
// tears real geometry apart; the faces behind every cut and every wound are
// the glowing deck structure of the same shader.
//
// Model space: +X nose, +Y up, +Z starboard, units = bossgen model units.
// The module imports nothing; it receives THREE and (optionally) the game's Fx3D.
//
//   const bosses = new Bosses3D(THREE, { fx, quality: 1 });
//   bosses.warmup(renderer, camera, scene);                            // or add bosses.sample() to your own warm-up group
//   while (!bosses.prepare(level, gen, { mega })) await nextFrame();   // sliced build, ~10 short steps
//   const g = bosses.build(level, gen, { mega });                      // scale = fit.scale * 1.08, rotation.y = PI
//   g.userData:
//     turrets[i]            aim with .rotation.y (0 = barrels toward the nose); they ride on their hull section
//     nozzles               [{x,y,z,r}] model units (empty once a MEGA is down to its core)
//     emitter               [x,y,z] model units: the main-battery lens, where the lance beam should start
//     setFlash(0..1) setDamage(0..1) setShield(bool) setArrive(0..1)
//     setCharge(kind, 0..1) 'laser' | 'sweep' | 'ram' | 'volley' | 'bay'
//     blowTurret(i, {silent}) wreckage, stump and its own fireball (silent: restore a boss that had already lost it)
//     setPhase2({instant})  MEGA: the shell is thrown clear over ~3 s and the core unfolds
//     setDeath(q, tMs)      q 0..1 over the 1.7 s sequence; keep calling update() after q = 1 and the pieces keep drifting
//     update(dtMs, tMs, world)   world = { x, y, z, scale, rotY } of the group — every particle is emitted in world space
//     dispose()
//
// MEGA sizing: the core is modelled in hull units (about 0.9 of the hull's length across, like the sim's core
// fit) and corrects itself from world.scale, so the group may keep the hull scale or switch to the core's fit;
// wreckage of the shell likewise keeps the scale and heading the hull had when it broke.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex, k = 1) => [s2l(((hex >> 16) & 255) / 255) * k, s2l(((hex >> 8) & 255) / 255) * k, s2l((hex & 255) / 255) * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// h 0..360, s/l 0..1 → linear rgb
function hsl(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return s2l(l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
}
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// surface kinds (aPrm.x)
const M = { PAINT: 0, METAL: 1, GLASS: 2, DECKS: 3, EMIS: 4, BIO: 5, PLASMA: 6, STRUCT: 7 };
// emissive channels (index into uBLv)
const CH = {
  STATIC: 0, ENGINE: 1, NAV: 2, STROBE: 3, ACCENT: 4, LASER: 5, SWEEP: 6, RAM: 7, VOLLEY: 8, BAY: 9, SHIELD: 10, BEACON: 11,
  STUMP: 12, /* 12..15 */ CORE: 16, BEAM: 17, BIO: 18, SEAM: 19, N: 24,
};
// vertex animation tracks (index into uBAn)
const AN = { BAY: 1, RAM: 2, PEEL: 3, LASER: 4, DEPLOY: 5, N: 8 };

const PITCH = lin(0x060709), DARK = lin(0x191b20), GUN = lin(0x33373f), STEEL = lin(0x6b717b), HEAT = lin(0x4a3d34);
const ENG = { hot: [5.2, 3.9, 2.3], mid: [4.2, 1.4, 0.28], rim: [2.2, 0.45, 0.07] };
const LAMP_RED = [5.5, 0.4, 0.12], LAMP_WHITE = [3.2, 3.0, 2.6], LAMP_AMBER = [4.5, 1.9, 0.22];
const WINDOW_GLASS = [1.6, 2.3, 2.8];

/* ========================================================================== */
/*  Triangle kit — every helper returns a flat [x,y,z, …] list, 9 per triangle */
/* ========================================================================== */

const tri = (t, a, b, c) => { t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
const quad = (t, a, b, c, d) => { tri(t, a, b, c); tri(t, a, c, d); };
function flip(t) {
  for (let i = 0; i < t.length; i += 9) for (let j = 0; j < 3; j++) { const v = t[i + 3 + j]; t[i + 3 + j] = t[i + 6 + j]; t[i + 6 + j] = v; }
  return t;
}
function move(t, dx, dy, dz) { for (let i = 0; i < t.length; i += 3) { t[i] += dx; t[i + 1] += dy; t[i + 2] += dz; } return t; }
function rot(t, ax, a) {
  const c = Math.cos(a), s = Math.sin(a), u = (ax + 1) % 3, v = (ax + 2) % 3;
  for (let i = 0; i < t.length; i += 3) { const p = t[i + u], q = t[i + v]; t[i + u] = p * c - q * s; t[i + v] = p * s + q * c; }
  return t;
}
const rotX = (t, a) => rot(t, 0, a), rotY = (t, a) => rot(t, 1, a);
const centroid = (r) => { const c = [0, 0, 0]; for (const p of r) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } const n = r.length || 1; return [c[0] / n, c[1] / n, c[2] / n]; };

// skin over a list of closed rings (same point count); winding is fixed up so faces look outward
function loft(rings, o = {}) {
  const t = [], n = rings[0].length;
  let sum = 0;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1], ca = centroid(A), cb = centroid(B);
    const cx = (ca[0] + cb[0]) / 2, cy = (ca[1] + cb[1]) / 2, cz = (ca[2] + cb[2]) / 2;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n, a = A[j], b = A[j1], c = B[j1], d = B[j];
      quad(t, a, b, c, d);
      // outwardness of this quad (unnormalised normal · offset from the axis)
      const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
      sum += (uy * vz - uz * vy) * ((a[0] + c[0]) / 2 - cx) + (uz * vx - ux * vz) * ((a[1] + c[1]) / 2 - cy) + (ux * vy - uy * vx) * ((a[2] + c[2]) / 2 - cz);
    }
  }
  if (sum < 0) flip(t);
  const cap = (R, other) => {
    const c = centroid(R), oc = centroid(other), k = [];
    for (let j = 0; j < n; j++) tri(k, c, R[j], R[(j + 1) % n]);
    // the cap must face away from the neighbouring ring
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < n; j++) {
      const a = R[j], b = R[(j + 1) % n];
      nx += (a[1] - c[1]) * (b[2] - c[2]) - (a[2] - c[2]) * (b[1] - c[1]);
      ny += (a[2] - c[2]) * (b[0] - c[0]) - (a[0] - c[0]) * (b[2] - c[2]);
      nz += (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0]);
    }
    if (nx * (c[0] - oc[0]) + ny * (c[1] - oc[1]) + nz * (c[2] - oc[2]) < 0) flip(k);
    for (let i = 0; i < k.length; i++) t.push(k[i]);
  };
  if (o.capA !== false) cap(rings[0], rings[rings.length - 1]);
  if (o.capB !== false) cap(rings[rings.length - 1], rings[0]);
  return t;
}
// rectangle ring in the YZ plane at x, optional chamfer → octagon
function ringRect(x, y0, y1, z0, z1, c = 0) {
  if (c <= 0) return [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]];
  return [[x, y0, z0 + c], [x, y0 + c, z0], [x, y1 - c, z0], [x, y1, z0 + c], [x, y1, z1 - c], [x, y1 - c, z1], [x, y0 + c, z1], [x, y0, z1 - c]];
}
const box = (x0, x1, y0, y1, z0, z1, c = 0) => loft([ringRect(x0, y0, y1, z0, z1, c), ringRect(x1, y0, y1, z0, z1, c)]);
// box whose section changes from one end to the other: a = [y0,y1,z0,z1] at x0, b at x1
const tbox = (x0, x1, a, b, c = 0) => loft([ringRect(x0, a[0], a[1], a[2], a[3], c), ringRect(x1, b[0], b[1], b[2], b[3], c)]);
// extruded XZ polygon (convex) from y0 to y1; the top is scaled by `taper` about (cx, cz)
function prismY(poly, y0, y1, taper = 1, cx = 0, cz = 0) {
  return loft([poly.map((p) => [p[0], y0, p[1]]), poly.map((p) => [cx + (p[0] - cx) * taper, y1, cz + (p[1] - cz) * taper])]);
}
// surface of revolution around the X axis; profile [[x, r], …] listed nose → tail faces outward
function lathe(prof, n, o = {}) {
  const y = o.y || 0, z = o.z || 0, sy = o.sy || 1, sz = o.sz || 1, ph = o.phase || 0, t = [];
  const a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU, full = Math.abs(a1 - a0 - TAU) < 1e-6;
  const pt = (p, j) => { const a = ph + lerp(a0, a1, j / n); return [p[0], y + Math.sin(a) * p[1] * sy, z + Math.cos(a) * p[1] * sz]; };
  for (let i = 0; i < prof.length - 1; i++) {
    const p = prof[i], q = prof[i + 1];
    for (let j = 0; j < n; j++) {
      const j1 = full ? (j + 1) % n : j + 1;
      const a = pt(p, j), b = pt(p, j1), c = pt(q, j1), d = pt(q, j);
      if (p[1] < 1e-5) tri(t, a, c, d); else if (q[1] < 1e-5) tri(t, a, b, c); else quad(t, a, b, c, d);
    }
  }
  // orientation: the first real triangle belongs to the first real profile segment
  let k0 = 0;
  while (k0 < prof.length - 2 && Math.abs(prof[k0 + 1][0] - prof[k0][0]) < 1e-6 && Math.abs(prof[k0 + 1][1] - prof[k0][1]) < 1e-6) k0++;
  for (let i = 0; i < t.length; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    const my = (t[i + 1] + t[i + 4] + t[i + 7]) / 3 - y, mz = (t[i + 2] + t[i + 5] + t[i + 8]) / 3 - z;
    // a wall listed nose → tail faces away from the axis; a disc faces the way the profile opens
    const rad = ny * my + nz * mz, dx = prof[k0 + 1][0] - prof[k0][0], dr = prof[k0 + 1][1] - prof[k0][1];
    const want = Math.abs(dx) > 1e-6 ? (dx < 0 ? 1 : -1) * (rad >= 0 ? 1 : -1) : (dr > 0 ? 1 : -1) * (nx >= 0 ? 1 : -1);
    if (want < 0) flip(t);
    break;
  }
  if (o.flip) flip(t);
  return t;
}
// surface of revolution around the vertical through (x, z); profile [[y, r], …] listed top → bottom faces outward
function latheY(prof, n, x = 0, z = 0, o = {}) {
  const t = lathe(prof, n, { phase: o.phase || 0, sy: o.sx || 1, sz: o.sz || 1, a0: o.a0, a1: o.a1 });
  // lathe axis X → Y: (x, y, z) → (y, x, z) is a reflection, so flip back
  for (let i = 0; i < t.length; i += 3) { const a = t[i], b = t[i + 1]; t[i] = x + b; t[i + 1] = a; t[i + 2] += z; }
  return flip(t);
}
// thin prism between two points
function rod(a, b, r, n = 3, r1 = r) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / l, dy / l, dz / l];
  const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const ring = (p, rr) => { const o = []; for (let j = 0; j < n; j++) { const an = (j / n) * TAU, c = Math.cos(an) * rr, s = Math.sin(an) * rr; o.push([p[0] + u[0] * c + v[0] * s, p[1] + u[1] * c + v[1] * s, p[2] + u[2] * c + v[2] * s]); } return o; };
  return loft([ring(a, r), ring(b, r1)]);
}
// closed band around the vertical axis through (cx, cz): hexagonal section
function torusY(cx, cy, cz, R, a, b, n, a0 = 0, a1 = TAU) {
  const rings = [], full = Math.abs(a1 - a0 - TAU) < 1e-6;
  for (let i = 0; i <= n; i++) {
    const an = lerp(a0, a1, i / n), c = Math.cos(an), s = Math.sin(an);
    rings.push([[R + a, 0], [R + a * 0.45, b], [R - a * 0.45, b], [R - a, 0], [R - a * 0.45, -b], [R + a * 0.45, -b]].map(([r, y]) => [cx + c * r, cy + y, cz + s * r]));
  }
  return loft(rings, { capA: !full, capB: !full });
}
// faceted ball
const ball = (x, y, z, r, n = 8, m = 5, sy = 1) => {
  const p = [];
  for (let i = 0; i <= m; i++) { const a = (i / m) * Math.PI; p.push([y + Math.cos(a) * r * sy, Math.max(0, Math.sin(a) * r)]); }
  p[0][1] = 0; p[m][1] = 0;
  return latheY(p, n, x, z);
};

// The main hull: a chined capital-ship section lofted through stations.
// station: { x, w half-beam, t deck height, b keel depth, y centre offset,
//            dk deck half-width (·w), sh shoulder height (·t), ws shoulder width (·w),
//            bl bilge depth (·b), wb bilge width (·w), ks keel half-width (·w) }
const ST_DEF = { y: 0, dk: 0.5, sh: 0.55, ws: 0.9, bl: 0.5, wb: 0.86, ks: 0.34 };
function hullRing(s, k = 1) {
  const w = s.w * k, t = s.t * k, b = s.b * k;
  const h = [[t, 0], [t, w * s.dk], [t * s.sh, w * s.ws], [0, w], [-b * s.bl, w * s.wb], [-b, w * s.ks], [-b, 0]];
  const r = [];
  for (let i = 0; i <= 6; i++) r.push([s.x, s.y + h[i][0], h[i][1]]);
  for (let i = 5; i >= 1; i--) r.push([s.x, s.y + h[i][0], -h[i][1]]);
  return r;
}
function hullLoft(stations, o = {}) {
  const st = stations.map((s) => ({ ...ST_DEF, ...s })).sort((a, b) => b.x - a.x);
  const step = o.step ?? 3.2, keys = ['x', 'w', 't', 'b', 'y', 'dk', 'sh', 'ws', 'bl', 'wb', 'ks'];
  const at = (x) => {
    if (x >= st[0].x) return st[0];
    for (let i = 0; i < st.length - 1; i++) {
      if (x >= st[i + 1].x) { const f = (st[i].x - x) / (st[i].x - st[i + 1].x), r = {}; for (const k of keys) r[k] = lerp(st[i][k], st[i + 1][k], f); return r; }
    }
    return st[st.length - 1];
  };
  const fine = [];
  for (let i = 0; i < st.length - 1; i++) {
    const n = Math.max(1, Math.ceil((st[i].x - st[i + 1].x) / step));
    for (let j = 0; j < n; j++) fine.push(at(lerp(st[i].x, st[i + 1].x, j / n)));
  }
  fine.push(st[st.length - 1]);
  return {
    st, at,
    tris: loft(fine.map((s) => hullRing(s)), o),
    inner: (k = 0.86) => loft(fine.filter((s, i) => i > 0 && i < fine.length - 1).map((s) => hullRing(s, k))),
    top: (x) => { const s = at(x); return s.y + s.t; },
    bot: (x) => { const s = at(x); return s.y - s.b; },
    hw: (x) => at(x).w,
    deck: (x) => { const s = at(x); return s.w * s.dk; },
    ring: (x, k = 1) => hullRing(at(x), k),
  };
}

/* ========================================================================== */
/*  Build buffers                                                             */
/* ========================================================================== */

function newBuf() {
  return { pos: [], nrm: [], col: [], prm: [], anm: [], key: [], sec: [], gpos: [], gcol: [], gprm: [], gkey: [], gsec: [] };
}
// smooth normals inside one part: faces meeting at a vertex under `crease` degrees share a normal
function smoothNormals(t, fn, crease) {
  const cosC = Math.cos(crease * DEG), map = new Map(), n = t.length / 9, out = new Float32Array(t.length);
  const key = (i) => (Math.round(t[i] * 64) + 16384) + (Math.round(t[i + 1] * 64) + 16384) * 32768 + (Math.round(t[i + 2] * 64) + 16384) * 1073741824;
  for (let f = 0; f < n; f++) for (let v = 0; v < 3; v++) {
    const k = key(f * 9 + v * 3); let l = map.get(k);
    if (!l) map.set(k, (l = []));
    l.push(f);
  }
  for (let f = 0; f < n; f++) for (let v = 0; v < 3; v++) {
    const l = map.get(key(f * 9 + v * 3)), ax = fn[f * 4], ay = fn[f * 4 + 1], az = fn[f * 4 + 2];
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < l.length; i++) {
      const g = l[i] * 4, d = fn[g] * ax + fn[g + 1] * ay + fn[g + 2] * az;
      if (d >= cosC) { const w = fn[g + 3]; x += fn[g] * w; y += fn[g + 1] * w; z += fn[g + 2] * w; }
    }
    const len = Math.hypot(x, y, z) || 1, o = f * 9 + v * 3;
    out[o] = x / len; out[o + 1] = y / len; out[o + 2] = z / len;
  }
  return out;
}

class Kit {
  constructor(q, R) {
    this.q = q; this.R = R;
    this.bufs = new Map();
    this.cur = null; this.sec = -1;
    this.nozzles = []; this.wounds = []; this.rot = []; this.blasts = [];
    this.emitter = [60, 0, 0]; this.bays = []; this.cuts = [];
    this.use('hull');
  }
  use(name) { let b = this.bufs.get(name); if (!b) this.bufs.set(name, (b = newBuf())); this.cur = b; return this; }
  seg(n) { return this.q >= 1 ? n : Math.max(4, Math.round(n * 0.6)); }
  // detail count scaled by quality
  cnt(n) { return this.q >= 1 ? n : Math.max(1, Math.round(n * 0.5)); }
  rr(a, b) { return a + this.R() * (b - a); }
  pick(l) { return l[Math.floor(this.R() * l.length) % l.length]; }

  // opaque surface. o: mat, win (0..255 window density on walls), ch + ph (emissive channel for M.EMIS / M.PLASMA),
  //   crease (degrees; omitted = flat facets), anim [dx,dy,dz, track, delay 0..1], whole (keep the part in one hull section)
  add(t, col, o = {}) {
    const b = this.cur, n = t.length / 9;
    if (!n) return;
    const mat = o.mat ?? M.PAINT, win = o.win ?? 0, ch = o.ch ?? 0, ph = Math.round(sat(o.ph ?? 0) * 255);
    const an = o.anim, ax = an ? Math.round(an[0] * 64) : 0, ay = an ? Math.round(an[1] * 64) : 0, az = an ? Math.round(an[2] * 64) : 0;
    const aw = an ? an[3] * 16 + Math.round(sat(an[4] || 0) * 15) : 0;
    const fn = new Float32Array(n * 4);
    let x0 = Infinity, x1 = -Infinity, sx = 0, sy = 0, sz = 0;
    for (let f = 0; f < n; f++) {
      const i = f * 9;
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
      fn[f * 4] = l > 0 ? nx / l : 0; fn[f * 4 + 1] = l > 0 ? ny / l : 1; fn[f * 4 + 2] = l > 0 ? nz / l : 0; fn[f * 4 + 3] = l;
      for (let v = 0; v < 9; v += 3) { const x = t[i + v]; if (x < x0) x0 = x; if (x > x1) x1 = x; sx += x; sy += t[i + v + 1]; sz += t[i + v + 2]; }
    }
    const sm = o.crease ? smoothNormals(t, fn, o.crease) : null;
    const whole = o.whole ?? (x1 - x0 < 18), cnt = n * 3;
    const wkey = sx / cnt + 2.5 * Math.sin((sz / cnt) * 0.23 + 1.3) + 1.5 * Math.sin((sy / cnt) * 0.6);
    for (let f = 0; f < n; f++) {
      if (fn[f * 4 + 3] < 1e-7) continue; // degenerate
      const i = f * 9;
      for (let v = 0; v < 3; v++) {
        const o3 = i + v * 3;
        b.pos.push(t[o3], t[o3 + 1], t[o3 + 2]);
        if (sm) b.nrm.push(sm[o3], sm[o3 + 1], sm[o3 + 2]); else b.nrm.push(fn[f * 4], fn[f * 4 + 1], fn[f * 4 + 2]);
        b.col.push(col[0], col[1], col[2]);
        b.prm.push(mat, win, ch, ph);
        b.anm.push(ax, ay, az, aw);
      }
      if (whole) b.key.push(wkey);
      else {
        const cx = (t[i] + t[i + 3] + t[i + 6]) / 3, cy = (t[i + 1] + t[i + 4] + t[i + 7]) / 3, cz = (t[i + 2] + t[i + 5] + t[i + 8]) / 3;
        b.key.push(cx + 2.5 * Math.sin(cz * 0.23 + 1.3) + 1.5 * Math.sin(cy * 0.6));
      }
      b.sec.push(o.sec ?? this.sec);
    }
  }
  metal(t, col = STEEL, o = {}) { this.add(t, col, { mat: M.METAL, ...o }); }
  dark(t, col = DARK, o = {}) { this.add(t, col, { mat: M.STRUCT, ...o }); }
  glass(t, col = PITCH, o = {}) { this.add(t, col, { mat: M.GLASS, ...o }); }
  // self-lit opaque surface: colour is HDR, multiplied by the channel level
  em(t, col, ch = CH.STATIC, ph = 0, o = {}) { this.add(t, col, { mat: M.EMIS, ch, ph, ...o }); }
  // burning deck structure (what shows through wounds and cuts)
  decks(t, o = {}) { this.add(t, PITCH, { mat: M.DECKS, ...o }); }

  // additive glow; cols = one colour or one per vertex
  glow(t, cols, ch = CH.STATIC, ph = 0, flick = 0) {
    const b = this.cur, n = t.length / 9, per = Array.isArray(cols[0]);
    for (let f = 0; f < n; f++) {
      const i = f * 9;
      for (let v = 0; v < 3; v++) {
        const c = per ? cols[f * 3 + v] : cols;
        b.gpos.push(t[i + v * 3], t[i + v * 3 + 1], t[i + v * 3 + 2]);
        b.gcol.push(c[0], c[1], c[2]);
        b.gprm.push(ch, Math.round(sat(ph) * 255), Math.round(sat(flick) * 255), 0);
      }
      const cx = (t[i] + t[i + 3] + t[i + 6]) / 3;
      b.gkey.push(cx); b.gsec.push(this.sec);
    }
  }
  // soft frustum of light around the X axis: colour c0 at (x0, r0) → c1 at (x1, r1)
  glowCone(x0, r0, c0, x1, r1, c1, y, z, n, ch, sy = 1, sz = 1, flick = 0.5) {
    const t = [], cols = [], p = (x, r, j) => { const a = (j / n) * TAU; return [x, y + Math.sin(a) * r * sy, z + Math.cos(a) * r * sz]; };
    for (let j = 0; j < n; j++) {
      const a = p(x0, r0, j), b = p(x0, r0, j + 1), c = p(x1, r1, j + 1), d = p(x1, r1, j);
      tri(t, a, b, c); cols.push(c0, c0, c1); tri(t, a, c, d); cols.push(c0, c1, c1);
    }
    this.glow(t, cols, ch, 0, flick);
  }
  // soft star of light readable from every side: centre colour fading to nothing at r
  halo(x, y, z, r, col, ch = CH.NAV, ph = 0) {
    const t = [], cols = [], Z = [0, 0, 0], c = [x, y, z], n = r > 2.5 ? 10 : 4, mid = mul(col, 0.22);
    const fan = (u, v) => {
      const p = (a, k) => [x + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r * k, y + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r * k, z + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r * k];
      for (let j = 0; j < n; j++) {
        const a0 = (j / n) * TAU, a1 = ((j + 1) / n) * TAU;
        if (n === 4) { tri(t, c, p(a0, 1), p(a1, 1)); cols.push(col, Z, Z); continue; }
        // two rings: a hot heart and a long soft skirt
        tri(t, c, p(a0, 0.4), p(a1, 0.4)); cols.push(col, mid, mid);
        tri(t, p(a0, 0.4), p(a0, 1), p(a1, 1)); cols.push(mid, Z, Z);
        tri(t, p(a0, 0.4), p(a1, 1), p(a1, 0.4)); cols.push(mid, Z, mid);
      }
    };
    fan([1, 0, 0], [0, 0, 1]); fan([1, 0, 0], [0, 1, 0]); fan([0, 0, 1], [0, 1, 0]);
    this.glow(t, cols, ch, ph);
  }
  // running light: a lit lens with its halo
  lamp(x, y, z, r, col, ch = CH.NAV, ph = 0) {
    this.em(box(x - r, x + r, y - r, y + r, z - r, z + r, r * 0.4), col, ch, ph);
    this.halo(x, y, z, r * 5.5, mul(col, 0.34), ch, ph);
  }
  // lit strip lying on a deck (thin emissive slab with dark kerbs)
  strip(x0, x1, y, z0, z1, col, ch = CH.ACCENT, ph = 0) {
    this.em(box(x0, x1, y, y + 0.14, z0, z1), col, ch, ph);
  }
  // painted deck marking: a thin slab of colour
  mark(poly, y, col, o = {}) { this.add(prismY(poly, y, y + 0.13), col, o); }

  // big engine bell, exit plane at x opening toward −X
  engine(x, y, z, r, len, o = {}) {
    const n = o.n || this.seg(14), sy = o.sy || 1, sz = o.sz || 1, L = { y, z, sy, sz, phase: TAU / (2 * n) }, g = o.glow ?? 1, E = o.eng || ENG;
    this.metal(lathe([[x + len, r * 0.74], [x + len * 0.62, r * 1.04], [x + len * 0.16, r * 1.05], [x, r * 0.95], [x + len * 0.06, r * 0.84], [x + len * 0.5, r * 0.58]], n, L), o.col || HEAT);
    this.metal(lathe([[x + len * 0.74, r * 1.1], [x + len * 0.6, r * 1.2], [x + len * 0.44, r * 1.2], [x + len * 0.36, r * 1.06]], n, L), GUN);
    const xc = x + len * 0.5;
    // burner face: concentric HDR rings, hot core
    const ringQ = (ra, rb, c) => { const t = []; for (let j = 0; j < n; j++) { const a0 = L.phase + (j / n) * TAU, a1 = L.phase + ((j + 1) / n) * TAU, p = (rr, a) => [xc, y + Math.sin(a) * rr * sy, z + Math.cos(a) * rr * sz]; quad(t, p(ra, a0), p(rb, a0), p(rb, a1), p(ra, a1)); } this.em(t, c, CH.ENGINE); };
    ringQ(0, r * 0.2, mul(E.hot, 0.8 * g)); ringQ(r * 0.2, r * 0.42, mul(E.mid, 0.95 * g)); ringQ(r * 0.42, r * 0.6, mul(E.rim, 1.0 * g));
    // glowing throat wall
    this.em(lathe([[x + len * 0.5, r * 0.58], [x + len * 0.06, r * 0.84]], n, L), mul(E.rim, 0.55 * g), CH.ENGINE);
    if (this.q >= 1 && r > 3) { // flame-holder cross, black against the fire
      for (let j = 0; j < 3; j++) this.dark(move(rotX(box(xc - len * 0.1, xc - len * 0.02, -r * 0.045 * sy, r * 0.045 * sy, -r * 0.6 * sz, r * 0.6 * sz), (j / 3) * Math.PI), 0, y, z), PITCH);
    }
    // petals: armoured flaps round the lip that spread when the engines flare
    const np = o.petals ?? (r > 4 ? 8 : 0);
    for (let j = 0; j < np; j++) {
      const a = (j / np) * TAU, c = Math.cos(a), s = Math.sin(a);
      const t = move(rotX(tbox(x - len * 0.1, x + len * 0.34, [r * 1.0, r * 1.1, -r * 0.2, r * 0.2], [r * 1.16, r * 1.3, -r * 0.3, r * 0.3]), -a), 0, 0, 0);
      for (let i = 0; i < t.length; i += 3) { t[i + 1] = y + t[i + 1] * sy; t[i + 2] = z + t[i + 2] * sz; }
      this.metal(t, GUN, { anim: [-0.3, c * r * 0.16 * sy, s * r * 0.16 * sz, AN.RAM, 0] });
    }
    // short soft plume (the long one is the game's particle exhaust)
    this.glowCone(x + len * 0.3, r * 0.6, mul(E.mid, 0.34 * g), x - r * 1.2, r * 0.78, mul(E.rim, 0.1 * g), y, z, n, CH.ENGINE, sy, sz);
    this.glowCone(x - r * 1.2, r * 0.78, mul(E.rim, 0.1 * g), x - r * 3.4, r * 0.3, [0, 0, 0], y, z, n, CH.ENGINE, sy, sz);
    this.nozzles.push({ x, y, z, r: r * 0.9 * Math.max(sy, sz) });
  }

  // turret mount i: armoured barbette reaching down into the hull, and the stump that burns once the turret is gone
  barbette(i, p, r = 5.6, depth = 7, col = GUN, mat = M.METAL) {
    this.add(latheY([[p[1] + 0.05, r * 0.72], [p[1] + 0.05, r], [p[1] - 1.1, r * 1.14], [p[1] - depth, r * 1.18]], this.seg(12), p[0], p[2]), col, { mat });
    this.decks(latheY([[p[1] - 0.25, 0.001], [p[1] - 0.25, r * 0.74]], this.seg(10), p[0], p[2]));
    this.em(latheY([[p[1] + 0.02, 0.001], [p[1] + 0.02, r * 0.42]], 7, p[0], p[2]), [2.0, 0.5, 0.07], CH.STUMP + i);
    // torn ring-teeth, hidden inside the turret base until it is blown off
    for (let j = 0; j < 7; j++) {
      const a = (j / 7) * TAU + i, rr = r * 0.62, h = 0.5 + ((j * 7 + i * 3) % 5) * 0.22;
      this.metal(rod([p[0] + Math.cos(a) * rr, p[1], p[2] + Math.sin(a) * rr], [p[0] + Math.cos(a + 0.3) * rr * 1.08, p[1] + h, p[2] + Math.sin(a + 0.3) * rr * 1.08], 0.5, 3, 0.05), DARK);
    }
  }

  // antenna forest: whips, yards and a few lamps
  antennas(x, y, z, n, spread, hmax, o = {}) {
    n = this.cnt(n);
    for (let i = 0; i < n; i++) {
      const ax = x + this.rr(-spread, spread), az = z + this.rr(-spread, spread) * (o.sz ?? 1), h = hmax * this.rr(0.35, 1);
      const lean = o.lean ?? 0;
      this.metal(rod([ax, y, az], [ax - lean * h, y + h, az], 0.16, 3, 0.05), GUN, { whole: true });
      if (this.R() < 0.4) this.metal(box(ax - 0.1 - lean * h * 0.7, ax + 0.1 - lean * h * 0.7, y + h * 0.7, y + h * 0.7 + 0.14, az - h * 0.22, az + h * 0.22), GUN);
      if (i === 0 || this.R() < 0.2) this.lamp(ax - lean * h, y + h + 0.2, az, 0.2, LAMP_RED, CH.BEACON, (i % 3) / 3 + 0.01);
    }
  }
  // deck clutter at capital scale: housings, vents, tanks
  greebles(x0, x1, z0, z1, y, n, hmax, cols, o = {}) {
    n = this.cnt(n);
    for (let i = 0; i < n; i++) {
      const l = this.rr(1.2, 4.2) * (o.size ?? 1), w = this.rr(0.9, 3.0) * (o.size ?? 1), h = this.rr(0.4, 1) * hmax;
      const x = this.rr(x0 + l / 2, x1 - l / 2), z = this.rr(z0 + w / 2, z1 - w / 2), c = this.pick(cols);
      const kind = this.R();
      if (kind < 0.62) this.add(box(x - l / 2, x + l / 2, y - 0.2, y + h, z - w / 2, z + w / 2, kind < 0.3 ? Math.min(l, w, h) * 0.18 : 0), c, { win: h > 1.6 ? 150 : 0, mat: this.R() < 0.3 ? M.METAL : M.PAINT });
      else if (kind < 0.82) this.metal(latheY([[y + h, w * 0.3], [y + h * 0.8, w * 0.5], [y - 0.2, w * 0.5]], 6, x, z), c);
      else this.metal(lathe([[x + l / 2, 0.001], [x + l / 2 - 0.3, w * 0.36], [x - l / 2 + 0.3, w * 0.36], [x - l / 2, 0.001]], 6, { y: y + w * 0.3, z }), c);
    }
  }
  // row of casemate guns along a flank at z (barrels point outboard and forward); muzzles light in sequence on 'volley'
  gallery(x0, x1, y, z, n, s, col) {
    n = this.cnt(n);
    for (let i = 0; i < n; i++) {
      const x = lerp(x0, x1, n > 1 ? i / (n - 1) : 0.5);
      this.add(tbox(x - 1.5, x + 1.5, [y - 0.9, y + 0.9, z - 0.2 * s, z + 1.3 * s], [y - 0.6, y + 0.6, z - 0.2 * s, z + 1.0 * s]), col);
      const a = [x + 0.2, y, z + 1.0 * s], b = [x + 2.6, y, z + 3.4 * s];
      this.metal(rod(a, b, 0.3, 4), GUN, { whole: true });
      this.em(rod([b[0] - 0.05, b[1], b[2] - 0.05 * s], [b[0] + 0.12, b[1], b[2] + 0.12 * s], 0.34, 4), [4, 1.6, 0.3], CH.VOLLEY, 0.1 + 0.8 * (i / Math.max(1, n - 1)));
    }
  }
  // recessed, lit trench along x on a deck
  trench(x0, x1, y, z, w, col, ch = CH.ACCENT, ph = 0) {
    this.dark(box(x0 - 0.4, x1 + 0.4, y - 0.05, y + 0.3, z - w / 2 - 0.5, z - w / 2), PITCH);
    this.dark(box(x0 - 0.4, x1 + 0.4, y - 0.05, y + 0.3, z + w / 2, z + w / 2 + 0.5), PITCH);
    this.em(box(x0, x1, y, y + 0.1, z - w / 2, z + w / 2), col, ch, ph);
  }
  // sensor tower: stacked tiers with window bands, a glazed bridge, mast and yards. Returns the top y.
  tower(x, y, z, o = {}) {
    const l = o.l ?? 12, w = o.w ?? 7, h = o.h ?? 12, tiers = o.tiers ?? 3, C = o.col, C2 = o.col2 || DARK;
    let y0 = y, cl = l, cw = w, cx = x;
    for (let i = 0; i < tiers; i++) {
      const th = (h / tiers) * (i === 0 ? 1.25 : i === tiers - 1 ? 0.75 : 1), nl = cl * 0.86, nw = cw * 0.88, rake = (o.rake ?? 0.7) * (i + 1) * 0.4;
      this.add(tbox(cx - cl / 2, cx + cl / 2, [y0, y0 + th, z - cw / 2, z + cw / 2], [y0, y0 + th * (i === tiers - 1 ? 0.7 : 0.9), z - cw * 0.42, z + cw * 0.42], 0.25), i % 2 ? C2 : C, { win: 210, whole: true });
      // gallery ledge
      this.metal(box(cx - cl / 2 - 0.4, cx + cl / 2 + 0.3, y0 + th - 0.25, y0 + th, z - cw / 2 - 0.4, z + cw / 2 + 0.4), GUN, { whole: true });
      y0 += th; cx -= rake * 0.5; cl = nl * 0.82; cw = nw * 0.86;
    }
    // bridge: wrap-around glazing looking forward
    const bl = cl * 1.1, bw = cw * 1.25, bh = h * 0.16;
    this.add(tbox(cx - bl / 2, cx + bl / 2, [y0, y0 + bh, z - bw / 2, z + bw / 2], [y0, y0 + bh * 0.7, z - bw * 0.36, z + bw * 0.36], 0.2), C, { whole: true });
    this.em(tbox(cx + bl * 0.1, cx + bl / 2 + 0.08, [y0 + bh * 0.3, y0 + bh * 0.7, z - bw / 2 - 0.06, z + bw / 2 + 0.06], [y0 + bh * 0.32, y0 + bh * 0.56, z - bw * 0.37, z + bw * 0.37]), mul(WINDOW_GLASS, o.glass ?? 1), CH.NAV);
    y0 += bh;
    // mast
    const mh = o.mast ?? h * 0.55;
    this.metal(rod([cx - bl * 0.2, y0, z], [cx - bl * 0.3, y0 + mh, z], 0.34, 4, 0.12), GUN, { whole: true });
    this.metal(box(cx - bl * 0.3 - 0.14, cx - bl * 0.3 + 0.14, y0 + mh * 0.55, y0 + mh * 0.55 + 0.2, z - bw * 0.7, z + bw * 0.7), GUN);
    this.metal(box(cx - bl * 0.3 - 0.14, cx - bl * 0.3 + 0.14, y0 + mh * 0.8, y0 + mh * 0.8 + 0.16, z - bw * 0.4, z + bw * 0.4), GUN);
    this.lamp(cx - bl * 0.3, y0 + mh + 0.3, z, 0.26, LAMP_RED, CH.BEACON, 0.01);
    for (const s of [1, -1]) this.lamp(cx - bl * 0.3, y0 + mh * 0.55 + 0.3, z + s * bw * 0.7, 0.18, s > 0 ? [0.5, 4, 0.9] : LAMP_RED, CH.NAV);
    return { top: y0, x: cx, mast: y0 + mh };
  }
  // rotating search radar; lives in its own buffer and turns about the vertical through (x, z)
  radar(x, y, z, r, speed = 0.0012) {
    const name = 'rot' + this.rot.length, prev = this.cur;
    this.use(name);
    this.metal(latheY([[1.4, 0.3], [0, 0.45]], 5), GUN);
    this.metal(tbox(-0.25, 0.25, [1.2, 1.2 + r * 0.62, -r, r], [1.35, 1.2 + r * 0.5, -r * 0.92, r * 0.92]), STEEL);
    this.dark(box(0.25, 0.4, 1.3, 1.2 + r * 0.55, -r * 0.9, r * 0.9), DARK);
    this.metal(box(-0.9, -0.25, 1.5, 1.75, -0.2, 0.2), GUN);
    this.rot.push({ name, pivot: [x, y, z], axis: 'y', speed });
    this.cur = prev;
  }
  // main-battery emitter on the bow facing +X: iris of prongs round a lens that spools up on 'laser'
  lens(x, y, z, r, col, o = {}) {
    const n = o.n ?? 6, ch = o.ch ?? CH.LASER;
    this.metal(lathe([[x + 0.6, r * 1.1], [x, r * 1.35], [x - r * 1.2, r * 1.25], [x - r * 1.6, r * 0.9]], this.seg(12), { y, z }), GUN);
    this.dark(lathe([[x + 0.6, r * 1.1], [x - 0.4, r * 0.9], [x - 0.4, 0.001]], this.seg(12), { y, z, flip: true }), PITCH);
    this.em(lathe([[x - 0.3, r * 0.86], [x + 0.3, r * 0.5], [x + 0.5, 0.001]], this.seg(10), { y, z }), mul(col, 0.16), CH.STATIC);
    this.em(lathe([[x - 0.25, r * 0.88], [x + 0.36, r * 0.52], [x + 0.56, 0.001]], this.seg(10), { y, z }), mul(col, 1.5), ch, 0.6);
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + TAU / (2 * n), c = Math.cos(a), s = Math.sin(a);
      const t = move(rotX(tbox(x - r * 0.9, x + r * 1.3, [r * 1.05, r * 1.5, -r * 0.2, r * 0.2], [r * 0.95, r * 1.12, -r * 0.1, r * 0.1]), -a), 0, y, z);
      this.metal(t, STEEL, { anim: [r * 0.5, c * r * 0.34, s * r * 0.34, AN.LASER, 0], whole: true });
      const e = move(rotX(box(x - r * 0.6, x + r * 1.1, r * 1.0, r * 1.06, -r * 0.07, r * 0.07), -a), 0, y, z);
      this.em(e, mul(col, 1.2), ch, 0.15 + 0.5 * (j / n), { anim: [r * 0.5, c * r * 0.34, s * r * 0.34, AN.LASER, 0] });
    }
    this.halo(x + r, y, z, r * 3.4, mul(col, 0.34), ch, 0.5);
    this.glowCone(x + 0.4, r * 0.8, mul(col, 0.22), x + r * 3.0, r * 0.1, [0, 0, 0], y, z, 10, ch, 1, 1, 1);
  }
  // record a place where battle damage opens (first listed opens first)
  wound(x, y, z, r) { this.wounds.push([x, y, z, r]); }
}

/* ========================================================================== */
/*  Shaders                                                                   */
/* ========================================================================== */

const HULL_VERT_HEAD = /* glsl */`
attribute vec4 aPrm; attribute vec4 aAnm;
uniform float uBAn[${AN.N}]; uniform vec3 uBArr;
varying vec3 vBP; varying vec3 vBN; varying vec4 vBPrm;
`;
const HULL_VERT_BEGIN = /* glsl */`
#include <begin_vertex>
{
  float bc = floor(aAnm.w / 16.0), bd = (aAnm.w - bc * 16.0) / 16.0;
  float bk = bc > 0.5 ? max(0.0, uBAn[int(bc)] - bd) / (1.0 - bd) : 0.0;
  transformed += aAnm.xyz * (bk / 64.0);
  transformed.x -= uBArr.x * max(0.0, uBArr.z - transformed.x);   // hyperspace stretch, anchored at the nose
}
vBP = position; vBN = normal; vBPrm = aPrm;
`;
const HULL_FRAG_HEAD = /* glsl */`
uniform float uBT; uniform vec4 uBS; uniform vec4 uBK;
uniform vec4 uBWound[8]; uniform float uBTear[8]; uniform float uBLv[${CH.N}]; uniform vec3 uBAcc;
varying vec3 vBP; varying vec3 vBN; varying vec4 vBPrm;
vec3 bEmis; float bRough; float bMetal;
float bh21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float bh31(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float bvn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bh31(i), bh31(i + vec3(1, 0, 0)), f.x), mix(bh31(i + vec3(0, 1, 0)), bh31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(bh31(i + vec3(0, 0, 1)), bh31(i + vec3(1, 0, 1)), f.x), mix(bh31(i + vec3(0, 1, 1)), bh31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// brick-laid plating with random splits: x = seam mask, y = plate id hash, z = distance to the seam
vec3 bPanel(vec2 uv, vec2 size, float seed, float aa) {
  vec2 g = uv / size; float row = floor(g.y);
  g.x += bh21(vec2(row, seed));
  vec2 id = floor(g), f = fract(g), sz = size;
  if (bh21(id + seed) > 0.5) {
    float sx = 0.3 + 0.4 * bh21(id + seed + 7.0);
    if (f.x > sx) { id += 0.37; f.x = (f.x - sx) / (1.0 - sx); sz.x *= 1.0 - sx; } else { f.x /= sx; sz.x *= sx; }
  }
  vec2 d = min(f, 1.0 - f) * sz;
  float e = min(d.x, d.y), lw = max(0.07, aa * 0.55);
  float line = (1.0 - smoothstep(lw, lw + aa + 0.01, e)) * clamp(0.11 / lw, 0.34, 1.0);
  return vec3(line, bh21(id * 1.3 + seed + 2.0), e);
}
`;
const HULL_FRAG_COLOR = /* glsl */`
#include <color_fragment>
{
  float bMat = floor(vBPrm.x + 0.5);
  bool bIn = (!gl_FrontFacing) || bMat == 3.0;
  bool bLit = bMat == 4.0 || bMat == 6.0;
  vec3 bAN = abs(vBN);
  vec2 bUV; float bSide;
  if (bAN.y > 0.62) { bUV = vBP.xz; bSide = 0.0; } else if (bAN.z >= bAN.x) { bUV = vBP.xy; bSide = 1.0; } else { bUV = vBP.zy; bSide = 2.0; }
  float bAA = max(fwidth(bUV.x), fwidth(bUV.y)) + 1e-4;
  bRough = 0.5; bMetal = 0.4; bEmis = vec3(0.0);
  float bLvl = uBLv[int(vBPrm.z + 0.5)];
  float bPh = vBPrm.w / 255.0;
  if (bPh > 0.0) bLvl *= smoothstep(bPh * 0.8, bPh * 0.8 + 0.2, bLvl);
  vec3 bCol = diffuseColor.rgb;
  float bFlick = 0.72 + 0.28 * sin(uBT * 23.0 + vBP.x * 2.1 + vBP.z * 3.3);

  // --- wounds: scorch, then torn plating with a white-hot rim ---
  float bBurn = 0.0, bRim = 0.0, bGap = 9.0;
  float bHurt = max(uBS.x, uBS.y);
  if (!bIn && bHurt > 0.0) {
    float nz = bvn(vBP * 0.45 + uBK.z) * 0.7 + bvn(vBP * 1.5) * 0.3 - 0.5;
    for (int i = 0; i < 8; i++) {
      vec4 w = uBWound[i];
      if (w.w <= 0.0) continue;
      float d = length((vBP - w.xyz) * vec3(1.0, 1.3, 1.0)) / w.w + nz * 0.7;
      bBurn = max(bBurn, 1.0 - smoothstep(0.5, 1.7, d));
      float cut = 0.62 * uBTear[i];
      if (cut > 0.02) {
        if (d < cut) discard;
        bRim = max(bRim, (1.0 - smoothstep(0.0, 0.09, d - cut)) * uBTear[i]);
        bGap = min(bGap, d - cut);
      }
    }
    bBurn = max(bBurn, smoothstep(1.0 - 0.42 * bHurt, 1.0 - 0.42 * bHurt + 0.2, bvn(vBP * 0.23 + 9.0 + uBK.z)) * 0.75);
  }

  if (bIn) {
    // burning deck structure behind the plating
    float fl = bvn(vec3(vBP.xz * 0.35, uBT * 1.3)), fl2 = bvn(vBP * 1.2 + vec3(0.0, -uBT * 2.0, 0.0));
    float slab = smoothstep(0.28, 0.46, abs(fract(vBP.y / 2.6) - 0.5));
    float bulk = smoothstep(0.38, 0.5, abs(fract((vBP.x + vBP.z * 0.3) / 5.0) - 0.5));
    vec3 fire = mix(vec3(0.9, 0.11, 0.012), vec3(2.6, 0.95, 0.2), smoothstep(0.25, 0.8, fl2 * fl * 2.0));
    bEmis = fire * (0.08 + 0.92 * uBK.w) * (1.0 - 0.94 * slab) * (1.0 - 0.8 * bulk) * (0.12 + 0.88 * smoothstep(0.3, 0.75, fl));
    bCol = vec3(0.012); bRough = 0.9; bMetal = 0.0;
  } else if (bMat == 4.0) {
    bEmis = bCol * bLvl; bCol = vec3(0.0); bRough = 0.6; bMetal = 0.0;
  } else if (bMat == 6.0) {
    float n1 = bvn(vBP * 0.2 + vec3(0.0, uBT * 0.7, uBT * 0.3)), n2 = bvn(vBP * 0.55 - uBT * 0.9);
    bEmis = bCol * (0.35 + 1.5 * n1 * n2 + 0.7 * n1 * n1 * n1) * bLvl; bCol = vec3(0.0); bRough = 0.6; bMetal = 0.0;
  } else if (bMat == 5.0) {
    // living hull: chitin scales with dark grooves; here and there a scale glows from beneath
    vec2 q = bUV / vec2(3.1, 2.0); vec2 ip = floor(q), fp = fract(q); float d1 = 8.0, d2 = 8.0; vec2 cid = vec2(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + vec2(bh21(ip + o + uBK.z), bh21(ip + o + uBK.z + 17.0)) - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; cid = ip + o; } else if (d < d2) d2 = d;
    }
    float edge = sqrt(d2) - sqrt(d1);
    float groove = (1.0 - smoothstep(0.02, 0.1 + bAA * 0.4, edge)) * clamp(0.5 / bAA, 0.25, 1.0);
    float wn = bvn(vBP * 0.5 + uBK.z), ch = bh21(cid + 4.7);
    float dark = 1.0 - smoothstep(0.03, 0.07, dot(bCol, vec3(0.33)));   // bone and horn do not glow
    bCol *= (0.7 + 0.5 * smoothstep(0.0, 0.5, edge)) * (0.75 + 0.5 * wn) * (0.8 + 0.4 * ch);
    bCol = mix(bCol, bCol * 0.3, groove);
    float pulse = 0.5 + 0.5 * sin(uBT * 2.2 - length(vBP.xz) * 0.16 + ch * 6.0);
    // bioluminescent pores: a soft dot in the middle of one scale in eight
    float lit = step(0.9, ch) * dark * (1.0 - smoothstep(0.004, 0.035 + bAA * 0.1, d1)) * clamp(0.9 / bAA, 0.4, 1.0);
    bEmis += uBAcc * lit * (0.25 + 0.75 * pulse) * 0.6 * uBLv[18];
    bRough = 0.26 + 0.3 * edge; bMetal = 0.55;
  } else {
    float wn = bvn(vBP * 0.6 + uBK.z);
    if (bMat == 2.0) { bRough = 0.1; bMetal = 0.9; }
    else {
      vec2 ps = bSide < 0.5 ? vec2(6.2, 4.2) : vec2(5.2, 2.6);
      vec3 pn = bPanel(bUV, ps, uBK.z, bAA);
      vec3 pn2 = bPanel(bUV + 3.7, ps * 0.34, uBK.z + 5.0, bAA);
      float seam = max(pn.x, pn2.x * 0.5 * clamp(0.45 / bAA, 0.0, 1.0));
      float tone = 1.0 + (pn.y - 0.5) * 0.34 + (pn2.y - 0.5) * 0.14 * clamp(0.6 / bAA, 0.0, 1.0);
      float streak = bvn(vec3(vBP.x * 0.12, vBP.y * 1.6, vBP.z * 1.6) + uBK.z);
      bCol *= tone * (0.8 + 0.34 * wn) * (0.86 + 0.2 * streak);
      bCol *= 1.0 - 0.6 * seam;
      if (bMat == 1.0) { bRough = 0.3 + 0.16 * pn.y; bMetal = 0.92; }
      else if (bMat == 7.0) { bRough = 0.7; bMetal = 0.5; }
      else { bRough = 0.44 + 0.2 * pn.y + 0.1 * wn; bMetal = 0.42; }
      // fire in the seams as the hull fails
      // plating stripped back from an open wound, plate by plate, down to the frames
      float strip = step(bGap, 0.62 * pn.y) * step(0.25, pn.y);
      if (strip > 0.5) {
        float fr = step(0.78, fract(bUV.x * 0.9)) + step(0.86, fract(bUV.y * 0.7));
        bCol = vec3(0.016, 0.015, 0.014) * (0.5 + 1.6 * min(fr, 1.0)); bRough = 0.85; bMetal = 0.5;
        bEmis += vec3(1.5, 0.3, 0.03) * (1.0 - min(fr, 1.0)) * smoothstep(0.45, 0.8, bvn(vBP * 0.9 + vec3(0.0, uBT * 0.8, 0.0))) * 0.5;
      }
      float th = 1.02 - max(0.34 * uBS.y, uBS.x * 0.26);
      float crack = (1.0 - smoothstep(0.0, 0.26 + bAA, pn.z)) * smoothstep(th, th + 0.12, bvn(vBP * 0.17 + 4.0 + uBK.z));
      bEmis += vec3(2.4, 0.55, 0.07) * crack * bFlick;
    }
    // lit window rows on walls: small panes in decks, whole decks dark, blocks of cabins lit together
    if (vBPrm.y > 0.5 && bSide > 0.5) {
      float dens = vBPrm.y / 255.0;
      vec2 cs = vec2(0.62, 0.86); vec2 g = bUV / cs; vec2 id = floor(g), f = fract(g);
      vec2 fa = fwidth(bUV) / cs;
      float deckOn = step(0.42, bh21(vec2(id.y, 7.3 + uBK.z)));
      float blk = bh21(floor(id / vec2(9.0, 1.0)) + uBK.z);
      float occ = dens * deckOn * smoothstep(0.25, 0.6, blk);
      float on = step(bh21(id + 3.1 + uBK.z), occ);
      float mx = smoothstep(0.22 - fa.x, 0.22 + fa.x, f.x) * (1.0 - smoothstep(0.78 - fa.x, 0.78 + fa.x, f.x));
      float my = smoothstep(0.36 - fa.y, 0.36 + fa.y, f.y) * (1.0 - smoothstep(0.66 - fa.y, 0.66 + fa.y, f.y));
      float farx = clamp(fa.x * 2.0 - 0.5, 0.0, 1.0), fary = clamp(fa.y * 2.0 - 0.5, 0.0, 1.0);
      float wv = mix(on * mx, occ * 0.56, farx) * mix(my, 0.3 * mix(1.0, 0.6 / max(deckOn, 0.6), fary), fary);
      vec3 wc = mix(vec3(1.0, 0.7, 0.34), vec3(0.55, 0.8, 1.0), step(0.8, bh21(floor(id / vec2(23.0, 3.0)) + 1.7)));
      bCol *= 1.0 - 0.6 * wv;
      bEmis += wc * wv * 2.8 * uBK.x * (1.0 - bBurn) * step(0.3, bGap);
    }
  }
  if (!bIn && !bLit) {
    bCol = mix(bCol, vec3(0.008, 0.0075, 0.007), min(1.0, bBurn * 1.15)); bRough = mix(bRough, 0.95, bBurn); bMetal *= 1.0 - 0.7 * bBurn;
    bEmis += (bCol * 1.2 + vec3(0.09, 0.075, 0.06)) * uBS.z;      // hit flash: the hull's own colour lifted, never white
  }
  bEmis += vec3(3.0, 0.85, 0.11) * bRim * bFlick;
  float bFr = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 2.5);
  bEmis += vec3(0.16, 0.62, 1.3) * bFr * uBS.w * 0.45;             // shield sheen
  bEmis += vec3(0.22, 0.5, 1.2) * uBK.y * (0.4 + 0.6 * bFr);     // hyperspace glow
  diffuseColor.rgb = bCol;
}
`;

const GLOW_VERT = /* glsl */`
attribute vec3 aCol; attribute vec4 aPrm;
uniform float uBLv[${CH.N}]; uniform vec3 uBArr; uniform float uBT;
varying vec3 vC;
void main() {
  vec3 p = position;
  p.x -= uBArr.x * max(0.0, uBArr.z - p.x);
  float l = uBLv[int(aPrm.x + 0.5)], ph = aPrm.y / 255.0;
  if (ph > 0.0) l *= smoothstep(ph * 0.8, ph * 0.8 + 0.2, l);
  l *= 1.0 + aPrm.z / 255.0 * 0.3 * sin(uBT * 31.0 + p.x * 0.7 + p.z * 1.3);
  vC = aCol * l;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const GLOW_FRAG = /* glsl */`
varying vec3 vC;
void main() { gl_FragColor = vec4(vC, 1.0); }`;

/* ========================================================================== */
/*  Shared assemblies                                                         */
/* ========================================================================== */

// per-level colours: the hue walks 63° a level exactly like bossgen, each class wears it its own way
function palette(level, cls, R) {
  const hue = (348 + (level - 1) * 63) % 360, accH = (hue + 30 + R() * 40) % 360;
  const P = {
    hue,
    hull: hsl(hue, 0.1, 0.31), hull2: hsl(hue, 0.14, 0.19), deck: hsl(hue, 0.08, 0.1),
    paint: hsl(hue, 0.7, 0.33), pale: hsl((hue + 180) % 360, 0.08, 0.6), gold: lin(0xa07c34),
    glow: mul(hsl(accH, 1, 0.56), 3.0), beam: [1.6, 0.32, 0.06], lens: [4.6, 0.95, 0.16],
  };
  if (cls === 'carrier') { P.hull = hsl(hue, 0.08, 0.37); P.hull2 = hsl(hue, 0.1, 0.24); }
  if (cls === 'ram') { P.hull = hsl(hue, 0.12, 0.23); P.hull2 = hsl(hue, 0.16, 0.14); P.paint = hsl(hue, 0.76, 0.35); P.pale = lin(0xb8931f); }
  if (cls === 'lance') { P.hull = hsl(hue, 0.07, 0.42); P.hull2 = hsl(hue, 0.12, 0.22); }
  if (cls === 'leviathan') {
    P.hull = hsl(hue, 0.4, 0.12); P.hull2 = hsl((hue + 24) % 360, 0.45, 0.07); P.paint = hsl((hue + 330) % 360, 0.55, 0.15); P.pale = hsl(36, 0.22, 0.36);
    P.glow = mul(hsl(accH, 1, 0.55), 3.2);
  }
  if (cls === 'citadel') { P.hull = hsl(hue, 0.12, 0.27); P.hull2 = hsl(hue, 0.18, 0.16); P.paint = hsl(hue, 0.7, 0.28); }
  return P;
}

const fanX = (ring) => { const c = centroid(ring), t = []; for (let j = 0; j < ring.length; j++) tri(t, c, ring[j], ring[(j + 1) % ring.length]); return t; };
// glowing bulkheads behind every cut of the main hull
function bulkheads(k, F) {
  k.cuts.forEach((x, i) => {
    k.decks(fanX(F.ring(x - 0.7, 0.95)), { sec: i, whole: true });
    k.decks(fanX(F.ring(x + 0.7, 0.95)), { sec: i + 1, whole: true });
  });
}
// armour belt slabs standing proud of the hull's waist between x0 and x1 (both sides); they peel off as the ship dies
function belt(k, F, x0, x1, y0, y1, th, col, o = {}) {
  const n = Math.max(1, Math.round(Math.abs(x0 - x1) / 9));
  for (const s of [1, -1]) for (let i = 0; i < n; i++) {
    const xa = lerp(x0, x1, i / n) - 0.25, xb = lerp(x0, x1, (i + 1) / n) + 0.25;
    const ring = (x) => { const w = F.hw(x); return [[x, y0, s * w * 0.9], [x, y1, s * w * 0.9], [x, y1 - 0.5, s * (w + th)], [x, y0 + 0.5, s * (w + th)]]; };
    k.add(loft([ring(xa), ring(xb)]), Array.isArray(col[0]) ? col[i % col.length] : col, { whole: true, anim: [(k.R() - 0.5) * 8, 3 + k.R() * 5, s * (9 + k.R() * 9), AN.PEEL, k.R() * 0.6], mat: o.mat ?? M.PAINT, win: o.win ?? 0 });
  }
}
// Capital-scale dressing for a lofted hull between x0 and x1: frames up the flanks, a kerb pipe along the deck edge,
// hatch rows, flak mounts, and strips of machinery ("city") let into the deck.
function dressHull(k, F, x0, x1, P, o = {}) {
  const ribs = o.ribs ?? 3.8, s0 = o.sides || [1, -1];
  for (const s of s0) {
    for (let x = x0 - 1; x > x1; x -= ribs) {
      const r = F.ring(x), a = r[s > 0 ? 2 : 10], b = r[s > 0 ? 3 : 9], c = r[s > 0 ? 4 : 8];
      k.metal(tube([[x, a[1], a[2] * 1.005, 0.3], [x, b[1], b[2] + s * 0.25, 0.42], [x, c[1], c[2] * 1.005, 0.3]], 4), GUN, { whole: true });
    }
    let prev = null;
    for (let x = x0; x >= x1 - 0.01; x -= 4) {
      const d = F.ring(x)[s > 0 ? 1 : 11], p = [x, d[1] + 0.2, d[2] * 0.985];
      if (prev) k.metal(rod(prev, p, 0.24, 4), GUN, { whole: true });
      prev = p;
    }
    if (o.hatches !== false) for (let x = x0 - 2, i = 0; x > x1 + 2; x -= 2.4, i++) {
      const z = s * F.deck(x) * (i % 2 ? 0.84 : 0.66), y = F.top(x);
      if (o.keep && o.keep(x, z)) continue;
      k.dark(box(x - 0.8, x + 0.8, y - 0.1, y + 0.12, z - 0.5, z + 0.5), i % 3 ? PITCH : P.hull2);
      if (i % 4 === 1) k.em(box(x - 0.2, x + 0.2, y + 0.12, y + 0.2, z - 0.16, z + 0.16), [1.6, 1.5, 1.2], CH.STATIC);
    }
    if (o.flak !== false) for (let x = x0 - 6; x > x1 + 4; x -= o.flakStep ?? 7) {
      const z = s * (F.hw(x) * 0.9 + 0.2), y = F.top(x) * 0.55 + 0.5;
      flak(k, x, y, z, s);
    }
  }
}
// light anti-fighter mount: a dome and a pair of barrels
function flak(k, x, y, z, s = 1) {
  k.metal(latheY([[y + 0.9, 0.3], [y + 0.6, 0.72], [y - 0.4, 0.8]], 6, x, z), GUN, { whole: true });
  for (const d of [0.22, -0.22]) k.metal(rod([x + 0.2, y + 0.5, z + d], [x + 2.0, y + 1.3, z + d + s * 0.5], 0.09, 3), DARK, { whole: true });
}
// a strip of small machinery let into a deck: many tiny blocks over a dark bed
function city(k, x0, x1, z0, z1, y, P, dens = 1) {
  k.dark(box(x0, x1, y - 0.1, y + 0.08, z0, z1), PITCH);
  const n = k.cnt(Math.round(Math.abs((x1 - x0) * (z1 - z0)) * 0.9 * dens));
  for (let i = 0; i < n; i++) {
    const l = k.rr(0.3, 1.5), w = k.rr(0.3, 1.0), h = k.rr(0.15, 0.9), x = k.rr(x0 + l / 2, x1 - l / 2), z = k.rr(Math.min(z0, z1) + w / 2, Math.max(z0, z1) - w / 2), c = k.R();
    if (c < 0.07) k.em(box(x - 0.12, x + 0.12, y + 0.08, y + 0.2, z - 0.12, z + 0.12), c < 0.035 ? [1.8, 1.6, 1.2] : mul(P.glow, 0.5), CH.STATIC);
    else k.add(box(x - l / 2, x + l / 2, y, y + h, z - w / 2, z + w / 2), c < 0.4 ? DARK : c < 0.7 ? P.hull2 : c < 0.9 ? GUN : P.hull, { mat: c > 0.55 ? M.METAL : M.STRUCT, whole: true });
  }
}
// tube swept along a path of [x, y, z, r] points (horns, tentacles, booms)
function tube(pts, n = 6, o = {}) {
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    const up = Math.abs(dy) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    let ux = dy * up[2] - dz * up[1], uy = dz * up[0] - dx * up[2], uz = dx * up[1] - dy * up[0]; const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux, r = pts[i][3], p = pts[i], ring = [];
    for (let j = 0; j < n; j++) { const an = (j / n) * TAU + (o.phase || 0), c = Math.cos(an) * r * (o.sx ?? 1), s = Math.sin(an) * r * (o.sy ?? 1); ring.push([p[0] + ux * c + vx * s, p[1] + uy * c + vy * s, p[2] + uz * c + vz * s]); }
    rings.push(ring);
  }
  return loft(rings, o);
}
// faceted pod: pointed at x0 (front), blunt at x1; z is its centreline
function pod(x0, x1, y0, y1, z, hw, c = 1.2) {
  return loft([
    ringRect(x0, lerp(y0, y1, 0.3), lerp(y0, y1, 0.78), z - hw * 0.3, z + hw * 0.3, c * 0.3), ringRect(x0 - 5, y0, y1, z - hw, z + hw, c),
    ringRect(x1 + 6, y0, y1, z - hw, z + hw, c), ringRect(x1, y0 + 1, y1 - 1, z - hw * 0.82, z + hw * 0.82, c * 0.8),
  ]);
}
// swept plate fin lying in the XZ plane (poly [[x,z]…]), bottom at y
const fin = (poly, y, th) => prismY(poly, y, y + th, 0.94, poly[0][0], poly[0][1]);
// wall facing +X between x-d and x, pierced by hangar mouths [{y0,y1,z0,z1}] (sorted by z)
function hangarWall(k, x, d, y0, y1, z0, z1, mouths, col, o = {}) {
  let z = z0;
  for (const m of mouths) {
    if (m.z0 > z) k.add(box(x - d, x, y0, y1, z, m.z0, 0), col, { whole: true });
    k.add(box(x - d, x, m.y1, y1, m.z0, m.z1), col, { whole: true });
    k.add(box(x - d, x, y0, m.y0, m.z0, m.z1), col, { whole: true });
    z = m.z1;
  }
  if (z < z1) k.add(box(x - d, x, y0, y1, z, z1), col, { whole: true });
  mouths.forEach((m, i) => {
    const gl = o.glow || [2.0, 1.25, 0.5], zm = (m.z0 + m.z1) / 2, hw = (m.z1 - m.z0) / 2, ph = mouths.length > 1 ? 0.5 * Math.abs(i - (mouths.length - 1) / 2) / mouths.length : 0;
    const xb = x - d + 0.05;
    k.dark(box(xb - 0.3, xb, m.y0, m.y1, m.z0, m.z1), PITCH, { whole: true });
    // lit throat: dim always, bright when the bay is working; a deck strip and guide lights
    k.em(box(xb, xb + 0.04, lerp(m.y0, m.y1, 0.34), lerp(m.y0, m.y1, 0.9), m.z0 + 0.3, m.z1 - 0.3), mul(gl, 0.3), CH.STATIC);
    k.em(box(xb + 0.04, xb + 0.08, lerp(m.y0, m.y1, 0.34), lerp(m.y0, m.y1, 0.9), m.z0 + 0.3, m.z1 - 0.3), mul(gl, 1.4), CH.BAY, ph);
    k.em(box(xb, x - 0.2, m.y0, m.y0 + 0.08, zm - 0.25, zm + 0.25), mul(gl, 1.5), CH.STATIC);
    for (const s of [1, -1]) k.em(box(xb, x - 0.2, m.y0, m.y0 + 0.08, zm + s * hw * 0.8 - 0.1, zm + s * hw * 0.8 + 0.1), [0.5, 1.6, 2.6], CH.STROBE);
    // parked craft silhouettes against the light
    if (hw > 3) for (const s of [1, -1]) k.dark(box(xb + 0.1, xb + 1.6, m.y0 + 0.1, lerp(m.y0, m.y1, 0.45), zm + s * hw * 0.42 - hw * 0.2, zm + s * hw * 0.42 + hw * 0.2, 0.2), PITCH);
    // door leaves
    for (const s of [1, -1]) {
      const an = [-(d + 1.2), 0, s * hw * 0.35, AN.BAY, ph];
      k.metal(box(x - 0.5, x - 0.2, m.y0, m.y1, s > 0 ? zm + 0.05 : m.z0, s > 0 ? m.z1 : zm - 0.05), GUN, { anim: an, whole: true });
      k.em(box(x - 0.2, x - 0.14, lerp(m.y0, m.y1, 0.42), lerp(m.y0, m.y1, 0.58), s > 0 ? zm + 0.3 : m.z0 + 0.3, s > 0 ? m.z1 - 0.3 : zm - 0.3), [3.2, 1.2, 0.2], CH.STROBE, 0, { anim: an });
    }
    k.halo(x + 1, (m.y0 + m.y1) / 2, zm, hw * 1.5, mul(gl, 0.2), CH.BAY, ph);
    k.bays.push([x, (m.y0 + m.y1) / 2, zm]);
  });
}
// chevrons painted on a deck, pointing +X
function chevrons(k, x, z, y, w, n, gap, col) {
  for (let i = 0; i < n; i++) {
    const xx = x - i * gap, t = gap * 0.45;
    for (const s of [1, -1]) k.mark([[xx, z], [xx - w * 0.7, z + s * w], [xx - w * 0.7 - t, z + s * w], [xx - t, z]], y, col);
  }
}

/* -------------------------------- turrets -------------------------------- */
// Local space: pivot at the origin on the mount plane, barrels along +X.
function turret(k, G, i) {
  const P = G.pal, s = i < 2 ? 1 : 0.88, cls = G.cls;
  if (cls === 'leviathan') return bioTurret(k, G, i, s);
  const hw = 4.3 * s, hh = 4.5 * s;
  k.metal(latheY([[1.3 * s, 4.5 * s], [0.9 * s, 5.1 * s], [-0.3, 5.1 * s]], k.seg(12)), GUN);
  // armoured house with a sloped glacis
  k.add(loft([
    ringRect(-5.6 * s, 1.2 * s, hh * 0.8, -hw * 0.78, hw * 0.78, 0.5 * s), ringRect(-1.2 * s, 1.2 * s, hh, -hw, hw, 0.8 * s),
    ringRect(3.4 * s, 1.2 * s, hh * 0.9, -hw * 0.94, hw * 0.94, 0.8 * s), ringRect(6.3 * s, 1.4 * s, hh * 0.5, -hw * 0.72, hw * 0.72, 0.45 * s),
  ]), cls === 'ram' ? P.paint : P.hull2, { whole: true });
  k.add(box(-4.4 * s, -1.6 * s, hh * 0.86, hh + 0.3 * s, -hw * 0.42, hw * 0.42, 0.15), cls === 'ram' ? P.hull2 : P.paint);
  k.metal(box(0.2 * s, 2.4 * s, hh * 0.9, hh + 0.5 * s, -0.9 * s, 0.9 * s, 0.2), GUN);
  k.metal(box(4.2 * s, 6.8 * s, 1.5 * s, 3.7 * s, -hw * 0.8, hw * 0.8, 0.4 * s), GUN);
  const nb = cls === 'lance' ? 1 : cls === 'ram' || cls === 'carrier' ? 2 : i < 2 ? 3 : 2;
  const br = (cls === 'ram' ? 1.0 : cls === 'lance' ? 1.15 : 0.72) * s, L = (cls === 'lance' ? 21 : cls === 'ram' ? 15 : 17.5) * s;
  for (let b = 0; b < nb; b++) {
    const z = (b - (nb - 1) / 2) * (cls === 'ram' ? 3.6 : 2.6) * s, y = 2.6 * s;
    k.metal(lathe([[L, br * 0.6], [L, br * 1.4], [L - 1.7 * s, br * 1.4], [L - 1.9 * s, br], [8 * s, br], [7.6 * s, br * 1.5], [5 * s, br * 1.6], [4.6 * s, 0.001]], k.seg(8), { y, z }), GUN, { crease: 40 });
    k.dark(lathe([[L - 0.25, 0.001], [L - 0.25, br * 0.62]], 6, { y, z }), PITCH);
    k.em(lathe([[L - 0.2, 0.001], [L - 0.2, br * 0.6]], 6, { y, z }), [4.4, 1.5, 0.25], CH.VOLLEY, 0.05 + b * 0.2);
    k.halo(L + 0.5, y, z, br * 3.2, [1.6, 0.5, 0.08], CH.VOLLEY, 0.3 + b * 0.2);
    if (cls === 'lance') for (let r = 0; r < 3; r++) k.em(lathe([[10 * s + r * 3 * s + 0.3, br * 1.3], [10 * s + r * 3 * s - 0.3, br * 1.3]], 8, { y, z }), mul(P.lens, 0.5), CH.VOLLEY, 0.2 + r * 0.2);
  }
  // rangefinder ears with accent lenses, sight slit, whip
  for (const e of [1, -1]) {
    k.metal(box(-1.8 * s, 0.6 * s, hh * 0.5, hh * 0.8, e * hw * 0.9, e * (hw + 1.4 * s), 0.2), GUN);
    k.em(box(0.6 * s, 0.68 * s, hh * 0.56, hh * 0.74, e * (hw + 0.2 * s), e * (hw + 1.2 * s)), mul(P.glow, 0.7), CH.ACCENT);
  }
  k.em(tbox(4.9 * s, 5.0 * s, [hh * 0.7, hh * 0.76, -hw * 0.5, hw * 0.5], [hh * 0.68, hh * 0.74, -hw * 0.5, hw * 0.5]), [3.6, 0.5, 0.14], CH.NAV);
  k.metal(rod([-4.6 * s, hh * 0.8, hw * 0.5], [-5.8 * s, hh + 5 * s, hw * 0.5], 0.13, 3, 0.04), GUN);
}
// living turret: a chitin bulb that throws spines
function bioTurret(k, G, i, s) {
  const P = G.pal;
  k.add(ball(0, 1.6 * s, 0, 5 * s, k.seg(10), 5, 0.62), P.hull2, { mat: M.BIO, crease: 50 });
  k.add(latheY([[1.2 * s, 5.6 * s], [0.3 * s, 6.2 * s], [-0.4, 5.6 * s]], k.seg(10)), P.hull, { mat: M.BIO });
  for (let b = 0; b < 3; b++) {
    const z = (b - 1) * 2.4 * s, y = (2.4 + (b === 1 ? 0.9 : 0)) * s, L = (b === 1 ? 16 : 12.5) * s;
    k.add(tube([[2.5 * s, y, z, 1.25 * s], [7 * s, y + 0.2, z * 1.1, 0.95 * s], [L - 2, y, z * 1.15, 0.6 * s], [L, y - 0.2, z * 1.15, 0.04]], 5), P.pale, { mat: M.BIO, crease: 40 });
    k.em(ball(3.2 * s, y + 0.8 * s, z, 0.8 * s, 6, 3), mul(P.glow, 0.5), CH.ACCENT);
    k.em(ball(3.2 * s, y + 0.8 * s, z, 0.84 * s, 6, 3), mul(P.glow, 1.3), CH.VOLLEY, 0.1 + b * 0.25);
  }
  for (let j = 0; j < 5; j++) { const a = Math.PI * 0.6 + (j / 4) * Math.PI * 0.8; k.add(tube([[Math.cos(a) * 3.6 * s, 2.6 * s, Math.sin(a) * 3.6 * s, 0.7 * s], [Math.cos(a) * 6.5 * s, 4.6 * s, Math.sin(a) * 6.5 * s, 0.05]], 4), P.pale, { mat: M.BIO }); }
}

/* ========================================================================== */
/*  The classes                                                               */
/* ========================================================================== */

/* ------------------------------ DREADNOUGHT ------------------------------ */
// Line-of-battle ship: stepped decks, a citadel tower, armoured belt, batteries on outrigger sponsons.
function* dreadnought(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, v = Math.floor(G.level / 2) % 2;
  const F = hullLoft([
    { x: 66, w: 1.4, t: 1.2, b: 2.6, dk: 0.4 }, { x: 60, w: 5, t: yA * 0.5, b: 5.4 }, { x: 50, w: 9.5, t: yA * 0.84, b: 8 },
    { x: 45, w: 12, t: yA - 0.3, b: 9, dk: 0.62 }, { x: 30, w: 15.5, t: yA - 0.3, b: 10, dk: 0.64 }, { x: 28.6, w: 16, t: lerp(yA, yB, 0.5) - 0.3, b: 10.2, dk: 0.64 },
    { x: 9, w: 18.5, t: lerp(yA, yB, 0.5) - 0.3, b: 11, dk: 0.64 }, { x: 7.6, w: 18.6, t: yB - 0.3, b: 11, dk: 0.62 }, { x: -28, w: 19.5, t: yB - 0.3, b: 11, dk: 0.6 },
    { x: -45, w: 17.5, t: yB * 0.8, b: 9.4, dk: 0.56 }, { x: -56, w: 14.5, t: yB * 0.62, b: 7.4 }, { x: -59, w: 12, t: yB * 0.52, b: 6 },
  ]);
  k.cuts = [-24, 25];
  k.add(F.tris, P.hull, { win: 110 });
  k.decks(F.inner(0.86));
  bulkheads(k, F);
  belt(k, F, 44, -44, -3.4, 2.6, 1.0, [P.hull2, P.hull2, P.paint]);
  dressHull(k, F, 58, -57, P, { keep: (x) => Math.abs(x - 38) < 7 });
  yield;
  // --- foredeck, forward battery, deckhouse ---
  const yM = lerp(yA, yB, 0.5) - 0.3;
  k.barbette(0, piv[0], 6.2); if (piv[1]) k.barbette(1, piv[1], 6.2);
  k.add(tbox(11, 27, [yM, yM + 3.2, -4.6, 4.6], [yM, yM + 2.2, -3.6, 3.6], 0.3), P.hull2, { win: 220, whole: true });
  k.add(box(13, 21, yM + 3.2, yM + 5.2, -2.8, 2.8, 0.3), P.hull, { win: 220 });
  k.em(box(21, 21.1, yM + 3.9, yM + 4.7, -2.4, 2.4), mul(WINDOW_GLASS, 0.8), CH.NAV);
  k.antennas(16, yM + 5.2, 0, 4, 2, 5);
  k.metal(box(10.6, 27.4, yM + 3.0, yM + 3.3, -5, 5), GUN);
  for (const s of [1, -1]) { city(k, 10, 27, s * 8.3, s * 10.4, yM, P); city(k, -43, -9.5, s * 9.6, s * 11.2, yB - 0.3, P); city(k, 46, 56, s * 0.8, s * 4.6, F.top(51) + 0.2, P, 0.7); }
  // bow cheek armour and hawse lights
  for (const s of [1, -1]) {
    k.add(loft([[[62, -1, s * 3.6], [62, 1.4, s * 3.4], [62, 1.2, s * 4.4], [62, -1.2, s * 4.6]], [[46, -4, s * 11.4], [46, 3.4, s * 11], [46, 3, s * 12.6], [46, -4.4, s * 12.8]]]), P.paint, { whole: true, anim: [6, 3, s * 10, AN.PEEL, 0.3] });
    k.em(box(50, 53, -0.5, 0.1, s * 10.9 - 0.1, s * 10.9 + 0.1), [1.4, 1.3, 1.0], CH.NAV);
  }
  for (const s of [1, -1]) {
    k.trench(11, 27, yM, s * 7.2, 0.7, mul(P.glow, 0.7));
    k.gallery(-2, 26, -1.2, s * (F.hw(12) + 0.9), 5, s, P.hull2);
    k.mark([[47, s * 2], [47, s * 6.6], [57, s * 2.6], [57, s * 0.6]], F.top(52) + 0.3, P.paint);
  }
  k.greebles(45, 57, -4, 4, yA * 0.8, 6, 1.6, [P.hull2, DARK, P.hull]);
  k.lamp(64.5, 1.6, 0, 0.3, LAMP_WHITE, CH.STROBE);
  // chin lance under the bow
  k.metal(tbox(44, 60, [-11.5, -6, -3, 3], [-8, -4.6, -1.6, 1.6], 0.5), P.hull2, { whole: true });
  k.lens(60.5, -6.6, 0, 1.9, P.lens);
  k.emitter = [63, -6.6, 0];
  yield;
  // --- citadel ---
  const yD = yB - 0.3;
  k.add(tbox(-36, -8.5, [yD, yD + 4.2, -6.4, 6.4], [yD, yD + 3.4, -5.2, 5.2], 0.5), P.hull2, { win: 210 });
  const tw = k.tower(-20, yD + 4.2, 0, { l: 13 + v * 2, w: 8.4, h: 10 + v * 3, tiers: 3 + v, col: P.hull, col2: P.hull2 });
  k.radar(tw.x + 1.5, tw.top, v ? 2.6 : -2.6, 3.4, 0.0011);
  // raked stacks with a dull furnace glow
  for (const s of [1, -1]) {
    k.metal(tbox(-41, -37, [yD, yD + 3, s * 2 - 1.5, s * 2 + 1.5], [yD + 5.5, yD + 6.5, s * 2.2 - 1.1, s * 2.2 + 1.1], 0.3), HEAT, { whole: true });
    k.em(box(-41.6, -39.6, yD + 6.1, yD + 6.2, s * 2.2 - 0.8, s * 2.2 + 0.8), [2.4, 0.7, 0.12], CH.ENGINE);
    k.trench(-42, -9, yD, s * 8.6, 0.7, mul(P.glow, 0.7));
  }
  k.greebles(-55, -43, -6, 6, F.top(-50) - 0.2, 12, 2.2, [P.hull2, DARK, P.hull]);
  city(k, -56, -44, -7.4, 7.4, F.top(-52) - 0.6, P, 0.5);
  // aft director tower and a searchlight platform
  k.tower(-47, F.top(-47) - 0.2, 0, { l: 6, w: 4.6, h: 6, tiers: 2, col: P.hull2, col2: P.hull, mast: 5 });
  for (const s of [1, -1]) { k.metal(box(-8, -6, yD + 4.2, yD + 4.6, s * 6.6, s * 9.4), GUN); k.lamp(-7, yD + 5, s * 9, 0.3, LAMP_WHITE, CH.NAV); flak(k, -30, yD + 4.2, s * 5, s); flak(k, -14, yD + 4.2, s * 5, s); }
  k.antennas(-48, F.top(-48), 0, 5, 4, 7, { lean: 0.25 });
  k.mark([[-8.5, -9], [-8.5, 9], [-10.5, 9], [-10.5, -9]], yD + 0.02, P.paint);
  yield;
  // --- sponsons with the wing batteries ---
  for (const s of [1, -1]) {
    const z = s * pz;
    k.add(pod(36 - v * 4, -44, -4.2, yC - 0.3, z, 6.6), P.hull, { win: 150 });
    k.add(box(-32, 4, yC - 0.3, yC + 2, z - 3.6, z + 3.6, 0.5), P.hull2, { win: 220 });
    k.dark(box(-28, 24, -2.2, 2.0, s * 14, s * (pz - 5)), P.deck);
    for (const x of [-18, 6]) k.metal(tube([[x, 4, s * 13, 1.2], [x, 2.2, s * (pz - 5), 1.2]], 6), GUN);
    k.add(box(-40, 30 - v * 4, 0.4, 1.6, z + s * 6.4, z + s * 7.4), P.paint);
    city(k, -40, -33, z - 4.6, z + 4.6, yC - 0.3, P); city(k, 5, 9, z - 4.6, z + 4.6, yC - 0.3, P);
    for (let x = 26 - v * 4; x > -44; x -= 6) k.metal(box(x - 0.3, x + 0.3, -4.5, yC - 0.1, z - 6.9, z + 6.9, 1.3), GUN, { whole: true });
    for (const x of [-26, -12, 1]) flak(k, x, yC + 2.2, z, s);
    k.antennas(-30, yC + 2, z, 3, 2, 5);
    k.gallery(-36, -6, -1, z + s * 6.7, 4, s, P.hull2);
    // intake mouth with a deep glow
    k.em(box(31.2 - v * 4, 31.4 - v * 4, -2.4, 2.2, z - 3.6, z + 3.6), mul(P.glow, 0.4), CH.ACCENT);
    k.metal(box(30.6 - v * 4, 31.9 - v * 4, -0.3, 0.2, z - 4.4, z + 4.4), GUN); k.metal(box(30.6 - v * 4, 31.9 - v * 4, -3, 2.8, z - 0.3, z + 0.3), GUN);
    // swept stabiliser
    const wz = Math.min(49, pz + 19);
    k.add(fin([[-8, z + s * 6], [-36, z + s * 6], [-47, s * wz], [-37, s * wz]], -0.2, 1.3), P.hull2);
    k.add(fin([[-14, z + s * 6.2], [-20, z + s * 6.2], [-39.5, s * (wz - 0.4)], [-36, s * (wz - 0.4)]], 1.1, 0.14), P.paint);
    k.lamp(-41, 1.4, s * wz, 0.34, s > 0 ? [0.4, 4.6, 1.0] : LAMP_RED, CH.NAV);
    k.engine(-50, -0.6, z, 4.6, 8, { petals: 6 });
    if (piv[s > 0 ? 2 : 3]) k.barbette(s > 0 ? 2 : 3, piv[s > 0 ? 2 : 3], 5.4);
    else { k.add(box(10, 22, yC - 0.3, yC + 1.6, z - 4, z + 4, 0.5), P.hull2, { win: 200 }); k.antennas(16, yC + 1.6, z, 3, 2.5, 5); }
  }
  yield;
  // --- stern, keel ---
  if (v) { for (const s of [1, -1]) k.engine(-64, -1.2, s * 6.6, 5.6, 9); } else {
    k.engine(-65, -1.6, 0, 7.4, 10);
    for (const s of [1, -1]) k.engine(-62, 2.6, s * 9.4, 2.6, 6, { petals: 0 });
  }
  k.add(tbox(-22, 30, [-15.5, -9, -3.6, 3.6], [-13.4, -8, -2.4, 2.4], 0.6), P.hull2, { win: 200, whole: false });
  k.em(box(-18, 26, -15.56, -15.5, -0.3, 0.3), mul(P.glow, 0.8), CH.ACCENT);
  for (let x = -16; x < 26; x += 7) { k.dark(box(x, x + 4, -11, -9.6, -3.4, 3.4), PITCH); k.em(box(x + 0.4, x + 3.6, -10.6, -10, 3.1, 3.2), [1.9, 1.2, 0.5], CH.BAY); k.em(box(x + 0.4, x + 3.6, -10.6, -10, -3.2, -3.1), [1.9, 1.2, 0.5], CH.BAY); }
  for (const s of [1, -1]) for (const x of [-34, 36]) { k.metal(ball(x, -9.6 + (x > 0 ? 1.4 : 0), s * 6, 2.4, 8, 4, 0.7), GUN); flak(k, x, -11.2 + (x > 0 ? 1.4 : 0), s * 6, s); }
  k.antennas(22, -15.5, 0, 4, 2, -6);
  k.add(fin([[-30, 0], [-52, 0], [-60, 1], [-46, 1]], -1, 2), P.hull2, { whole: false });
  k.add(rotX(fin([[-34, 0], [-50, 0], [-60, 13], [-52, 13]], -0.5, 1), -Math.PI / 2), P.hull2);
  k.add(move(rotX(fin([[-30, 0], [-46, 0], [-58, 12], [-50, 12]], -0.5, 1), Math.PI / 2), 0, yB * 0.7, 0), P.paint);
  k.lamp(-55, yB * 0.7 + 12.4, 0, 0.3, LAMP_RED, CH.BEACON, 0.3);
  k.wound(20, 4, 13, 9); k.wound(-30, 5, -15, 10); k.wound(48, 3, -5, 7); k.wound(-6, 2, 19, 9);
  k.wound(-46, 4, 8, 8); k.wound(8, 5, -pz, 8); k.wound(34, 4, 9, 7); k.wound(-18, 9, -2, 9);
  k.blasts = [[-52, 3, 4], [-38, 6, -8], [-22, 9, 5], [-6, 6, -12], [10, 6, 10], [24, 5, -6], [40, 5, 3], [54, 3, -2]];
}

/* --------------------------------- LANCE --------------------------------- */
// A gun with a ship round it: forked prow, spinal barrel ringed with capacitors, heat radiators.
function* lance(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, v = G.level % 2;
  const F = hullLoft([
    { x: 9, w: 9, t: yB * 0.6, b: 6.5 }, { x: 6.5, w: 12.5, t: yB - 0.3, b: 8.6, dk: 0.62 }, { x: -30, w: 15, t: yB - 0.3, b: 10, dk: 0.6 },
    { x: -48, w: 14, t: yB * 0.82, b: 9, dk: 0.55 }, { x: -57, w: 10.5, t: yB * 0.6, b: 6.4 }, { x: -59, w: 9, t: yB * 0.5, b: 5.4 },
  ]);
  k.cuts = [-34, 24];
  k.add(F.tris, P.hull, { win: 120 });
  k.decks(F.inner(0.86));
  bulkheads(k, F);
  belt(k, F, 4, -44, -3, 2.4, 0.9, [P.hull2, P.paint, P.hull2]);
  dressHull(k, F, 4, -57, P, { keep: (x) => x > -8 });
  yield;
  // --- forked prow ---
  for (const s of [1, -1]) {
    k.add(loft([
      ringRect(66, -1.2, 1.4, s * 7, s * 8.8, 0.3), ringRect(52, -3.6, 4.2, s * 5, s * 10.6, 0.8),
      ringRect(30, -5, yA - 0.3, s * 4.6, s * 11.8, 0.9), ringRect(5, -6.4, yA - 0.3, s * 4.2, s * 12.2, 0.9),
    ]), P.hull, { win: 110 });
    k.decks(loft([ringRect(50, -2.6, 3, s * 5.6, s * 9.8), ringRect(8, -5, yA - 1.4, s * 5.2, s * 11.2)]));
    k.add(box(8, 50, 1.4, 2.6, s * 11.6, s * 12.5), P.paint);
    // inner rail: lights run down it as the lance spools
    for (let i = 0; i < 9; i++) k.em(box(10 + i * 5, 13 + i * 5, -0.6, 0.6, s * 4.3, s * 4.45), mul(P.lens, 0.8), CH.LASER, 0.05 + i * 0.09);
    for (let i = 0; i < 9; i++) k.em(box(10 + i * 5, 13 + i * 5, -1.2, -0.9, s * 4.3, s * 4.45), mul(P.glow, 0.34), CH.ACCENT);
    k.lamp(65.6, 1.8, s * 7.9, 0.3, LAMP_WHITE, CH.STROBE);
    k.trench(8, 28, yA - 0.3, s * 8.2, 0.6, mul(P.glow, 0.7));
    k.greebles(46, 58, s * 6.4, s * 9.6, 3.4, 3, 1.2, [P.hull2, DARK]);
    city(k, 9, 30, s * 5.4, s * 7.4, yA - 0.3, P); city(k, 9, 30, s * 9, s * 11, yA - 0.3, P);
    for (let x = 48; x > 8; x -= 5) k.metal(box(x - 0.3, x + 0.3, -5.2, lerp(4, yA - 0.2, sat((52 - x) / 22)), s * 11.7, s * 12.2), GUN, { whole: true });
    for (const x of [46, 24, 12]) flak(k, x, 2, s * 12.4, s);
  }
  k.add(box(31.5, 44.5, yA - 2.3, yA - 0.3, -12, 12, 0.5), P.hull2, { win: 0 });
  k.mark([[31.5, -12], [31.5, 12], [33, 12], [33, -12]], yA - 0.28, P.paint);
  k.barbette(0, piv[0], 6); if (piv[1]) k.barbette(1, piv[1], 6.2);
  yield;
  // --- the barrel ---
  k.metal(lathe([[52, 2.0], [51, 3.1], [6, 3.3]], k.seg(12), { y: -0.6 }), GUN, { crease: 40 });
  for (let i = 0; i < 6; i++) {
    const x = 12 + i * 7;
    k.metal(lathe([[x + 1, 3.3], [x + 0.7, 4.5], [x - 0.7, 4.5], [x - 1, 3.3]], k.seg(12), { y: -0.6 }), STEEL);
    k.em(lathe([[x + 0.3, 4.56], [x - 0.3, 4.56]], k.seg(12), { y: -0.6 }), mul(P.lens, 1.1), CH.LASER, 0.08 + i * 0.13);
    k.em(lathe([[x + 0.62, 4.52], [x + 0.42, 4.52]], k.seg(12), { y: -0.6 }), mul(P.glow, 0.3), CH.ACCENT);
  }
  k.lens(52, -0.6, 0, 2.5, P.lens);
  k.emitter = [56, -0.6, 0];
  yield;
  // --- outrigger pods ---
  for (const s of [1, -1]) {
    const z = s * pz, ti = s > 0 ? 2 : 3;
    k.add(pod(31, -26, -3.6, yC - 0.3, z, 5.2, 1.1), P.hull, { win: 140 });
    for (const x of [-10, 18]) k.dark(box(x - 2.5, x + 2.5, -1, 1.6, s * 11, z - s * 4), P.hull2);
    k.add(box(-20, 24, 0.6, 1.5, z + s * 5.1, z + s * 5.9), P.paint);
    k.engine(-30, -0.4, z, 3.5, 6.5, { petals: 6 });
    if (piv[ti]) k.barbette(ti, piv[ti], 5.2);
    else { k.add(box(10, 22, yC - 0.3, yC + 1.4, z - 3.4, z + 3.4, 0.5), P.hull2, { win: 200 }); k.antennas(16, yC + 1.4, z, 3, 2.5, 6); }
    k.lamp(27, yC - 0.1, z, 0.28, s > 0 ? [0.4, 4.6, 1.0] : LAMP_RED, CH.NAV);
    k.gallery(-14, 8, -0.6, z + s * 5.3, 3, s, P.hull2);
    city(k, -20, 9, z - 3.4, z + 3.4, yC - 0.3, P);
    for (let x = 22; x > -22; x -= 5.5) k.metal(box(x - 0.3, x + 0.3, -3.9, yC - 0.1, z - 5.5, z + 5.5, 1.2), GUN, { whole: true });
    // radiators: an X of glowing slatted fins
    for (const up of [1, -1]) {
      const wz = 47, a = up * (0.34 + v * 0.1);
      const place = (t) => move(rotX(move(t, 0, 0, -s * 14), -a * s), 0, up * 1.5, s * 14);
      k.dark(place(fin([[-10, s * 14], [-44, s * 14], [-58, s * wz], [-40, s * wz]], -0.4, 0.8)), P.hull2, { whole: false });
      for (let i = 0; i < 7; i++) {
        const f0 = 0.08 + i * 0.125, f1 = f0 + 0.07, zz = (f) => s * lerp(14, wz, f), xa = (f) => lerp(-13, -41, f), xb = (f) => lerp(-42, -56, f);
        for (const yy of [0.42, -0.42]) k.em(place(prismY([[xa(f0), zz(f0)], [xb(f0), zz(f0)], [xb(f1), zz(f1)], [xa(f1), zz(f1)]], yy - 0.03, yy + 0.03)), [0.85, 0.2, 0.035], CH.SEAM, 0, { whole: true });
      }
    }
  }
  yield;
  // --- tower, stern ---
  const yD = yB - 0.3;
  k.add(tbox(-36, -9, [yD, yD + 3, -5.6, 5.6], [yD, yD + 2.4, -4.6, 4.6], 0.4), P.hull2, { win: 210 });
  const tw = k.tower(-22, yD + 3, 0, { l: 10, w: 6.4, h: 9 + v * 4, tiers: 3, col: P.hull, col2: P.hull2, mast: 8 });
  k.radar(tw.x, tw.top, v ? -2.2 : 2.2, 2.8, -0.0013);
  for (const s of [1, -1]) k.trench(-44, -8, yD, s * 7.2, 0.6, mul(P.glow, 0.7));
  k.greebles(-56, -40, -5, 5, F.top(-48) - 0.2, 10, 2, [P.hull2, DARK, P.hull]);
  for (const s of [1, -1]) { city(k, -44, -9, s * 6, s * 8.6, yD, P); flak(k, -30, yD + 3, s * 4, s); flak(k, -14, yD + 3, s * 4, s); }
  // capacitor banks either side of the breech
  for (const s of [1, -1]) for (let i = 0; i < 4; i++) {
    k.metal(lathe([[2 - i * 3.2, 0.001], [1.7 - i * 3.2, 1.3], [-0.3 - i * 3.2, 1.3], [-0.6 - i * 3.2, 0.001]], 8, { y: yD + 1.2, z: s * 10 }), STEEL);
    k.em(lathe([[1.0 - i * 3.2, 1.34], [0.4 - i * 3.2, 1.34]], 8, { y: yD + 1.2, z: s * 10 }), mul(P.lens, 0.9), CH.LASER, 0.05 + i * 0.1);
  }
  k.antennas(-44, F.top(-44), 0, 5, 3.5, 8, { lean: 0.3 });
  k.engine(-66, -1.4, 0, 8.6, 11);
  for (const [y, z] of [[5, 7.5], [5, -7.5], [-6.5, 6.5], [-6.5, -6.5]]) k.engine(-61, y, z, 2.2, 5, { petals: 0 });
  k.add(rotX(fin([[-20, 0], [-46, 0], [-58, 14], [-48, 14]], -0.6, 1.2), -Math.PI / 2), P.hull2);
  k.add(tbox(-16, 2, [-13, -8.4, -2.6, 2.6], [-11.6, -8, -1.6, 1.6], 0.5), P.hull2, { win: 200 });
  k.em(box(2, 2.1, -11, -9.4, -1.2, 1.2), mul(P.glow, 0.7), CH.ACCENT);
  k.wound(-20, 4, 12, 9); k.wound(30, 3, -8, 7); k.wound(-44, 5, -9, 8); k.wound(14, 2, pz, 7);
  k.wound(46, 2, 8, 6); k.wound(-6, 6, -6, 8); k.wound(-30, 2, -32, 9); k.wound(22, 0, 0, 6);
  k.blasts = [[-54, 2, 0], [-40, 6, 7], [-26, 8, -5], [-10, 6, 6], [6, 4, -8], [22, 2, 7], [38, 4, -7], [54, 1, 8]];
}

/* -------------------------------- CARRIER -------------------------------- */
// Flat-top: hangar mouths across the bow, a lit flight deck, an island offset to starboard.
function* carrier(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, v = Math.floor(G.level / 3) % 2, w = Math.floor(G.level / 6) % 2;
  const hw = pz - 7.2;
  const F = hullLoft([
    { x: 57, w: hw * 0.84, t: yA - 0.3, b: 7, dk: 0.88, ws: 0.97, sh: 0.8, ks: 0.6 }, { x: 28, w: hw * 0.96, t: yA - 0.3, b: 8.6, dk: 0.9, ws: 0.98, sh: 0.8, ks: 0.6 },
    { x: 27, w: hw * 0.97, t: yB - 0.3, b: 8.8, dk: 0.9, ws: 0.98, sh: 0.82, ks: 0.6 }, { x: -44, w: hw, t: yB - 0.3, b: 9, dk: 0.9, ws: 0.98, sh: 0.82, ks: 0.6 },
    { x: -56, w: hw * 0.92, t: yB * 0.86, b: 8, dk: 0.84, ws: 0.96, sh: 0.8, ks: 0.6 }, { x: -59, w: hw * 0.84, t: yB * 0.7, b: 6.4, dk: 0.8, ws: 0.95, sh: 0.8, ks: 0.6 },
  ]);
  k.cuts = [-42, 25];
  k.add(F.tris, P.hull, { win: 130 });
  k.decks(F.inner(0.86));
  bulkheads(k, F);
  dressHull(k, F, 26, -57, P, { hatches: false, flak: false });
  yield;
  // --- bow: three hangar mouths under the foredeck ---
  const bw = hw * 0.84;
  hangarWall(k, 62, 5.2, -6.4, yA - 0.3, -bw, bw, w ? [
    { y0: -5, y1: yA - 2.3, z0: -bw + 1.4, z1: -1.6 }, { y0: -5, y1: yA - 2.3, z0: 1.6, z1: bw - 1.4 },
  ] : [
    { y0: -4.6, y1: yA - 2.6, z0: -bw + 1.2, z1: -bw * 0.32 }, { y0: -5.2, y1: yA - 2.2, z0: -bw * 0.24, z1: bw * 0.24 }, { y0: -4.6, y1: yA - 2.6, z0: bw * 0.32, z1: bw - 1.2 },
  ], P.hull2);
  k.add(box(56.6, 62.6, yA - 0.3, yA + 0.3, -bw - 0.5, bw + 0.5), P.paint);
  k.metal(tbox(50, 62, [-9.6, -6.4, -bw * 0.9, bw * 0.9], [-8, -6.4, -bw * 0.7, bw * 0.7], 0.5), P.hull2);
  k.lens(62.4, -7.8, 0, 1.3, P.lens);
  k.emitter = [64, -7.8, 0];
  for (const s of [1, -1]) k.lamp(62.4, yA + 0.6, s * bw, 0.3, LAMP_WHITE, CH.STROBE);
  k.barbette(0, piv[0], 6); if (piv[1]) k.barbette(1, piv[1], 6);
  // foredeck: catapult tracks
  for (const s of [1, -1]) { k.trench(44.5, 61, yA - 0.3, s * bw * 0.55, 0.5, [0.6, 1.9, 2.6], CH.STROBE); k.mark([[30, s * 9], [30, s * 11], [36, s * 11], [36, s * 9]], yA - 0.28, P.pale); }
  yield;
  // --- flight deck ---
  const yD = yB - 0.3, dw = hw * 0.9 - 1.2;
  k.mark([[26, -dw], [26, dw], [-54, dw * 0.94], [-54, -dw * 0.94]], yD + 0.01, P.deck, { whole: false });
  for (let i = 0; i < 13; i++) { const x = 22 - i * 6; if (Math.abs(x) < 8) continue; k.em(box(x - 1.7, x + 1.7, yD + 0.14, yD + 0.22, -0.3, 0.3), [1.5, 1.4, 1.1], CH.STATIC); }
  for (const s of [1, -1]) {
    for (let i = 0; i < 14; i++) k.em(box(23 - i * 5.8, 23.8 - i * 5.8, yD + 0.14, yD + 0.3, s * dw - 0.25, s * dw + 0.25), i % 2 ? [0.5, 1.7, 2.6] : [2.6, 1.6, 0.3], CH.NAV);
    k.mark([[24, s * (dw - 3)], [24, s * (dw - 2.2)], [-52, s * (dw * 0.94 - 2.2)], [-52, s * (dw * 0.94 - 3)]], yD + 0.15, P.pale, { whole: false });
    // elevators
    k.dark(box(-38 + s * 4, -27 + s * 4, yD + 0.14, yD + 0.24, s * 3.6 - 3, s * 3.6 + 3), PITCH);
    k.em(box(-38 + s * 4, -27 + s * 4, yD + 0.24, yD + 0.3, s * 3.6 - 3.2, s * 3.6 - 3), [2.4, 1.5, 0.3], CH.STROBE);
  }
  chevrons(k, -42, 0, yD + 0.15, 4.2, 3, 3.4, P.paint);
  if (w) for (const s of [1, -1]) k.mark([[-50, s * 1.2 - dw * 0.5], [-50, s * 1.2 - dw * 0.5 + 0.7], [10, s * 1.2 + dw * 0.45 + 0.7], [10, s * 1.2 + dw * 0.45]], yD + 0.16, P.paint, { whole: false });
  chevrons(k, 20, 0, yD + 0.15, 3.4, 2, 3, P.pale);
  // parked wings on the deck edge, tie-down lights
  for (let i = 0; i < 6; i++) {
    const x = 16 - i * 9.5, z = (i % 2 ? 1 : -1) * (dw - 5.2);
    if (Math.abs(x) < 9) continue;
    k.dark(prismY([[x + 2.2, z], [x - 1.4, z + 1.7], [x - 0.8, z], [x - 1.4, z - 1.7]], yD + 0.14, yD + 0.7, 0.7, x, z), GUN, { mat: M.METAL });
    k.em(box(x - 1.5, x - 1.3, yD + 0.3, yD + 0.5, z - 0.3, z + 0.3), [2.6, 0.9, 0.2], CH.ENGINE);
  }
  for (const s of [1, -1]) city(k, 31, 44, s * (bw * 0.62), s * (bw * 0.86), yA - 0.3, P);
  yield;
  // --- side galleries: the batteries, the island, launch bays ---
  for (const s of [1, -1]) {
    const z = s * pz, ti = s > 0 ? 2 : 3, zo = Math.min(48, pz + 9.5);
    k.add(loft([
      ringRect(44, -2, yC - 1.6, s * (hw * 0.8), s * (pz + 3), 0.6), ringRect(36, -4.4, yC - 0.3, s * (hw * 0.8), s * (pz + 7.6), 1), ringRect(-44, -4.4, yC - 0.3, s * (hw * 0.8), s * (pz + 7.6), 1), ringRect(-54, -3, yC - 1.4, s * (hw * 0.8), s * (pz + 4), 0.8),
    ]), P.hull2, { win: 170 });
    k.add(box(-40, 34, yC - 0.3, yC + 0.5, z + s * 7.2, z + s * 7.9), P.paint);
    if (piv[ti]) k.barbette(ti, piv[ti], 5.4);
    else { k.add(box(11, 21, yC - 0.3, yC + 2, z - 3.6, z + 3.6, 0.5), P.hull, { win: 210 }); k.antennas(16, yC + 2, z, 3, 2.4, 5); }
    // lit launch slots in the hull wall above the gallery
    for (let i = 0; i < 4; i++) {
      const x = -6 - i * 9 - (s > 0 ? 28 * 0 : 0), zz = s * (hw * 0.985 + 0.12);
      if (yB - yC < 3) break;
      k.dark(box(x - 3.2, x + 3.2, yC + 0.3, yB - 1.4, zz - 0.1, zz + 0.1), PITCH);
      k.em(box(x - 2.8, x + 2.8, yC + 0.5, yB - 1.7, zz + s * 0.1 - 0.02, zz + s * 0.1 + 0.02), [2.2, 1.3, 0.5], CH.BAY, 0.2 + i * 0.15);
      k.em(box(x - 2.8, x + 2.8, yC + 0.5, yC + 0.8, zz + s * 0.13 - 0.02, zz + s * 0.13 + 0.02), [1.8, 1.1, 0.4], CH.STATIC);
    }
    k.gallery(-34, 30, -1.6, z + s * 7.7, 7, s, P.hull2);
    // sponson wing
    k.add(fin([[4, z + s * 7], [-34, z + s * 7], [-46, s * zo], [-30, s * zo]], -2.6, 1.4), P.hull2);
    k.lamp(-38, -1, s * zo, 0.34, s > 0 ? [0.4, 4.6, 1.0] : LAMP_RED, CH.NAV);
    k.greebles(22, 34, z - 4, z + 6, yC - 0.3, 5, 1.8, [P.hull, DARK, P.hull2]);
    city(k, 24, 35, z - 5, z + 6.6, yC - 0.3, P, 0.6); city(k, -4, 8, z - 5, z + 6.6, yC - 0.3, P, 0.6);
    for (let x = 30; x > -42; x -= 6) k.metal(box(x - 0.3, x + 0.3, -4.7, yC - 0.1, z + s * 7.5 - 0.5, z + s * 7.5 + 0.5), GUN, { whole: true });
    for (const x of [-44, 2, 30]) flak(k, x, yC, z + s * 5, s);
  }
  // the island stands on one gallery, the working gear on the other; which side, and whether a second island
  // rides aft of it, changes from carrier to carrier
  const is = v ? 1 : -1, iz = is * (pz + 1.2), wz = -is * pz, ix = w ? -16 : -26;
  const tw = k.tower(ix, yC - 0.3, iz, { l: 20 - w * 5, w: 8.4, h: 13 + v * 3 + (yB - yC), tiers: 3 + v, col: P.hull, col2: P.hull2, rake: 0.3 });
  k.radar(tw.x + 3, tw.top, iz, 3.6, 0.001);
  k.radar(ix - 8, yC + 4, iz + is, 2, -0.0021);
  if (w) { const t2 = k.tower(-38, yC - 0.3, iz, { l: 9, w: 6.4, h: 8 + (yB - yC), tiers: 2, col: P.hull2, col2: P.hull, mast: 7 }); k.antennas(t2.x, t2.top, iz, 3, 1.5, 5); }
  else {
    k.add(box(-42, -37, yC - 0.3, yC + 6, iz - 2.4, iz + 2.4, 0.4), P.hull2, { win: 200 });
    k.metal(tbox(-41, -38, [yC + 6, yC + 9, iz - 1.4, iz + 1.4], [yC + 6, yC + 10, iz - 1, iz + 1]), HEAT);
  }
  k.greebles(-40, 2, Math.min(wz - is * 6, wz + is * 3), Math.max(wz - is * 6, wz + is * 3), yC - 0.3, 14, 3, [P.hull, DARK, P.hull2, P.paint]);
  k.antennas(-30, yC - 0.3, wz - is * 2, 8, 5, 9);
  // crane
  k.metal(rod([-14, yC, wz - is * 3], [-14, yC + 8, wz - is * 3], 0.5, 4), GUN); k.metal(rod([-14, yC + 7.6, wz - is * 3], [-2, yC + 10.5, wz - is * 4], 0.34, 4, 0.2), P.paint);
  k.lamp(-2, yC + 10.8, wz - is * 4, 0.24, LAMP_AMBER, CH.BEACON, 0.4);
  yield;
  // --- stern, belly ---
  const ez = hw / 2.6;
  for (const z of [-ez * 1.9, -ez * 0.64, ez * 0.64, ez * 1.9]) k.engine(-63, -1, z, Math.min(5, ez * 0.62), 8, { petals: 6 });
  for (const s of [1, -1]) {
    k.add(pod(34, -30, -13, -8.6, s * hw * 0.5, 3.4, 0.9), P.hull2, { win: 160 });
    k.em(box(-24, 28, -13.06, -13, s * hw * 0.5 - 0.25, s * hw * 0.5 + 0.25), mul(P.glow, 0.7), CH.ACCENT);
  }
  k.dark(box(-18, 14, -9.3, -9, -hw * 0.3, hw * 0.3), PITCH);
  k.em(box(-17, 13, -9.36, -9.3, -hw * 0.26, hw * 0.26), [1.7, 1.0, 0.4], CH.BAY);
  k.antennas(40, -8, 0, 4, 3, -6);
  k.wound(10, 6, -12, 9); k.wound(-30, 8, 6, 10); k.wound(46, 2, 8, 7); k.wound(-10, 3, pz, 9);
  k.wound(-50, 3, -8, 8); k.wound(20, 4, -pz, 8); k.wound(-20, 9, -4, 8); k.wound(36, 6, -2, 7);
  k.blasts = [[-54, 4, 5], [-40, 9, -6], [-26, 9, 8], [-12, 9, -9], [4, 9, 6], [18, 9, -7], [34, 6, 6], [52, 3, -4]];
}

/* ---------------------------------- RAM ---------------------------------- */
// The brute: a plough of layered armour, tusks, and more engine than ship.
function* ram(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, v = Math.floor(G.level / 4) % 2;
  const mw = Math.min(22, pz - 3);
  const F = hullLoft([
    { x: 66, w: 0.7, t: yA * 0.86, b: 9.5, dk: 0.5, ks: 0.6, ws: 1, wb: 1 }, { x: 57, w: 4.6, t: yA * 0.94, b: 12, dk: 0.5, ks: 0.5 }, { x: 45, w: 11.5, t: yA - 0.3, b: 12.6, dk: 0.6 },
    { x: 30, w: mw * 0.86, t: yA - 0.3, b: 12, dk: 0.62 }, { x: 28.6, w: mw * 0.88, t: lerp(yA, yB, 0.5), b: 12, dk: 0.62 }, { x: 9, w: mw, t: lerp(yA, yB, 0.5), b: 11.4, dk: 0.62 },
    { x: 7.6, w: mw, t: yB - 0.3, b: 11.4, dk: 0.62 }, { x: -20, w: mw, t: yB - 0.3, b: 11, dk: 0.6 }, { x: -28, w: mw + 4, t: yB * 0.92, b: 12.4, dk: 0.66 },
    { x: -54, w: mw + 5, t: yB * 0.86, b: 12.4, dk: 0.66 }, { x: -58, w: mw + 2, t: yB * 0.7, b: 10.4, dk: 0.6 },
  ]);
  k.cuts = [-25, 27];
  k.add(F.tris, P.hull, { win: 70 });
  k.decks(F.inner(0.86));
  bulkheads(k, F);
  dressHull(k, F, 20, -56, P, { keep: (x) => Math.abs(x) < 8, ribs: 4.4 });
  yield;
  // --- the plough: overlapping armour scales that slam forward and lock for the charge ---
  for (const s of [1, -1]) {
    [[61, 45], [49, 33], [37, 21]].forEach(([xa, xb], i) => {
      const ring = (x, o) => { const w = F.hw(x) + o; return [[x, -11.4 + i, s * (w * 0.7)], [x, -3, s * (w + 0.6)], [x, yA * 0.62, s * (w * 0.93 + 0.5)], [x, yA * 0.62 - 0.8, s * (w * 0.93 + 1.9)], [x, -3, s * (w + 2.1)], [x, -11.4 + i + 0.6, s * (w * 0.7 + 1.5)]]; };
      const an = [3.4, 0, -s * 1.1, AN.RAM, i * 0.18];
      k.add(loft([ring(xa, -0.6), ring(xb, 0.9)]), i === 1 ? P.paint : P.hull2, { whole: true, anim: an });
      // hazard bars on the scale face
      for (let j = 0; j < 3; j++) { const x = lerp(xa, xb, 0.25 + j * 0.25), w = F.hw(x) + lerp(-0.6, 0.9, 0.25 + j * 0.25); k.add(box(x - 0.7, x + 0.7, -7 + i, -1, s * (w + 2.0) - 0.12, s * (w + 2.0) + 0.12), j % 2 ? PITCH : P.pale, { anim: an, whole: true }); }
      k.em(box(xb - 0.5, xb - 0.2, -9 + i, yA * 0.5, s * (F.hw(xb) + 1.2) - 0.5, s * (F.hw(xb) + 1.2) + 0.5), [3.2, 0.9, 0.12], CH.RAM, 0.2 + i * 0.2);
    });
  }
  // the edge itself: heats as the charge winds up
  k.metal(tbox(60, 67.4, [-10.4, yA * 0.9, -1.4, 1.4], [-8.6, yA * 0.8, -0.16, 0.16]), STEEL, { whole: true });
  k.em(box(67.4, 67.6, -8.4, yA * 0.78, -0.2, 0.2), [0.5, 0.12, 0.02], CH.STATIC);
  k.em(box(67.45, 67.7, -8.4, yA * 0.78, -0.24, 0.24), [5, 1.6, 0.25], CH.RAM, 0.3);
  k.halo(67, -1, 0, 9, [1.5, 0.4, 0.06], CH.RAM, 0.5);
  chevrons(k, 54, 0, F.top(50) + 0.4, 3.2, 3, 3.2, P.pale);
  k.barbette(0, piv[0], 6); if (piv[1]) k.barbette(1, piv[1], 6.3);
  // chin gun
  k.metal(tbox(40, 52, [-15.4, -11.6, -2.4, 2.4], [-14, -11.6, -1.4, 1.4], 0.4), P.hull2);
  k.lens(52.6, -13.4, 0, 1.5, P.lens);
  k.emitter = [55, -13.4, 0];
  yield;
  // --- pauldrons and tusks ---
  for (const s of [1, -1]) {
    const z = s * pz, ti = s > 0 ? 2 : 3;
    k.add(loft([
      ringRect(34, -3, yC - 2, z - 4, z + 5, 0.8), ringRect(27, -5.6, yC - 0.3, z - 7, z + 8.6, 1.4), ringRect(4, -5.6, yC - 0.3, z - 7, z + 8.6, 1.4), ringRect(-6, -4, yC - 1.6, z - 6, z + 6, 1),
    ]), P.hull2, { win: 90 });
    k.add(box(2, 28, yC - 0.3, yC + 0.4, z + s * 8.4 - 0.5, z + s * 8.4 + 0.5), P.paint);
    if (piv[ti]) k.barbette(ti, piv[ti], 5.4);
    else { k.add(tbox(10, 22, [yC - 0.3, yC + 2.4, z - 4, z + 4], [yC - 0.3, yC + 1.6, z - 3, z + 3], 0.5), P.hull, { whole: true }); }
    // tusk: a forged horn reaching past the bow
    k.metal(tube([[20, -1.5, z + s * 5, 3.6], [36, -2, z + s * 7, 3.2], [52, -1.6, z + s * 4, 2.2], [64, -0.6, z - s * 3, 0.9], [66.5, -0.4, z - s * 5, 0.05]], 6, { sy: 1.25 }), STEEL, { crease: 30, whole: false });
    k.add(tube([[30, -1.8, z + s * 6.4, 3.9], [34, -1.9, z + s * 6.8, 3.8]], 6, { sy: 1.25 }), P.paint);
    k.add(tube([[44, -1.8, z + s * 5.8, 3.1], [47, -1.8, z + s * 5.2, 2.9]], 6, { sy: 1.25 }), P.paint);
    k.em(tube([[58, -1.2, z + s * 0.6, 1.72], [59, -1.1, z - s * 0.1, 1.6]], 6, { sy: 1.25 }), [4, 1.2, 0.2], CH.RAM, 0.4);
    k.gallery(4, 24, -2, z + s * 8.6, 4, s, P.hull2);
    k.lamp(26, yC, z + s * 6, 0.3, s > 0 ? [0.4, 4.6, 1.0] : LAMP_RED, CH.NAV);
    // stern skid
    const wz = Math.min(48, mw + 22);
    k.add(fin([[-24, s * (mw + 3)], [-50, s * (mw + 4)], [-60, s * wz], [-46, s * wz]], -3, 2), P.hull2);
    k.add(fin([[-30, s * (mw + 4)], [-36, s * (mw + 4)], [-52, s * (wz - 0.5)], [-48, s * (wz - 0.5)]], -1.1, 0.16), P.pale);
    k.lamp(-53, -1.6, s * wz, 0.34, LAMP_AMBER, CH.STROBE);
  }
  yield;
  // --- bridge hood, engine block ---
  const yD = yB - 0.3;
  k.add(tbox(-22, -8.6, [yD, yD + 5, -6.6, 6.6], [yD, yD + 2.6, -5, 5], 0.6), P.hull2, { whole: true });
  k.dark(tbox(-9.6, -8.3, [yD + 3.2, yD + 4.4, -5.9, 5.9], [yD + 1.7, yD + 2.6, -4.8, 4.8]), PITCH, { mat: M.GLASS });
  k.em(tbox(-9.3, -8.1, [yD + 3.55, yD + 3.85, -5.2, 5.2], [yD + 2.05, yD + 2.3, -4.3, 4.3]), [3.2, 0.4, 0.1], CH.NAV);
  k.antennas(-18, yD + 5, 0, 4, 3, 6, { lean: 0.3 });
  k.radar(-17, yD + 5, v ? 3 : -3, 2.6, 0.0016);
  const yE = yB * 0.9;
  for (const s of [1, -1]) {
    // intake scoops and stacks on the block
    k.add(tbox(-52, -28, [yE - 1, yE + 4.6, s * 9, s * (mw + 2)], [yE - 1, yE + 2, s * 10, s * (mw + 1)], 0.6), P.hull2, { whole: true });
    k.em(box(-28, -27.8, yE + 0.2, yE + 1.7, s * 10.6, s * (mw + 0.4)), mul(P.glow, 0.45), CH.ACCENT);
    for (let i = 0; i < 3; i++) { k.metal(tbox(-36 - i * 5, -33 - i * 5, [yE + 4.6, yE + 7.5, s * 13 - 1.2, s * 13 + 1.2], [yE + 4.6, yE + 8.4, s * 13 - 0.9, s * 13 + 0.9]), HEAT, { whole: true }); k.em(box(-35.6 - i * 5, -33.6 - i * 5, yE + 8.2, yE + 8.3, s * 13 - 0.7, s * 13 + 0.7), [2.6, 0.7, 0.1], CH.ENGINE); }
    k.trench(-52, -30, yE + 0.02, s * 4.6, 0.8, mul(P.glow, 0.7));
  }
  belt(k, F, -22, -54, -4, 3, 1.2, [P.hull2, P.paint], { win: 0 });
  k.greebles(-54, -30, -7, 7, yE - 0.2, 12, 2.4, [DARK, P.hull2, P.hull]);
  for (const s of [1, -1]) { city(k, 10, 27, s * 8, s * (mw * 0.6), lerp(yA, yB, 0.5), P); city(k, -52, -30, s * 5.6, s * 8.4, yE, P); }
  // rivet-studded armour bosses along the spine
  for (let x = 24; x > -4; x -= 7) if (Math.abs(x) > 8) k.metal(prismY([[x + 2.4, 0], [x, 2.2], [x - 2.4, 0], [x, -2.2]], lerp(yA, yB, 0.5), lerp(yA, yB, 0.5) + 1.1, 0.6, x, 0), STEEL);
  k.engine(-66, 3.4, 0, 8.4, 11);
  for (const s of [1, -1]) k.engine(-65, -4.2, s * (mw - 5), 7.4, 10);
  if (v) for (const s of [1, -1]) k.engine(-61, 6, s * (mw - 1), 2.6, 5, { petals: 0 });
  k.add(rotX(fin([[-10, 0], [-44, 0], [-56, 9], [-30, 9]], -0.8, 1.6), -Math.PI / 2), P.hull2);
  if (!v) { // a dorsal armour crest and a ram horn over the bow
    k.add(move(rotX(fin([[-24, 0], [-50, 0], [-58, 12], [-44, 12]], -0.8, 1.6), Math.PI / 2), 0, yE, 0), P.paint);
    k.metal(tube([[48, yA * 0.7, 0, 2.4], [58, yA + 2, 0, 1.6], [66, yA + 3, 0, 0.06]], 5, { sx: 0.6 }), STEEL, { whole: true });
  }
  k.wound(46, 0, 6, 8); k.wound(-10, 4, -18, 10); k.wound(20, 4, 14, 9); k.wound(-40, 5, 10, 10);
  k.wound(10, 2, -pz, 8); k.wound(34, 5, -8, 7); k.wound(-48, 3, -14, 9); k.wound(-2, 9, 3, 8);
  k.blasts = [[-54, 4, 6], [-42, 8, -10], [-28, 8, 8], [-12, 8, -6], [4, 7, 10], [20, 5, -8], [38, 4, 4], [56, 0, 0]];
}

/* ------------------------------- LEVIATHAN ------------------------------- */
// Not built — grown. A lopsided carapace with one great scythe arm, a ring of teeth and a throat full of light.
function* leviathan(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, bio = { mat: M.BIO, crease: 55 }, R = k.R;
  const N = k.seg(22);
  // body: super-elliptic rings, bellied to port
  const st = [
    [61, 3, 2.4, 2.4, 2], [54, 8, yA * 0.62, 5.4, 1.6], [46, 12.5, yA * 0.92, 7.4, 1.2], [38, 16, yA + 0.5, 8.6, 0.8], [27, pz - 2, lerp(yA, yB, 0.5), 9.4, 0.2],
    [16, pz + 6.5, yB + 0.4, 10, -0.4], [0, pz + 6, yB + 0.6, 10.4, -1], [-16, pz + 1, yB * 1.22, 10.6, -1], [-32, 17, yB * 0.9, 8.6, 0], [-46, 10, 5, 5, 1], [-56, 5, 2.8, 2.6, 1.6], [-60, 2, 1.2, 1.2, 1.8],
  ];
  const ring = ([x, w, t, b, zo], kk = 1) => {
    const r = [];
    for (let j = 0; j < N; j++) { const a = (j / N) * TAU, c = Math.cos(a), s = Math.sin(a), e = 0.78, pw = (v) => Math.sign(v) * Math.pow(Math.abs(v), e); r.push([x, pw(s) * (s > 0 ? t : b) * kk, zo + pw(c) * w * kk]); }
    return r;
  };
  const dense = [];
  for (let i = 0; i < st.length - 1; i++) { const n = Math.ceil((st[i][0] - st[i + 1][0]) / 4.5); for (let j = 0; j < n; j++) dense.push(st[i].map((v, q) => lerp(v, st[i + 1][q], j / n))); }
  dense.push(st[st.length - 1]);
  k.cuts = [-24, 26];
  k.add(loft(dense.map((s) => ring(s))), P.hull, bio);
  k.decks(loft(dense.slice(1, -1).map((s) => ring(s, 0.86))));
  const at = (x) => { for (let i = 0; i < dense.length - 1; i++) if (x <= dense[i][0] && x >= dense[i + 1][0]) return dense[i]; return dense[x > 0 ? 0 : dense.length - 1]; };
  k.cuts.forEach((x, i) => { k.decks(fanX(ring(at(x - 0.7), 0.95)), { sec: i, whole: true }); k.decks(fanX(ring(at(x + 0.7), 0.95)), { sec: i + 1, whole: true }); });
  yield;
  // --- carapace: overlapping dorsal shields with a spine ridge ---
  for (let i = 0; i < 7; i++) {
    const xa = 44 - i * 14.5, xb = xa - 17, rs = [];
    for (const [x, lift] of [[xa, 0.5], [(xa + xb) / 2, 1.3], [xb, 2.6]]) {
      const s = at(clamp(x, -58, 60)), w = s[1] * 0.74, t = s[2] + lift, r = [];
      for (let j = 0; j <= 8; j++) { const a = lerp(0.12, Math.PI - 0.12, j / 8); r.push([x, Math.pow(Math.sin(a), 0.7) * t, s[4] + Math.cos(a) * w]); }
      for (let j = 8; j >= 0; j--) { const a = lerp(0.12, Math.PI - 0.12, j / 8); r.push([x, Math.pow(Math.sin(a), 0.7) * (t - 1.1) - 0.2, s[4] + Math.cos(a) * (w - 0.8)]); }
      rs.push(r);
    }
    if (xa < -52) break;
    // the shields make way for the mounts
    const clash = piv.some((p) => p[2] === 0 && p[0] < xa + 5 && p[0] > xb - 5);
    if (!clash) {
      k.add(loft(rs), i % 2 ? P.paint : P.hull2, { ...bio, whole: true, anim: [(R() - 0.5) * 6, 10 + R() * 8, (R() - 0.5) * 16, AN.PEEL, R() * 0.5] });
      const s = at(clamp(xb, -58, 60));
      k.add(tube([[xb + 6, s[2] + 1.6, s[4], 1.5], [xb + 1, s[2] + 4.5 + (i % 3), s[4], 0.8], [xb - 4, s[2] + 7 + (i % 3) * 1.5, s[4], 0.05]], 5), P.pale, { ...bio, whole: true });
    }
  }
  k.barbette(0, piv[0], 6.2, 7, P.hull2, M.BIO); if (piv[1]) k.barbette(1, piv[1], 6.4, 7, P.hull2, M.BIO);
  for (const ti of [2, 3]) if (piv[ti]) k.barbette(ti, piv[ti], 5.6, 7, P.hull2, M.BIO);
  yield;
  // --- the maw: teeth round a lit gullet, a cluster of eyes to starboard ---
  const mx = 58, my = -0.6, mz = 1.8;
  k.add(lathe([[mx + 2, 4.6], [mx - 2, 6.4], [mx - 8, 6.6]], 10, { y: my, z: mz, sy: 0.9 }), P.hull2, bio);
  k.dark(lathe([[mx + 2, 4.6], [mx - 3, 3.4], [mx - 3, 0.001]], 10, { y: my, z: mz, sy: 0.9, flip: true }), PITCH);
  k.em(lathe([[mx - 2.9, 0.001], [mx - 2.9, 3.3]], 10, { y: my, z: mz, sy: 0.9 }), mul(P.glow, 0.34), CH.BIO);
  k.em(lathe([[mx - 2.8, 0.001], [mx - 2.8, 3.2]], 10, { y: my, z: mz, sy: 0.9 }), mul(P.lens, 1.3), CH.LASER, 0.5);
  for (let j = 0; j < 9; j++) {
    const a = (j / 9) * TAU + 0.2, c = Math.cos(a), s = Math.sin(a), L = 6 + (j % 3) * 2.2;
    k.add(tube([[mx, my + s * 4.6, mz + c * 5.2, 1.3], [mx + L * 0.6, my + s * 5.2, mz + c * 5.8, 0.8], [mx + L, my + s * 3, mz + c * 3.4, 0.04]], 5), P.pale, { ...bio, whole: true, anim: [1.5, s * 2.6, c * 2.6, AN.LASER, 0] });
    k.em(ball(mx - 1, my + s * 4.9, mz + c * 5.5, 0.5, 5, 3), mul(P.lens, 1.1), CH.LASER, 0.1 + j * 0.08);
  }
  k.halo(mx + 2, my, mz, 12, mul(P.lens, 0.5), CH.LASER, 0.5);
  k.emitter = [mx + 3, my, mz];
  for (const [x, y, z, r] of [[49, 5.6, 8.5, 2.2], [45, 7.4, 11.5, 1.5], [52, 3.6, 10.6, 1.2], [43, 5.2, 14.2, 1.0], [48, 2.2, 12.6, 0.8]]) {
    k.add(ball(x - 0.3, y - 0.2, z, r * 1.25, 7, 4), P.hull2, bio);
    k.glass(ball(x + r * 0.3, y + r * 0.2, z + r * 0.2, r, 8, 5), PITCH, { crease: 60 });
    k.em(box(x + r * 1.18, x + r * 1.3, y - r * 0.3, y + r * 0.75, z + r * 0.08, z + r * 0.34), mul(P.glow, 0.5), CH.BIO);
  }
  // starboard mandibles
  for (let j = 0; j < 3; j++) {
    const z0 = 10 + j * 5, y0 = -3 - j * 0.6;
    k.add(tube([[40 - j * 5, y0, z0, 2.6 - j * 0.3], [50 - j * 3, y0 - 1.5, z0 + 5, 1.9], [59 - j * 4, y0 - 1, z0 + 2, 1.1], [64 - j * 5, y0 + 0.4, z0 - 4, 0.05]], 5), j % 2 ? P.paint : P.pale, { ...bio, whole: false });
  }
  yield;
  // --- the scythe arm (port) ---
  const sz = -(pz + 6);
  k.add(ball(8, 0.5, sz - 1, 7, 9, 5, 0.8), P.hull2, bio);
  k.add(tube([[8, 0.5, sz - 2, 5.4], [18, 3, sz - 9, 4.6], [29, 4.6, sz - 12, 3.6]], 7), P.hull, bio);
  k.add(ball(30, 4.8, sz - 12, 4.4, 8, 4), P.hull2, bio);
  const blade = [[30, 4.6, sz - 12, 3.4], [42, 3.2, sz - 11, 3.2], [53, 1, sz - 6, 2.6], [61, -1.6, sz + 3, 1.6], [65, -3.4, sz + 10, 0.06]];
  k.add(tube(blade, 4, { sx: 0.5, sy: 1.7, phase: Math.PI / 4 }), P.pale, { ...bio, crease: 20 });
  for (let j = 0; j < 4; j++) { const a = blade[j], b = blade[j + 1]; k.em(tube([[lerp(a[0], b[0], 0.1), a[1] - a[3] * 1.3, lerp(a[2], b[2], 0.1) + 0.6, 0.3], [lerp(a[0], b[0], 0.9), b[1] - b[3] * 1.3 - 0.1, lerp(a[2], b[2], 0.9) + 0.6, 0.24]], 4), mul(P.glow, 0.8), CH.BIO); }
  for (let j = 0; j < 6; j++) { const f = j / 6, i0 = Math.floor(f * 4), a = blade[i0], b = blade[i0 + 1], u = f * 4 - i0, x = lerp(a[0], b[0], u), y = lerp(a[1], b[1], u), z = lerp(a[2], b[2], u), r = lerp(a[3], b[3], u); k.add(tube([[x, y + r, z, 0.9], [x - 2, y + r + 3.4, z - 1, 0.05]], 4), P.hull2, bio); }
  // --- starboard: a ribbed fin; port: trailing feelers ---
  const fz = pz + 5;
  for (let j = 0; j < 5; j++) {
    const x0 = 6 - j * 9, tipx = x0 - 22 - j * 3, tipz = Math.min(49, fz + 20 - j * 2.4);
    k.add(tube([[x0, 1, fz - 2, 1.8], [x0 - 8, 2.4, fz + 9, 1.3], [tipx, 1, tipz, 0.05]], 5), P.pale, { ...bio, whole: true });
    if (j < 4) k.add(prismY([[x0 - 1, fz - 1], [x0 - 9, fz - 1], [tipx - 3 - 1, Math.min(49, fz + 17.6 - j * 2.4)], [tipx, tipz]], 0.9, 1.4), P.paint, { mat: M.BIO, whole: true });
  }
  for (let j = 0; j < 4; j++) k.add(tube([[-6 - j * 9, -3, sz + 4, 1.6], [-20 - j * 9, -6, sz - 5 - j, 1.0], [-38 - j * 6, -4, sz - 3 + j * 3, 0.05]], 5), P.pale, { ...bio, whole: true });
  yield;
  // --- tails and thrust sacs, belly ribs, pores ---
  for (const [z, y, r, L] of [[2, 0, 5.6, 0], [14, -1, 3.6, 4], [-12, 1, 3.6, 6]]) {
    const x = -58 + L;
    k.add(lathe([[x + 9, r * 0.8], [x + 3, r * 1.2], [x, r * 1.02], [x + 1, r * 0.8], [x + 4, r * 0.5]], 9, { y, z }), P.hull2, bio);
    k.em(lathe([[x + 4, 0.001], [x + 4, r * 0.5], [x + 1, r * 0.8]], 9, { y, z, flip: true }), mul(P.glow, 0.9), CH.ENGINE);
    k.glowCone(x + 2, r * 0.7, mul(P.glow, 0.3), x - r * 2.6, r * 0.2, [0, 0, 0], y, z, 9, CH.ENGINE);
    k.nozzles.push({ x, y, z, r: r * 0.9 });
    for (let j = 0; j < 3; j++) { const a = j * 2.1 + z; k.add(tube([[x + 5, y + Math.sin(a) * r, z + Math.cos(a) * r, 1.1], [x - 8, y + Math.sin(a) * r * 1.6, z + Math.cos(a) * r * 1.6, 0.7], [x - 20 + L * 0.5, y + Math.sin(a) * r * 0.8, z + Math.cos(a) * r * 2.2, 0.04]], 4), P.pale, { ...bio, whole: true }); }
  }
  for (let i = 0; i < 8; i++) {
    const x = 34 - i * 9, s = at(x), w = s[1] * 0.86, pts = [];
    for (let j = 0; j <= 6; j++) { const a = lerp(-0.25, Math.PI + 0.25, j / 6); pts.push([x, -Math.pow(Math.max(0, Math.sin(a)), 0.7) * (s[3] + 0.9) + (Math.sin(a) < 0 ? 1.5 : 0), s[4] + Math.cos(a) * w, 0.9]); }
    k.add(tube(pts, 4), P.pale, { ...bio, whole: true });
  }
  for (let i = 0; i < 26; i++) {
    const x = 44 - i * 3.6, s = at(x);
    for (const sd of [1, -1]) { const z = s[4] + sd * s[1] * 0.985; k.em(ball(x, 0.6, z, 0.38, 4, 2), mul(P.glow, i % 5 === 0 ? 1.4 : 0.6), CH.BIO); }
  }
  // gill slits: slanted vents that breathe light
  for (const sd of [1, -1]) for (let i = 0; i < 7; i++) {
    const x = 30 - i * 6.4, s = at(x), z = s[4] + sd * s[1] * 0.93, y0 = -s[3] * 0.34, y1 = s[2] * 0.3;
    k.dark(loft([[[x + 1.9, y1, z + sd * 0.25], [x + 0.9, y1, z + sd * 0.5], [x - 1.5, y0, z + sd * 0.5], [x - 0.5, y0, z + sd * 0.25]], [[x + 1.9, y1, z - sd * 1], [x + 0.9, y1, z - sd * 1], [x - 1.5, y0, z - sd * 1], [x - 0.5, y0, z - sd * 1]]]), PITCH);
    k.em(loft([[[x + 1.6, y1 - 0.3, z + sd * 0.56], [x + 1.2, y1 - 0.3, z + sd * 0.6], [x - 1.2, y0 + 0.3, z + sd * 0.6], [x - 0.8, y0 + 0.3, z + sd * 0.56]], [[x + 1.6, y1 - 0.3, z], [x + 1.2, y1 - 0.3, z], [x - 1.2, y0 + 0.3, z], [x - 0.8, y0 + 0.3, z]]]), mul(P.glow, 0.5), CH.SEAM, 0, { whole: true });
  }
  // crown of horns over the head, lateral spines down the back
  for (const sd of [1, -1]) {
    for (let j = 0; j < 3; j++) k.add(tube([[40 - j * 5, yA * 0.8, 1 + sd * (6 + j * 3), 1.9 - j * 0.3], [47 - j * 4, yA + 5 + j * 2, 1 + sd * (8 + j * 4), 1.2], [57 - j * 5, yA + 6 + j * 3.4, 1 + sd * (7 + j * 4.6), 0.05]], 5), P.pale, { ...bio, whole: true });
    for (let i = 0; i < 9; i++) { const x = 26 - i * 8, s = at(x), z = s[4] + sd * s[1] * 0.72, y = s[2] * 0.62; k.add(tube([[x + 1, y, z, 1.25], [x - 2.6, y + 3.4, z + sd * 2.6, 0.6], [x - 6.6, y + 4.6, z + sd * 4.6, 0.04]], 4), i % 3 ? P.hull2 : P.pale, { ...bio, whole: true }); }
  }
  k.bays.push([20, -8, 0]);
  k.wound(22, 5, 10, 9); k.wound(-24, 5, -12, 10); k.wound(44, 4, -6, 7); k.wound(0, 3, pz, 9);
  k.wound(-42, 3, 4, 8); k.wound(14, 3, -pz - 4, 9); k.wound(34, 5, 6, 7); k.wound(-10, 9, 0, 9);
  k.blasts = [[-52, 2, 2], [-38, 5, -6], [-24, 8, 8], [-8, 9, -10], [8, 9, 12], [22, 7, -14], [38, 6, 4], [52, 2, 0]];
}

/* -------------------------------- CITADEL -------------------------------- */
// MEGA. A fortress of seven armour masses bolted round a reactor; the seams between them glow with what is inside.
function* citadel(k, G) {
  const P = G.pal, { yA, yB, yC, pz, piv } = G, v = Math.floor(G.level / 5) % 2, GOLD = P.gold;
  const seam = mul(P.glow, 1.0), zo = pz + 9, yD = yB - 0.3;
  k.nShell = 7; k.cuts = [];
  k.turSec = [6, 5, 4, 3];
  // 5 — the keep: spine block with the crown of towers
  k.sec = 5;
  const F = hullLoft([
    { x: 31, w: 9, t: yA - 0.3, b: 9, dk: 0.7, ws: 0.96 }, { x: 28, w: 12.6, t: lerp(yA, yB, 0.5), b: 11, dk: 0.7, ws: 0.96 }, { x: 9, w: 12.8, t: lerp(yA, yB, 0.5), b: 12, dk: 0.7, ws: 0.96 },
    { x: 7.6, w: 12.8, t: yD, b: 12, dk: 0.7, ws: 0.96 }, { x: -38, w: 12.8, t: yD, b: 12, dk: 0.7, ws: 0.96 }, { x: -41, w: 11, t: yD * 0.8, b: 9, dk: 0.7, ws: 0.96 },
  ]);
  k.add(F.tris, P.hull, { win: 150 });
  k.decks(F.inner(0.84));
  dressHull(k, F, 28, -40, P, { keep: (x) => x < 8, flak: false });
  for (const s of [1, -1]) { city(k, 10, 27, s * 5.6, s * 8.4, lerp(yA, yB, 0.5), P); city(k, -40, -9.5, s * 9.9, s * 8.5, yD, P); }
  if (piv[1]) k.barbette(1, piv[1], 6.4);
  k.add(tbox(-36, -9, [yD, yD + 5, -8, 8], [yD, yD + 4, -6.6, 6.6], 0.6), P.hull2, { win: 220 });
  k.metal(box(-36.4, -8.6, yD + 4.4, yD + 5, -8.4, 8.4), GOLD, { whole: true });
  const tw = k.tower(-21, yD + 5, 0, { l: 14, w: 9, h: 15 + v * 3, tiers: 4, col: P.hull, col2: P.hull2, mast: 10 });
  for (const s of [1, -1]) {
    k.tower(-31, yD + 5, s * 5, { l: 6, w: 4.4, h: 9, tiers: 3, col: P.hull2, col2: P.hull, mast: 6 });
    k.tower(-11.5, yD + 5, s * 5.2, { l: 4.6, w: 3.6, h: 6, tiers: 2, col: P.hull2, col2: P.hull, mast: 4 });
    k.trench(-40, 6, yD + 0.02, s * 9.4, 0.7, seam, CH.SEAM);
    k.add(box(11, 27, lerp(yA, yB, 0.5), lerp(yA, yB, 0.5) + 2.6, s * 3 - 2.2, s * 3 + 2.2, 0.3), P.hull2, { win: 220 });
  }
  k.radar(tw.x + 1, tw.top, 3, 3.8, 0.001); k.rot[k.rot.length - 1].sec = 5;
  k.antennas(-36, yD + 5, 0, 6, 3, 8, { lean: 0.2 });
  // reactor well under the keep: the core's light through a ribbed belly dome
  k.add(ball(-4, -11, 0, 8.6, k.seg(14), 6, 0.7), seam, { mat: M.PLASMA, ch: CH.CORE, crease: 60 });
  for (let j = 0; j < 8; j++) { const a = (j / 8) * TAU; k.metal(tube([[-4 + Math.cos(a) * 9.4, -10.6, Math.sin(a) * 9.4, 0.9], [-4 + Math.cos(a) * 7.4, -15.4, Math.sin(a) * 7.4, 0.8], [-4, -17.6, 0, 0.6]], 4), GOLD, { whole: true }); }
  k.metal(latheY([[-10.4, 10.4], [-11.6, 9.6], [-11.6, 8.8]], k.seg(14), -4, 0), GUN);
  k.halo(-4, -15, 0, 13, mul(seam, 0.2), CH.CORE);
  yield;
  // 1..4 — the four bastions
  const bastion = (sec, s, fore) => {
    k.sec = sec;
    const x0 = fore ? 46 : -3, x1 = fore ? 3 : -52, zi = s * 13.6, z = s * pz, top = fore ? yC - 0.3 : yC + 1.2;
    const xin = fore ? x0 - 12 : x0, xout = fore ? x1 : x1 + 10;
    // main mass: an armoured slab, chamfered outboard, cut back toward the bow / stern
    const sect = (x, k1) => [[x, -9 * k1, zi], [x, top + 2.2, zi], [x, top + 2.2, s * (pz - 8)], [x, top, s * (pz - 7.4)], [x, top, s * (zo - 1) * k1 + zi * (1 - k1)], [x, top - 4, s * (zo + 4) * k1 + zi * (1 - k1)], [x, -4.6 * k1, s * (zo + 4) * k1 + zi * (1 - k1)], [x, -9 * k1, s * (pz - 2) * k1 + zi * (1 - k1)]];
    k.add(loft(fore ? [sect(x0, 0.42), sect(xin, 1), sect(x1, 1)] : [sect(x0, 1), sect(xout, 1), sect(x1, 0.6)]), P.hull, { win: 170 });
    k.decks(loft([sect(lerp(x0, x1, 0.2), 0.8), sect(lerp(x0, x1, 0.8), 0.8)].map((r) => r.map((p) => [p[0], p[1] * 0.8, lerp(s * pz, p[2], 0.8)]))));
    // gilded edge, livery slab, glowing seam against the keep
    k.metal(box(Math.min(xin, xout) + 1, Math.max(x1, x0 === xin ? x0 : xin) - 1, top - 0.1, top + 0.5, s * (zo - 1.6), s * (zo - 0.6)), GOLD, { whole: false });
    k.add(box(lerp(xin, xout, 0.5) - 9, lerp(xin, xout, 0.5) + 9, top - 3.6, top - 0.8, s * (zo + 2.2) - 0.5, s * (zo + 2.2) + 0.5), P.paint, { anim: [0, 4, s * 14, AN.PEEL, 0.2], whole: true });
    k.em(box(Math.min(x0, x1) + 2, Math.max(x0, x1) - 2, top + 2.2, top + 2.3, zi + s * 0.1, zi + s * 0.7), seam, CH.SEAM);
    for (const yy of [top - 0.4, -2.2]) k.em(box(fore ? x1 - 0.4 : x0 + 0.1, fore ? x1 - 0.1 : x0 + 0.4, yy - 0.3, yy, s * 15, s * (zo + 2)), seam, CH.SEAM);
    const ti = fore ? (s > 0 ? 2 : 3) : -1;
    if (fore && piv[ti]) k.barbette(ti, piv[ti], 5.6);
    if (fore) {
      // bastion face toward the enemy: a hangar mouth and gun ports
      hangarWall(k, xin + 0.3, 3, -4, top - 0.4, s > 0 ? pz - 5 : -(zo - 1), s > 0 ? zo - 1 : -(pz - 5), [{ y0: -2.6, y1: top - 2.4, z0: s > 0 ? pz - 3.4 : -(zo - 2.6), z1: s > 0 ? zo - 2.6 : -(pz - 3.4) }], P.hull2);
      k.gallery(6, 30, -1.4, s * (zo + 4), 5, s, P.hull2);
      k.greebles(24, 32, s * (pz - 6), s * (pz + 6), top, 5, 2, [P.hull2, DARK, GOLD]);
    } else {
      k.tower(-30, top, s * (pz + 1), { l: 9, w: 6, h: 8 + v * 2, tiers: 3, col: P.hull, col2: P.hull2, mast: 6 });
      k.gallery(-44, -10, -1.4, s * (zo + 4), 6, s, P.hull2);
      k.greebles(-22, -6, s * (pz - 6), s * (pz + 7), top, 9, 2.6, [P.hull2, DARK, P.hull]);
      k.antennas(-44, top, s * pz, 5, 4, 8);
      // corner spire reaching for the hitbox edge
      const wz = Math.min(50, zo + 13);
      k.add(fin([[-18, s * (zo + 3)], [-44, s * (zo + 3)], [-56, s * wz], [-44, s * wz]], -2.4, 1.8), P.hull2);
      k.metal(fin([[-24, s * (zo + 3.4)], [-29, s * (zo + 3.4)], [-49, s * (wz - 0.4)], [-46, s * (wz - 0.4)]], -0.5, 0.16), GOLD);
      k.lamp(-50, -1, s * wz, 0.36, s > 0 ? [0.4, 4.6, 1.0] : LAMP_RED, CH.NAV);
    }
    for (let i = 0; i < 3; i++) k.strip(lerp(xin, xout, 0.2 + i * 0.3) - 2, lerp(xin, xout, 0.2 + i * 0.3) + 2, top, s * (pz + 5.4), s * (pz + 6), seam, CH.ACCENT);
    // battlements along the outer parapet and the inner step, buttresses down the wall
    const xa = Math.max(xin, xout) - 1.5, xb = Math.min(xin, xout) + 1.5;
    for (let x = xa; x > xb; x -= 2.2) {
      k.add(box(x - 0.7, x + 0.7, top, top + 1.0, s * (zo - 1.5) - 0.45, s * (zo - 1.5) + 0.45), P.hull2, { whole: true });
      if (Math.round(x) % 2) k.add(box(x - 0.6, x + 0.6, top + 2.2, top + 3.0, s * (pz - 8.5) - 0.4, s * (pz - 8.5) + 0.4), P.hull2, { whole: true });
    }
    for (let x = xa - 1; x > xb; x -= 6.5) {
      k.add(loft([[[x - 0.7, top - 4, s * (zo + 3.9)], [x + 0.7, top - 4, s * (zo + 3.9)], [x + 0.7, -4.6, s * (zo + 3.9)], [x - 0.7, -4.6, s * (zo + 3.9)]], [[x - 0.5, top - 4.6, s * (zo + 4.5)], [x + 0.5, top - 4.6, s * (zo + 4.5)], [x + 0.5, -4.4, s * (zo + 5.6)], [x - 0.5, -4.4, s * (zo + 5.6)]]]), P.hull2, { whole: true });
      k.em(box(x - 0.25, x + 0.25, -3.9, -3.5, s * (zo + 5.3) - 0.1, s * (zo + 5.3) + 0.1), seam, CH.ACCENT);
      flak(k, x + 3, top + 0.2, s * (zo - 3.6), s);
    }
    city(k, xb, xa, s * (pz + 6.6), s * (zo - 2.4), top, P, 0.8);
    // corner keep
    const cx = fore ? xin - 3.5 : xout + 3.5;
    k.tower(cx, top, s * (zo - 4.6), { l: 4.4, w: 4.4, h: 5.5, tiers: 2, col: P.hull2, col2: P.hull, mast: 4 });
    for (const yy of [-3.6, -1.6]) k.em(box(xb, xa, yy, yy + 0.2, s * (zo + 4.02) - 0.06, s * (zo + 4.02) + 0.06), mul(WINDOW_GLASS, 0.3), CH.NAV);
  };
  bastion(1, -1, false); bastion(2, 1, false);
  yield;
  bastion(3, -1, true); bastion(4, 1, true);
  yield;
  // 6 — the prow: twin rams round the great lens
  k.sec = 6;
  for (const s of [1, -1]) {
    k.add(loft([ringRect(66, -1.6, 1.8, s * 6.4, s * 9.4, 0.4), ringRect(54, -5, 4.6, s * 4.4, s * 12, 1), ringRect(32, -8, yA - 0.3, s * 4.2, s * 12.6, 1)]), P.hull, { win: 130 });
    k.decks(loft([ringRect(54, -4, 3.6, s * 5.4, s * 11), ringRect(33, -7, yA - 1.3, s * 5.2, s * 11.6)]));
    k.metal(box(34, 56, yA * 0.42, yA * 0.42 + 0.7, s * 12.2, s * 13), GOLD);
    for (let i = 0; i < 5; i++) k.em(box(35 + i * 4, 37.6 + i * 4, -1, 0.6, s * 4.1, s * 4.25), mul(P.lens, 0.9), CH.LASER, 0.05 + i * 0.14);
    k.lamp(65.6, 2.2, s * 7.9, 0.34, LAMP_WHITE, CH.STROBE);
    k.em(box(31.6, 31.9, -1, -0.5, s * 5, s * 12), seam, CH.SEAM);
  }
  k.add(box(31.5, 44.5, yA - 2.4, yA - 0.3, -12.6, 12.6, 0.5), P.hull2);
  k.metal(box(43.8, 44.7, yA - 2.5, yA - 0.2, -12.8, 12.8), GOLD);
  k.barbette(0, piv[0], 6.2);
  k.lens(47, -2.6, 0, 3.4, P.lens, { n: 8 });
  k.emitter = [52, -2.6, 0];
  // 0 — the engine bank
  k.sec = 0;
  const ew = Math.min(38, zo + 2);
  k.add(loft([ringRect(-40, -10, yD * 0.86, -ew * 0.8, ew * 0.8, 3), ringRect(-52, -10.6, yD * 0.8, -ew, ew, 3.4), ringRect(-60, -9, yD * 0.6, -ew * 0.94, ew * 0.94, 3)]), P.hull2, { win: 150 });
  k.decks(loft([ringRect(-41, -8, yD * 0.7, -ew * 0.7, ew * 0.7, 2), ringRect(-58, -8, yD * 0.5, -ew * 0.84, ew * 0.84, 2)]));
  k.metal(box(-60.4, -59.6, yD * 0.6 - 1, yD * 0.6, -ew * 0.86, ew * 0.86), GOLD);
  k.em(box(-39.9, -39.6, 0, 0.5, -ew * 0.7, ew * 0.7), seam, CH.SEAM);
  k.engine(-67, -1.4, 0, 8.4, 11);
  for (const s of [1, -1]) { k.engine(-65, -1.6, s * ew * 0.47, 6, 9); k.engine(-63, -1.6, s * ew * 0.82, 3.8, 7, { petals: 6 }); }
  k.greebles(-58, -44, -ew * 0.7, ew * 0.7, yD * 0.72, 10, 2.4, [P.hull, DARK, P.hull2]);
  k.add(move(rotX(fin([[-40, 0], [-52, 0], [-62, 11], [-54, 11]], -0.6, 1.2), Math.PI / 2), 0, yD * 0.7, 0), P.paint);
  k.sec = -1;
  k.wound(20, 4, pz, 9); k.wound(-26, 6, -pz, 10); k.wound(44, 2, 8, 7); k.wound(-8, 9, 4, 9);
  k.wound(-48, 4, 12, 9); k.wound(18, 4, -pz, 9); k.wound(-24, 5, pz, 9); k.wound(40, 3, -8, 7);
  k.blasts = [[-52, 4, 10], [-34, 8, -pz], [-16, 12, 4], [0, 6, pz], [14, 6, -pz], [26, 8, 2], [42, 4, -8], [54, 2, 8]];
  yield;
  yield* heroCore(k, G);
}

// The reactor core a MEGA fights on with: plasma in an armoured cage, four beam emitters on the equator, three orbiting rings.
// Built in hull units about the origin, ±56 across with everything deployed.
function* heroCore(k, G) {
  const P = G.pal, GOLD = P.gold, plasma = mul(P.glow, 0.85), n = k.seg(6);
  k.use('core');
  for (let qd = 0; qd < 4; qd++) {
    k.sec = qd;
    const a0 = -Math.PI / 4 + qd * Math.PI / 2, a1 = a0 + Math.PI / 2, mid = (a0 + a1) / 2;
    const ro = (t) => rotY(t, -mid); // template is built facing +X, then turned to its quadrant
    // plasma
    const prof = []; for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; prof.push([Math.cos(a) * 19, Math.max(0.001, Math.sin(a) * 19)]); }
    k.add(rotY(latheY(prof, n, 0, 0, { a0: Math.PI / 4, a1: Math.PI * 3 / 4 }), -mid + Math.PI / 2), plasma, { mat: M.PLASMA, ch: CH.CORE, crease: 60 });
    // cage plates north and south: thick shells with gaps on the equator and the meridians
    for (const ns of [1, -1]) {
      const band = (la0, la1, ri, roo, az, off = 0) => {
        const pr = [[Math.sin(la1) * roo * ns, Math.cos(la1) * roo], [Math.sin(la0) * roo * ns, Math.cos(la0) * roo], [Math.sin(la0) * ri * ns, Math.cos(la0) * ri], [Math.sin(la1) * ri * ns, Math.cos(la1) * ri], [Math.sin(la1) * roo * ns, Math.cos(la1) * roo]];
        return rotY(latheY(ns > 0 ? pr : pr.slice().reverse(), n, 0, 0, { a0: Math.PI / 2 - az + off, a1: Math.PI / 2 + az + off }), -mid + Math.PI / 2);
      };
      for (const sd of [1, -1]) k.add(band(0.3, 0.7, 21.4, 24, 0.27, sd * 0.42), P.hull, { win: 0, anim: [0, ns * 3, 0, AN.DEPLOY, 0.6] });
      k.add(band(0.76, 1.12, 21.2, 23.4, 0.66), qd % 2 ? P.paint : P.hull2);
      k.metal(band(1.16, 1.5, 21, 22.6, Math.PI / 4), GOLD);
      k.em(band(0.71, 0.75, 22.4, 23, 0.6), mul(P.glow, 0.7), CH.SEAM);
      // meridian rib over the gap between the plates
      k.metal(band(0.12, 1.2, 23.6, 25, 0.05), GUN);
      // pole spire
      if (qd === 0) { k.sec = ns > 0 ? 0 : 2; k.metal(tube([[0, ns * 22, 0, 3], [0, ns * 31, 0, 1.3], [0, ns * 44, 0, 0.06]], 6), GUN); k.metal(latheY([[ns > 0 ? 27 : -25, 4.6], [ns > 0 ? 26 : -26, 5.4], [ns > 0 ? 25 : -27, 4.6]], 8), GOLD); k.lamp(0, ns * 44.4, 0, 0.3, LAMP_RED, CH.BEACON); k.sec = qd; }
    }
    // equator ring segment and the beam emitter riding on it
    k.metal(ro(torusY(0, 0, 0, 27, 2.6, 2.2, n * 2, -Math.PI / 4, Math.PI / 4)), GUN);
    k.em(ro(torusY(0, 0, 0, 29.4, 0.3, 0.5, n * 2, -0.6, 0.6)), mul(P.glow, 0.8), CH.SEAM);
    k.add(ro(tbox(24, 36, [-4, 4, -5.2, 5.2], [-2.8, 2.8, -3.4, 3.4], 0.7)), P.hull2, { whole: true });
    k.metal(ro(box(31, 32.2, -3.7, 3.7, -4.6, 4.6, 0.6)), GOLD);
    for (const s of [1, -1]) {
      k.metal(ro(tbox(35, 46, [-1.6, 1.6, s * 2.4, s * 4], [-0.6, 0.6, s * 1.6, s * 2.3])), STEEL, { anim: [Math.cos(mid) * 3, 0, Math.sin(mid) * 3, AN.DEPLOY, 0.5], whole: true });
      k.metal(ro(tbox(35, 44, [s * 2.4, s * 4, -1.3, 1.3], [s * 1.6, s * 2.3, -0.5, 0.5])), STEEL, { anim: [Math.cos(mid) * 3, 0, Math.sin(mid) * 3, AN.DEPLOY, 0.5], whole: true });
      // diagonal armour spike
      k.add(ro(rotY(tube([[25, 0, 0, 3.4], [36, 0, 0, 2.2], [50, 0, 0, 0.08]], 4, { sy: 0.6 }), s * Math.PI / 4)), s > 0 ? P.paint : P.hull2, { whole: true });
    }
    k.em(ro(lathe([[36, 0.001], [36.5, 1.8], [36, 2.7]], 8, { flip: true })), mul(P.lens, 0.22), CH.STATIC);
    k.em(ro(lathe([[36.1, 0.001], [36.6, 1.8], [36.1, 2.7]], 8, { flip: true })), mul(P.lens, 1.5), CH.BEAM, 0.3);
    { const c = Math.cos(mid), s = Math.sin(mid); k.halo(c * 38, 0, s * 38, 9, mul(P.lens, 0.4), CH.BEAM, 0.3); }
    for (let i = 0; i < 4; i++) k.em(ro(box(25 + i * 2.4, 26.4 + i * 2.4, 4.02, 4.1, -1.1, 1.1)), mul(P.lens, 1.0), CH.BEAM, 0.1 + i * 0.2);
  }
  k.sec = -1;
  yield;
  // orbiting rings
  const ringDef = [[47.5, 1.5, 1.0, 0.0011, [0.3, 0.1]], [53, 1.1, 1.5, -0.0008, [-0.2, -0.42]], [32.5, 1.2, 0.8, 0.0019, [1.25, 0.5]]];
  ringDef.forEach(([Rr, a, b, speed, tilt], i) => {
    const name = 'rot' + k.rot.length;
    k.use(name);
    k.metal(torusY(0, 0, 0, Rr, a, b, k.seg(40)), i === 1 ? GOLD : GUN);
    const ns = i === 1 ? 6 : 8;
    for (let j = 0; j < ns; j++) {
      const an = (j / ns) * TAU, c = Math.cos(an), s = Math.sin(an);
      k.add(rotY(box(Rr - a - 0.6, Rr + a + 0.9, -b - 0.5, b + 0.5, -2.6, 2.6, 0.4), -an), i === 2 ? P.paint : P.hull2, { whole: true });
      k.em(rotY(box(Rr + a + 0.9, Rr + a + 1.0, -b * 0.5, b * 0.5, -1.8, 1.8), -an), mul(P.glow, 1.0), CH.SEAM);
      if (j % 2 === 0) k.halo(c * (Rr + a + 1.4), 0, s * (Rr + a + 1.4), 4, mul(P.glow, 0.3), CH.SEAM);
    }
    k.rot.push({ name, pivot: [0, 0, 0], axis: 'y', speed, core: true, tilt });
  });
  k.use('hull');
  k.coreInfo = { wounds: [[17, 12, 12, 10], [-15, -10, 15, 10], [12, 6, -19, 10], [-20, 10, -10, 10], [22, -8, -5, 9], [-5, 18, 12, 9]], emitters: 4 };
}

const DESIGNS = { dreadnought, lance, carrier, ram, leviathan, citadel };


/* ========================================================================== */
/*  Runtime                                                                   */
/* ========================================================================== */

const SEC_Q = [0.42, 0.56, 0.68]; // when each cut lets go during the death sequence (stern first)

export class Bosses3D {
  constructor(THREE, { fx = null, quality = 1 } = {}) {
    this.THREE = THREE; this.fx = fx; this.q = quality;
    this._proto = null; this._job = null; this._live = new Set();
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._m = new THREE.Matrix4(); this._ax = new THREE.Vector3();
    this._fire = { scale: 1, light: false }; // the one mutable fx option set (fire trails vary in size)
    this.stats = null;
  }

  static classOf(level, mega = level % 5 === 0) {
    if (mega) return 'citadel';
    if (level % 3 === 0) return 'carrier';
    if (level % 4 === 0) return 'ram';
    // the rest of the line rotates through the three other hulls
    let n = 0;
    for (let l = 1; l < level; l++) if (l % 5 && l % 3 && l % 4) n++;
    return ['dreadnought', 'lance', 'leviathan'][n % 3];
  }

  /* ------------------------------ materials ------------------------------ */

  _uniforms() {
    const T = this.THREE, w = [];
    for (let i = 0; i < 8; i++) w.push(new T.Vector4(0, 0, 0, 0));
    return {
      uBT: { value: 0 }, uBS: { value: new T.Vector4(0, 0, 0, 0) }, uBK: { value: new T.Vector4(1, 0, 0, 0.3) },
      uBWound: { value: w }, uBTear: { value: new Float32Array(8) }, uBLv: { value: new Float32Array(CH.N) },
      uBAn: { value: new Float32Array(AN.N) }, uBArr: { value: new T.Vector3(0, 0, 66) }, uBAcc: { value: new T.Vector3(1, 1, 1) },
    };
  }
  _hullMat(U) {
    const T = this.THREE;
    const mat = new T.MeshStandardMaterial({ vertexColors: true, side: T.DoubleSide, metalness: 1, roughness: 1 });
    mat.onBeforeCompile = (sh) => {
      for (const k in U) sh.uniforms[k] = U[k];
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + HULL_VERT_HEAD)
        .replace('#include <begin_vertex>', HULL_VERT_BEGIN);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + HULL_FRAG_HEAD)
        .replace('#include <color_fragment>', HULL_FRAG_COLOR)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = bRough;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = bMetal;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += bEmis;');
    };
    mat.customProgramCacheKey = () => 'b3d-hull1';
    return mat;
  }
  _glowMat(U) {
    const T = this.THREE;
    return new T.ShaderMaterial({
      uniforms: { uBLv: U.uBLv, uBArr: U.uBArr, uBT: U.uBT }, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, transparent: true, fog: false,
    });
  }
  // one mesh of each program, for the integrator's own warm-up pass
  sample() {
    const T = this.THREE, U = this._uniforms(), g = new T.Group();
    const k = new Kit(this.q, makeRng(1));
    k.add(box(-1, 1, -1, 1, -1, 1), [0.5, 0.5, 0.5]); k.halo(0, 0, 0, 1, [1, 1, 1]);
    const geo = finalize(T, k.bufs.get('hull'), [], null)[0];
    g.add(new T.Mesh(geo.geo, this._hullMat(U)), new T.Mesh(geo.glow, this._glowMat(U)));
    g.userData.dispose = () => { geo.geo.dispose(); geo.glow.dispose(); };
    return g;
  }
  // compile both programs against the CURRENT render target. `scene` supplies the lights and environment the
  // programs are keyed on; without it the result only matches a scene with the same light set-up.
  warmup(renderer, camera, scene = null) {
    if (!renderer || !renderer.compile) return;
    const s = this.sample();
    try {
      if (scene) renderer.compile(s, camera, scene);
      else { const sc = new this.THREE.Scene(); sc.add(s); renderer.compile(sc, camera); }
    } catch (e) { /* best effort */ }
    s.userData.dispose();
  }

  /* -------------------------------- build -------------------------------- */

  // Heavy geometry build, cached per level. Sliced: returns true once the boss is ready.
  prepare(level, gen, { mega = level % 5 === 0 } = {}) {
    const key = level + (mega ? 'M' : '') + '@' + this.q;
    if (this._proto && this._proto.key === key) return true;
    if (!this._job || this._job.key !== key) this._job = { key, it: buildSteps(this.THREE, this.q, level, gen, mega, key) };
    const r = this._job.it.next();
    if (!r.done) return false;
    const old = this._proto;
    this._proto = r.value; this._job = null;
    if (old) { old.orphan = true; if (old.refs <= 0) disposeProto(old); }
    this.stats = this._proto.stats;
    return true;
  }

  build(level, gen, opts = {}) {
    while (!this.prepare(level, gen, opts)) { /* finish synchronously */ }
    const g = instance(this, this._proto);
    this._live.add(g);
    return g;
  }

  info() { return this.stats; }

  dispose() {
    for (const g of [...this._live]) g.userData.dispose();
    if (this._proto) { disposeProto(this._proto); this._proto = null; }
    this._job = null;
  }
}

function disposeProto(p) {
  if (p.gone) return;
  p.gone = true;
  for (const g of p.geos) g.dispose();
}

// buffer → BufferGeometry list. cuts: ascending x of the section cuts (section 0 = stern). secOf overrides with explicit ids.
function finalize(T, b, cuts, nSec) {
  const n = b.key.length, gn = b.gkey.length, ns = nSec ?? cuts.length + 1;
  const secIdx = (key, ex) => { if (ex >= 0) return Math.min(ns - 1, ex); let s = 0; for (let i = 0; i < cuts.length; i++) if (key > cuts[i]) s = i + 1; return s; };
  const count = new Int32Array(ns), gcount = new Int32Array(ns), of = new Uint8Array(n), gof = new Uint8Array(gn);
  for (let f = 0; f < n; f++) count[(of[f] = secIdx(b.key[f], b.sec[f]))]++;
  for (let f = 0; f < gn; f++) gcount[(gof[f] = secIdx(b.gkey[f], b.gsec[f]))]++;
  const out = [];
  for (let s = 0; s < ns; s++) {
    const m = count[s] * 3, pos = new Float32Array(m * 3), nrm = new Int8Array(m * 3), col = new Float32Array(m * 3), prm = new Uint8Array(m * 4), anm = new Int16Array(m * 4);
    let w = 0, cx = 0, cy = 0, cz = 0, r2 = 0;
    for (let f = 0; f < n; f++) {
      if (of[f] !== s) continue;
      for (let v = 0; v < 3; v++, w++) {
        const i = (f * 3 + v);
        pos[w * 3] = b.pos[i * 3]; pos[w * 3 + 1] = b.pos[i * 3 + 1]; pos[w * 3 + 2] = b.pos[i * 3 + 2];
        cx += pos[w * 3]; cy += pos[w * 3 + 1]; cz += pos[w * 3 + 2];
        nrm[w * 3] = Math.round(b.nrm[i * 3] * 127); nrm[w * 3 + 1] = Math.round(b.nrm[i * 3 + 1] * 127); nrm[w * 3 + 2] = Math.round(b.nrm[i * 3 + 2] * 127);
        col[w * 3] = b.col[i * 3]; col[w * 3 + 1] = b.col[i * 3 + 1]; col[w * 3 + 2] = b.col[i * 3 + 2];
        prm[w * 4] = b.prm[i * 4]; prm[w * 4 + 1] = b.prm[i * 4 + 1]; prm[w * 4 + 2] = b.prm[i * 4 + 2]; prm[w * 4 + 3] = b.prm[i * 4 + 3];
        anm[w * 4] = b.anm[i * 4]; anm[w * 4 + 1] = b.anm[i * 4 + 1]; anm[w * 4 + 2] = b.anm[i * 4 + 2]; anm[w * 4 + 3] = b.anm[i * 4 + 3];
      }
    }
    const c = m ? [cx / m, cy / m, cz / m] : [0, 0, 0];
    for (let i = 0; i < m; i++) r2 = Math.max(r2, (pos[i * 3] - c[0]) ** 2 + (pos[i * 3 + 1] - c[1]) ** 2 + (pos[i * 3 + 2] - c[2]) ** 2);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nrm, 3, true));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.setAttribute('aPrm', new T.BufferAttribute(prm, 4));
    geo.setAttribute('aAnm', new T.BufferAttribute(anm, 4));
    geo.boundingSphere = new T.Sphere(new T.Vector3(c[0], c[1], c[2]), Math.sqrt(r2));
    let glow = null;
    if (gcount[s]) {
      const gm = gcount[s] * 3, gp = new Float32Array(gm * 3), gc = new Float32Array(gm * 3), gq = new Uint8Array(gm * 4);
      let gw = 0;
      for (let f = 0; f < gn; f++) {
        if (gof[f] !== s) continue;
        for (let v = 0; v < 3; v++, gw++) {
          const i = f * 3 + v;
          gp[gw * 3] = b.gpos[i * 3]; gp[gw * 3 + 1] = b.gpos[i * 3 + 1]; gp[gw * 3 + 2] = b.gpos[i * 3 + 2];
          gc[gw * 3] = b.gcol[i * 3]; gc[gw * 3 + 1] = b.gcol[i * 3 + 1]; gc[gw * 3 + 2] = b.gcol[i * 3 + 2];
          gq[gw * 4] = b.gprm[i * 4]; gq[gw * 4 + 1] = b.gprm[i * 4 + 1]; gq[gw * 4 + 2] = b.gprm[i * 4 + 2];
        }
      }
      glow = new T.BufferGeometry();
      glow.setAttribute('position', new T.BufferAttribute(gp, 3));
      glow.setAttribute('aCol', new T.BufferAttribute(gc, 3));
      glow.setAttribute('aPrm', new T.BufferAttribute(gq, 4));
      glow.boundingSphere = new T.Sphere(new T.Vector3(c[0], c[1], c[2]), Math.sqrt(r2) + 40);
    }
    out.push({ geo, glow, c, r: Math.sqrt(r2), tris: count[s] + gcount[s] });
  }
  return out;
}

// the sliced build: one design stage, one turret or one buffer per step
function* buildSteps(T, q, level, gen, mega, key) {
  const cls = Bosses3D.classOf(level, mega);
  const R = makeRng((level * 2654435761 + 0xB055E5) >>> 0);
  const k = new Kit(q, R);
  const piv = gen.turrets.map((t) => t.pivot.slice());
  const noz = gen.core.nozzles || [];
  const G = {
    level, mega, cls, R, piv, nT: piv.length,
    yA: piv[0][1], yB: piv[1] ? piv[1][1] : piv[0][1] * 1.55,
    yC: piv[2] ? piv[2][1] : 6.2, pz: Math.abs(piv[2] ? piv[2][2] : (noz[0] ? noz[0].z : 27)),
    pal: palette(level, cls, R), variant: Math.floor(level / 3) + level,
  };
  yield* DESIGNS[cls](k, G);
  for (let i = 0; i < piv.length; i++) { k.use('tur' + i); k.sec = -1; turret(k, G, i); yield; }
  const proto = {
    key, cls, level, mega, refs: 0, orphan: false, gone: false, geos: [], pal: G.pal, piv,
    nozzles: k.nozzles, wounds: k.wounds.slice(0, 8), emitter: k.emitter, bays: k.bays, blasts: k.blasts,
    sections: null, turrets: [], rot: [], core: null, cuts: k.cuts.slice(), turSec: k.turSec || [],
  };
  let tris = 0, draws = 0;
  const fin = (name, cuts, ns) => {
    const l = finalize(T, k.bufs.get(name), cuts, ns);
    for (const s of l) { proto.geos.push(s.geo); if (s.glow) proto.geos.push(s.glow); tris += s.tris; draws += 1 + (s.glow ? 1 : 0); }
    return l;
  };
  proto.sections = fin('hull', mega ? [] : k.cuts, mega ? k.nShell : null);
  yield;
  for (let i = 0; i < piv.length; i++) proto.turrets.push(fin('tur' + i, [], 1)[0]);
  for (const r of k.rot) proto.rot.push({ ...r, part: fin(r.name, [], 1)[0] });
  yield;
  if (mega) {
    proto.core = fin('core', [], 4);
    proto.coreInfo = k.coreInfo;
    yield;
  }
  proto.stats = { level, cls, mega, tris, draws, sections: proto.sections.length };
  return proto;
}

function instance(lib, proto) {
  const T = lib.THREE, fx = lib.fx, g = new T.Group(), ud = g.userData;
  proto.refs++;
  const U = lib._uniforms(), UT = { ...U, uBWound: lib._uniforms().uBWound, uBTear: { value: new Float32Array(8) }, uBS: { value: new T.Vector4(0, 0, 0, 0) } };
  const UC = proto.core ? { ...U, uBWound: lib._uniforms().uBWound, uBTear: { value: new Float32Array(8) }, uBS: { value: new T.Vector4(0, 0, 0, 0) }, uBK: { value: new T.Vector4(1, 0, proto.level * 3.7, 0.3) } } : null;
  const hullMat = lib._hullMat(U), turMat = lib._hullMat(UT), glowMat = lib._glowMat(U), coreMat = UC ? lib._hullMat(UC) : null;
  U.uBK.value.set(1, 0, proto.level * 1.37, 0.3);
  U.uBAcc.value.set(proto.pal.glow[0], proto.pal.glow[1], proto.pal.glow[2]);
  const Lv = U.uBLv.value, An = U.uBAn.value;
  const R = makeRng(proto.level * 7919 + 13);
  const mk = (part, mat) => {
    const m = new T.Mesh(part.geo, mat);
    m.frustumCulled = false;
    if (part.glow) { const gm = new T.Mesh(part.glow, glowMat); gm.frustumCulled = false; gm.renderOrder = 2; m.add(gm); }
    return m;
  };
  const mkSec = (part, mat, spread) => {
    const m = mk(part, mat);
    m.matrixAutoUpdate = false;
    const c = part.c, out = [c[0], c[1] * 0.4, c[2]], l = Math.hypot(out[0], out[1], out[2]) || 1;
    return {
      mesh: m, c, r: part.r,
      v: [out[0] / l * spread * (0.6 + R() * 0.6) + (R() - 0.5) * 6, (R() - 0.35) * spread * 0.5, out[2] / l * spread * (0.6 + R() * 0.6) + (R() - 0.5) * 12],
      ax: new T.Vector3(R() - 0.5, (R() - 0.5) * 0.6, R() - 0.5).normalize(), w: (0.25 + R() * 0.5) * (R() < 0.5 ? -1 : 1),
      q: 0.5, snapped: false,
    };
  };
  const secOfX = (x) => { let n = 0; for (let i = 0; i < proto.cuts.length; i++) if (x > proto.cuts[i]) n = i + 1; return n; };

  // hull sections (stern → bow); a MEGA's sections are the masses of its armour shell
  const hullRoot = new T.Group();
  g.add(hullRoot);
  const secs = proto.sections.map((p) => mkSec(p, hullMat, proto.mega ? 62 : 16));
  secs.forEach((s, i) => {
    hullRoot.add(s.mesh);
    // each piece lets go at the cut on its bow side (the bow goes with the last cut); a shell bursts in a ripple
    s.q = proto.mega ? 0.3 + 0.4 * (i / Math.max(1, secs.length - 1)) : SEC_Q[Math.min(i, Math.max(0, secs.length - 2))];
  });
  // MEGA: the hero core waits inside, folded
  let core = null;
  if (proto.core) {
    const root = new T.Group();
    root.visible = false;
    g.add(root);
    const cs = proto.core.map((p) => mkSec(p, coreMat, 26));
    cs.forEach((s, i) => { s.q = 0.42 + i * 0.09; root.add(s.mesh); });
    core = { root, secs: cs, rings: [], info: proto.coreInfo, open: 0 };
  }
  // rotating gear rides on the section that carries it; the core's rings orbit under the core root
  const rots = [];
  proto.rot.forEach((r, i) => {
    const m = mk(r.part, r.core ? coreMat : turMat);
    if (r.core) {
      const holder = new T.Group();
      holder.rotation.set(r.tilt[0], 0, r.tilt[1]);
      holder.add(m); core.root.add(holder);
      core.rings.push({ m, holder, axis: 'y', speed: r.speed, ph: i * 1.7, v: [(R() - 0.5) * 50, (R() - 0.5) * 40, (R() - 0.5) * 50] });
      return;
    }
    m.position.set(r.pivot[0], r.pivot[1], r.pivot[2]);
    secs[proto.mega ? Math.min(secs.length - 1, r.sec ?? 5) : secOfX(r.pivot[0])].mesh.add(m);
    rots.push({ m, axis: r.axis, speed: r.speed });
  });
  // turrets: the integrator aims the outer group, the body inside rises on deploy; each rides on its section
  const turrets = [], bodies = [], wrecks = [];
  proto.turrets.forEach((p, i) => {
    const tg = new T.Group(), body = mk(p, turMat), pv = proto.piv[i];
    tg.position.set(pv[0], pv[1], pv[2]);
    tg.add(body);
    secs[proto.mega ? Math.min(secs.length - 1, proto.turSec[i] ?? 5) : secOfX(pv[0])].mesh.add(tg);
    turrets.push(tg); bodies.push(body);
    const wm = mk(p, turMat);
    wm.visible = false; g.add(wm);
    wrecks.push({ m: wm, on: false, t: 0, p: new T.Vector3(), v: new T.Vector3(), ax: new T.Vector3(1, 0, 0), w: 0, yaw: 0 });
  });

  /* ------------------------------- state ------------------------------- */
  const S = {
    flash: 0, damage: 0, shield: 0, shieldT: 0, arrive: 1, death: 0, deathT0: null, tMs: 0, live: false,
    charge: { laser: 0, sweep: 0, ram: 0, volley: 0, bay: 0 }, ease: { laser: 0, sweep: 0, ram: 0, volley: 0, bay: 0 },
    blown: proto.turrets.map(() => false), blast: 0, final: false, phase2: false, p2t: -1, hullScale: 0, rot0: 0, lastWoundFx: 0,
    world: { x: 0, y: 0, z: 0, scale: 1, rotY: Math.PI },
  };
  const wOpen = new Float32Array(8), wTear = new Float32Array(8), wSeen = new Uint8Array(8);
  Lv[CH.STATIC] = 1; Lv[CH.ENGINE] = 1; Lv[CH.NAV] = 1; Lv[CH.ACCENT] = 1; Lv[CH.BIO] = 1; Lv[CH.SEAM] = 1; Lv[CH.CORE] = 1; Lv[CH.BEACON] = 1; Lv[CH.STROBE] = 1;

  // model point → world (yaw only; the hull's roll is a few degrees)
  const W = [0, 0, 0];
  const toWorld = (x, y, z) => {
    const w = S.world, c = Math.cos(w.rotY), s = Math.sin(w.rotY);
    W[0] = w.x + (x * c + z * s) * w.scale; W[1] = w.y + y * w.scale; W[2] = w.z + (-x * s + z * c) * w.scale;
    return W;
  };
  const fire = (p, scale, light) => { const o = lib._fire; o.scale = scale; o.light = !!light; fx.fireTrail(p[0], p[1], p[2], o); };
  const placeSec = (s, tau, k = 1) => {
    if (tau <= 0) { s.mesh.matrix.identity(); s.mesh.matrixWorldNeedsUpdate = true; return; }
    const e = tau * (1 + 0.25 * tau) * k; // drifts apart, slowly gathering way
    lib._q.setFromAxisAngle(s.ax, s.w * tau * k);
    lib._v.set(s.c[0], s.c[1], s.c[2]).applyQuaternion(lib._q);
    lib._m.makeRotationFromQuaternion(lib._q);
    lib._m.setPosition(s.c[0] + s.v[0] * e - lib._v.x, s.c[1] + s.v[1] * e - lib._v.y, s.c[2] + s.v[2] * e - lib._v.z);
    s.mesh.matrix.copy(lib._m); s.mesh.matrixWorldNeedsUpdate = true;
  };

  ud.turrets = turrets;
  ud.nozzles = proto.nozzles;
  ud.cls = proto.cls;
  ud.emitter = proto.emitter;
  ud.stats = proto.stats;
  ud.setFlash = (v) => { S.flash = sat(v); };
  ud.setShield = (on) => { S.shield = on ? 1 : 0; };
  ud.setCharge = (kind, v) => { if (kind in S.charge) S.charge[kind] = sat(v); };
  ud.setArrive = (a) => { S.arrive = sat(a); };
  ud.setDamage = (d) => {
    d = sat(d); S.damage = d;
    const tgt = S.phase2 && UC ? UC : U, n = S.phase2 && core ? core.info.wounds.length : proto.wounds.length, list = S.phase2 && core ? core.info.wounds : proto.wounds;
    // a MEGA's damage restarts on the core: its second half of health is the core's whole life
    const dd = proto.mega ? (S.phase2 ? sat((d - 0.5) * 2) : sat(d * 2)) : d;
    for (let i = 0; i < 8; i++) {
      const w = tgt.uBWound.value[i];
      if (i >= n) { w.w = 0; continue; }
      const th = 0.07 + (i / n) * 0.78, open = sat((dd - th) / 0.15), tear = sat((open - 0.35) / 0.65);
      wOpen[i] = open; wTear[i] = tear;
      w.set(list[i][0], list[i][1], list[i][2], open > 0 ? list[i][3] * (0.5 + 0.5 * open) : 0);
      tgt.uBTear.value[i] = tear;
      if (tear > 0 && !wSeen[i]) {
        wSeen[i] = 1;
        if (S.live && fx) { // the plating gives way
          const p = toWorld(list[i][0], list[i][1], list[i][2]);
          fx.explosion(p[0], p[1], p[2], 0.34, FX_POP);
          fx.shrapnel(p[0], p[1], p[2], 6, FX_CHIPS);
        }
      } else if (tear <= 0) wSeen[i] = 0;
    }
    tgt.uBS.value.x = dd;
    if (tgt !== U) U.uBS.value.x = 0;
  };

  ud.blowTurret = (i, o) => {
    if (i < 0 || i >= turrets.length || S.blown[i]) return;
    S.blown[i] = true;
    turrets[i].visible = false;
    if (S.phase2) return;
    Lv[CH.STUMP + i] = 1;
    if (!S.live || (o && o.silent)) return;
    const w = wrecks[i], pv = proto.piv[i];
    w.on = true; w.t = 0; w.m.visible = true;
    w.p.set(pv[0], pv[1] + 1, pv[2]);
    w.v.set(-18 - R() * 22, 34 + R() * 26, (pv[2] === 0 ? (R() < 0.5 ? -1 : 1) : Math.sign(pv[2])) * (20 + R() * 26));
    w.ax.set(R() - 0.5, R() * 0.4, R() - 0.5).normalize(); w.w = 2.2 + R() * 2.6; w.yaw = turrets[i].rotation.y;
    if (fx) {
      const p = toWorld(pv[0], pv[1] + 2, pv[2]);
      fx.explosion(p[0], p[1], p[2], 0.5, FX_POP);
      fx.shrapnel(p[0], p[1], p[2], 8, FX_CHIPS);
    }
  };

  ud.setPhase2 = (o) => {
    if (!core || S.phase2) return;
    S.phase2 = true; S.p2t = o && o.instant ? -2 : -1; // -1: stamped on the next update
    for (const tg of turrets) tg.visible = false;
    for (const w of wrecks) { w.on = false; w.m.visible = false; }
    for (let i = 0; i < 4; i++) Lv[CH.STUMP + i] = 0;
    core.root.visible = true;
    wSeen.fill(0);
    ud.setDamage(S.damage);
    ud.nozzles = EMPTY_LIST;
  };

  ud.setDeath = (q, tMs) => {
    q = sat(q);
    if (q > 0 && S.deathT0 == null) S.deathT0 = (tMs ?? S.tMs) - q * 1700;
    if (q <= 0) S.deathT0 = null;
    S.death = q;
    if (tMs != null) S.deathNow = tMs;
  };

  /* ------------------------------- update ------------------------------ */
  ud.update = (dtMs, tMs, world) => {
    const dt = Math.min(0.1, Math.max(0, dtMs / 1000)), t = tMs / 1000;
    S.tMs = tMs;
    if (world) { const w = S.world; w.x = world.x; w.y = world.y || 0; w.z = world.z; w.scale = world.scale || 1; w.rotY = world.rotY ?? Math.PI; }
    if (!S.phase2 || !S.hullScale) { S.hullScale = S.world.scale; S.rot0 = S.world.rotY; }
    U.uBT.value = t;
    const a = S.arrive, dq = S.death;

    // eased charges
    const ez = 1 - Math.exp(-dt * 9);
    for (const kk in S.ease) S.ease[kk] += (S.charge[kk] - S.ease[kk]) * (S.live ? ez : 1);
    const E = S.ease;
    S.shieldT += (S.shield - S.shieldT) * (S.live ? 1 - Math.exp(-dt * 7) : 1);

    // arrival: stretched streak → hull, then lights and weapons
    const st = a < 0.6 ? (1 - a / 0.6) : 0;
    U.uBArr.value.x = st * st * 5;
    U.uBK.value.y = a < 1 ? Math.pow(1 - a, 1.5) * 0.9 : 0;
    const lightsOn = a >= 1 ? 1 : smooth(0.55, 0.62, a) * (a < 0.8 ? (Math.sin(tMs * 0.09) > -0.3 ? 1 : 0.25) : 1);
    const navOn = a >= 1 ? 1 : smooth(0.66, 0.7, a), accOn = a >= 1 ? 1 : smooth(0.74, 0.8, a);
    const deploy = a >= 1 ? 1 : smooth(0.62, 0.95, a);
    const dying = dq > 0, alive = dying ? Math.max(0, 1 - dq * 1.6) : 1, flicker = dying ? (Math.sin(tMs * 0.05) * Math.sin(tMs * 0.017) > -0.2 ? 1 : 0.2) : 1;
    const dmgFlick = S.damage > 0.6 ? 0.8 + 0.2 * Math.sin(tMs * 0.031) * Math.sin(tMs * 0.0127) : 1;
    U.uBK.value.x = lightsOn * alive * flicker * dmgFlick;
    U.uBK.value.w = sat(0.3 + S.damage * 0.5 + dq * 1.2) * (dq >= 1 ? 0.8 : 1);
    if (UC) UC.uBK.value.w = U.uBK.value.w;
    U.uBS.value.y = dq; U.uBS.value.z = S.flash; U.uBS.value.w = S.shieldT;
    UT.uBS.value.set(0, dq * 0.6, S.flash, S.shieldT);
    if (UC) { UC.uBS.value.y = dq; UC.uBS.value.z = S.flash; UC.uBS.value.w = S.shieldT; }

    // channels
    const k = alive * flicker;
    Lv[CH.STATIC] = (0.25 + 0.75 * lightsOn) * (dying ? Math.max(0.2, k) : 1);
    Lv[CH.ENGINE] = (a < 1 ? 0.5 + 0.9 * (1 - a) : 1) * (1 + 0.05 * Math.sin(tMs * 0.021) + E.ram * 1.3) * (dying ? alive * (0.4 + 0.6 * flicker) : 1);
    Lv[CH.NAV] = navOn * k;
    Lv[CH.ACCENT] = accOn * (0.82 + 0.18 * Math.sin(tMs * 0.0021)) * k;
    Lv[CH.STROBE] = navOn * k * (((tMs % 1400) < 90 || ((tMs + 1220) % 1400) < 90) ? 1 : 0.06);
    Lv[CH.BEACON] = navOn * k * (0.5 + 0.5 * Math.sin(tMs * 0.0045));
    Lv[CH.LASER] = E.laser; Lv[CH.SWEEP] = E.sweep; Lv[CH.RAM] = E.ram; Lv[CH.VOLLEY] = E.volley;
    Lv[CH.BAY] = Math.max(E.bay, 0.12 * lightsOn) * (dying ? k : 1);
    Lv[CH.SHIELD] = S.shieldT;
    Lv[CH.BIO] = accOn * (dying ? k : 1) * (1 + E.laser + E.volley * 0.6);
    Lv[CH.SEAM] = accOn * (0.7 + 0.3 * Math.sin(tMs * 0.0034)) * (dying ? 1 + dq : 1) * (1 + E.ram);
    Lv[CH.CORE] = (0.85 + 0.15 * Math.sin(tMs * 0.0062)) * (1 + E.laser * 0.6 + E.sweep * 0.6) * (dying ? 1 + dq * 0.8 : 1);
    Lv[CH.BEAM] = Math.max(E.laser, E.sweep);
    for (let i = 0; i < turrets.length; i++) if (S.blown[i] && !S.phase2) Lv[CH.STUMP + i] = (0.6 + 0.4 * Math.sin(tMs * 0.03 + i * 2)) * (dq >= 1 ? 0.3 : 1);
    An[AN.BAY] = E.bay; An[AN.RAM] = E.ram; An[AN.LASER] = E.laser; An[AN.DEPLOY] = deploy;
    An[AN.PEEL] = dying ? smooth(0.08, 1, dq) * (1 + Math.max(0, (tMs - S.deathT0 - 1700) / 1700) * 0.6) : 0;

    // turrets rise out of their wells; rotating gear
    for (let i = 0; i < bodies.length; i++) { bodies[i].position.y = -(1 - deploy) * 7; bodies[i].visible = deploy > 0.02; }
    for (const r of rots) r.m.rotation[r.axis] = tMs * r.speed;

    // blown turrets: tumbling, burning wreckage
    for (let i = 0; i < wrecks.length; i++) {
      const w = wrecks[i];
      if (!w.on) continue;
      w.t += dt;
      w.v.y -= 30 * dt;
      w.p.addScaledVector(w.v, dt);
      w.m.position.copy(w.p);
      lib._q.setFromAxisAngle(w.ax, w.w * w.t);
      w.m.quaternion.copy(lib._q);
      w.m.rotateY(w.yaw);
      const life = 2.4;
      if (fx) { const p = toWorld(w.p.x, w.p.y, w.p.z); fire(p, 0.4, false); }
      if (w.t > life) {
        w.on = false; w.m.visible = false;
        if (fx) { const p = toWorld(w.p.x, w.p.y, w.p.z); fx.explosion(p[0], p[1], p[2], 0.4, FX_POP_DARK); }
      }
    }

    // MEGA phase 2: the shell is thrown clear and the core unfolds
    if (S.phase2 && core) {
      if (S.p2t === -1) {
        S.p2t = tMs;
        if (fx && S.live) {
          const p = toWorld(0, 0, 0);
          fx.explosion(p[0], p[1] + 10, p[2], 1.0, FX_POP);
          fx.shockwave(p[0], p[1], p[2], 240 * S.world.scale);
          fx.shrapnel(p[0], p[1], p[2], 16, FX_BURST);
        }
      } else if (S.p2t === -2) S.p2t = tMs - 5000;
      const tau = (tMs - S.p2t) / 1000, ks = S.hullScale / S.world.scale;
      hullRoot.visible = tau < 3.2;
      if (hullRoot.visible) {
        // the wreckage keeps the hull's scale and heading whatever the integrator does to the group afterwards
        hullRoot.scale.setScalar(ks * (tau > 2.6 ? Math.max(0.01, 1 - (tau - 2.6) / 0.6) : 1));
        hullRoot.rotation.y = -(S.world.rotY - S.rot0);
        for (const s of secs) placeSec(s, tau, 1.5);
        if (fx && tau < 2.2) for (let i = 0; i < secs.length; i += 2) {
          const s = secs[(i + (Math.floor(tMs / 50) & 1)) % secs.length], e = tau * (1 + 0.25 * tau) * 1.5;
          const p = toWorld((s.c[0] + s.v[0] * e) * ks, (s.c[1] + s.v[1] * e) * ks, (s.c[2] + s.v[2] * e) * ks);
          fire(p, 0.9, false);
        }
      }
      const open = smooth(0.05, 1.1, tau);
      core.open = open;
      core.root.scale.setScalar(ks * lerp(0.42, 1, open));
      An[AN.DEPLOY] = open;
      for (const r of core.rings) r.m.rotation.y = tMs * r.speed + r.ph;
    }

    // --- death: explosions walk the hull, the spine snaps, the pieces drift apart ---
    if (dying) {
      const set = S.phase2 && core ? core.secs : secs, tdead = tMs - S.deathT0;
      const nb = 8, due = Math.min(nb, Math.floor(dq / 0.045));
      if (S.live && fx) {
        while (S.blast < due) {
          const i = S.blast++, bl = proto.blasts.length ? proto.blasts[i % proto.blasts.length] : [lerp(-50, 55, i / (nb - 1)), 4, ((i * 37) % 30) - 15];
          const kc = S.phase2 && core ? 0.5 : 1;
          const p = toWorld(bl[0] * kc, bl[1] + 3, bl[2] * kc);
          fx.explosion(p[0], p[1], p[2], 0.3 + (i % 3) * 0.08, i % 2 ? FX_POP_DARK : FX_POP);
          if (i % 2) fx.shrapnel(p[0], p[1], p[2], 6, FX_CHIPS);
        }
      } else S.blast = due;
      for (let i = 0; i < set.length; i++) {
        const s = set[i], tau = (tdead - s.q * 1700) / 1000;
        placeSec(s, tau);
        if (tau > 0 && !s.snapped) {
          s.snapped = true;
          if (S.live && fx) {
            const p = toWorld(s.c[0], s.c[1], s.c[2]);
            fx.explosion(p[0], p[1], p[2], 0.5, FX_POP);
            fx.sparks(p[0], p[1], p[2], 14, 0, 0, FX_SPRAY);
          }
        }
        if (fx && S.live && tau > 0 && tau < 4 && ((i + Math.floor(tMs / 34)) & 1)) {
          const e = tau * (1 + 0.25 * tau), p = toWorld(s.c[0] + s.v[0] * e, s.c[1] + s.v[1] * e, s.c[2] + s.v[2] * e);
          fire(p, 0.6, false);
        }
      }
      if (dq >= 0.97 && !S.final) {
        S.final = true;
        if (S.live && fx) { // the reactor goes: one restrained flash, tinted, never white
          const p = toWorld(S.phase2 ? 0 : -18, 2, 0);
          fx.explosion(p[0], p[1], p[2], 0.95, FX_FINAL);
          fx.shockwave(p[0], p[1], p[2], 150 * S.world.scale);
        }
      }
      if (fx && S.live && dq < 1) { const p = toWorld(0, 0, 0); fx.arcs(p[0], p[1], p[2], 55 * S.world.scale, FX_ARCS); }
    } else if (S.final || S.blast) {
      // death rolled back (harness scrubbing): put the pieces home
      S.final = false; S.blast = 0;
      for (const s of secs) { s.snapped = false; placeSec(s, 0); }
      if (core) for (const s of core.secs) { s.snapped = false; placeSec(s, 0); }
    }

    // --- battle damage: smoke from scorched plating, fire and sparks from the open wounds ---
    if (fx && S.live && !dying && a >= 1) {
      const list = S.phase2 && core ? core.info.wounds : proto.wounds, n = Math.min(8, list.length), kc = S.phase2 && core ? core.open * (S.hullScale / S.world.scale) : 1;
      const slot = Math.floor(tMs / 33);
      for (let i = 0; i < n; i++) {
        if (wOpen[i] <= 0 || (S.phase2 && !core)) continue;
        const p = toWorld(list[i][0] * kc, list[i][1] * kc + 1.5, list[i][2] * kc);
        if (wTear[i] > 0.05) {
          if ((slot + i * 3) % 5 === 0) fire(p, 0.24 + 0.2 * wTear[i], i < 1);
          if ((slot + i * 7) % 29 === 0) fx.sparks(p[0], p[1], p[2], 4, 0, 0, FX_SPIT);
        } else if ((slot + i * 5) % 9 === 0) fx.smokePuff(p[0], p[1] + 3, p[2], 10 + 8 * wOpen[i], FX_SMOKE);
      }
      if (!S.phase2) for (let i = 0; i < turrets.length; i++) {
        if (!S.blown[i] || (slot + i) % 5) continue;
        const pv = proto.piv[i], p = toWorld(pv[0], pv[1] + 1.5, pv[2]);
        fire(p, 0.3, false);
      }
      // charge glows that should light the scene
      if (E.laser > 0.05) { const em = proto.emitter, p = toWorld(em[0], em[1], em[2]); fx.lightNow(p[0], p[1] + 20, p[2], proto.pal.beam, 0.1 * E.laser); }
    }
    S.live = true;
  };

  ud.dispose = () => {
    if (ud.disposed) return;
    ud.disposed = true;
    lib._live.delete(g);
    if (g.parent) g.parent.remove(g);
    proto.refs--;
    if (proto.orphan && proto.refs <= 0) disposeProto(proto);
  };

  ud.update(0, 0, null);
  S.live = false;
  return g;
}

const EMPTY_LIST = Object.freeze([]);
// option sets for the fx calls: shared constants, so a boss fight makes no garbage
const FX_POP = Object.freeze({ shockwave: false }), FX_POP_DARK = Object.freeze({ shockwave: false, light: false });
const FX_CHIPS = Object.freeze({ speed: 220, trail: 1 }), FX_BURST = Object.freeze({ speed: 320, trail: 3 });
const FX_SPRAY = Object.freeze({ spread: 3.1, speed: 380 }), FX_SPIT = Object.freeze({ spread: 3.1, speed: 220, life: 340 });
const FX_FINAL = Object.freeze({ tint: Object.freeze([1, 0.8, 0.6]), shockwave: false });
const FX_ARCS = Object.freeze({ rate: 10 }), FX_SMOKE = Object.freeze({ dark: 0.8, life: 800 });

