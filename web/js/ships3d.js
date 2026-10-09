// ships3d.js — hero player-ship models, built entirely in code.
//
// Each ship is modelled from lofted fuselage sections, bevelled wings, lathed
// nozzles/barrels and small greebles, merged by material into four draw calls
// (painted hull, bare-metal mechanics, canopy glass, additive emissives). A
// top-projected "livery" texture set (albedo + roughness/metalness + normal),
// drawn on a 2D canvas in the ship's own plan coordinates, carries the panel
// lines, paint blocks, markings and wear.
//
// Model space: +X nose, +Y up, +Z starboard. A built group is exactly 1 long
// on X, centred on the origin. The module imports nothing: it receives THREE.
//
//   const ships = new Ships3D(THREE, { quality: 1 });
//   const g = ships.build('vanguard', { tint: [0.3, 1, 0.4] });
//   g.userData.{nozzles,muzzles,setThrust,setBank,setFlash,setOpacity,setDamage,setTint,update,dispose}
//
// Moving parts (control surfaces, nozzle petals, guns, gear, canopy, doors, torn
// panels) are not separate meshes. Every vertex carries a rig slot + weight and
// the shaders pose it from two small uniform arrays, so a hull stays at four
// draw calls however much of it moves. Extra userData, all optional:
//   setPitch(-1..1) setYaw(-1..1)            control surfaces / thrust vectoring / airbrakes (pitch < 0)
//   setWeapon(1..3) setFire() setRocket() setLaser(0..1) setOverdrive(bool)
//   setGear(0..1) setCanopy(0..1)            hangar / launch
//   setLaserCharge(0..1) hit(x,y,z,power) rocketPort
//   wounds, woundCount, breakOff(), repair() damage hooks
//   muzzleCount, groundY, settle()

export const SHIP_IDS = ['vanguard', 'interceptor', 'juggernaut', 'ghost', 'ace', 'player1', 'player2'];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// sRGB hex → linear rgb triple (optionally scaled into HDR)
const lin = (hex, k = 1) => [s2l(((hex >> 16) & 255) / 255) * k, s2l(((hex >> 8) & 255) / 255) * k, s2l((hex & 255) / 255) * k];
const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
const rgba = (hex, a) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ========================================================================== */
/*  Triangle-soup modelling kit (flat number arrays, 9 per triangle)          */
/* ========================================================================== */

export function tri(t, a, b, c) { t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
export function quad(t, a, b, c, d) { tri(t, a, b, c); tri(t, a, c, d); }
export function flip(t) {
  for (let i = 0; i < t.length; i += 9) {
    for (let k = 0; k < 3; k++) { const v = t[i + 3 + k]; t[i + 3 + k] = t[i + 6 + k]; t[i + 6 + k] = v; }
  }
  return t;
}
function signedVol(t) {
  let cx = 0, cy = 0, cz = 0;
  const n = t.length / 3;
  for (let i = 0; i < t.length; i += 3) { cx += t[i]; cy += t[i + 1]; cz += t[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i] - cx, ay = t[i + 1] - cy, az = t[i + 2] - cz;
    const bx = t[i + 3] - cx, by = t[i + 4] - cy, bz = t[i + 5] - cz;
    const dx = t[i + 6] - cx, dy = t[i + 7] - cy, dz = t[i + 8] - cz;
    v += ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx);
  }
  return v;
}
export function cat(...ts) { const o = []; for (const t of ts) for (let i = 0; i < t.length; i++) o.push(t[i]); return o; }
export function mirrorZ(t) { for (let i = 2; i < t.length; i += 3) t[i] = -t[i]; return flip(t); }
// s = +1 keeps, s = -1 mirrors to port
const side = (t, s) => (s < 0 ? mirrorZ(t) : t);
export function move(t, dx, dy, dz) { for (let i = 0; i < t.length; i += 3) { t[i] += dx; t[i + 1] += dy; t[i + 2] += dz; } return t; }
// rotate about the X axis through (y0,z0): positive angle swings +Z toward +Y
export function rotX(t, ang, y0 = 0, z0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const y = t[i + 1] - y0, z = t[i + 2] - z0;
    t[i + 1] = y0 + y * c + z * s; t[i + 2] = z0 - y * s + z * c;
  }
  return t;
}
// rotate about the Y axis through (x0,z0): positive angle swings +X toward +Z
export function rotY(t, ang, x0 = 0, z0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const x = t[i] - x0, z = t[i + 2] - z0;
    t[i] = x0 + x * c - z * s; t[i + 2] = z0 + x * s + z * c;
  }
  return t;
}
// rotate about the Z axis through (x0,y0): positive angle swings +X toward +Y
export function rotZ(t, ang, x0 = 0, y0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const x = t[i] - x0, y = t[i + 1] - y0;
    t[i] = x0 + x * c - y * s; t[i + 1] = y0 + x * s + y * c;
  }
  return t;
}

// Skin a stack of closed rings (each an array of [x,y,z], same count). The
// result is oriented outward by signed volume, so ring direction never matters.
export function loft(rings, o = {}) {
  const capA = o.capA !== false, capB = o.capB !== false;
  const sideT = [], a = [], b = [];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; quad(sideT, A[j], B[j], B[j2], A[j2]); }
  }
  const cen = (R) => { const c = [0, 0, 0]; for (const p of R) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return [c[0] / n, c[1] / n, c[2] / n]; };
  const A = rings[0], B = rings[rings.length - 1], ca = cen(A), cb = cen(B);
  for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; tri(a, ca, A[j], A[j2]); tri(b, cb, B[j2], B[j]); }
  const neg = signedVol(cat(sideT, a, b)) < 0;
  const out = cat(sideT, capA ? a : [], capB ? b : []);
  return neg !== !!o.inward ? flip(out) : out;
}

// monotone cubic interpolation (no overshoot — widths never go negative)
function pchip(xs, ys) {
  const n = xs.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// superellipse cross-section in the YZ plane: half-width w, top height t,
// bottom depth b, exponents et/eb (2 = ellipse, >2 boxy, <2 chined/lens)
function secRing(x, s, n) {
  const R = [], y0 = s.y || 0, z0 = s.z || 0;
  for (let j = 0; j < n; j++) {
    const a = (j / n) * TAU, c = Math.cos(a), sn = Math.sin(a);
    const e = sn >= 0 ? s.et : s.eb;
    const z = s.w * Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
    const y = (sn >= 0 ? s.t : s.b) * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e);
    R.push([x, y0 + y, z0 + z]);
  }
  return R;
}

const FKEYS = ['w', 't', 'b', 'y', 'z', 'et', 'eb'];
const FDEF = { y: 0, z: 0, et: 2, eb: 2 };
// fuselage: keyframed sections interpolated along X and lofted
export function fuselage(keys, o = {}) {
  const n = o.n || 24, sub = o.sub || 4;
  const xs = keys.map((k) => k.x), f = {};
  for (const key of FKEYS) f[key] = pchip(xs, keys.map((k) => (k[key] ?? (key === 'b' ? k.t : FDEF[key]))));
  const at = (x) => { const s = {}; for (const key of FKEYS) s[key] = f[key](x); return s; };
  const rings = [];
  for (let i = 0; i < keys.length - 1; i++) {
    for (let k = 0; k < sub; k++) { const x = lerp(xs[i], xs[i + 1], k / sub); rings.push(secRing(x, at(x), n)); }
  }
  rings.push(secRing(xs[xs.length - 1], at(xs[xs.length - 1]), n));
  const top = (x, z = 0) => {
    const s = at(x), u = Math.min(1, Math.abs((z - s.z) / Math.max(1e-6, s.w)));
    return s.y + s.t * Math.pow(Math.max(0, 1 - Math.pow(u, s.et)), 1 / s.et);
  };
  return { tris: loft(rings, o), at, top };
}

const WPROF = [[0, 0], [0.045, 0.62], [0.2, 1], [0.62, 0.9], [1, 0.14], [1, -0.14], [0.62, -0.72], [0.2, -0.82], [0.045, -0.5]];
const WPROF_FACET = [[0, 0], [0.34, 1], [0.8, 0.5], [1, 0.06], [1, -0.06], [0.7, -0.5], [0.3, -0.7]];
// wing: stations {z, xl (leading-edge x), xt (trailing-edge x), y, th}; bevelled
// airfoil section; span runs along +Z in its local frame; chamfered tip.
function wingRing(s, prof, shrink = 0, thk = 1) {
  const c = s.xl - s.xt, R = [];
  const xl = s.xl - c * shrink, cc = c * (1 - 2 * shrink);
  for (const [f, h] of prof) R.push([xl - f * cc, s.y + h * s.th * 0.5 * thk, s.z]);
  return R;
}
export function wing(st, o = {}) {
  const prof = o.prof || WPROF;
  const rings = st.map((s) => wingRing(s, prof));
  if (o.tip !== false) {
    const L = st[st.length - 1], P = st[st.length - 2];
    const dz = L.z - P.z, len = Math.abs(dz) || 1, ext = L.th * 0.45;
    const tipS = { ...L, z: L.z + (dz / len) * ext, y: L.y + ((L.y - P.y) / len) * ext };
    rings.push(wingRing(tipS, prof, 0.06, 0.25));
  }
  return loft(rings, o);
}
// airfoil ring clipped at chord fraction fh (front keeps the leading part)
function clipProf(prof, fh, front) {
  const out = [], n = prof.length, inside = (p) => (front ? p[0] <= fh : p[0] >= fh);
  for (let i = 0; i < n; i++) {
    const a = prof[i], b = prof[(i + 1) % n], ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) out.push([fh, lerp(a[1], b[1], (fh - a[0]) / (b[0] - a[0]))]);
  }
  return out;
}
function spanCut(st, za, zb) {
  const out = [wAt(st, za)];
  for (const s of st) if (s.z > za + 1e-6 && s.z < zb - 1e-6) out.push(s);
  out.push(wAt(st, zb));
  return out;
}
// wing with the trailing edge aft of chord fraction fh cut loose over each span range in
// cuts = [[z0, z1], ...] (ascending): { main, flaps: [{ flap, p (hinge point), a (hinge axis, running outboard) }] }
export function wingFlap(st, cuts, fh, o = {}) {
  const prof = o.prof || WPROF, zB = st[st.length - 1].z, gap = o.gap ?? 0.014, inset = o.inset ?? 0.0025;
  const main = [], flaps = [];
  const add = (t) => { for (let i = 0; i < t.length; i++) main.push(t[i]); };
  let z = st[0].z;
  for (const [z0, z1] of cuts) {
    if (z0 > z + 1e-6) add(wing(spanCut(st, z, z0), { prof, tip: false }));
    add(loft(spanCut(st, z0, z1).map((s) => wingRing(s, clipProf(prof, fh, true)))));
    const a = wAt(st, z0), b = wAt(st, z1);
    const pa = [lerp(a.xl, a.xt, fh + gap), a.y, z0], pb = [lerp(b.xl, b.xt, fh + gap), b.y, z1];
    const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], l = Math.hypot(d[0], d[1], d[2]);
    flaps.push({ flap: loft(spanCut(st, z0 + inset, z1 - inset).map((s) => wingRing(s, clipProf(prof, fh + gap, false)))), p: pa, a: [d[0] / l, d[1] / l, d[2] / l] });
    z = z1;
  }
  if (z < zB - 1e-6) add(wing(spanCut(st, z, zB), { prof, tip: o.tip }));
  return { main, flaps };
}
// height of a wing's upper (up = 1) or lower surface at plan point (x, z)
export function wTop(st, x, z, up = 1, prof = WPROF) {
  const s = wAt(st, z), f = clamp((s.xl - x) / (s.xl - s.xt), 0, 1);
  let h = 0;
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i], b = prof[(i + 1) % prof.length];
    if (a[1] * up < 0 || b[1] * up < 0 || a[0] === b[0]) continue;
    if ((f - a[0]) * (f - b[0]) <= 0) h = Math.max(h, Math.abs(lerp(a[1], b[1], (f - a[0]) / (b[0] - a[0]))));
  }
  return s.y + up * h * s.th * 0.5;
}
// chord/planform helpers shared by geometry and livery
export function wAt(st, z) {
  let i = 0;
  while (i < st.length - 2 && z > st[i + 1].z) i++;
  const a = st[i], b = st[i + 1], t = clamp((z - a.z) / (b.z - a.z), 0, 1);
  return { xl: lerp(a.xl, b.xl, t), xt: lerp(a.xt, b.xt, t), y: lerp(a.y, b.y, t), th: lerp(a.th, b.th, t), z };
}
const wPt = (st, z, f) => { const w = wAt(st, z); return [lerp(w.xl, w.xt, f), z]; };
// polygon [x,z] between chord fractions f0..f1 and span z0..z1 (follows cranks)
function wPoly(st, z0, z1, f0, f1, sgn = 1) {
  const zs = [z0];
  for (const s of st) if (s.z > z0 + 1e-6 && s.z < z1 - 1e-6) zs.push(s.z);
  zs.push(z1);
  const out = [];
  for (const z of zs) { const p = wPt(st, z, f0); out.push([p[0], p[1] * sgn]); }
  for (let i = zs.length - 1; i >= 0; i--) { const p = wPt(st, zs[i], f1); out.push([p[0], p[1] * sgn]); }
  return out;
}
function wLine(st, z0, z1, f, sgn = 1) {
  const zs = [z0];
  for (const s of st) if (s.z > z0 + 1e-6 && s.z < z1 - 1e-6) zs.push(s.z);
  zs.push(z1);
  return zs.map((z) => { const p = wPt(st, z, f); return [p[0], p[1] * sgn]; });
}

// body of revolution about an X-parallel axis; profile = [[x, r], ...]
export function lathe(profile, n, o = {}) {
  const y0 = o.y || 0, z0 = o.z || 0, sy = o.sy || 1, sz = o.sz || 1, ph = o.phase || 0;
  const rings = profile.map(([x, r]) => {
    const R = [];
    for (let j = 0; j < n; j++) { const a = (j / n) * TAU + ph; R.push([x, y0 + Math.sin(a) * r * sy, z0 + Math.cos(a) * r * sz]); }
    return R;
  });
  return loft(rings, o);
}
// chamfered rectangle ring in the YZ plane
export function ringRect(x, y0, y1, z0, z1, c = 0) {
  if (c <= 0) return [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]];
  return [[x, y0, z0 + c], [x, y0, z1 - c], [x, y0 + c, z1], [x, y1 - c, z1], [x, y1, z1 - c], [x, y1, z0 + c], [x, y1 - c, z0], [x, y0 + c, z0]];
}
// box with chamfered edges all round
export function box(x0, x1, y0, y1, z0, z1, bv = 0) {
  if (bv <= 0) return loft([ringRect(x0, y0, y1, z0, z1), ringRect(x1, y0, y1, z0, z1)]);
  return loft([
    ringRect(x0, y0 + bv, y1 - bv, z0 + bv, z1 - bv, bv * 0.5), ringRect(x0 + bv, y0, y1, z0, z1, bv),
    ringRect(x1 - bv, y0, y1, z0, z1, bv), ringRect(x1, y0 + bv, y1 - bv, z0 + bv, z1 - bv, bv * 0.5),
  ]);
}
function offsetPoly(poly, d) {
  const n = poly.length, out = [];
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n], c = poly[i], q = poly[(i + 1) % n];
    let ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // inward normals
    const n1x = -az * sg, n1z = ax * sg, n2x = -bz * sg, n2z = bx * sg;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const k = d / Math.max(0.35, mx * n1x + mz * n1z);
    out.push([c[0] + mx * k, c[1] + mz * k]);
  }
  return out;
}
// raised plate: polygon [x,z] extruded from y0 up to y1 with a chamfered rim
export function plate(poly, y0, y1, bv = 0.003) {
  const up = y1 >= y0 ? 1 : -1;
  const R = (pl, y) => pl.map(([x, z]) => [x, y, z]);
  return loft([R(poly, y0), R(poly, y1 - bv * up), R(offsetPoly(poly, bv), y1)], { capA: false });
}

// crease-aware normals for a triangle soup; drops degenerate triangles
function creaseNormals(p, cosT) {
  const nt0 = p.length / 9;
  const pos = [];
  const fnx = [], fny = [], fnz = [], fux = [], fuy = [], fuz = [];
  for (let f = 0; f < nt0; f++) {
    const i = f * 9;
    const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-11)) continue;
    for (let k = 0; k < 9; k++) pos.push(p[i + k]);
    fnx.push(nx); fny.push(ny); fnz.push(nz); fux.push(nx / l); fuy.push(ny / l); fuz.push(nz / l);
  }
  const nv = pos.length / 3;
  const keys = new Float64Array(nv), next = new Int32Array(nv), map = new Map();
  for (let v = 0; v < nv; v++) {
    const key = (Math.round(pos[v * 3] * 16000) + 32768) + (Math.round(pos[v * 3 + 1] * 16000) + 32768) * 65536 + (Math.round(pos[v * 3 + 2] * 16000) + 32768) * 4294967296;
    keys[v] = key;
    const h = map.get(key);
    next[v] = h === undefined ? -1 : h;
    map.set(key, v);
  }
  const nrm = new Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const f = (v / 3) | 0;
    let x = 0, y = 0, z = 0;
    for (let u = map.get(keys[v]); u >= 0; u = next[u]) {
      const g = (u / 3) | 0;
      if (g === f || fux[f] * fux[g] + fuy[f] * fuy[g] + fuz[f] * fuz[g] >= cosT) { x += fnx[g]; y += fny[g]; z += fnz[g]; }
    }
    const l = Math.hypot(x, y, z) || 1;
    nrm[v * 3] = x / l; nrm[v * 3 + 1] = y / l; nrm[v * 3 + 2] = z / l;
  }
  return { pos, nrm };
}

// Baked contact shading. The opaque shell is voxelised, then every vertex is
// darkened by how much of the hemisphere over it is blocked close by: wing
// roots, the undersides of plates, the gaps between pods, the insides of ducts.
// bufs: [{ pos, nrm, col, skip? }] — col is multiplied in place; vertices flagged in skip neither cast nor receive.
export function bakeAO(bufs, o = {}) {
  const vox = o.vox || 0.0085, floor = o.floor ?? 0.36, pad = 2;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of bufs) {
    const p = b.pos;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
  }
  if (!(x1 > x0)) return;
  const nx = Math.ceil((x1 - x0) / vox) + 2 * pad + 1, ny = Math.ceil((y1 - y0) / vox) + 2 * pad + 1, nz = Math.ceil((z1 - z0) / vox) + 2 * pad + 1;
  const occ = new Uint8Array(nx * ny * nz), iv = 1 / vox;
  const at = (x, y, z) => {
    const i = Math.floor((x - x0) * iv) + pad, j = Math.floor((y - y0) * iv) + pad, k = Math.floor((z - z0) * iv) + pad;
    return i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : i + nx * (j + ny * k);
  };
  for (const b of bufs) {
    const p = b.pos;
    for (let t = 0; t < p.length; t += 9) {
      if (b.skip && b.skip[t / 3]) continue;
      const ax = p[t], ay = p[t + 1], az = p[t + 2];
      const ux = p[t + 3] - ax, uy = p[t + 4] - ay, uz = p[t + 5] - az, vx = p[t + 6] - ax, vy = p[t + 7] - ay, vz = p[t + 8] - az;
      const m = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
      const n = Math.max(1, Math.min(72, Math.ceil(m / (vox * 0.7))));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n, q = at(ax + ux * u + vx * v, ay + uy * u + vy * v, az + uz * u + vz * v);
        if (q >= 0) occ[q] = 1;
      }
    }
  }
  const D = [2.3 * vox, 3.7 * vox, 5.6 * vox, 8.4 * vox], Wt = [1, 0.8, 0.55, 0.32];
  const hit = (x, y, z, dx, dy, dz) => {
    for (let k = 0; k < 4; k++) { const q = at(x + dx * D[k], y + dy * D[k], z + dz * D[k]); if (q >= 0 && occ[q]) return Wt[k]; }
    return 0;
  };
  for (const b of bufs) {
    const p = b.pos, nr = b.nrm, c = b.col;
    for (let i = 0; i < p.length; i += 3) {
      if (b.skip && b.skip[i / 3]) continue;
      const x = p[i], y = p[i + 1], z = p[i + 2], a = nr[i], bb = nr[i + 1], cc = nr[i + 2];
      // tangent frame
      let tx, ty, tz;
      if (Math.abs(bb) < 0.9) { tx = cc; ty = 0; tz = -a; } else { tx = 0; ty = -cc; tz = bb; }
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const sx = bb * tz - cc * ty, sy = cc * tx - a * tz, sz = a * ty - bb * tx;
      const A = 0.8, B = 0.6;
      let s = hit(x, y, z, a, bb, cc) * 1.4;
      s += hit(x, y, z, a * A + tx * B, bb * A + ty * B, cc * A + tz * B);
      s += hit(x, y, z, a * A - tx * B, bb * A - ty * B, cc * A - tz * B);
      s += hit(x, y, z, a * A + sx * B, bb * A + sy * B, cc * A + sz * B);
      s += hit(x, y, z, a * A - sx * B, bb * A - sy * B, cc * A - sz * B);
      const k = 1 - (1 - floor) * Math.min(1, s / 3.6);
      c[i] *= k; c[i + 1] *= k; c[i + 2] *= k;
    }
  }
}

/* ========================================================================== */
/*  Livery: top-projected texture set painted in plan (x,z) coordinates       */
/* ========================================================================== */

const UV_X0 = 0.54, UV_XW = 1.08;

export class Livery {
  constructor(doc, zr, res) {
    this.zr = zr; this.W = res; this.s = res / UV_XW; this.H = Math.max(64, Math.round(2 * zr * this.s));
    this.px = 1 / this.s;
    const mk = () => {
      const c = doc.createElement('canvas'); c.width = this.W; c.height = this.H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.setTransform(this.s, 0, 0, this.s, UV_X0 * this.s, zr * this.s);
      x.lineJoin = 'round'; x.lineCap = 'round';
      return x;
    };
    this.a = mk(); this.h = mk(); this.o = mk();
    this.h.fillStyle = '#808080'; this.h.fillRect(-1, -1, 2, 2);
  }
  static orm(rough, metal) { return `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`; }
  _path(c, pts, close) {
    c.beginPath();
    for (let i = 0; i < pts.length; i++) (i ? c.lineTo(pts[i][0], pts[i][1]) : c.moveTo(pts[i][0], pts[i][1]));
    if (close) c.closePath();
  }
  base(col, rough = 0.56, metal = 0.2) {
    this.a.fillStyle = css(col); this.a.fillRect(-1, -1, 2, 2);
    this.o.fillStyle = Livery.orm(rough, metal); this.o.fillRect(-1, -1, 2, 2);
  }
  // paint a polygon; o: { rough, metal, h (-1..1 height step), alpha }
  fill(pts, col, o = {}) {
    if (col != null) {
      this._path(this.a, pts, true);
      this.a.fillStyle = o.alpha != null ? rgba(col, o.alpha) : css(col); this.a.fill();
    }
    if (o.rough != null || o.metal != null) {
      this._path(this.o, pts, true); this.o.fillStyle = Livery.orm(o.rough ?? 0.56, o.metal ?? 0.2); this.o.fill();
    }
    if (o.h) {
      const g = Math.round(128 + o.h * 100);
      this._path(this.h, pts, true); this.h.fillStyle = `rgb(${g},${g},${g})`; this.h.fill();
    }
  }
  // engraved panel line (w in texels)
  line(pts, o = {}) {
    const w = (o.w ?? 1.5) * this.px;
    this._path(this.a, pts, o.close);
    this.a.strokeStyle = `rgba(6,8,12,${o.a ?? 0.6})`; this.a.lineWidth = w; this.a.stroke();
    this._path(this.h, pts, o.close);
    this.h.strokeStyle = '#303030'; this.h.lineWidth = w + this.px * 0.8; this.h.stroke();
    this._path(this.o, pts, o.close);
    this.o.strokeStyle = Livery.orm(0.8, 0.2); this.o.lineWidth = w; this.o.stroke();
  }
  // painted line (pinstripe)
  stripe(pts, col, wUnits, o = {}) {
    this._path(this.a, pts, o.close);
    this.a.strokeStyle = css(col); this.a.lineWidth = wUnits; this.a.lineCap = 'butt'; this.a.stroke(); this.a.lineCap = 'round';
  }
  rect(x0, z0, x1, z1) { return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }
  // access hatch: outlined rounded panel with corner fasteners
  hatch(x0, z0, x1, z1, o = {}) {
    const r = Math.min(Math.abs(x1 - x0), Math.abs(z1 - z0)) * 0.22;
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1), za = Math.min(z0, z1), zb = Math.max(z0, z1);
    const pts = [[xa + r, za], [xb - r, za], [xb, za + r], [xb, zb - r], [xb - r, zb], [xa + r, zb], [xa, zb - r], [xa, za + r]];
    if (o.col != null) this.fill(pts, o.col, o);
    this.line(pts, { close: true, w: 1.2, a: 0.55 });
    this.dots([[xa + r, za + r], [xb - r, za + r], [xb - r, zb - r], [xa + r, zb - r]], 1.1);
  }
  dots(pts, rTex = 1) {
    const r = rTex * this.px;
    for (const [x, z] of pts) {
      this.a.fillStyle = 'rgba(10,12,16,0.5)'; this.a.beginPath(); this.a.arc(x, z, r, 0, TAU); this.a.fill();
      this.h.fillStyle = '#404040'; this.h.beginPath(); this.h.arc(x, z, r * 1.2, 0, TAU); this.h.fill();
    }
  }
  rivets(a, b, n) { const p = []; for (let i = 0; i <= n; i++) p.push([lerp(a[0], b[0], i / n), lerp(a[1], b[1], i / n)]); this.dots(p, 0.8); }
  // soft shading along a polyline (fake ambient occlusion / soot / highlights)
  shade(pts, wUnits, alpha, col = '0,0,0') {
    for (let i = 1; i <= 5; i++) {
      this._path(this.a, pts, false);
      this.a.strokeStyle = `rgba(${col},${alpha / 3})`; this.a.lineWidth = (wUnits * i) / 5; this.a.stroke();
    }
  }
  text(str, x, z, size, col, rot = 0, font = '900') {
    const c = this.a;
    c.save(); c.translate(x, z); c.rotate(rot); c.scale(size / 100, size / 100);
    c.font = `${font} 100px "Arial Black", "Helvetica Neue", Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = css(col); c.fillText(str, 0, 0); c.restore();
  }
  // weathering: airflow streaks, chips, roughness blotches
  wear(seed, amt = 1) {
    const R = rng(seed), a = this.a, o = this.o, px = this.px, zr = this.zr;
    for (let i = 0; i < 26; i++) { // broad tonal blotches
      const x = R() - 0.5, z = (R() * 2 - 1) * zr, r = 0.04 + R() * 0.12, dark = R() < 0.6;
      const g = a.createRadialGradient(x, z, 0, x, z, r);
      g.addColorStop(0, dark ? `rgba(0,0,0,${0.10 * amt})` : `rgba(255,255,255,${0.07 * amt})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = g; a.fillRect(x - r, z - r, r * 2, r * 2);
      const g2 = o.createRadialGradient(x, z, 0, x, z, r);
      g2.addColorStop(0, dark ? 'rgba(255,190,60,0.35)' : 'rgba(255,70,120,0.3)'); g2.addColorStop(1, 'rgba(255,128,90,0)');
      o.fillStyle = g2; o.fillRect(x - r, z - r, r * 2, r * 2);
    }
    for (let i = 0; i < 420 * amt; i++) { // airflow streaks
      const x = R() * 1.02 - 0.51, z = (R() * 2 - 1) * zr, l = 0.01 + R() * 0.05;
      a.strokeStyle = R() < 0.65 ? `rgba(0,0,0,${0.05 + R() * 0.08})` : `rgba(255,255,255,${0.04 + R() * 0.07})`;
      a.lineWidth = px * (0.8 + R() * 1.6); a.beginPath(); a.moveTo(x, z); a.lineTo(x - l, z + (R() - 0.5) * 0.004); a.stroke();
    }
    for (let i = 0; i < 260 * amt; i++) { // paint chips down to metal
      const x = R() * 1.02 - 0.51, z = (R() * 2 - 1) * zr, w = px * (0.8 + R() * 2.2), h = px * (0.8 + R() * 1.6);
      a.fillStyle = `rgba(190,196,204,${0.25 + R() * 0.4})`; a.fillRect(x, z, w, h);
      o.fillStyle = Livery.orm(0.28, 0.95); o.fillRect(x, z, w, h);
    }
  }
  swatch() { // flat white block that "solid colour" parts sample
    const p = this.rect(0.45, -this.zr, 0.54, -this.zr + 0.06);
    this.fill(p, 0xffffff, { rough: 0.56, metal: 0.2 });
    this._path(this.h, p, true); this.h.fillStyle = '#808080'; this.h.fill();
  }
  finish(THREE, aniso) {
    const W = this.W, H = this.H;
    const src = this.h.getImageData(0, 0, W, H).data;
    const nc = this.h.canvas.ownerDocument.createElement('canvas'); nc.width = W; nc.height = H;
    const nx = nc.getContext('2d'), img = nx.createImageData(W, H), d = img.data, K = 5 / 255;
    for (let y = 0; y < H; y++) {
      const ym = (y > 0 ? y - 1 : y) * W, yp = (y < H - 1 ? y + 1 : y) * W, y0 = y * W;
      for (let x = 0; x < W; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < W - 1 ? x + 1 : x;
        const dx = (src[(y0 + xp) * 4] - src[(y0 + xm) * 4]) * K, dy = (src[(yp + x) * 4] - src[(ym + x) * 4]) * K;
        const l = 1 / Math.sqrt(dx * dx + dy * dy + 1), i = (y0 + x) * 4;
        d[i] = (-dx * l * 0.5 + 0.5) * 255; d[i + 1] = (dy * l * 0.5 + 0.5) * 255; d[i + 2] = (l * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
    }
    nx.putImageData(img, 0, 0);
    const tex = (canvas, srgb) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      return t;
    };
    return { map: tex(this.a.canvas, true), orm: tex(this.o.canvas, false), normal: tex(nc, false) };
  }
}

/* ========================================================================== */
/*  Build kit: material buckets + shared ship parts                           */
/* ========================================================================== */

const GLASS_A = 0.34;
// emissive channels: every glowing vertex names one, and its level is a uniform
const CH = { STATIC: 0, ENGINE: 1, NAV: 2, STROBE: 3, ACCENT: 4, COCKPIT: 5, AB: 6, SHIM: 7, GOLD: 8, BHEAT: 9, COIL: 10, LASER: 11, ROCKET: 12, FLASHA: 13, FLASHB: 14, SPARK: 15, PUFF: 16, CHARGE: 17 };
const NCH = 18;
// rig: slot 0 is the rigid hull; the others are posed every frame from the state channels below
const NP = 48;
const S = {
  ONE: 0, BANK: 1, PITCH: 2, YAW: 3, BRAKE: 4, THR: 5, AB: 6, GEARD: 7, GEARL: 8, CANOPY: 9, W2: 10, W3: 11,
  FIREA: 12, FIREB: 13, ROCKET: 14, LASER: 15, OD: 16, BRK1: 17, BRK2: 18, SPIN: 19, BREATHE: 20, DMG1: 21, DMG2: 22,
  GUT: 23, TWITCH: 24, BANKP: 25, BANKN: 26, SWEEP: 27, RAIL: 28, KICK: 29, N: 30,
};
const HEATC = [5.5, 1.5, 0.25], GOLDC = [6.5, 4.2, 0.7], SPARKC = [7, 2.4, 0.4];
const METAL = lin(0x9aa0a8), GUNMETAL = lin(0x3a3e45), SOOT = lin(0x17171a), PITCH = lin(0x08090b);
const K3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const NAV_RED = [6.5, 0.25, 0.18], NAV_GREEN = [0.2, 5.5, 0.9], NAV_WHITE = [5, 5.4, 6.5];

export class Kit {
  constructor(q, zr, P) {
    this.q = q; this.zr = zr; this.P = P;
    this.hull = { pos: [], nrm: [], col: [], uv: [], rig: [] };
    this.mech = { pos: [], nrm: [], col: [], rig: [] };
    this.glass = { pos: [], nrm: [], col: [], rig: [] };
    this.emis = { pos: [], col: [], ch: [], rig: [] };
    this.nozzles = []; this.muzzles = [];
    this.parts = [{ p: [0, 0, 0], a: [0, 0, 1], ao: true, tag: 0 }]; this.ri = 0; this.rw = null;
    this.groundY = 0; this.tears = [];
    this.nosePart = 0; this.noseW = null; this.noseK = 0; this.rocketPort = null;
    this.sw = [(0.495 + UV_X0) / UV_XW, 1 - 0.03 / (2 * zr)];
  }
  seg(n) { return this.q >= 1 ? n : Math.max(6, Math.round(n * 0.55)); }
  /* ---- rig ---- */
  // Declare a moving part. Terms are flat lists read against the state channels S:
  //   rot  [ch, radians, ...] about axis a through pivot p     rot2 the same about a2 (applied after)
  //   mov  [ch, dx, dy, dz, ...]                               iris [ch, gain, ...] → YZ scale 1 + sum
  //   vis  [base, ch, gain, ...] → shown while the sum > 0     glow [base, ch, gain, ...] → emissive level
  // ao:false keeps the part out of the baked contact shading (things that are stowed or hidden at rest);
  // brk 1|2 marks the piece breakOff() throws away; raw:true exempts it from the burn-through shading.
  part(o = {}) {
    if (this.parts.length >= NP) throw new Error('ships3d: out of rig slots');
    const a = o.a || [0, 0, 1], l = Math.hypot(a[0], a[1], a[2]) || 1;
    this.parts.push({
      p: (o.p || [0, 0, 0]).slice(), a: [a[0] / l, a[1] / l, a[2] / l], rot: o.rot || null, a2: o.a2 || null, rot2: o.rot2 || null,
      mov: o.mov ? o.mov.slice() : null, vis: o.vis || null, iris: o.iris || null, glow: o.glow || null, ao: o.ao !== false, brk: o.brk || 0, range: [],
      tag: o.raw ? 0.25 : 0, // raw: torn metal — the damage shader leaves it alone
    });
    return this.parts.length - 1;
  }
  // emit everything fn builds into rig slot i; w(x,y,z) → 0..1 blends a vertex between rest and posed
  in(i, fn, w) { const pi = this.ri, pw = this.rw; this.ri = i; this.rw = w || null; fn(); this.ri = pi; this.rw = pw; }
  _emit(b, t, col, crease, mode) {
    const { pos, nrm } = creaseNormals(t, Math.cos((crease ?? 32) * DEG));
    const zr = this.zr, ri = this.ri, v0 = b.pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) {
      b.pos.push(pos[i], pos[i + 1], pos[i + 2]);
      b.nrm.push(nrm[i], nrm[i + 1], nrm[i + 2]);
      b.col.push(col[0], col[1], col[2]);
      b.rig.push(ri + this.parts[ri].tag, ri ? (this.rw ? this.rw(pos[i], pos[i + 1], pos[i + 2]) : 1) : 0);
      if (b.uv) {
        if (mode === 1) b.uv.push(this.sw[0], this.sw[1]);
        else b.uv.push((pos[i] + UV_X0) / UV_XW, 1 - (pos[i + 2] + zr) / (2 * zr));
      }
    }
    if (ri && b === this.hull && this.parts[ri].brk) this.parts[ri].range.push(v0, b.pos.length / 3);
  }
  // painted hull: colour comes from the livery texture (plan projection)
  paint(t, o = {}) { const s = o.shade ?? 1; this._emit(this.hull, t, [s, s, s], o.crease, 0); }
  // hull-material part in one flat colour (fins, vertical faces, recesses)
  solid(t, col, o = {}) { this._emit(this.hull, t, col, o.crease, 1); }
  metal(t, col = METAL, crease) { this._emit(this.mech, t, col, crease); }
  glassy(t, col) { this._emit(this.glass, t, col, 50); }

  /* ---- emissives (additive, HDR) ---- */
  glow(a, b, c, ca, cb, cc, ch, ea = 0, eb = 0, ec = 0) {
    const E = this.emis;
    E.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    E.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    E.ch.push(ch, ea, ch, eb, ch, ec);
    const ri = this.ri, w = this.rw;
    E.rig.push(ri, ri ? (w ? w(a[0], a[1], a[2]) : 1) : 0, ri, ri ? (w ? w(b[0], b[1], b[2]) : 1) : 0, ri, ri ? (w ? w(c[0], c[1], c[2]) : 1) : 0);
  }
  glowTris(t, col, ch) {
    for (let i = 0; i < t.length; i += 9) this.glow([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]], col, col, col, ch);
  }
  glowBox(x0, x1, y0, y1, z0, z1, col, ch) { this.glowTris(box(x0, x1, y0, y1, z0, z1), col, ch); }
  glowBall(x, y, z, r, col, ch) {
    this.glowTris(lathe([[x - r, r * 0.02], [x - r * 0.6, r * 0.8], [x + r * 0.6, r * 0.8], [x + r, r * 0.02]], 6, { y, z }), col, ch);
  }
  // frustum between two YZ rings, per-ring colour and thrust extension
  glowCone(x0, r0, c0, e0, x1, r1, c1, e1, y, z, n, ch, sy = 1, sz = 1) {
    for (let j = 0; j < n; j++) {
      const a0 = (j / n) * TAU, a1 = ((j + 1) / n) * TAU;
      const p = (x, r, a) => [x, y + Math.sin(a) * r * sy, z + Math.cos(a) * r * sz];
      const A = p(x0, r0, a0), B = p(x0, r0, a1), C = p(x1, r1, a1), D = p(x1, r1, a0);
      this.glow(A, B, C, c0, c0, c1, ch, e0, e0, e1);
      this.glow(A, C, D, c0, c1, c1, ch, e0, e1, e1);
    }
  }

  /* ---- shared parts ---- */
  // disc of concentric emissive rings in the YZ plane: stops = [[r, col], ...] from the centre out
  glowDisc(x, y, z, stops, n, ch, sy = 1, sz = 1, e = 0) {
    for (let i = 0; i < stops.length - 1; i++) this.glowCone(x, Math.max(1e-5, stops[i][0]), stops[i][1], e, x, stops[i + 1][0], stops[i + 1][1], e, y, z, n, ch, sy, sz);
  }
  // shaped exhaust flame behind an exit plane at x: sheath, core spike and shock diamonds. Every
  // vertex carries a thrust extension (> 0 marks it as plume, which the shader fades end-on).
  flame(x, y, z, r, E, n, sy = 1, sz = 1, o = {}) {
    const k = o.k ?? 1, K = (c, m) => [c[0] * m * k, c[1] * m * k, c[2] * m * k], Z = [0, 0, 0], e0 = 1e-4, CE = CH.ENGINE;
    const xb = x + r * 0.12;
    // sheath: swells just past the lip, then tapers
    this.glowCone(xb, r * 0.76, K(E.mid, 0.08), e0, x - r * 0.1, r * 0.7, K(E.mid, 0.065), r * 0.55, y, z, n, CE, sy, sz);
    this.glowCone(x - r * 0.1, r * 0.7, K(E.mid, 0.065), r * 0.55, x - r * 0.3, r * 0.05, Z, r * 2.1, y, z, n, CE, sy, sz);
    // core spike
    this.glowCone(xb, r * 0.4, K(E.hot, 0.045), e0, x - r * 0.05, r * 0.3, K(E.hot, 0.04), r * 0.3, y, z, n, CE, sy, sz);
    this.glowCone(x - r * 0.05, r * 0.3, K(E.hot, 0.04), r * 0.3, x - r * 0.2, r * 0.03, Z, r * 1.35, y, z, n, CE, sy, sz);
    // shock diamonds riding the core
    const nd = o.diamonds ?? (this.q >= 1 ? 3 : 2), m = Math.max(6, n >> 1);
    for (let i = 0; i < nd; i++) {
      const ec = r * (0.42 + 0.46 * i), h = r * 0.2, w = r * (0.3 - 0.06 * i), c = K(E.hot, 0.1 - 0.02 * i);
      this.glowCone(x - r * 0.06, r * 0.04, Z, ec - h, x - r * 0.08, w, c, ec, y, z, m, CE, sy, sz);
      this.glowCone(x - r * 0.08, w, c, ec, x - r * 0.1, r * 0.04, Z, ec + h, y, z, m, CE, sy, sz);
    }
  }
  // engine nozzle whose exit plane is at x (opening toward -X), length len. The petals, liner and
  // plume ride one rig slot: weighted from the hinge ring to the lip, it opens/closes as an iris
  // with thrust and vectors with pitch / yaw / bank. The first nozzle built is the one that gutters.
  nozzle(x, y, z, r, len, o = {}) {
    const hx = x + len * 0.44, v = o.vec ?? 1, bs = z > 0.001 ? -1 : z < -0.001 ? 1 : 0, ik = o.iris ?? 1;
    const np = this.part({
      p: [hx, y, z], a: [0, 0, 1], rot: [S.PITCH, -0.17 * v, S.BANK, 0.11 * v * bs], a2: [0, 1, 0], rot2: [S.YAW, -0.15 * v],
      iris: [S.ONE, -0.15 * ik, S.THR, 0.15 * ik, S.AB, 0.17 * ik, S.BREATHE, 0.014],
      glow: this.nozzles.length === 0 ? [0, S.GUT, 1] : null,
    });
    this.in(np, () => this._nozzle(x, y, z, r, len, o), (X) => clamp((hx - X) / (len * 0.4), 0, 1));
    return np;
  }
  _nozzle(x, y, z, r, len, o) {
    const n = this.seg(20), np = this.seg(14), sy = o.sy || 1, sz = o.sz || 1, L = { y, z, sy, sz };
    const E0 = this.P.eng, K = (c, m) => [c[0] * m, c[1] * m, c[2] * m];
    // collar + actuator band (bare metal)
    this.metal(lathe([[x + len, r * 1.0], [x + len * 0.66, r * 1.09], [x + len * 0.62, r * 1.18], [x + len * 0.46, r * 1.18], [x + len * 0.42, r * 1.08]], n, { ...L, capA: false, capB: false }), o.band || METAL, 30);
    // convergent petals (faceted, heat-stained) turning in over the lip
    this.metal(lathe([[x + len * 0.43, r * 1.07], [x + len * 0.04, r * 0.96], [x, r * 0.91], [x + len * 0.03, r * 0.85]], np, { ...L, capA: false, capB: false, phase: 0.2 }), lin(0x4a4038), 12);
    // liner down to the flame holder, closed by a back wall
    const xh = x + len * 0.58;
    this.metal(lathe([[x + len * 0.03, r * 0.85], [x + len * 0.3, r * 0.8], [xh, r * 0.76], [xh + len * 0.04, r * 0.4], [xh + len * 0.05, 0.0005]], np, { ...L, capA: false, capB: false, phase: 0.2 }), lin(0x2b2623), 14);
    if (this.q >= 1) { // petal actuator struts
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * TAU + 0.39, cy = y + Math.sin(a) * r * 1.13 * sy, cz = z + Math.cos(a) * r * 1.13 * sz, w = r * 0.07;
        this.metal(box(x + len * 0.18, x + len * 0.5, cy - w, cy + w, cz - w, cz + w), GUNMETAL, 30);
      }
    }
    // flame holder: tail cone, gutter ring and radial struts, black against the burner
    const fh = [], DKM = lin(0x101012);
    for (const t of lathe([[xh, r * 0.2], [xh - len * 0.1, r * 0.17], [xh - len * 0.3, r * 0.015]], this.seg(10), { capA: false })) fh.push(t);
    for (const t of lathe([[xh - len * 0.02, r * 0.43], [xh - len * 0.075, r * 0.47], [xh - len * 0.02, r * 0.52]], this.seg(16), {})) fh.push(t);
    const ns = this.q >= 1 ? 6 : 3;
    for (let j = 0; j < ns; j++) for (const t of rotX(box(xh - len * 0.07, xh - len * 0.005, -r * 0.035, r * 0.035, r * 0.16, r * 0.78), (j / ns) * TAU + 0.26)) fh.push(t);
    for (let i = 0; i < fh.length; i += 3) { fh[i + 1] = y + fh[i + 1] * sy; fh[i + 2] = z + fh[i + 2] * sz; }
    this.metal(fh, DKM, 30);
    // burner face: white-hot core fading out to the wall
    this.glowDisc(xh - 0.0006, y, z, [[0, K(E0.hot, 0.2)], [r * 0.2, K(E0.hot, 0.16)], [r * 0.4, K(E0.mid, 0.3)], [r * 0.6, K(E0.mid, 0.13)], [r * 0.76, K(E0.rim, 0.1)]], n, CH.ENGINE, sy, sz);
    // afterburner ring: a thin hot annulus just inside the liner
    const xa = x + len * 0.34;
    this.glowCone(xa, r * 0.68, K(E0.hot, 0.1), 0, xa - len * 0.02, r * 0.745, K(E0.hot, 0.34), 0, y, z, n, CH.ENGINE, sy, sz);
    this.glowCone(xa - len * 0.02, r * 0.745, K(E0.hot, 0.34), 0, xa - len * 0.04, r * 0.8, K(E0.mid, 0.12), 0, y, z, n, CH.ENGINE, sy, sz);
    // glowing liner walls, cooling toward the lip, and the hot petal tips
    this.glowCone(xh, r * 0.76, K(E0.mid, 0.2), 0, x + len * 0.05, r * 0.845, K(E0.rim, 0.05), 0, y, z, n, CH.ENGINE, sy, sz);
    this.glowCone(x + len * 0.035, r * 0.845, K(E0.rim, 0.22), 0, x + len * 0.005, r * 0.9, K(E0.rim, 0.02), 0, y, z, n, CH.ENGINE, sy, sz);
    this.flame(x, y, z, r, E0, n, sy, sz);
    // afterburner: two shock rings riding the plume and a hot band on the lip, lit only above cruise
    for (const [rr, e, kk] of [[0.84, r * 0.25, 0.16], [0.62, r * 0.85, 0.11]]) {
      const c = K(E0.hot, kk), c2 = K(E0.mid, kk * 0.5);
      this.glowCone(x - r * 0.02, r * rr * 0.86, c2, e, x - r * 0.02, r * rr, c, e, y, z, n, CH.AB, sy, sz);
      this.glowCone(x - r * 0.02, r * rr, c, e, x - r * 0.1, r * rr * 0.97, c2, e + r * 0.1, y, z, n, CH.AB, sy, sz);
    }
    this.glowCone(x + len * 0.2, r * 0.82, K(E0.mid, 0.12), 0, x + len * 0.01, r * 0.9, K(E0.hot, 0.1), 0, y, z, n, CH.AB, sy, sz);
    this.nozzles.push({ x, y, z, r: r * 0.9 * Math.max(sy, sz) });
  }
  // gun barrel from x0 (breech) to x1 (muzzle)
  barrel(x0, x1, y, z, r, o = {}) {
    const n = this.seg(10);
    this.metal(lathe([[x0, r * 1.5], [x0 + r * 2, r * 1.5], [x0 + r * 2.6, r], [x1 - r * 5, r], [x1 - r * 4.6, r * 1.45], [x1 - r * 0.8, r * 1.45], [x1, r * 1.15], [x1 - r * 0.3, r * 0.72], [x1 - r * 4, r * 0.6]], n, { y, z, capB: false }), o.col || GUNMETAL, 30);
    this.glowCone(x1 - r * 2.5, 0.0001, this.P.glow.map((v) => v * 0.7), 0, x1 - r * 2.5, r * 0.62, this.P.glow.map((v) => v * 0.35), 0, y, z, n, CH.ACCENT);
    if (o.muzzle !== false) this.muzzles.push({ x: x1, y, z });
  }
  navLight(x, y, z, col, ch = CH.NAV, r = 0.0105) {
    this.metal(lathe([[x - r * 1.5, r * 0.6], [x - r * 1.1, r * 1.05], [x + r * 1.1, r * 1.05], [x + r * 1.5, r * 0.6]], 6, { y: y - r * 0.5, z }), GUNMETAL, 40);
    this.glowBall(x, y + r * 0.25, z, r, col, ch);
  }
  missile(x0, x1, y, z, r, col) {
    const n = this.seg(8), len = x1 - x0;
    this.solid(lathe([[x0, r * 0.7], [x0 + len * 0.04, r], [x1 - len * 0.2, r], [x1 - len * 0.06, r * 0.55], [x1, r * 0.05]], n, { y, z }), col || lin(0xd8dce0), { crease: 35 });
    this.solid(lathe([[x1 - len * 0.2, r * 1.02], [x1 - len * 0.06, r * 0.57], [x1, r * 0.06]], n, { y, z, capA: false }), lin(0x2a2d33), { crease: 35 });
    for (const a of [45, 135, 225, 315]) { // tail fins
      const f = box(x0 + len * 0.02, x0 + len * 0.2, y + r * 0.6, y + r * 2.3, z - r * 0.12, z + r * 0.12);
      this.solid(rotX(f, a * DEG, y, z), lin(0x3a3e45), { crease: 30 });
    }
  }
  // canopy: glass bubble over keys {x,w,t}, sill frame and arches, pilot + instruments
  canopy(keys, y0, o = {}) {
    const n = o.n || this.seg(18), sub = this.q >= 1 ? 5 : 3;
    const gk = keys.map((k) => ({ x: k.x, w: k.w, t: k.t, b: 0.004, y: y0, et: o.et || 2.2, eb: 2 }));
    const G = fuselage(gk, { n, sub });
    const fc = o.frame || lin(0x1b1f26);
    // the hood (glass, arches, spine) lifts on a hinge behind the seat
    const hood = this.part({ p: [keys[0].x + 0.006, y0 + 0.002, 0], a: [0, 0, 1], rot: [S.CANOPY, o.lift ?? 0.8] });
    this.in(hood, () => this.glassy(G.tris, K3(this.P.glass, 0.42)));
    // sill (stays on the hull)
    this.solid(fuselage(keys.map((k) => ({ x: k.x, w: k.w * 1.1 + 0.004, t: Math.max(0.003, k.t * 0.2), b: 0.012, y: y0 - 0.001, et: 2.6, eb: 2 })), { n, sub: 3 }).tris, fc, { crease: 40 });
    this.in(hood, () => {
    // arches
    for (const ax of o.arches || []) {
      const s = G.at(ax), hw = o.archW || 0.0045;
      const R = (x) => secRing(x, { w: s.w * 1.04 + 0.0015, t: s.t * 1.04 + 0.0015, b: 0.004, y: y0, et: s.et, eb: 2 }, n);
      this.solid(loft([R(ax - hw), R(ax + hw)]), fc, { crease: 40 });
    }
    if (o.spine) { // centre frame along the top
      const x0 = o.spine[0], x1 = o.spine[1], rings = [];
      for (let i = 0; i <= 6; i++) { const x = lerp(x0, x1, i / 6), s = G.at(x); rings.push(ringRect(x, y0 + s.t * 0.6, y0 + s.t + 0.002, -0.003, 0.003)); }
      this.solid(loft(rings), fc, { crease: 40 });
    }
    });
    // cockpit: tub, side consoles, seat, pilot (suit, helmet, visor), instrument coaming and glowing screens
    const px = o.pilot ?? lerp(keys[0].x, keys[keys.length - 1].x, 0.48), s = G.at(px);
    const x0 = keys[0].x, x1 = keys[keys.length - 1].x, sw = s.w, st = s.t, ig = this.P.glow;
    const tub = (xa, xb) => { const a = G.at(xa), b2 = G.at(xb); return loft([ringRect(xa, y0 - 0.005, y0 + 0.003, -a.w * 0.82, a.w * 0.82), ringRect(xb, y0 - 0.005, y0 + 0.003, -b2.w * 0.82, b2.w * 0.82)]); };
    this.solid(tub(lerp(x0, x1, 0.14), px), PITCH); this.solid(tub(px, lerp(x0, x1, 0.86)), PITCH);
    for (const sd of [1, -1]) { // side consoles with switch lights
      this.solid(box(px - 0.03, px + 0.03, y0, y0 + st * 0.26, sd * sw * 0.56, sd * sw * 0.8, 0.002), lin(0x191c22), { crease: 30 });
      for (let i = 0; i < 3; i++) this.glowBox(px - 0.018 + i * 0.014, px - 0.012 + i * 0.014, y0 + st * 0.262, y0 + st * 0.29, sd * sw * 0.62, sd * sw * 0.7, i === 1 ? [1.6, 0.5, 0.12] : K3(ig, 0.16), CH.COCKPIT);
    }
    // seat: pan, raked back, headrest
    const bx = px - 0.03, SEAT = lin(o.seat || 0x34302a);
    this.solid(box(bx, px + 0.012, y0, y0 + st * 0.14, -sw * 0.4, sw * 0.4, 0.002), SEAT, { crease: 30 });
    this.solid(rotZ(box(bx - 0.005, bx + 0.007, y0, y0 + st * 0.7, -sw * 0.42, sw * 0.42, 0.002), 0.14, bx, y0), SEAT, { crease: 30 });
    this.solid(box(bx - 0.013, bx - 0.003, y0 + st * 0.56, y0 + st * 0.82, -sw * 0.24, sw * 0.24, 0.002), lin(0x1a1a1c), { crease: 30 });
    // pilot
    const hr = Math.min(sw * 0.34, st * 0.27), hx = px - 0.008, hy = y0 + st * 0.6;
    this.solid(loft([ringRect(hx - 0.012, y0 + st * 0.1, y0 + st * 0.42, -sw * 0.38, sw * 0.38, sw * 0.1), ringRect(hx + 0.008, y0 + st * 0.1, y0 + st * 0.36, -sw * 0.32, sw * 0.32, sw * 0.1)]), lin(o.suit || 0x4a5048), { crease: 40 });
    this.solid(lathe([[hx - hr, hr * 0.12], [hx - hr * 0.7, hr * 0.74], [hx, hr], [hx + hr * 0.7, hr * 0.74], [hx + hr, hr * 0.12]], 10, { y: hy }), lin(o.helmet || 0xd4d8dc), { crease: 60 });
    this.solid(lathe([[hx + hr * 0.25, hr * 0.8], [hx + hr * 0.72, hr * 0.74], [hx + hr * 1.06, hr * 0.3], [hx + hr * 1.1, hr * 0.02]], 10, { y: hy - hr * 0.12, sy: 0.72, sz: 0.98, capA: false }), lin(0x06080c), { crease: 60 }); // visor
    this.solid(box(hx - hr * 0.5, hx + hr * 0.55, hy + hr * 0.82, hy + hr * 1.03, -hr * 0.16, hr * 0.16, 0.001), lin(o.stripe || this.P.accent || 0x808890), { crease: 40 });
    // coaming + screens (raked toward the pilot), HUD combiner
    const cx = px + 0.03, cs = G.at(cx);
    this.solid(loft([ringRect(cx - 0.004, y0, y0 + cs.t * 0.5, -cs.w * 0.62, cs.w * 0.62, 0.002), ringRect(cx + 0.02, y0, y0 + cs.t * 0.34, -cs.w * 0.5, cs.w * 0.5, 0.002)]), lin(0x101216), { crease: 30 });
    for (const [za, zb, col] of [[-0.52, -0.2, K3(ig, 0.34)], [-0.14, 0.14, K3(ig, 0.5)], [0.2, 0.52, [0.35, 1.7, 0.6]]]) {
      this.glowBox(cx - 0.0052, cx - 0.004, y0 + cs.t * 0.12, y0 + cs.t * 0.42, cs.w * za, cs.w * zb, col, CH.COCKPIT);
    }
    this.glowBox(cx + 0.006, cx + 0.0068, y0 + cs.t * 0.52, y0 + cs.t * 0.74, -cs.w * 0.2, cs.w * 0.2, K3(ig, 0.1), CH.COCKPIT);
    return G;
  }
  // rectangular intake mouth: lip ring + dark duct. ring = outer front ring pts
  duct(ring, depth, lip, o = {}) {
    const n = ring.length, c = [0, 0, 0];
    for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
    const inner = ring.map((p) => { const dy = p[1] - c[1], dz = p[2] - c[2], l = Math.hypot(dy, dz) || 1, k = Math.max(0.2, 1 - lip / l); return [p[0] - lip * 0.3, c[1] + dy * k, c[2] + dz * k]; });
    const back = inner.map((p) => [p[0] - depth, c[1] + (p[1] - c[1]) * 0.7, c[2] + (p[2] - c[2]) * 0.7]);
    const lipT = [];
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; quad(lipT, ring[j], ring[j2], inner[j2], inner[j]); }
    // face +X
    const nx = (lipT[4] - lipT[1]) * (lipT[8] - lipT[2]) - (lipT[5] - lipT[2]) * (lipT[7] - lipT[1]);
    if (nx < 0) flip(lipT);
    this.solid(lipT, o.lipCol || lin(0x2a2f37), { crease: 20 });
    this.solid(loft([inner, back], { capA: false, inward: true }), o.col || PITCH, { crease: 30 });
    if (o.glow) { // faint turbine glow deep inside
      const bc = [0, 0, 0];
      for (const p of back) { bc[0] += p[0] / n; bc[1] += p[1] / n; bc[2] += p[2] / n; }
      for (let j = 0; j < n; j++) this.glow([bc[0] + 0.002, bc[1], bc[2]], [back[j][0] + 0.002, back[j][1], back[j][2]], [back[(j + 1) % n][0] + 0.002, back[(j + 1) % n][1], back[(j + 1) % n][2]], o.glow, [0, 0, 0], [0, 0, 0], CH.ACCENT);
    }
  }
  // round intake mouth at x facing +X: lip, dark duct, shock spike
  intakeRound(x, y, z, r) {
    const n = this.seg(16), L = { y, z };
    this.solid(lathe([[x - r * 0.05, r], [x + r * 0.14, r * 0.95], [x, r * 0.84]], n, { ...L, capA: false, capB: false }), lin(0x2a2f37), { crease: 30 });
    this.solid(lathe([[x - r * 2.4, r * 0.45], [x, r * 0.84]], n, { ...L, capB: false, inward: true }), PITCH, { crease: 30 });
    this.metal(lathe([[x - r * 2.0, r * 0.5], [x - r * 0.3, r * 0.44], [x + r * 1.0, 0.0008]], n, { ...L, capA: false }), METAL, 30);
  }
  // row of dark cooling slats on a flat-ish top surface
  vents(x0, x1, y, z0, z1, n, col = SOOT) {
    for (let i = 0; i < n; i++) {
      const x = lerp(x0, x1, (i + 0.5) / n), w = ((x1 - x0) / n) * 0.3;
      this.solid(box(x - w, x + w, y - 0.004, y + 0.0022, z0, z1, 0.0012), col, { crease: 30 });
    }
  }

  /* ---- moving parts ---- */
  // Nose section that recoils when the beam fires: everything built inside nose(fn) slides back
  // `kick`, blended in over `ramp` aft of x0 so the skin telescopes instead of tearing.
  noseAt(x0, ramp = 0.05, kick = 0.03) {
    this.nosePart = this.part({ mov: [S.KICK, -kick, 0, 0] });
    this.noseK = kick;
    this.noseW = (x) => { const t = clamp((x - x0) / ramp, 0, 1); return t * t * (3 - 2 * t); };
  }
  nose(fn) { if (this.nosePart) this.in(this.nosePart, fn, this.noseW); else fn(); }
  // rocket bay: a mirrored pair of doors (see hatch) over a launch rail that pushes a round clear of
  // the skin, with a puff of gas at the breech. Registers rocketPort (the starboard round).
  rocketBay(x0, x1, z0, z1, y, o = {}) {
    const up = o.up ?? 1, yh = Array.isArray(y) ? (y[0] + y[1]) / 2 : y, lo = (a, b) => Math.min(yh + up * a, yh + up * b), hi = (a, b) => Math.max(yh + up * a, yh + up * b);
    this.hatch(x0, x1, z0, z1, y, { ...o, sym: true, open: [S.ROCKET, o.ang ?? 1.2], glow: [4, 0.5, 0.2], glowCh: CH.ROCKET });
    const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2, l = (x1 - x0) * 0.72, w = z1 - z0, rise = o.rise ?? 0.016;
    const rail = this.part({ mov: [S.RAIL, 0, up * rise, 0], vis: [0, S.RAIL, 1], ao: false });
    this.in(rail, () => {
      for (const s of [1, -1]) {
        this.metal(box(xm - l * 0.5, xm + l * 0.42, lo(-0.012, -0.007), hi(-0.012, -0.007), s * zm - w * 0.12, s * zm + w * 0.12), GUNMETAL, 30);
        for (const fx of [-0.3, 0.25]) this.metal(box(xm + l * fx - 0.003, xm + l * fx + 0.003, lo(-0.016, -0.007), hi(-0.016, -0.007), s * zm - w * 0.2, s * zm + w * 0.2), METAL, 30);
        this.missile(xm - l * 0.5, xm + l * 0.5, yh - up * 0.002, s * zm, Math.min(0.0075, w * 0.2));
      }
    });
    for (const s of [1, -1]) this.glowBall(xm - l * 0.5, yh + up * 0.008, s * zm, w * 0.42, [2.4, 2.1, 1.9], CH.PUFF);
    this.rocketPort = { x: xm, y: yh + up * 0.006, z: zm, part: rail };
  }
  // launch lamps for a bay the camera cannot see: a hooded light either side that flares with the rocket
  launchCue(x0, x1, y, z) {
    for (const s of [1, -1]) {
      this.solid(side(box(x0 - 0.004, x1 + 0.004, y - 0.004, y + 0.002, z - 0.005, z + 0.005, 0.0015), s), lin(0x14161a), { crease: 30 });
      this.glowBox(x0, x1, y + 0.002, y + 0.0036, s * z - 0.003, s * z + 0.003, [5, 0.7, 0.25], CH.ROCKET);
      this.glowBall((x0 + x1) / 2, y + 0.006, s * z, 0.008, [2.2, 1.9, 1.7], CH.PUFF);
    }
  }
  // capacitor coils across the spine: hoops with a lit band that pulses toward the nose while the beam charges
  spineCoils(pts, hw = 0.014) {
    for (const [x, y] of pts) {
      this.metal(box(x - 0.005, x + 0.005, y - 0.005, y + 0.003, -hw, hw, 0.002), GUNMETAL, 30);
      this.glowBox(x - 0.0028, x + 0.0028, y + 0.003, y + 0.0045, -hw * 0.82, hw * 0.82, K3(this.P.glow, 0.55), CH.CHARGE);
    }
  }
  // wing with hinged trailing-edge surfaces: flaps = [[z0, z1, rot], ...] aft of chord fraction fh.
  // Positive rotation = trailing edge down on either side (the port hinge axis is flipped so both
  // sides share the convention). Returns the rig slots.
  flapWing(st, s, fh, flaps, o = {}) {
    const W = wingFlap(st, flaps, fh, o), cr = o.crease ?? 26;
    this.paint(side(W.main, s), { crease: cr });
    return W.flaps.map((f, i) => {
      const part = this.part({ p: [f.p[0], f.p[1], s * f.p[2]], a: [s * f.a[0], s * f.a[1], f.a[2]], rot: flaps[i][2] });
      this.in(part, () => this.paint(side(f.flap, s), { crease: cr }));
      return part;
    });
  }
  // gold light strip along a wing at chord fraction f (overdrive trim)
  wingTrim(st, s, z0, z1, f = 0.07, o = {}) {
    const zs = [z0];
    for (const q of st) if (q.z > z0 + 1e-6 && q.z < z1 - 1e-6) zs.push(q.z);
    zs.push(z1);
    const P = (z) => { const w = wAt(st, z), x = lerp(w.xl, w.xt, f); return [x, wTop(st, x, z, 1, o.prof), s * z]; };
    for (let i = 0; i < zs.length - 1; i++) this.trim(P(zs[i]), P(zs[i + 1]), o.w ?? 0.0022);
  }
  // a hull piece breakOff() can shed (everything fn paints), plus the frames it leaves showing: rb = ribs() arguments
  shed(brk, fn, rb) {
    const B = brk === 1 ? S.BRK1 : S.BRK2, part = this.part({ brk, vis: [1, B, -1] });
    this.in(part, fn);
    if (rb) { const ex = this.part({ vis: [0, B, 1], ao: false, raw: true }); this.in(ex, () => this.ribs(...rb)); }
    return part;
  }
  // all-moving surface (canard / tailplane) about a spanwise axis through chord point x at the root
  slab(st, s, x, rot, o = {}) {
    const r = st[0], part = this.part({ p: [x, r.y, s * r.z], a: [0, 0, 1], rot });
    this.in(part, () => this.paint(side(wing(st, o), s), { crease: o.crease ?? 26 }));
    return part;
  }
  // fin standing at (y0, z0), canted by `cant` (as rotX). The panel outboard of station `cut` is an
  // all-moving rudder with a heat-shimmer skin; with brk it is also the piece breakOff() sheds,
  // leaving a torn stump on the fixed root.
  fin(st, cant, y0, z0, s, o = {}) {
    if (st.length < 3) { // give a plain two-station fin a mid station to cut at
      const a = st[0], b = st[1], t = o.at ?? 0.45;
      st = [a, { z: lerp(a.z, b.z, t), xl: lerp(a.xl, b.xl, t), xt: lerp(a.xt, b.xt, t), y: lerp(a.y, b.y, t), th: lerp(a.th, b.th, t) }, b];
    }
    const cut = o.cut ?? 1, cr = o.crease ?? 26, sn = Math.sin(cant), cs = Math.cos(cant);
    const emit = (t) => (o.col ? this.solid(t, o.col, { crease: cr }) : this.paint(t, { crease: cr }));
    const place = (t) => side(move(rotX(t, cant), 0, y0, z0), s);
    const P = (x, yl, zl) => [x, y0 + yl * cs + zl * sn, s * (z0 - yl * sn + zl * cs)];
    emit(place(wing(st.slice(0, cut + 1), { tip: false, prof: o.prof })));
    const A = st[cut], B = st[st.length - 1], ax = [0, sn, s * cs];
    const part = this.part({
      p: P(lerp(A.xl, A.xt, 0.42), 0, A.z), a: ax, rot: o.rot || [S.YAW, -0.3], brk: o.brk || 0,
      vis: o.brk ? [1, o.brk === 1 ? S.BRK1 : S.BRK2, -1] : null,
    });
    this.in(part, () => {
      emit(place(wing(st.slice(cut), { prof: o.prof })));
      if (o.heat !== false) { // heat haze over the trailing half, both faces
        const nu = 5, nv = 2;
        const pt = (u, v, sd) => {
          const th = lerp(A.th, B.th, v), h = 0.14 + 0.86 * Math.min(1, (1 - u) * 2.4);
          return P(lerp(lerp(A.xl, B.xl, v), lerp(A.xt, B.xt, v), u), sd * (th * 0.5 * h + 0.0016), lerp(A.z, B.z, v));
        };
        const cu = (u, v) => K3(HEATC, 0.34 * u * u * (0.4 + 0.6 * v));
        for (const sd of [1, -1]) for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
          const u0 = lerp(0.3, 1, i / nu), u1 = lerp(0.3, 1, (i + 1) / nu), v0 = j / nv, v1 = (j + 1) / nv;
          const a = pt(u0, v0, sd), b = pt(u1, v0, sd), c = pt(u1, v1, sd), d = pt(u0, v1, sd);
          this.glow(a, b, c, cu(u0, v0), cu(u1, v0), cu(u1, v1), CH.SHIM);
          this.glow(a, c, d, cu(u0, v0), cu(u1, v1), cu(u0, v1), CH.SHIM);
        }
      }
    });
    if (o.brk) this.stump(wingRing(A, o.prof || WPROF).map((p) => P(p[0], p[1], p[2])), ax, o.brk);
    return { part, P };
  }
  // what is left where a piece was shot away: a ragged collar of torn skin around a hot core
  stump(ring, dir, brk, len) {
    const n = ring.length, c = [0, 0, 0];
    for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
    let ext = 0;
    for (const p of ring) ext = Math.max(ext, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    const L = len ?? ext * 0.55, R = rng(n * 131 + brk * 17);
    const far = ring.map((p) => {
      const k = 0.5 + R() * 0.3, j = L * (0.2 + R() * 0.8);
      return [c[0] + (p[0] - c[0]) * k + dir[0] * j, c[1] + (p[1] - c[1]) * k + dir[1] * j, c[2] + (p[2] - c[2]) * k + dir[2] * j];
    });
    const part = this.part({ vis: [0, brk === 1 ? S.BRK1 : S.BRK2, 1], ao: false, raw: true });
    this.in(part, () => {
      this.metal(loft([ring, far]), lin(0x1c1a19), 8);
      const e = 0.0012, fc = [c[0] + dir[0] * (L * 0.5 + e), c[1] + dir[1] * (L * 0.5 + e), c[2] + dir[2] * (L * 0.5 + e)];
      const q = (p) => [p[0] + dir[0] * e, p[1] + dir[1] * e, p[2] + dir[2] * e];
      for (let j = 0; j < n; j++) this.glow(fc, q(far[j]), q(far[(j + 1) % n]), K3(SPARKC, 0.42), K3(SPARKC, 0.1), K3(SPARKC, 0.1), CH.SPARK);
    });
    return part;
  }
  // buckled frames over a molten bed: the structure a torn or missing panel exposes
  ribs(x0, x1, z0, z1, y, up = 1) {
    const l = x1 - x0, zc = (z0 + z1) / 2, w = z1 - z0, DKR = lin(0x1a1716), lo = Math.min(y - up * 0.003, y + up * 0.0036), hi = Math.max(y - up * 0.003, y + up * 0.0036);
    for (let i = 0; i < 3; i++) { const rx = x0 + l * (0.14 + i * 0.33); this.metal(box(rx - l * 0.035, rx + l * 0.035, lo, hi, z0 + w * 0.04, z1 - w * 0.04), DKR, 20); }
    this.metal(box(x0 + l * 0.04, x1 - l * 0.08, lo, hi - 0.0008, zc - w * 0.06, zc + w * 0.06), DKR, 20);
    // dark pit with a patchwork of embers in it, and a few sparking points
    this.solid(box(x0 + l * 0.04, x1 - l * 0.08, Math.min(y, y + up * 0.0012), Math.max(y, y + up * 0.0012), z0 + w * 0.06, z1 - w * 0.06), lin(0x0b0a0a), { crease: 30 });
    const R = rng(Math.round((x0 + 2) * 9173 + (z0 + 2) * 311)), yy = y + up * 0.0016, nx = 5, nz = 4;
    const g = [];
    for (let i = 0; i <= nx; i++) { g.push([]); for (let j = 0; j <= nz; j++) g[i].push(K3(SPARKC, R() < 0.45 ? 0.01 : 0.02 + R() * R() * 0.16)); }
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const P = (a, b) => [lerp(x0 + l * 0.06, x1 - l * 0.1, a / nx), yy, lerp(z0 + w * 0.08, z1 - w * 0.08, b / nz)];
      this.glow(P(i, j), P(i + 1, j), P(i + 1, j + 1), g[i][j], g[i + 1][j], g[i + 1][j + 1], CH.SPARK);
      this.glow(P(i, j), P(i + 1, j + 1), P(i, j + 1), g[i][j], g[i + 1][j + 1], g[i][j + 1], CH.SPARK);
    }
    for (let i = 0; i < 3; i++) this.glowBall(lerp(x0, x1, 0.15 + R() * 0.7), y + up * 0.004, lerp(z0, z1, 0.15 + R() * 0.7), 0.0028, K3(SPARKC, 0.7), CH.SPARK);
  }
  // battle damage that only exists once setDamage passes stage n: a skin panel peeled back on its
  // forward edge over the exposed frames
  tear(n, x, y, z, l, w, o = {}) {
    const D = n === 1 ? S.DMG1 : S.DMG2;
    const bed = this.part({ vis: [0, D, 1], ao: false, raw: true });
    this.in(bed, () => this.ribs(x - l * 0.5, x + l * 0.45, z - w * 0.5, z + w * 0.5, y));
    const flap = this.part({ p: [x + l * 0.5, y + 0.002, z], a: [o.skew ?? 0.3, 0, 1], rot: [D, -(o.ang ?? 1.05)], vis: [0, D, 1], ao: false, raw: true });
    const poly = [[x + l * 0.5, z - w * 0.5], [x + l * 0.5, z + w * 0.5], [x - l * 0.15, z + w * 0.5], [x - l * 0.5, z + w * 0.05], [x - l * 0.3, z - w * 0.5]];
    const R = (yy) => poly.map(([px, pz]) => [px, yy, pz]);
    this.in(flap, () => this.solid(loft([R(y + 0.0012), R(y + 0.0042)]), lin(0x35322f), { crease: 20 }));
  }
  // flat door lying on the skin (up = 1 dorsal, -1 belly), hinged across the ship on its forward
  // (default) or rear edge, over a dark tray. open = [channel, radians, ...]; sym mirrors it to port
  // in the same slot (the hinge line runs straight across).
  hatch(x0, x1, z0, z1, y, o = {}) {
    const up = o.up ?? 1, th = o.th ?? 0.003, front = o.hinge !== 'rear', sg = (front ? -1 : 1) * up;
    // y may be [y at x0, y at x1]: the door is built flat at the hinge and tipped to the slope
    const y0 = Array.isArray(y) ? y[0] : y, y1 = Array.isArray(y) ? y[1] : y, xh = front ? x1 : x0, yh = front ? y1 : y0;
    const slope = Math.atan2(y1 - y0, x1 - x0), tip = (t) => (slope ? rotZ(t, slope, xh, yh) : t);
    const open = o.open || [S.BRAKE, 0.9], rot = [];
    for (let i = 0; i < open.length; i += 2) rot.push(open[i], open[i + 1] * sg);
    const part = this.part({ p: [xh, yh + up * 0.001, 0], a: [0, 0, 1], rot });
    const lo = (a, b) => Math.min(yh + up * a, yh + up * b), hi = (a, b) => Math.max(yh + up * a, yh + up * b), m = Math.min(x1 - x0, z1 - z0) * 0.1;
    for (const s of o.sym ? [1, -1] : [1]) {
      const za = s > 0 ? z0 : -z1, zb = s > 0 ? z1 : -z0;
      if (o.bay !== false) this.solid(tip(box(x0 + m, x1 - m, lo(-0.004, 0.0007), hi(-0.004, 0.0007), za + m, zb - m)), o.bayCol || PITCH, { crease: 30 });
      if (o.glow) this.glowTris(tip(box(x0 + m * 2, x1 - m * 2, lo(0.0007, 0.001), hi(0.0007, 0.001), za + m * 2, zb - m * 2)), o.glow, o.glowCh ?? CH.GOLD);
      this.in(part, () => {
        const t = tip(box(x0, x1, lo(0.0012, 0.0012 + th), hi(0.0012, 0.0012 + th), za, zb, Math.min(0.0012, th * 0.4)));
        if (o.col) this.solid(t, o.col, { crease: 30 }); else this.paint(t, { crease: 30, shade: o.shade ?? 0.93 });
      });
    }
    return part;
  }
  // landing gear at belly height y reaching down to ground level G: one leg on the centreline, or a
  // mirrored pair at ±z. The leg folds aft into its bay behind a front-hinged door (ya = belly
  // height at the aft end of the bay, where the skin slopes).
  gear(x, y, z, G, o = {}) {
    const len = y - G, pair = z > 0.001, r = (o.r ?? 0.0042) * 1.5, w = (o.w ?? 0.008) * 1.25, A = 88 * DEG, foot = o.foot || 'skid';
    this.hatch(x - len * 1.15, x + 0.012, pair ? z - w * 1.5 : -w * 1.5, pair ? z + w * 1.5 : w * 1.5, o.ya != null ? [o.ya, y] : y, { up: -1, sym: pair, open: [S.GEARD, 1.42], col: o.col || lin(0x2a2f37), th: 0.0025 });
    const leg = this.part({ p: [x, y + 0.004, 0], a: [0, 0, 1], rot: [S.ONE, -A, S.GEARL, A], vis: [0, S.GEARL, 1], ao: false });
    const TYRE = lin(0x0c0c0d);
    this.in(leg, () => {
      for (const s of pair ? [1, -1] : [1]) {
        const zc = pair ? s * z : 0, yf = foot === 'wheel' ? G + (o.wr ?? len * 0.3) : G + 0.006;
        this.metal(latheY([[yf, r * 0.75], [y - len * 0.42, r * 0.75], [y - len * 0.42, r * 1.35], [y + 0.004, r * 1.35]], 8, x, zc), METAL, 30);
        // drag brace back up into the bay
        this.metal(loft([ringRect(x - len * 0.5, y - 0.003, y + 0.003, zc - r * 0.6, zc + r * 0.6), ringRect(x - r, y - len * 0.5 - 0.003, y - len * 0.5 + 0.003, zc - r * 0.6, zc + r * 0.6)]), GUNMETAL, 30);
        if (foot === 'wheel') {
          const wr = o.wr ?? len * 0.3, ww = w * 0.6;
          for (const d of o.twin ? [1, -1] : [0]) {
            const wz = zc + d * ww * 1.25;
            this.metal(move(rotY(lathe([[-ww, wr * 0.72], [-ww * 0.6, wr], [ww * 0.6, wr], [ww, wr * 0.72]], this.seg(12), {}), 90 * DEG), x, G + wr, wz), TYRE, 40);
            this.metal(move(rotY(lathe([[-ww * 1.08, wr * 0.2], [-ww * 1.08, wr * 0.55], [ww * 1.08, wr * 0.55], [ww * 1.08, wr * 0.2]], 8, {}), 90 * DEG), x, G + wr, wz), METAL, 40);
          }
        } else {
          const hl = len * (foot === 'pad' ? 0.42 : 0.62), hw = foot === 'pad' ? w * 1.3 : w * 0.7;
          this.metal(loft([
            ringRect(x + hl, G + 0.009, G + 0.013, zc - hw * 0.7, zc + hw * 0.7), ringRect(x + hl * 0.6, G, G + 0.006, zc - hw, zc + hw),
            ringRect(x - hl * 0.7, G, G + 0.006, zc - hw, zc + hw), ringRect(x - hl, G + 0.004, G + 0.008, zc - hw * 0.7, zc + hw * 0.7),
          ]), GUNMETAL, 30);
        }
      }
    });
    this.groundY = Math.min(this.groundY, G);
    return leg;
  }
  // pair of recoil slots [A, B] for the guns of one upgrade tier. Tier 1 guns are always out (and
  // run out a further `ext` at tier 3); later tiers sit hidden `stow` back until they are fitted.
  gunSlots(tier, o = {}) {
    const rec = o.recoil ?? 0.014, sv = o.stow || [-0.08, 0, 0], ext = o.ext ?? 0, W = tier === 2 ? S.W2 : S.W3;
    const mk = (F, zs) => this.part({
      mov: tier === 1 ? [F, -rec, 0, 0, S.W3, ext, 0, 0] : [S.ONE, sv[0], sv[1], sv[2] * zs, W, -sv[0], -sv[1], -sv[2] * zs, F, -rec, 0, 0],
      vis: tier === 1 ? null : [0, W, 1], ao: tier === 1,
    });
    return [mk(S.FIREA, 1), mk(S.FIREB, -1)];
  }
  // gun barrel riding a rig slot: heat sleeve over the muzzle brake, breech flash, optional plasma
  // coils. Its muzzle point follows the slot. o: { tier, set 'A'|'B', coil, breech (x of the flash) }
  gun(part, x0, x1, y, z, r, o = {}) {
    const n = this.seg(10), dim = K3(HEATC, 0.26), Z = [0, 0, 0];
    this.in(part, () => {
      this.barrel(x0, x1, y, z, r, { col: o.col, muzzle: false });
      this.glowCone(x1 - r * 0.7, r * 1.6, K3(HEATC, 0.5), 0, x1 - r * 4.7, r * 1.6, dim, 0, y, z, n, CH.BHEAT);
      this.glowCone(x1 - r * 4.7, r * 1.16, dim, 0, Math.max(x0 + r * 2, x1 - r * 15), r * 1.14, Z, 0, y, z, n, CH.BHEAT);
      const nc = o.coil || 0, cc = K3(this.P.glow, 0.5);
      for (let i = 0; i < nc; i++) {
        const cx = lerp(x0 + r * 5, x1 - r * 7.5, nc > 1 ? i / (nc - 1) : 0.5);
        this.metal(lathe([[cx - r * 1.0, r * 1.15], [cx - r * 0.7, r * 1.95], [cx + r * 0.7, r * 1.95], [cx + r * 1.0, r * 1.15]], n, { y, z, capA: false, capB: false }), GUNMETAL, 30);
        this.glowCone(cx - r * 0.5, r * 2.04, cc, 0, cx + r * 0.5, r * 2.04, cc, 0, y, z, n, CH.COIL);
      }
      this.glowBall(o.breech ?? x0 + r * 3, y, z, r * 2.3, [3.2, 2.2, 1.1], o.set === 'B' ? CH.FLASHB : CH.FLASHA);
    });
    if (o.muzzle !== false) this.muzzles.push({ x: x1, y, z, part, tier: o.tier || 1 });
  }
  // beam emitter looking along +X: housing, fixed collar and an iris whose blades draw back under
  // the collar while the beam is on, uncovering the lens
  emitter(x, y, z, r, o = {}) {
    const n = this.seg(12), L = { y, z }, kw = this.noseW ? this.noseW(x) * this.noseK : 0;
    this.nose(() => {
      if (o.housing !== false) this.solid(lathe([[x - r * 6, r * 0.2], [x - r * 3.6, r * 1.3], [x - r * 0.3, r * 1.3], [x - r * 0.05, r * 1.1]], n, L), o.col || lin(0x2a2f37), { crease: 34 });
      this.metal(lathe([[x - r * 0.4, r * 1.32], [x + r * 0.22, r * 1.24], [x + r * 0.22, r * 0.98], [x - r * 0.2, r * 0.92]], n, { ...L, capA: false, capB: false }), METAL, 28);
      this.metal(lathe([[x - r * 0.62, r * 0.98], [x - r * 0.6, 0.0004]], n, { ...L, capA: false }), PITCH, 30);
      const g = o.glow || this.P.glow;
      this.glowDisc(x - r * 0.3, y, z, [[0, K3(g, 1.3)], [r * 0.45, K3(g, 0.8)], [r * 0.9, K3(g, 0.25)]], n, CH.LASER);
      this.glowCone(x - r * 0.3, r * 0.9, K3(g, 0.3), 0, x + r * 0.2, r * 0.96, K3(g, 0.12), 0, y, z, n, CH.LASER);
    });
    const hub = o.hub ?? 0.14; // closed aperture as a fraction of r (a centre spike needs room)
    const part = this.part({ p: [x, y, z], iris: [S.LASER, 0.9 / hub - 1], mov: [S.KICK, -kw, 0, 0] }), nb = 8, t = [];
    const P = (a, rr) => [x - r * 0.08, y + Math.sin(a) * rr, z + Math.cos(a) * rr];
    for (let j = 0; j < nb; j++) {
      const a0 = (j / nb) * TAU, a1 = ((j + 1) / nb) * TAU;
      quad(t, P(a0 + 0.5, r * hub), P(a1 + 0.5, r * hub), P(a1, r * 0.97), P(a0, r * 0.97));
    }
    if ((t[4] - t[1]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[7] - t[1]) < 0) flip(t);
    this.in(part, () => this.metal(t, GUNMETAL, 4), (X, Y, Z) => (Math.hypot(Y - y, Z - z) < r * (hub + 0.97) * 0.5 ? 1 : 0));
    return part;
  }
  // rotating sensor bar on a short mast
  scanner(x, y, z, r = 0.012) {
    this.metal(latheY([[y - 0.002, r * 0.5], [y + r * 0.5, r * 0.32], [y + r * 0.9, r * 0.32]], 6, x, z), GUNMETAL, 30);
    const part = this.part({ p: [x, y, z], a: [0, 1, 0], rot: [S.SPIN, 1] });
    this.in(part, () => {
      this.metal(box(x - r, x + r, y + r * 0.9, y + r * 1.25, z - r * 0.24, z + r * 0.24, r * 0.08), METAL, 30);
      this.glowBox(x + r * 0.5, x + r * 0.98, y + r * 1.25, y + r * 1.36, z - r * 0.18, z + r * 0.18, K3(this.P.glow, 0.5), CH.ACCENT);
    });
    return part;
  }
  // belly dressing between x0..x1 at height y: twin conduits, frames, a scoop and an anti-collision beacon
  keel(x0, x1, y, hw, o = {}) {
    for (const s of [1, -1]) this.metal(lathe([[x0, 0.0034], [x1, 0.0034]], 6, { y: y - 0.0015, z: s * hw }), GUNMETAL, 40);
    const nf = o.frames ?? 4;
    for (let i = 0; i < nf; i++) { const fx = lerp(x0, x1, (i + 0.5) / nf); this.metal(box(fx - 0.004, fx + 0.004, y - 0.005, y + 0.002, -hw * 1.12, hw * 1.12, 0.0015), METAL, 30); }
    if (o.scoop != null) {
      const xs = o.scoop, sw = hw * 0.62, ring = ringRect(xs, y - 0.016, y - 0.001, -sw, sw, 0.003);
      this.solid(loft([ringRect(xs - 0.075, y - 0.004, y, -sw * 0.5, sw * 0.5, 0.001), ringRect(xs - 0.02, y - 0.016, y - 0.001, -sw, sw, 0.003), ring], { capB: false }), o.col || lin(0x2a2f37), { crease: 30 });
      this.duct(ring, 0.03, 0.003, { glow: K3(this.P.glow, 0.12) });
    }
    const bx = o.beacon ?? lerp(x0, x1, 0.5);
    this.metal(lathe([[bx - 0.011, 0.004], [bx - 0.007, 0.007], [bx + 0.007, 0.007], [bx + 0.011, 0.004]], 6, { y: y - 0.002, z: 0 }), GUNMETAL, 40);
    this.glowBall(bx, y - 0.008, 0, 0.006, NAV_RED, CH.STROBE);
  }
  // thin gold light strip (overdrive trim) between two points, lying on a surface facing `up`
  trim(a, b, w = 0.002, up = 1) {
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w, nz = (dx / l) * w, h = up * 0.0016, c = K3(GOLDC, 0.3);
    const A = [a[0] - nx, a[1] + h, a[2] - nz], B = [a[0] + nx, a[1] + h, a[2] + nz], C = [b[0] + nx, b[1] + h, b[2] + nz], D = [b[0] - nx, b[1] + h, b[2] - nz];
    this.glow(A, B, C, c, c, c, CH.GOLD); this.glow(A, C, D, c, c, c, CH.GOLD);
  }
}

/* ========================================================================== */
/*  Ship definitions                                                          */
/* ========================================================================== */

const ENG_BLUE = { hot: [7, 8.5, 10], mid: [0.9, 2.6, 7], rim: [0.3, 1.2, 5] };

function defVanguard(over = {}) {
  const P = {
    base: 0x8d99aa, base2: 0x56616f, dark: 0x22272e, accent: 0x1c6dff, accent2: 0x0f3fa8, trim: 0xc6ced6,
    glass: lin(0x6f93b8), glow: [0.5, 2.2, 6], eng: ENG_BLUE, hull: '07', ...over,
  };
  const WING = [
    { z: 0.07, xl: 0.17, xt: -0.305, y: -0.006, th: 0.036 },
    { z: 0.15, xl: 0.03, xt: -0.293, y: -0.005, th: 0.028 },
    { z: 0.305, xl: -0.118, xt: -0.268, y: -0.002, th: 0.013 },
  ];
  const STAB = [
    { z: 0.098, xl: -0.335, xt: -0.458, y: -0.004, th: 0.016 },
    { z: 0.218, xl: -0.428, xt: -0.492, y: -0.004, th: 0.008 },
  ];
  const FKEY = [
    { x: -0.42, w: 0.058, t: 0.028, b: 0.03, et: 2.6, eb: 2.6 },
    { x: -0.30, w: 0.08, t: 0.036, b: 0.038, et: 2.6, eb: 2.6 },
    { x: -0.12, w: 0.098, t: 0.05, b: 0.046, et: 2.4, eb: 2.4 },
    { x: 0.04, w: 0.09, t: 0.058, b: 0.048, et: 2.1, eb: 2.0 },
    { x: 0.16, w: 0.066, t: 0.055, b: 0.044, et: 1.8, eb: 1.8 },
    { x: 0.30, w: 0.043, t: 0.038, b: 0.034, et: 1.6, eb: 1.6 },
    { x: 0.41, w: 0.023, t: 0.021, b: 0.02, et: 1.6, eb: 1.6 },
    { x: 0.47, w: 0.0105, t: 0.01, b: 0.01, et: 1.8, eb: 1.8 },
    { x: 0.497, w: 0.003, t: 0.003, b: 0.003, et: 2, eb: 2 },
  ];
  return {
    zr: 0.38, P, feel: { ctl: 80, eng: 140 },
    // wound sites [x, z, r, y]: starboard wing root, port wing (tear 1), starboard outer wing (tear 2), nose
    breach: [[-0.08, 0.14, 0.085], [-0.09, -0.2, 0.06, wTop(WING, -0.09, 0.2)], [-0.15, 0.24, 0.05, wTop(WING, -0.15, 0.24)], [0.12, -0.05, 0.06]],
    geo(k) {
      const q = k.q, A = lin(P.accent), B2 = lin(P.base2), DK = lin(P.dark), GND = -0.102;
      const G1 = k.gunSlots(1, { ext: 0.03 }), G2 = k.gunSlots(2, { stow: [-0.1, 0, 0] }), G3 = k.gunSlots(3, { stow: [0, 0.032, 0], recoil: 0.01 });
      const F = fuselage(FKEY, { n: k.seg(28), sub: q >= 1 ? 4 : 2 });
      k.noseAt(0.31);
      k.nose(() => k.paint(F.tris, { crease: 38 }));
      // dorsal spine
      k.paint(fuselage([
        { x: -0.37, w: 0.012, t: 0.006, b: 0.01, y: 0.03 }, { x: -0.2, w: 0.022, t: 0.017, b: 0.01, y: 0.04, et: 2.6 },
        { x: 0.0, w: 0.031, t: 0.027, b: 0.01, y: 0.044, et: 2.6 }, { x: 0.075, w: 0.03, t: 0.03, b: 0.01, y: 0.04, et: 2.6 },
      ], { n: k.seg(14), sub: 3 }).tris, { crease: 38 });
      k.canopy([
        { x: 0.045, w: 0.011, t: 0.005 }, { x: 0.09, w: 0.028, t: 0.027 }, { x: 0.16, w: 0.0335, t: 0.04 },
        { x: 0.225, w: 0.028, t: 0.03 }, { x: 0.275, w: 0.013, t: 0.009 }, { x: 0.292, w: 0.003, t: 0.002 },
      ], 0.038, { arches: [0.118, 0.222], pilot: 0.165 });
      for (const s of [1, -1]) {
        // engine nacelle humps
        k.paint(side(lathe([[-0.4, 0.043], [-0.3, 0.046], [-0.16, 0.041], [-0.04, 0.03], [0.05, 0.012]], k.seg(18), { y: 0.004, z: 0.054, sy: 0.96 }), s), { crease: 38 });
        k.nozzle(-0.5, 0.004, s * 0.054, 0.04, 0.115);
        // wings, leading-edge extension, tailplanes
        // wing: inboard flap (drops as an airbrake) and aileron
        k.flapWing(WING, s, 0.74, [[0.09, 0.185, [S.BRAKE, 0.55, S.PITCH, -0.12]], [0.195, 0.295, [S.BANK, -s * 0.5, S.PITCH, -0.1]]]);
        k.wingTrim(WING, s, 0.08, 0.3, 0.09);
        k.paint(side(wing([{ z: 0.028, xl: 0.37, xt: 0.02, y: 0.016, th: 0.01 }, { z: 0.07, xl: 0.19, xt: 0.0, y: 0.014, th: 0.014 }, { z: 0.112, xl: 0.1, xt: -0.02, y: 0.01, th: 0.014 }]), s), { crease: 26 });
        // all-moving tailplanes
        k.slab(STAB, s, -0.4, [S.PITCH, -0.3, S.BANK, -s * 0.34]);
        // side intake under the LERX
        {
          const rk = (R) => R.map((p) => [p[0] - (p[2] - 0.058) * 0.55 - (0.02 - p[1]) * 0.25, p[1], p[2]]);
          const r0 = rk(ringRect(0.175, -0.036, 0.016, 0.058, 0.108, 0.006));
          k.paint(side(loft([ringRect(-0.12, -0.04, 0.02, 0.05, 0.098, 0.01), ringRect(0.06, -0.042, 0.02, 0.052, 0.113, 0.008), r0], { capB: false }), s), { crease: 30 });
          k.duct(r0.map((p) => [p[0], p[1], p[2] * s]), 0.07, 0.006, { glow: [0.2, 0.7, 1.6] });
        }
        // canted twin fins
        {
          // (the upper panel is a rudder; the port one can be shot away)
          const fin = k.fin([{ z: 0, xl: -0.2, xt: -0.405, y: 0, th: 0.016 }, { z: 0.062, xl: -0.275, xt: -0.428, y: 0, th: 0.012 }, { z: 0.128, xl: -0.365, xt: -0.452, y: 0, th: 0.007 }], 68 * DEG, 0.022, 0.09, s, { brk: s < 0 ? 1 : 0 });
          k.in(fin.part, () => k.navLight(-0.425, 0.022 + 0.128 * 0.93 + 0.004, s * (0.09 + 0.128 * 0.375), NAV_WHITE, CH.STROBE, 0.008));
        }
        // wingtip gun pods: the tier-2 barrel runs out of a fairing slung under the pod
        const gi = s > 0 ? 0 : 1, gs = s > 0 ? 'A' : 'B';
        k.paint(side(lathe([[-0.315, 0.002], [-0.285, 0.011], [-0.2, 0.0165], [-0.03, 0.0165], [0.015, 0.012], [0.03, 0.0085]], k.seg(12), { y: -0.001, z: 0.321 }), s), { crease: 30 });
        k.gun(G1[gi], -0.02, 0.135, -0.001, s * 0.321, 0.0058, { set: gs, breech: 0.042 });
        k.solid(side(lathe([[-0.17, 0.002], [-0.13, 0.0095], [-0.02, 0.0095], [0.005, 0.0065]], k.seg(8), { y: -0.019, z: 0.321 }), s), B2, { crease: 35 });
        k.gun(G2[gi], -0.03, 0.108, -0.019, s * 0.321, 0.0046, { set: gs, tier: 2, breech: 0.014 });
        k.glowBox(-0.2, -0.06, 0.0155, 0.0175, s * 0.321 - 0.0022, s * 0.321 + 0.0016, P.glow.map((v) => v * 0.3), CH.ACCENT);
        k.navLight(-0.25, 0.012, s * 0.329, s > 0 ? NAV_GREEN : NAV_RED);
        // nose cannon
        k.gun(G1[gi], 0.24, 0.385, -0.012, s * 0.043, 0.005, { set: gs, muzzle: false, breech: 0.333 });
        k.solid(side(lathe([[0.2, 0.004], [0.24, 0.011], [0.3, 0.011], [0.325, 0.007]], k.seg(8), { y: -0.012, z: 0.043 }), s), B2, { crease: 35 });
        // tier 3: a plasma cannon pod drops out of the wing between the pylons
        k.in(G3[gi], () => {
          k.solid(side(lathe([[-0.15, 0.003], [-0.11, 0.0125], [-0.01, 0.0125], [0.025, 0.008]], k.seg(10), { y: -0.036, z: 0.2145 }), s), B2, { crease: 35 });
          k.solid(side(box(-0.11, -0.03, -0.026, -0.01, 0.2115, 0.2175, 0.002), s), DK, { crease: 30 });
        });
        k.gun(G3[gi], -0.01, 0.105, -0.036, s * 0.2145, 0.0052, { set: gs, tier: 3, coil: 2, breech: 0.03 });
        // wing-root armour plate (the starboard one can be blown off its frames) + vents
        {
          const ap = () => k.paint(side(plate([[0.02, 0.085], [-0.12, 0.085], [-0.12, 0.14], [-0.06, 0.14]], 0.005, 0.0165, 0.003), s), { crease: 25 });
          if (s > 0) k.shed(2, ap, [-0.115, 0.0, 0.09, 0.136, 0.0125]); else ap();
        }
        k.vents(-0.3, -0.2, 0.049, s * 0.054 - 0.018, s * 0.054 + 0.018, 4);
        // underwing stores
        if (q >= 1) {
          k.solid(side(box(-0.17, -0.07, -0.03, -0.012, 0.176, 0.184, 0.002), s), B2, { crease: 30 });
          k.missile(-0.21, -0.03, -0.039, s * 0.18, 0.0095);
          k.solid(side(box(-0.2, -0.12, -0.024, -0.008, 0.246, 0.252, 0.002), s), B2, { crease: 30 });
          k.missile(-0.225, -0.085, -0.031, s * 0.249, 0.0075);
        }
      }
      // overdrive vents on the nacelle tops, airbrakes on the upper wing roots
      k.hatch(-0.185, -0.125, 0.044, 0.064, 0.0495, { sym: true, open: [S.OD, 0.8], glow: K3(GOLDC, 0.5) });
      k.hatch(-0.265, -0.15, 0.1, 0.142, [wTop(WING, -0.265, 0.12), wTop(WING, -0.15, 0.12)], { sym: true, open: [S.BRAKE, 0.95] });
      // battle damage: panels that peel off the wings
      k.tear(1, -0.09, wTop(WING, -0.09, 0.2), -0.2, 0.075, 0.05);
      k.tear(2, -0.15, wTop(WING, -0.15, 0.24), 0.24, 0.06, 0.042, { skew: -0.3 });
      // chin beam emitter, sensor mast, rocket bay in the belly fairing, undercarriage
      k.emitter(0.405, -0.027, 0, 0.0085, { col: B2 });
      k.scanner(-0.255, 0.049, 0, 0.011);
      k.rocketBay(-0.1, 0.0, 0.005, 0.03, -0.064, { up: -1, ang: 1.25, col: B2 });
      k.launchCue(0.03, 0.055, 0.052, 0.041); // (the bay is under the belly: lamps on the shoulders show the launch from above)
      k.spineCoils([[-0.3, 0.047], [-0.2, 0.055], [-0.095, 0.063]]);
      k.keel(-0.255, -0.115, -0.064, 0.024, { frames: 3, scoop: 0.135, beacon: -0.135, col: B2 });
      k.gear(0.25, -F.at(0.25).b, 0, GND, { foot: 'wheel', ya: -F.at(0.17).b, r: 0.0036 });
      k.gear(-0.2, -0.037, 0.062, GND, { foot: 'wheel', w: 0.0085 });
      // belly fairing, dorsal antenna, tail sting
      k.solid(box(-0.27, 0.12, -0.064, -0.04, -0.034, 0.034, 0.01), B2, { crease: 30 });
      k.solid(wingBlade(-0.04, 0.074, 0.03, 0.03), DK, { crease: 30 });
      k.solid(box(-0.47, -0.4, -0.006, 0.012, -0.012, 0.012, 0.004), DK, { crease: 30 });
      k.navLight(-0.468, 0.016, 0, NAV_WHITE, CH.STROBE, 0.008);
      k.navLight(-0.15, 0.062, 0, NAV_RED, CH.STROBE, 0.007);
      // accent light strips flanking the spine
      for (const s of [1, -1]) k.glowBox(-0.1, 0.02, 0.0545, 0.0565, s * 0.04 - 0.0016, s * 0.04 + 0.0014, P.glow.map((v) => v * 0.3), CH.ACCENT);
      k.muzzles.unshift({ x: 0.5, y: 0, z: 0 });
      void A;
    },
    liv(L) {
      L.base(P.base);
      const S = (f) => { f(1); f(-1); };
      // fuselage centre section and nose radome
      L.fill([[0.3, -0.03], [0.05, -0.062], [-0.4, -0.05], [-0.4, 0.05], [0.05, 0.062], [0.3, 0.03]], P.base2);
      L.fill([[0.54, -0.04], [0.405, -0.04], [0.405, 0.04], [0.54, 0.04]], P.dark, { rough: 0.62, metal: 0.1 });
      L.stripe([[0.4, -0.05], [0.4, 0.05]], P.trim, 0.006);
      // spine flash
      L.fill([[0.03, -0.012], [-0.38, -0.006], [-0.38, 0.006], [0.03, 0.012]], P.accent);
      S((s) => {
        // wing paint: accent outer panel with white pinstripe, dark leading edge
        L.fill(wPoly(WING, 0.205, 0.32, -0.02, 1.02, s), P.accent);
        L.fill(wPoly(WING, 0.25, 0.32, 0.38, 1.02, s), P.accent2);
        L.fill(wPoly(WING, 0.188, 0.2, -0.02, 1.02, s), P.trim);
        L.fill(wPoly(WING, 0.07, 0.32, -0.02, 0.055, s), P.dark, { rough: 0.6, metal: 0.15 });
        // gun pod
        L.fill(L.rect(-0.33, s * 0.303, 0.05, s * 0.34), P.base2);
        L.fill(L.rect(-0.03, s * 0.303, 0.05, s * 0.34), P.dark);
        // walkway by the root
        L.fill(wPoly(WING, 0.085, 0.14, 0.3, 0.62, s), P.base2, { rough: 0.75, metal: 0.1 });
        // LERX + intake shoulder
        L.fill([[0.37, s * 0.03], [0.19, s * 0.07], [0.1, s * 0.112], [0.0, s * 0.112], [0.0, s * 0.06]], P.base2);
        // tailplanes: accent tips
        L.fill(wPoly(STAB, 0.17, 0.23, -0.02, 1.02, s), P.accent);
        L.fill(wPoly(STAB, 0.158, 0.166, -0.02, 1.02, s), P.trim);
        L.fill(wPoly(STAB, 0.098, 0.23, -0.02, 0.07, s), P.dark);
        // fins (projected): accent band
        L.fill([[-0.2, s * 0.088], [-0.46, s * 0.088], [-0.46, s * 0.145], [-0.3, s * 0.145]], P.accent2);
        // panel lines: spars, ribs, flaps, slats
        L.line(wLine(WING, 0.075, 0.3, 0.3, s)); L.line(wLine(WING, 0.075, 0.3, 0.72, s));
        for (const z of [0.115, 0.15, 0.2, 0.25]) L.line([wPt(WING, z, 0.055), wPt(WING, z, 1)].map((p) => [p[0], p[1] * s]));
        L.line(wPoly(WING, 0.09, 0.185, 0.74, 0.97, s), { close: true, w: 2 }); L.line(wPoly(WING, 0.195, 0.295, 0.74, 0.97, s), { close: true, w: 2 });
        L.line(wLine(STAB, 0.1, 0.215, 0.5, s));
        L.hatch(-0.05, s * 0.2, -0.1, s * 0.235); L.hatch(-0.16, s * 0.1, -0.24, s * 0.13);
        L.rivets([-0.02, s * 0.165], [-0.25, s * 0.165], 16);
        // nacelle panels
        L.line([[-0.02, s * 0.03], [-0.4, s * 0.02]]); L.line([[-0.05, s * 0.095], [-0.4, s * 0.095]]);
        L.hatch(-0.1, s * 0.04, -0.18, s * 0.07);
        // shading: wing root, exhaust soot, canopy surround
        L.shade([[0.12, s * 0.1], [-0.3, s * 0.1]], 0.035, 0.3);
        L.shade([[-0.36, s * 0.054], [-0.44, s * 0.054]], 0.09, 0.5);
        L.shade([[-0.3, s * 0.14], [-0.33, s * 0.29]], 0.03, 0.16);
      });
      for (const x of [0.34, 0.25, 0.02, -0.09, -0.2, -0.33]) L.line([[x, -0.1], [x, 0.1]], { a: 0.5 });
      L.shade([[0.3, 0], [0.04, 0]], 0.1, 0.25);
      L.hatch(0.33, -0.014, 0.37, 0.014);
      // markings
      L.text(P.hull, -0.19, -0.245, 0.06, P.trim, Math.PI / 2);
      L.fill([[-0.135, 0.215], [-0.165, 0.245], [-0.195, 0.245], [-0.165, 0.215], [-0.195, 0.185], [-0.165, 0.185]].map(([x, z]) => [x, z + 0.03]), P.trim);
      L.wear(7, 1);
    },
  };
}
// swept antenna / sensor blade standing on y0
function wingBlade(x, y0, h, chord) {
  return move(rotX(wing([{ z: 0, xl: chord * 0.5, xt: -chord * 0.5, y: 0, th: 0.006 }, { z: h, xl: -chord * 0.1, xt: -chord * 0.5, y: 0, th: 0.003 }]), 90 * DEG), x, y0, 0);
}

const SYM = (f) => { f(1); f(-1); };
const circRing = (x, y, z, r, n, sy = 1, sz = 1, ph = 0) => {
  const R = [];
  for (let j = 0; j < n; j++) { const a = (j / n) * TAU + ph; R.push([x, y + Math.sin(a) * r * sy, z + Math.cos(a) * r * sz]); }
  return R;
};
// body of revolution about a vertical axis (turrets, domes): profile [[y, r], ...]
export function latheY(profile, n, x, z) {
  return move(rotZ(lathe(profile, n, {}), 90 * DEG), x, 0, z);
}

/* ------------------------------ INTERCEPTOR ------------------------------ */
function defInterceptor() {
  const P = {
    base: 0x1d97a6, base2: 0x0f5f6c, dark: 0x10262c, accent: 0xbfcdd0, accent2: 0x5fd3dc, trim: 0xc4d2d5,
    glass: lin(0x5fb0b8), glow: [0.4, 5.5, 6], eng: { hot: [7, 10, 10], mid: [0.6, 4.2, 6], rim: [0.2, 2.4, 4.5] }, hull: '11',
  };
  // forward-swept wing
  const WING = [
    { z: 0.045, xl: -0.03, xt: -0.33, y: -0.004, th: 0.03 },
    { z: 0.12, xl: 0.0, xt: -0.25, y: -0.003, th: 0.024 },
    { z: 0.3, xl: 0.135, xt: 0.035, y: 0.004, th: 0.011 },
  ];
  const CAN = [{ z: 0.03, xl: 0.285, xt: 0.19, y: 0.004, th: 0.011 }, { z: 0.125, xl: 0.21, xt: 0.165, y: 0.004, th: 0.006 }];
  const NZ = 0.082, NR = 0.031;
  return {
    zr: 0.36, P, feel: { ctl: 34, eng: 90, twitch: 1 },
    breach: [[-0.12, 0.1, 0.07], [-0.03, -0.2, 0.05, wTop(WING, -0.03, 0.2)], [0.005, 0.225, 0.045, wTop(WING, 0.005, 0.225)], [0.1, -0.03, 0.05]],
    geo(k) {
      const q = k.q, B2 = lin(P.base2), DK = lin(P.dark), GND = -0.088;
      const G1 = k.gunSlots(1, { ext: 0.03, recoil: 0.012 }), G2 = k.gunSlots(2, { stow: [-0.11, 0, 0], recoil: 0.012 }), G3 = k.gunSlots(3, { stow: [-0.1, 0, 0], recoil: 0.01 });
      const F = fuselage([
        { x: -0.43, w: 0.022, t: 0.02, b: 0.018, et: 2.2 }, { x: -0.3, w: 0.044, t: 0.036, b: 0.03, et: 2.2 },
        { x: -0.08, w: 0.054, t: 0.046, b: 0.036, et: 2 }, { x: 0.1, w: 0.047, t: 0.045, b: 0.034, et: 1.7, eb: 1.7 },
        { x: 0.28, w: 0.03, t: 0.03, b: 0.025, et: 1.5, eb: 1.5 }, { x: 0.42, w: 0.014, t: 0.013, b: 0.012, et: 1.5, eb: 1.5 },
        { x: 0.482, w: 0.005, t: 0.005, b: 0.005 }, { x: 0.5, w: 0.0012, t: 0.0012, b: 0.0012 },
      ], { n: k.seg(24), sub: q >= 1 ? 4 : 2 });
      k.noseAt(0.31);
      k.nose(() => k.paint(F.tris, { crease: 38 }));
      k.paint(fuselage([
        { x: -0.4, w: 0.01, t: 0.005, b: 0.01, y: 0.022 }, { x: -0.2, w: 0.02, t: 0.014, b: 0.01, y: 0.036, et: 2.5 },
        { x: 0.0, w: 0.026, t: 0.022, b: 0.01, y: 0.038, et: 2.5 }, { x: 0.05, w: 0.026, t: 0.024, b: 0.01, y: 0.036, et: 2.5 },
      ], { n: k.seg(12), sub: 3 }).tris, { crease: 38 });
      k.canopy([
        { x: 0.02, w: 0.008, t: 0.004 }, { x: 0.07, w: 0.022, t: 0.022 }, { x: 0.15, w: 0.0265, t: 0.032 },
        { x: 0.23, w: 0.021, t: 0.022 }, { x: 0.285, w: 0.009, t: 0.006 }, { x: 0.3, w: 0.002, t: 0.0015 },
      ], 0.03, { arches: [0.1, 0.225], pilot: 0.16 });
      for (const s of [1, -1]) {
        // long spiked engine nacelles
        k.paint(side(lathe([[-0.405, NR * 1.0], [-0.3, NR * 1.08], [-0.1, NR * 1.08], [0.0, NR * 0.98], [0.05, NR * 0.8]], k.seg(16), { y: -0.002, z: NZ, capB: false }), s), { crease: 36 });
        k.intakeRound(0.05, -0.002, s * NZ, NR * 0.8);
        k.nozzle(-0.5, -0.002, s * NZ, 0.029, 0.1, { vec: 1.25 });
        // forward-swept wing with a full-span flaperon
        k.flapWing(WING, s, 0.72, [[0.125, 0.285, [S.BANK, -s * 0.55, S.PITCH, -0.16, S.BRAKE, 0.4, S.TWITCH, s * 0.06]]]);
        k.wingTrim(WING, s, 0.06, 0.29, 0.1);
        // upturned winglet (the port one can be shot away)
        {
          const wl = () => k.solid(side(move(rotX(wing([{ z: 0, xl: 0.135, xt: 0.035, y: 0, th: 0.011 }, { z: 0.05, xl: 0.085, xt: 0.02, y: 0, th: 0.005 }]), 62 * DEG), 0, 0.004, 0.3), s), lin(P.accent), { crease: 26 });
          if (s < 0) {
            k.shed(1, wl);
            k.stump(wingRing({ z: 0.3, xl: 0.135, xt: 0.035, y: 0.004, th: 0.011 }, WPROF).map((p) => [p[0], p[1], s * p[2]]), [0, Math.sin(62 * DEG), s * Math.cos(62 * DEG)], 1, 0.016);
          } else wl();
        }
        k.navLight(0.07, 0.012, s * 0.298, s > 0 ? NAV_GREEN : NAV_RED);
        // canards: all-moving, and never quite still
        k.slab(CAN, s, 0.23, [S.PITCH, 0.34, S.BANK, -s * 0.4, S.YAW, -s * 0.12, S.TWITCH, s * 0.16]);
        // nacelle fins, canted out (rudders; the starboard one can be shot away)
        {
          const fin = k.fin([{ z: 0, xl: -0.24, xt: -0.4, y: 0, th: 0.012 }, { z: 0.095, xl: -0.36, xt: -0.445, y: 0, th: 0.005 }], 58 * DEG, 0.024, NZ + 0.008, s, { col: lin(P.base2), brk: s > 0 ? 2 : 0, rot: [S.YAW, -0.36, S.TWITCH, 0.08] });
          k.in(fin.part, () => k.navLight(-0.425, 0.024 + 0.095 * 0.85 + 0.003, s * (NZ + 0.008 + 0.095 * 0.53), NAV_WHITE, CH.STROBE, 0.007));
        }
        // cheek guns; tier 2 runs a second pair out from under the intakes, tier 3 a coil lance out of each wingtip
        const gi = s > 0 ? 0 : 1, gs = s > 0 ? 'A' : 'B';
        k.solid(side(lathe([[0.14, 0.003], [0.18, 0.009], [0.27, 0.009], [0.3, 0.006]], k.seg(8), { y: -0.012, z: 0.036 }), s), B2, { crease: 35 });
        k.gun(G1[gi], 0.21, 0.375, -0.012, s * 0.036, 0.0045, { set: gs, breech: 0.305 });
        k.solid(side(lathe([[-0.1, 0.002], [-0.05, 0.0085], [0.05, 0.0085], [0.075, 0.006]], k.seg(8), { y: -0.037, z: NZ }), s), B2, { crease: 35 });
        k.gun(G2[gi], 0.03, 0.175, -0.037, s * NZ, 0.0042, { set: gs, tier: 2, breech: 0.082 });
        k.gun(G3[gi], 0.075, 0.215, 0.004, s * 0.291, 0.0038, { set: gs, tier: 3, coil: 2, breech: 0.14 });
        // accent light strip on the nacelle
        k.glowBox(-0.28, -0.1, NR * 1.06 - 0.003, NR * 1.06 - 0.001, s * NZ - 0.0013, s * NZ + 0.0013, P.glow.map((v) => v * 0.2), CH.ACCENT);
        k.vents(-0.37, -0.31, NR * 1.02 - 0.002, s * NZ - 0.012, s * NZ + 0.012, 3);
        if (q >= 1) {
          k.solid(side(box(-0.2, -0.12, -0.02, -0.006, 0.166, 0.172, 0.002), s), B2, { crease: 30 });
          k.missile(-0.23, -0.08, -0.027, s * 0.169, 0.007);
          // ventral strake
          k.solid(side(move(rotX(wing([{ z: 0, xl: -0.26, xt: -0.4, y: 0, th: 0.008 }, { z: 0.04, xl: -0.33, xt: -0.41, y: 0, th: 0.004 }]), -70 * DEG), 0, -0.024, NZ), s), DK, { crease: 26 });
        }
      }
      k.solid(wingBlade(-0.1, 0.058, 0.022, 0.026), DK, { crease: 30 });
      // overdrive vents on the nacelle shoulders, airbrakes on the upper wing roots
      k.hatch(-0.085, -0.03, NZ - 0.009, NZ + 0.009, [0.0312, 0.0298], { sym: true, open: [S.OD, 0.8], glow: K3(GOLDC, 0.5) });
      k.hatch(-0.24, -0.15, 0.05, 0.1, [wTop(WING, -0.24, 0.075), wTop(WING, -0.15, 0.075)], { sym: true, open: [S.BRAKE, 1.0] });
      k.tear(1, -0.03, wTop(WING, -0.03, 0.2), -0.2, 0.055, 0.04);
      k.tear(2, 0.005, wTop(WING, 0.005, 0.225), 0.225, 0.05, 0.036, { skew: -0.3 });
      k.emitter(0.405, -0.018, 0, 0.007, { col: B2 });
      k.scanner(-0.22, 0.048, 0, 0.01);
      k.rocketBay(-0.12, -0.03, 0.003, 0.02, -0.046, { up: -1, ang: 1.25, col: B2 });
      k.launchCue(-0.06, -0.035, 0.037, 0.032);
      k.spineCoils([[-0.32, 0.034], [-0.16, 0.047], [-0.04, 0.057]], 0.012);
      k.keel(-0.195, -0.13, -0.046, 0.015, { frames: 2, scoop: 0.155, beacon: -0.16, col: B2 });
      k.gear(0.24, -F.at(0.24).b, 0, GND, { foot: 'wheel', ya: -F.at(0.17).b, r: 0.0032, w: 0.006 });
      k.gear(-0.18, -0.002 - NR * 1.08, NZ, GND, { foot: 'skid', w: 0.007, r: 0.0036 });
      k.solid(box(-0.2, 0.14, -0.046, -0.03, -0.022, 0.022, 0.007), B2, { crease: 30 });
      k.navLight(-0.43, 0.022, 0, NAV_WHITE, CH.STROBE, 0.007);
      k.muzzles.unshift({ x: 0.5, y: 0, z: 0 });
    },
    liv(L) {
      L.base(P.base);
      L.fill([[0.54, -0.03], [0.39, -0.03], [0.39, 0.03], [0.54, 0.03]], P.dark, { rough: 0.62, metal: 0.1 });
      L.stripe([[0.385, -0.04], [0.385, 0.04]], P.trim, 0.005);
      L.fill([[0.3, -0.022], [0.0, -0.04], [-0.42, -0.02], [-0.42, 0.02], [0.0, 0.04], [0.3, 0.022]], P.base2);
      L.fill([[0.02, -0.01], [-0.4, -0.005], [-0.4, 0.005], [0.02, 0.01]], P.accent);
      SYM((s) => {
        // white outer wing with cyan chevron, dark leading edge
        L.fill(wPoly(WING, 0.17, 0.32, -0.02, 1.02, s), P.accent);
        L.fill(wPoly(WING, 0.15, 0.162, -0.02, 1.02, s), P.accent2);
        L.fill(wPoly(WING, 0.225, 0.255, -0.02, 1.02, s), P.base);
        L.fill(wPoly(WING, 0.045, 0.32, -0.02, 0.07, s), P.dark, { rough: 0.6, metal: 0.15 });
        // nacelle top: dark with white nose ring
        L.fill([[0.06, s * (NZ - 0.03)], [-0.42, s * (NZ - 0.03)], [-0.42, s * (NZ + 0.034)], [0.06, s * (NZ + 0.034)]], P.base2);
        L.fill([[0.06, s * (NZ - 0.03)], [0.02, s * (NZ - 0.03)], [0.02, s * (NZ + 0.034)], [0.06, s * (NZ + 0.034)]], P.trim);
        L.fill([[-0.3, s * (NZ - 0.034)], [-0.42, s * (NZ - 0.034)], [-0.42, s * (NZ + 0.036)], [-0.3, s * (NZ + 0.036)]], P.dark, { rough: 0.4, metal: 0.8 });
        L.fill(wPoly(CAN, 0.03, 0.13, -0.02, 1.02, s), P.accent);
        L.fill(wPoly(CAN, 0.03, 0.13, -0.02, 0.12, s), P.dark);
        L.line(wLine(WING, 0.05, 0.3, 0.32, s)); L.line(wLine(WING, 0.05, 0.3, 0.7, s));
        for (const z of [0.12, 0.17, 0.225]) L.line([wPt(WING, z, 0.07), wPt(WING, z, 1)].map((p) => [p[0], p[1] * s]));
        L.line(wPoly(WING, 0.125, 0.29, 0.72, 0.97, s), { close: true, w: 2 });
        for (const x of [-0.05, -0.16, -0.27]) L.line([[x, s * (NZ - 0.03)], [x, s * (NZ + 0.034)]]);
        L.hatch(-0.08, s * (NZ - 0.014), -0.14, s * (NZ + 0.014));
        L.shade([[-0.02, s * 0.05], [-0.3, s * 0.05]], 0.03, 0.3);
        L.shade([[-0.36, s * NZ], [-0.44, s * NZ]], 0.07, 0.45);
        L.rivets([-0.02, s * 0.13], [-0.2, s * 0.13], 12);
      });
      for (const x of [0.32, 0.2, 0.0, -0.1, -0.22, -0.34]) L.line([[x, -0.05], [x, 0.05]], { a: 0.5 });
      L.shade([[0.3, 0], [0.02, 0]], 0.08, 0.25);
      L.text(P.hull, 0.075, 0.262, 0.05, P.dark, -Math.PI / 2);
      L.text(P.hull, 0.075, -0.262, 0.05, P.dark, Math.PI / 2);
      L.wear(11, 0.9);
    },
  };
}

/* ------------------------------- JUGGERNAUT ------------------------------ */
function defJuggernaut() {
  const P = {
    base: 0x7c8086, base2: 0x4b4f55, dark: 0x1c1e22, accent: 0xff8a12, accent2: 0xb85a06, trim: 0xc9c2b2,
    glass: lin(0xb08a4a), glow: [6.5, 2.6, 0.4], eng: { hot: [10, 8.5, 6.5], mid: [6, 2.6, 0.7], rim: [4, 1.0, 0.2] }, hull: '23',
  };
  const WING = [{ z: 0.12, xl: 0.15, xt: -0.33, y: -0.008, th: 0.06 }, { z: 0.3, xl: 0.06, xt: -0.29, y: -0.006, th: 0.044 }];
  const PX0 = -0.27, PX1 = 0.18, PZ0 = 0.285, PZ1 = 0.39;
  const ROOT = [{ z: 0.1, xl: 0.03, xt: -0.43, y: -0.004, th: 0.104 }, { z: 0.14, xl: 0.085, xt: -0.375, y: -0.006, th: 0.076 }, { z: 0.19, xl: 0.118, xt: -0.325, y: -0.007, th: 0.056 }];
  const FK = [
    { x: -0.45, w: 0.118, t: 0.048, b: 0.05, et: 4, eb: 4 }, { x: -0.26, w: 0.14, t: 0.064, b: 0.06, et: 4, eb: 4 },
    { x: 0.0, w: 0.136, t: 0.068, b: 0.06, et: 4, eb: 3.6 }, { x: 0.2, w: 0.104, t: 0.06, b: 0.056, et: 3.4, eb: 3.2 },
    { x: 0.36, w: 0.074, t: 0.044, b: 0.047, et: 3, eb: 3 }, { x: 0.45, w: 0.052, t: 0.03, b: 0.036, et: 3, eb: 3 },
    { x: 0.478, w: 0.034, t: 0.018, b: 0.024, et: 3, eb: 3 },
  ];
  return {
    zr: 0.44, P, feel: { ctl: 230, eng: 320 },
    breach: [[-0.2, -0.2, 0.085], [-0.03, -0.06, 0.06, 0.083], [-0.06, 0.3375, 0.055, 0.05], [0.25, 0.04, 0.06]],
    geo(k) {
      const q = k.q, A = lin(P.accent), B2 = lin(P.base2), DK = lin(P.dark), GND = -0.128;
      const G1 = k.gunSlots(1, { ext: 0.035, recoil: 0.024 }), G2 = k.gunSlots(2, { stow: [-0.13, 0, 0], recoil: 0.018 });
      const G3 = k.part({ mov: [S.ONE, -0.1, 0, 0, S.W3, 0.1, 0, 0, S.FIREA, -0.01, 0, 0], vis: [0, S.W3, 1], ao: false });
      const F = fuselage(FK, { n: k.seg(28), sub: q >= 1 ? 4 : 2 });
      k.noseAt(0.36);
      k.nose(() => k.paint(F.tris, { crease: 34 }));
      // raised armoured deck + bow plate
      k.paint(plate([[0.13, -0.062], [-0.02, -0.092], [-0.33, -0.092], [-0.36, -0.07], [-0.36, 0.07], [-0.33, 0.092], [-0.02, 0.092], [0.13, 0.062]], 0.045, 0.083, 0.007), { crease: 25 });
      k.nose(() => k.paint(plate([[0.44, -0.03], [0.3, -0.056], [0.3, 0.056], [0.44, 0.03]], 0.02, 0.052, 0.006), { crease: 25, shade: 0.9 }));
      // armoured greenhouse canopy
      k.canopy([
        { x: 0.135, w: 0.012, t: 0.004 }, { x: 0.17, w: 0.034, t: 0.022 }, { x: 0.23, w: 0.038, t: 0.03 },
        { x: 0.29, w: 0.03, t: 0.022 }, { x: 0.325, w: 0.012, t: 0.005 },
      ], 0.05, { arches: [0.185, 0.235, 0.283], archW: 0.006, spine: [0.16, 0.31], pilot: 0.235, et: 2.8 });
      // dorsal turret: race ring, sloped faceted housing under an appliqué roof plate, mantlet, sleeved twin guns, cupola
      {
        const TX = -0.135, TY = 0.083, TM = lin(0x565a61);
        k.metal(latheY([[TY - 0.002, 0.058], [TY + 0.006, 0.058], [TY + 0.011, 0.05], [TY + 0.011, 0.0005]], k.seg(18), TX, 0), GUNMETAL, 28);
        const HP = [[0.056, -0.022], [0.056, 0.022], [0.026, 0.047], [-0.036, 0.047], [-0.06, 0.028], [-0.06, -0.028], [-0.036, -0.047], [0.026, -0.047]].map(([x, z]) => [TX + x, z]);
        k.solid(plate(HP, TY + 0.009, TY + 0.04, 0.011), TM, { crease: 24 });
        k.solid(plate([[0.03, -0.018], [0.03, 0.018], [0.012, 0.032], [-0.03, 0.032], [-0.044, 0.018], [-0.044, -0.018], [-0.03, -0.032], [0.012, -0.032]].map(([x, z]) => [TX + x, z]), TY + 0.039, TY + 0.046, 0.003), B2, { crease: 24 });
        k.solid(box(TX + 0.046, TX + 0.078, TY + 0.012, TY + 0.036, -0.026, 0.026, 0.006), DK, { crease: 28 }); // mantlet
        for (const s of [1, -1]) {
          const bz = s * 0.0125, by = TY + 0.024;
          k.gun(G1[1], TX + 0.045, TX + 0.225, by, bz, 0.0052, { set: 'B', muzzle: false, breech: TX + 0.085 });
          k.in(G1[1], () => k.metal(lathe([[TX + 0.085, 0.0082], [TX + 0.15, 0.0082]], k.seg(10), { y: by, z: bz }), TM, 30)); // thermal sleeve
          k.solid(side(box(TX - 0.03, TX + 0.022, TY + 0.014, TY + 0.034, 0.047, 0.058, 0.003), s), B2, { crease: 28 }); // stowage bins
          if (q >= 1) for (const bx of [-0.02, 0.012]) k.metal(side(box(TX + bx, TX + bx + 0.005, TY + 0.033, TY + 0.0365, 0.049, 0.056), s), METAL, 30);
        }
        k.metal(latheY([[TY + 0.045, 0.015], [TY + 0.053, 0.015], [TY + 0.058, 0.009], [TY + 0.058, 0.0005]], k.seg(10), TX - 0.022, 0.014), GUNMETAL, 28); // cupola
        k.glowBox(TX - 0.0095, TX - 0.0085, TY + 0.0475, TY + 0.052, 0.008, 0.02, P.glow.map((v) => v * 0.35), CH.ACCENT); // vision slit
        k.metal(box(TX - 0.04, TX - 0.037, TY + 0.04, TY + 0.085, -0.02, -0.017), GUNMETAL, 30); // whip aerial
        k.navLight(TX - 0.038, TY + 0.088, -0.0185, NAV_RED, CH.STROBE, 0.005);
      }
      // layered bow armour: a second, smaller glacis plate and a pair of cheek plates
      k.nose(() => k.paint(plate([[0.41, -0.022], [0.33, -0.04], [0.33, 0.04], [0.41, 0.022]], 0.045, 0.06, 0.004), { crease: 25 }));
      k.vents(-0.33, -0.2, 0.084, -0.05, 0.05, 5);
      for (const s of [1, -1]) {
        k.paint(side(wing(WING, { tip: false }), s), { crease: 26 });
        // wing root: a thick fairing that swells out of the hull side and thins into the wing
        k.paint(side(wing(ROOT, { tip: false }), s), { crease: 40 });
        // appliqué armour: two overlapping plates on the wing, a pauldron over the intake, a cheek plate on the bow
        {
          const ap = () => k.paint(side(plate([[0.07, 0.165], [0.045, 0.27], [-0.09, 0.27], [-0.09, 0.165]], 0.01, 0.0275, 0.005), s), { crease: 25 });
          if (s > 0) k.shed(2, ap, [-0.085, 0.04, 0.172, 0.264, 0.022]); else ap();
        }
        k.paint(side(plate([[-0.11, 0.18], [-0.11, 0.275], [-0.25, 0.275], [-0.27, 0.2], [-0.24, 0.18]], 0.008, 0.0235, 0.004), s), { crease: 25, shade: 0.92 });
        // heavy elevon slab hung off the back of each pod
        {
          const el = k.part({ p: [PX0 - 0.002, -0.002, s * (PZ0 + PZ1) / 2], a: [0, 0, 1], rot: [S.BANK, -s * 0.5, S.PITCH, -0.32, S.BRAKE, s * 0.3] });
          k.in(el, () => k.paint(side(loft([ringRect(PX0 - 0.004, -0.02, 0.016, PZ0 + 0.016, PZ1 - 0.016, 0.005), ringRect(PX0 - 0.06, -0.012, 0.008, PZ0 + 0.014, PZ1 - 0.014, 0.004), ringRect(PX0 - 0.105, -0.004, 0.001, PZ0 + 0.018, PZ1 - 0.018, 0.001)]), s), { crease: 28 }));
          k.metal(side(box(PX0 - 0.012, PX0 + 0.01, -0.008, 0.004, PZ0 + 0.03, PZ0 + 0.042), s), GUNMETAL, 30);
          k.metal(side(box(PX0 - 0.012, PX0 + 0.01, -0.008, 0.004, PZ1 - 0.042, PZ1 - 0.03), s), GUNMETAL, 30);
        }
        k.paint(side(plate([[0.15, 0.108], [0.115, 0.192], [-0.04, 0.192], [-0.07, 0.108]], 0.03, 0.045, 0.005), s), { crease: 25 });
        k.paint(side(plate([[0.42, 0.036], [0.31, 0.062], [0.2, 0.086], [0.2, 0.05], [0.31, 0.03]], 0.02, 0.047, 0.004), s), { crease: 25, shade: 0.92 });
        if (q >= 1) for (const [bx, bz] of [[0.045, 0.18], [0.03, 0.255], [-0.075, 0.18], [-0.075, 0.255], [-0.125, 0.195], [-0.125, 0.262], [-0.23, 0.262]]) k.metal(side(latheY([[0.02, 0.0045], [0.0295, 0.0045], [0.0305, 0.003]], 6, bx, bz), s), METAL, 30);
        // pod pylon collar
        k.solid(side(box(-0.2, 0.08, -0.03, 0.03, PZ0 - 0.012, PZ0 + 0.006, 0.006), s), DK, { crease: 28 });
        // rocket pod
        {
          const c = 0.012;
          const front = ringRect(PX1, -0.046, 0.04, PZ0, PZ1, c);
          k.paint(side(loft([ringRect(PX0, -0.03, 0.026, PZ0 + 0.014, PZ1 - 0.014, c), ringRect(PX0 + 0.03, -0.046, 0.04, PZ0, PZ1, c), front], { capB: false }), s), { crease: 28 });
          k.duct(front.map((p) => [p[0], p[1], p[2] * s]), 0.02, 0.01, { lipCol: A, col: lin(0x0d0d0f) });
          for (const ry of [-0.024, 0.018]) for (const rz of [0.312, 0.3375, 0.363]) {
            k.solid(side(lathe([[PX1 - 0.03, 0.0095], [PX1 - 0.012, 0.0095], [PX1 + 0.004, 0.0012]], k.seg(8), { y: ry, z: rz }), s), lin(0xc9321c), { crease: 35 });
            k.metal(side(lathe([[PX1 - 0.022, 0.0118], [PX1 - 0.004, 0.0118], [PX1 - 0.004, 0.0098], [PX1 - 0.022, 0.0098]], k.seg(8), { y: ry, z: rz, capA: false, capB: false }), s), GUNMETAL, 30);
          }
          k.paint(side(plate([[0.1, PZ0 + 0.016], [-0.2, PZ0 + 0.016], [-0.2, PZ1 - 0.016], [0.1, PZ1 - 0.016]], 0.036, 0.05, 0.005), s), { crease: 25 });
          k.navLight(-0.2, 0.044, s * (PZ1 - 0.006), s > 0 ? NAV_GREEN : NAV_RED, CH.NAV, 0.012);
        }
        // shoulder intake at the wing root
        {
          const r0 = ringRect(0.17, -0.036, 0.034, 0.1, 0.2, 0.008).map((p) => [p[0] - (p[2] - 0.1) * 0.35, p[1], p[2]]);
          k.paint(side(loft([ringRect(-0.1, -0.04, 0.04, 0.09, 0.2, 0.01), ringRect(0.08, -0.04, 0.038, 0.095, 0.205, 0.008), r0], { capB: false }), s), { crease: 30 });
          k.duct(r0.map((p) => [p[0], p[1], p[2] * s]), 0.07, 0.008, { glow: [1.4, 0.5, 0.1] });
        }
        // engines: two mains, two outboard boosters
        k.nozzle(-0.5, 0, s * 0.066, 0.05, 0.125);
        k.paint(side(lathe([[-0.4, 0.036], [-0.25, 0.04], [-0.08, 0.032], [0.0, 0.012]], k.seg(14), { y: -0.004, z: 0.2 }), s), { crease: 36 });
        k.nozzle(-0.475, -0.004, s * 0.2, 0.03, 0.085);
        // slab fins
        {
          const fin = k.fin([{ z: 0, xl: -0.2, xt: -0.42, y: 0, th: 0.024 }, { z: 0.09, xl: -0.31, xt: -0.445, y: 0, th: 0.014 }], 80 * DEG, 0.05, 0.118, s, { brk: s < 0 ? 1 : 0, rot: [S.YAW, -0.26], at: 0.4 });
          k.in(fin.part, () => k.navLight(-0.4, 0.05 + 0.09 + 0.006, s * 0.134, NAV_WHITE, CH.STROBE, 0.008));
        }
        // side skirt armour
        k.paint(side(box(-0.3, 0.1, -0.03, 0.03, 0.128, 0.15, 0.008), s), { crease: 28, shade: 0.85 });
        k.glowBox(-0.2, 0.06, 0.0545, 0.0565, s * 0.1 - 0.002, s * 0.1 + 0.002, P.glow.map((v) => v * 0.3), CH.ACCENT);
        if (q >= 1) for (const bx of [-0.26, -0.14, -0.02, 0.07]) k.metal(side(box(bx, bx + 0.012, 0.028, 0.034, 0.134, 0.146, 0.002), s), METAL, 30);
      }
      // chin cannon; tier 2 runs a lighter barrel out either side of it, tier 3 slides a coil shroud up the main gun
      k.solid(box(0.22, 0.42, -0.07, -0.04, -0.03, 0.03, 0.01), B2, { crease: 30 });
      k.gun(G1[0], 0.32, 0.5, -0.052, 0, 0.011, { set: 'A', breech: 0.43 });
      for (const s of [1, -1]) k.gun(G2[s > 0 ? 0 : 1], 0.33, 0.475, -0.057, s * 0.0195, 0.0055, { set: s > 0 ? 'A' : 'B', tier: 2, breech: 0.428 });
      k.in(G3, () => {
        k.metal(lathe([[0.385, 0.014], [0.395, 0.0185], [0.455, 0.0185], [0.462, 0.014]], k.seg(12), { y: -0.052, capA: false, capB: false }), GUNMETAL, 30);
        for (const cx of [0.405, 0.425, 0.445]) k.glowCone(cx - 0.005, 0.0192, K3(P.glow, 0.5), 0, cx + 0.005, 0.0192, K3(P.glow, 0.5), 0, -0.052, 0, k.seg(12), CH.COIL);
      });
      // vectoring paddles over and under the main nozzles: they follow the stick and spread on afterburner
      for (const up of [1, -1]) {
        const pd = k.part({ p: [-0.43, up * 0.054, 0], a: [0, 0, 1], rot: [S.PITCH, -0.34, S.AB, -up * 0.22, S.ONE, up * 0.05, S.THR, -up * 0.05] });
        k.in(pd, () => { for (const s of [1, -1]) k.solid(side(loft([ringRect(-0.425, up > 0 ? 0.05 : -0.062, up > 0 ? 0.062 : -0.05, 0.022, 0.112, 0.004), ringRect(-0.47, up > 0 ? 0.052 : -0.06, up > 0 ? 0.06 : -0.052, 0.024, 0.11, 0.003), ringRect(-0.5, up > 0 ? 0.054 : -0.058, up > 0 ? 0.058 : -0.054, 0.03, 0.104, 0.0015)]), s), B2, { crease: 28 }); });
        for (const s of [1, -1]) k.metal(side(box(-0.44, -0.4, up > 0 ? 0.046 : -0.056, up > 0 ? 0.056 : -0.046, 0.06, 0.072), s), GUNMETAL, 30);
      }
      // pod tops: rocket hatches forward, airbrakes aft; overdrive vents on the deck
      k.rocketBay(-0.02, 0.08, PZ0 + 0.022, PZ1 - 0.022, 0.05, {});
      k.spineCoils([[-0.045, 0.083], [0.005, 0.083], [0.05, 0.083]], 0.02);
      k.hatch(-0.19, -0.1, PZ0 + 0.022, PZ1 - 0.022, 0.05, { sym: true, open: [S.BRAKE, 1.05], th: 0.004 });
      k.hatch(0.03, 0.1, 0.03, 0.07, 0.083, { sym: true, open: [S.OD, 0.8], glow: K3(GOLDC, 0.5) });
      for (const s of [1, -1]) { k.trim([0.12, 0.083, s * 0.058], [-0.02, 0.083, s * 0.088], 0.0025); k.trim([-0.02, 0.083, s * 0.088], [-0.32, 0.083, s * 0.088], 0.0025); }
      k.tear(1, -0.03, 0.083, -0.06, 0.06, 0.045);
      k.tear(2, -0.06, 0.05, 0.3375, 0.05, 0.05, { skew: -0.3 });
      k.emitter(0.482, 0.0, 0, 0.012, { col: DK });
      k.scanner(0.09, 0.083, 0, 0.014);
      k.keel(-0.28, -0.02, -0.078, 0.05, { frames: 4, scoop: 0.195, beacon: -0.15, col: B2 });
      k.gear(0.14, -0.078, 0, GND, { foot: 'pad', r: 0.006, w: 0.011 });
      k.gear(-0.05, -0.046, (PZ0 + PZ1) / 2, GND, { foot: 'pad', r: 0.0065, w: 0.013 });
      k.solid(box(-0.3, 0.16, -0.078, -0.052, -0.07, 0.07, 0.012), B2, { crease: 30 });
      // tail bumper between the mains
      k.solid(box(-0.475, -0.42, -0.02, 0.03, -0.014, 0.014, 0.005), DK, { crease: 30 });
      k.navLight(-0.47, 0.036, 0, NAV_WHITE, CH.STROBE, 0.008);
      k.solid(wingBlade(-0.25, 0.083, 0.03, 0.03), DK, { crease: 30 });
    },
    liv(L) {
      L.base(P.base);
      // armoured deck darker, bow plate
      L.fill([[0.13, -0.062], [-0.02, -0.092], [-0.33, -0.092], [-0.36, -0.07], [-0.36, 0.07], [-0.33, 0.092], [-0.02, 0.092], [0.13, 0.062]], P.base2, { rough: 0.6, metal: 0.3 });
      L.fill([[0.54, -0.06], [0.44, -0.06], [0.44, 0.06], [0.54, 0.06]], P.dark, { rough: 0.6, metal: 0.2 });
      L.fill([[0.44, -0.06], [0.405, -0.07], [0.405, 0.07], [0.44, 0.06]], P.accent);
      // amber centre stripe on the deck
      L.fill([[0.1, -0.016], [-0.34, -0.016], [-0.34, 0.016], [0.1, 0.016]], P.accent);
      L.fill([[0.1, -0.006], [-0.34, -0.006], [-0.34, 0.006], [0.1, 0.006]], P.dark);
      SYM((s) => {
        // wing: amber band + dark leading edge
        L.fill(wPoly(WING, 0.2, 0.25, -0.02, 1.02, s), P.accent);
        L.fill(wPoly(WING, 0.255, 0.262, -0.02, 1.02, s), P.trim);
        L.fill(wPoly(WING, 0.12, 0.3, -0.02, 0.07, s), P.dark, { rough: 0.6, metal: 0.15 });
        // pod top: hazard chevrons front and rear
        L.fill(L.rect(PX0, s * PZ0, PX1, s * PZ1), P.base2);
        for (let i = 0; i < 5; i++) {
          const x = PX1 - 0.012 - i * 0.022;
          L.fill([[x, s * PZ0], [x - 0.011, s * PZ0], [x - 0.031, s * PZ1], [x - 0.02, s * PZ1]], i % 2 ? P.dark : P.accent);
        }
        L.fill(L.rect(PX0, s * PZ0, PX0 + 0.05, s * PZ1), P.accent);
        L.line(L.rect(PX0 + 0.004, s * (PZ0 + 0.004), PX1 - 0.004, s * (PZ1 - 0.004)), { close: true });
        // booster nacelle
        L.fill(L.rect(-0.4, s * 0.17, -0.3, s * 0.232), P.dark, { rough: 0.4, metal: 0.8 });
        L.line(wLine(WING, 0.13, 0.285, 0.34, s)); L.line(wLine(WING, 0.13, 0.285, 0.72, s));
        for (const z of [0.16, 0.2, 0.25]) L.line([wPt(WING, z, 0.07), wPt(WING, z, 1)].map((p) => [p[0], p[1] * s]));
        L.line(wPoly(WING, 0.14, 0.28, 0.76, 0.97, s), { close: true, w: 2 });
        L.hatch(0.0, s * 0.215, -0.06, s * 0.245); L.hatch(-0.12, s * 0.14, -0.2, s * 0.165);
        L.rivets([0.1, s * 0.098], [-0.33, s * 0.098], 22); L.rivets([0.08, s * 0.275], [-0.26, s * 0.275], 18);
        L.line([[0.12, s * 0.04], [-0.35, s * 0.04]]); L.line([[0.3, s * 0.056], [0.44, s * 0.03]]);
        L.hatch(-0.2, s * 0.05, -0.3, s * 0.082);
        L.shade([[0.14, s * 0.13], [-0.32, s * 0.13]], 0.04, 0.35);
        L.shade([[-0.36, s * 0.066], [-0.46, s * 0.066]], 0.11, 0.5);
        L.shade([[0.16, s * 0.283], [-0.26, s * 0.283]], 0.02, 0.3);
        L.shade([[-0.3, s * 0.2], [-0.34, s * 0.2]], 0.06, 0.3);
      });
      for (const x of [0.36, 0.28, 0.13, 0.03, -0.08, -0.2, -0.36]) L.line([[x, -0.14], [x, 0.14]], { a: 0.5 });
      L.shade([[0.34, 0], [0.13, 0]], 0.1, 0.22);
      L.text(P.hull, -0.08, 0.338, 0.058, P.trim, -Math.PI / 2);
      L.text(P.hull, -0.08, -0.338, 0.058, P.trim, Math.PI / 2);
      L.wear(23, 1.4);
    },
  };
}

/* --------------------------------- GHOST --------------------------------- */
function defGhost() {
  const P = {
    base: 0x4d4470, base2: 0x322b4d, dark: 0x16131f, accent: 0xb45cff, accent2: 0x7a3ad1, trim: 0xb9a8e0,
    glass: lin(0x9a6ad0), glow: [3.2, 1.0, 7], eng: { hot: [9, 7.5, 10], mid: [3.2, 1.2, 7], rim: [1.8, 0.4, 5] }, hull: '31',
    sheen: [0.5, 0.16, 1.0, 0.42], // stealth coating: a violet film that swings toward teal at grazing angles
  };
  // faceted flying wing with a sawtooth trailing edge
  const WING = [
    { z: 0.04, xl: 0.325, xt: -0.34, y: 0, th: 0.052 },
    { z: 0.13, xl: 0.212, xt: -0.458, y: -0.001, th: 0.04 },
    { z: 0.215, xl: 0.105, xt: -0.31, y: -0.003, th: 0.03 },
    { z: 0.3, xl: -0.003, xt: -0.425, y: -0.006, th: 0.02 },
    { z: 0.365, xl: -0.086, xt: -0.3, y: -0.009, th: 0.01 },
  ];
  const EZ = 0.088;
  return {
    zr: 0.42, P, feel: { ctl: 170, eng: 260 },
    breach: [[-0.16, 0.3, 0.07], [-0.04, -0.165, 0.06, 0.0215], [-0.165, 0.255, 0.05, 0.0135], [0.2, -0.04, 0.05]],
    geo(k) {
      const q = k.q, B2 = lin(P.base2), DK = lin(P.dark), GND = -0.092, FAC = WPROF_FACET;
      const G1 = k.gunSlots(1, { ext: 0.025, recoil: 0.01 }), G2 = k.gunSlots(2, { stow: [-0.11, 0, 0], recoil: 0.01 }), G3 = k.gunSlots(3, { stow: [-0.1, 0, 0], recoil: 0.008 });
      // silent control: no hinges anywhere — vanes slide aft out of the sawtooth trailing edge instead
      const vIn = k.part({ mov: [S.PITCH, -0.055, 0, 0, S.BRAKE, -0.05, 0, 0], ao: false });
      const vEng = k.part({ mov: [S.THR, -0.014, 0, 0, S.AB, -0.03, 0, 0, S.ONE, 0.014, 0, 0] });
      const F = fuselage([
        { x: -0.475, w: 0.03, t: 0.006, b: 0.006, et: 1.3, eb: 1.3 }, { x: -0.38, w: 0.07, t: 0.022, b: 0.016, et: 1.3, eb: 1.3 },
        { x: -0.18, w: 0.108, t: 0.048, b: 0.03, et: 1.3, eb: 1.3 }, { x: 0.06, w: 0.1, t: 0.056, b: 0.032, et: 1.3, eb: 1.3 },
        { x: 0.3, w: 0.05, t: 0.03, b: 0.02, et: 1.3, eb: 1.3 }, { x: 0.44, w: 0.02, t: 0.012, b: 0.009, et: 1.3, eb: 1.3 }, { x: 0.5, w: 0.0015, t: 0.001, b: 0.001, et: 1.3, eb: 1.3 },
      ], { n: 8, sub: 2 });
      k.noseAt(0.37);
      k.nose(() => k.paint(F.tris, { crease: 12 }));
      k.canopy([
        { x: 0.095, w: 0.008, t: 0.003 }, { x: 0.15, w: 0.03, t: 0.02 }, { x: 0.22, w: 0.036, t: 0.03 },
        { x: 0.3, w: 0.024, t: 0.018 }, { x: 0.355, w: 0.006, t: 0.003 },
      ], 0.036, { arches: [0.262], pilot: 0.21, et: 1.4, n: 8, spine: [0.13, 0.25] });
      for (const s of [1, -1]) {
        k.paint(side(wing(WING, { prof: WPROF_FACET }), s), { crease: 14 });
        // buried engine hump with a scalloped top intake and a flat slot nozzle
        {
          const n = 8, y = 0.024;
          const R = (x, r) => circRing(x, y, EZ, r, n, 0.5, 1.15, Math.PI / 8);
          const front = R(0.1, 0.03).map((p) => [p[0] - Math.max(0, p[1] - y) * 2.2, p[1], p[2]]);
          k.paint(side(loft([R(-0.26, 0.04), R(-0.1, 0.043), R(0.02, 0.038), front], { capB: false }), s), { crease: 14 });
          k.duct(front.map((p) => [p[0], p[1], p[2] * s]), 0.06, 0.005, { glow: [0.8, 0.3, 1.8] });
          // radar-blocker grille across the intake mouth
          for (let i = 0; i < 5; i++) { const gz = EZ + (i - 2) * 0.0105; k.solid(side(box(0.078, 0.098, y - 0.012, y + 0.016, gz - 0.0016, gz + 0.0016), s), DK, { crease: 14 }); }
          k.solid(side(box(0.082, 0.094, y + 0.001, y + 0.004, EZ - 0.027, EZ + 0.027), s), DK, { crease: 14 });
          k.nozzle(-0.345, y, s * EZ, 0.036, 0.085, { sy: 0.46, sz: 1.2, vec: 0.35, iris: 0.5 });
          // eyelid vanes over and under the slot, drawn aft as the throttle opens
          k.in(vEng, () => { for (const vy of [y + 0.0195, y - 0.0225]) k.solid(side(box(-0.352, -0.275, vy, vy + 0.003, EZ - 0.04, EZ + 0.04, 0.001), s), DK, { crease: 14 }); });
          // exhaust trough: heat tiles stepping down to the trailing edge, flanked by two blade fences
          for (let i = 0; i < 4; i++) k.solid(side(box(-0.44 + i * 0.022, -0.424 + i * 0.022, 0.004, 0.012 + i * 0.002, EZ - 0.032, EZ + 0.032, 0.0015), s), lin(0x2a2630), { crease: 14 });
          for (const fz of [EZ - 0.045, EZ + 0.047]) k.solid(side(move(rotX(wing([{ z: 0, xl: -0.3, xt: -0.45, y: 0, th: 0.006 }, { z: 0.022, xl: -0.35, xt: -0.455, y: 0, th: 0.003 }], { prof: WPROF_FACET }), 90 * DEG), 0, 0.008, fz), s), B2, { crease: 14 });
        }
        // emitter nodes at every leading-edge crank: a faceted housing with a lit lens
        for (let i = 1; i < WING.length - 1; i++) {
          const w = WING[i];
          k.metal(side(lathe([[w.xl - 0.03, 0.003], [w.xl - 0.018, 0.0095], [w.xl - 0.002, 0.0095], [w.xl + 0.008, 0.003]], 6, { y: w.y + 0.004, z: w.z, sy: 0.7 }), s), GUNMETAL, 20);
          k.glowBall(w.xl - 0.01, w.y + 0.0105, s * w.z, 0.0058, P.glow.map((v) => v * 0.55), CH.ACCENT);
        }
        // chine facets: a wedge plate along the nose and a shoulder tile, sawtooth-edged
        k.paint(side(plate([[0.43, 0.014], [0.31, 0.046], [0.2, 0.05], [0.24, 0.02]], 0.01, 0.0265, 0.004), s), { crease: 14 });
        k.paint(side(plate([[0.0, 0.215], [-0.045, 0.255], [-0.02, 0.29], [-0.085, 0.29], [-0.06, 0.34], [-0.13, 0.3], [-0.12, 0.215]], 0.0, 0.0135, 0.003), s), { crease: 14, shade: 0.92 });
        // leading-edge shield emitter strips
        for (let i = 0; i < WING.length - 1; i++) {
          const a = WING[i], b = WING[i + 1], c = P.glow.map((v) => v * 0.22);
          const p = (w, d, h) => [w.xl - d, w.y + h, s * w.z];
          k.glow(p(a, 0.006, 0.006), p(b, 0.006, 0.004), p(b, 0.0115, 0.0065), c, c, c, CH.ACCENT);
          k.glow(p(a, 0.006, 0.006), p(b, 0.0115, 0.0065), p(a, 0.0115, 0.009), c, c, c, CH.ACCENT);
        }
        // wingtip emitter node + nav light
        k.metal(side(lathe([[-0.3, 0.004], [-0.27, 0.011], [-0.12, 0.011], [-0.085, 0.004]], 6, { y: -0.009, z: 0.37 }), s), GUNMETAL, 20);
        k.glowBall(-0.2, 0.004, s * 0.37, 0.011, P.glow.map((v) => v * 0.6), CH.ACCENT);
        k.navLight(-0.13, 0.003, s * 0.372, s > 0 ? NAV_GREEN : NAV_RED, CH.NAV, 0.009);
        // outboard drag vane (roll: one side runs out, the other stays buried) and the inboard pair (pitch)
        {
          // (thin blades buried in the wing just ahead of the trailing edge, each with a lit rear edge)
          const TE = (z) => wAt(WING, z).xt, Y = (z) => wAt(WING, z).y, IN = 0.013;
          const vane = (z0, z1, d) => {
            const t = loft([-0.0009, 0.0009].map((dy) => [[TE(z0) + IN, Y(z0) + dy, z0], [TE(z0) + d, Y(z0) + dy, z0], [TE(z1) + d, Y(z1) + dy, z1], [TE(z1) + IN, Y(z1) + dy, z1]]));
            k.solid(side(t, s), lin(P.accent2), { crease: 14 });
            const c = P.glow.map((v) => v * 0.45), e = (z, dx, dy) => [TE(z) + IN + dx, Y(z) + dy, s * z];
            for (const dy of [0.0012, -0.0012]) { k.glow(e(z0, 0, dy), e(z1, 0, dy), e(z1, 0.006, dy), c, c, c, CH.ACCENT); k.glow(e(z0, 0, dy), e(z1, 0.006, dy), e(z0, 0.006, dy), c, c, c, CH.ACCENT); }
          };
          const vOut = k.part({ mov: [S.BANK, s * 0.07, 0, 0, S.BRAKE, -0.06, 0, 0], ao: false });
          k.in(vOut, () => vane(0.224, 0.294, 0.13));
          k.in(vIn, () => vane(0.052, 0.12, 0.12));
        }
        // recessed guns; tier 2 slides a second pair out of the leading edge, tier 3 a coil lance out of each emitter node
        const gi = s > 0 ? 0 : 1, gs = s > 0 ? 'A' : 'B';
        k.gun(G1[gi], 0.27, 0.42, -0.002, s * 0.047, 0.0045, { set: gs, breech: 0.34 });
        k.gun(G2[gi], 0.17, 0.335, 0.0, s * 0.085, 0.0042, { set: gs, tier: 2, breech: 0.275 });
        k.gun(G3[gi], 0.02, 0.175, 0.001, s * 0.215, 0.0038, { set: gs, tier: 3, coil: 2, breech: 0.11 });
        k.wingTrim(WING, s, 0.05, 0.36, 0.12, { prof: FAC });
        // faceted armour tiles on the wing
        {
          const ap = () => k.paint(side(plate([[0.1, 0.13], [-0.1, 0.13], [-0.18, 0.2], [0.02, 0.2]], 0.006, 0.0215, 0.004), s), { crease: 14 });
          if (s > 0) k.shed(2, ap, [-0.11, 0.04, 0.138, 0.192, 0.0165]); else ap();
        }
        k.paint(side(plate([[-0.06, 0.225], [-0.2, 0.225], [-0.27, 0.285], [-0.13, 0.285]], 0.002, 0.0135, 0.003), s), { crease: 14 });
        k.paint(side(plate([[0.2, 0.06], [0.06, 0.115], [-0.02, 0.115], [-0.02, 0.06]], 0.012, 0.03, 0.004), s), { crease: 14, shade: 0.9 });
        k.vents(-0.24, -0.14, 0.047, s * EZ - 0.02, s * EZ + 0.02, 4);
        // downturned tip fins (the port one can be shot away)
        k.fin([{ z: 0, xl: -0.12, xt: -0.29, y: 0, th: 0.008 }, { z: 0.045, xl: -0.2, xt: -0.3, y: 0, th: 0.004 }], -50 * DEG, -0.01, 0.362, s, { col: B2, prof: FAC, crease: 14, brk: s < 0 ? 1 : 0, rot: [S.YAW, 0.2], at: 0.3 });
      }
      // dorsal shield emitter: hex dome with a glowing ring
      k.metal(latheY([[0.03, 0.046], [0.054, 0.042], [0.064, 0.03], [0.068, 0.02], [0.068, 0.0005]], 6, -0.13, 0), lin(0x4a4660), 14);
      {
        const c = P.glow.map((v) => v * 0.5), y = 0.069, EX = -0.13;
        for (let j = 0; j < 6; j++) {
          const a0 = (j / 6) * TAU, a1 = ((j + 1) / 6) * TAU, r0 = 0.012, r1 = 0.0185;
          const p = (r, a) => [EX + Math.sin(a) * r, y, Math.cos(a) * r];
          k.glow(p(r0, a0 + 0.08), p(r0, a1 - 0.08), p(r1, a1 - 0.08), c, c, c, CH.ACCENT); k.glow(p(r0, a0 + 0.08), p(r1, a1 - 0.08), p(r1, a0 + 0.08), c, c, c, CH.ACCENT);
        }
        // focusing crystal and three buttress vanes
        k.glowTris(latheY([[0.068, 0.0075], [0.078, 0.005], [0.085, 0.0004]], 6, EX, 0), P.glow.map((v) => v * 0.7), CH.ACCENT);
        for (let j = 0; j < 3; j++) k.metal(rotY(box(EX + 0.03, EX + 0.064, 0.03, 0.056, -0.004, 0.004, 0.002), (j / 3) * TAU + Math.PI / 3, EX, 0), GUNMETAL, 14);
        // a sensor arm sweeps round the crown of the dome
        const sw = k.part({ p: [EX, 0, 0], a: [0, 1, 0], rot: [S.SPIN, 0.6] });
        k.in(sw, () => {
          k.metal(box(EX + 0.006, EX + 0.03, 0.0685, 0.0725, -0.003, 0.003, 0.001), GUNMETAL, 14);
          k.glowBox(EX + 0.024, EX + 0.03, 0.0725, 0.0745, -0.0025, 0.0025, P.glow.map((v) => v * 0.6), CH.ACCENT);
        });
      }
      // overdrive vents on the engine humps, missile bays in the upper wing, battle damage on the armour tiles
      k.hatch(-0.1, -0.045, EZ - 0.012, EZ + 0.012, [0.0455, 0.0445], { sym: true, open: [S.OD, 0.75], glow: K3(GOLDC, 0.5), col: B2 });
      k.rocketBay(-0.29, -0.2, 0.152, 0.196, [wTop(WING, -0.29, 0.174, 1, FAC), wTop(WING, -0.2, 0.174, 1, FAC)], { ang: 1.15, col: B2 });
      k.spineCoils([[-0.28, 0.042], [-0.22, 0.049], [0.0, 0.06], [0.05, 0.055]], 0.012);
      k.tear(1, -0.04, 0.0215, -0.165, 0.07, 0.045);
      k.tear(2, -0.165, 0.0135, 0.255, 0.06, 0.04, { skew: -0.3 });
      k.emitter(0.365, -0.014, 0, 0.0075, { col: DK });
      k.keel(-0.28, -0.03, -0.04, 0.028, { frames: 3, scoop: 0.215, beacon: -0.2, col: DK });
      k.gear(0.16, -0.04, 0, GND, { foot: 'skid', r: 0.0034, w: 0.006 });
      k.gear(-0.15, wTop(WING, -0.15, 0.15, -1, FAC), 0.15, GND, { foot: 'skid', r: 0.0036, w: 0.007, ya: wTop(WING, -0.24, 0.15, -1, FAC) });
      // dorsal ridge: a knife-edged spine from the canopy to the tail
      k.paint(loft([[[0.1, 0.05, 0], [0.1, 0.04, 0.012], [0.1, 0.04, -0.012]], [[-0.06, 0.066, 0], [-0.06, 0.046, 0.02], [-0.06, 0.046, -0.02]], [[-0.3, 0.04, 0], [-0.3, 0.028, 0.016], [-0.3, 0.028, -0.016]], [[-0.45, 0.012, 0], [-0.45, 0.008, 0.006], [-0.45, 0.008, -0.006]]]), { crease: 14, shade: 0.9 });
      k.navLight(-0.46, 0.012, 0, NAV_WHITE, CH.STROBE, 0.008);
      k.solid(box(-0.3, 0.2, -0.04, -0.024, -0.04, 0.04, 0.008), DK, { crease: 14 });
      k.muzzles.unshift({ x: 0.5, y: 0, z: 0 });
    },
    liv(L) {
      L.base(P.base, 0.48, 0.3);
      // darker centre body, violet edge tiles
      L.fill([[0.5, 0], [0.3, -0.05], [0.06, -0.1], [-0.18, -0.108], [-0.38, -0.07], [-0.48, 0], [-0.38, 0.07], [-0.18, 0.108], [0.06, 0.1], [0.3, 0.05]], P.base2);
      SYM((s) => {
        // facet play: every panel is split on its diagonal and the halves catch the light differently
        {
          const zs = [0.04, 0.13, 0.215, 0.3, 0.365], fs = [0.085, 0.34, 0.8];
          for (let i = 0; i < zs.length - 1; i++) for (let j = 0; j < fs.length - 1; j++) {
            const q = wPoly(WING, zs[i], zs[i + 1], fs[j], fs[j + 1], s), odd = (i + j) % 2;
            L.fill([q[0], q[1], odd ? q[2] : q[3]], 0xffffff, { alpha: 0.085, rough: 0.34, metal: 0.55 });
            L.fill(odd ? [q[0], q[2], q[3]] : [q[1], q[2], q[3]], 0x000000, { alpha: 0.2, rough: 0.5, metal: 0.4 });
          }
        }
        L.fill(wPoly(WING, 0.04, 0.37, -0.02, 0.085, s), P.dark, { rough: 0.5, metal: 0.4 });
        L.fill(wPoly(WING, 0.255, 0.38, 0.085, 1.02, s), P.accent2);
        L.fill(wPoly(WING, 0.24, 0.25, 0.085, 1.02, s), P.trim);
        L.fill(wPoly(WING, 0.04, 0.37, 0.9, 1.02, s), P.dark, { rough: 0.5, metal: 0.4 });
        // exhaust trough
        L.fill([[-0.33, s * (EZ - 0.045)], [-0.46, s * (EZ - 0.03)], [-0.46, s * (EZ + 0.04)], [-0.33, s * (EZ + 0.045)]], 0x0e0c14, { rough: 0.35, metal: 0.9 });
        // faceted panel breaks
        L.line(wLine(WING, 0.045, 0.36, 0.34, s), { w: 2 }); L.line(wLine(WING, 0.045, 0.36, 0.8, s));
        for (const z of [0.13, 0.215, 0.3]) L.line([wPt(WING, z, 0.085), wPt(WING, z, 1)].map((p) => [p[0], p[1] * s]), { w: 2 });
        L.line([wPt(WING, 0.13, 0.34), wPt(WING, 0.215, 0.8)].map((p) => [p[0], p[1] * s]));
        L.line([wPt(WING, 0.215, 0.34), wPt(WING, 0.3, 0.8)].map((p) => [p[0], p[1] * s]));
        L.fill([[0.1, s * 0.13], [-0.1, s * 0.13], [-0.18, s * 0.2], [0.02, s * 0.2]], P.accent2);
        L.hatch(-0.2, s * 0.24, -0.26, s * 0.275);
        L.shade([[0.25, s * 0.05], [-0.36, s * 0.07]], 0.03, 0.3);
        L.shade([[-0.36, s * EZ], [-0.46, s * EZ]], 0.08, 0.4);
      });
      for (const x of [0.36, 0.08, -0.05, -0.24, -0.38]) L.line([[x, -0.1], [x, 0.1]], { a: 0.5 });
      L.fill([[0.08, -0.008], [-0.06, -0.008], [-0.06, 0.008], [0.08, 0.008]], P.accent);
      L.text(P.hull, -0.31, 0.2, 0.045, P.trim, -Math.PI / 2);
      L.wear(31, 0.7);
    },
  };
}

/* ---------------------------------- ACE ---------------------------------- */
function defAce() {
  const P = {
    base: 0xe0a91f, base2: 0x9a6a10, dark: 0x17171a, accent: 0x17171a, accent2: 0xc3261a, trim: 0xcfcabb,
    glass: lin(0x4a5560), glow: [7, 4.2, 0.6], eng: { hot: [10, 9, 6.5], mid: [6.5, 3.4, 0.6], rim: [4.5, 1.6, 0.2] }, hull: '1',
  };
  const WING = [
    { z: 0.05, xl: 0.05, xt: -0.365, y: -0.004, th: 0.032 },
    { z: 0.15, xl: -0.105, xt: -0.345, y: -0.003, th: 0.022 },
    { z: 0.262, xl: -0.23, xt: -0.37, y: -0.001, th: 0.012 },
  ];
  const CAN = [{ z: 0.04, xl: 0.245, xt: 0.135, y: 0.006, th: 0.012 }, { z: 0.155, xl: 0.155, xt: 0.105, y: 0.006, th: 0.006 }];
  const PZ = 0.278, PR = 0.029;
  return {
    zr: 0.36, P, feel: { ctl: 55, eng: 110 },
    breach: [[-0.215, 0.144, 0.05], [-0.265, -0.228, 0.05, wTop(WING, -0.265, 0.228)], [0.26, 0.052, 0.045, 0.027], [0.05, -0.04, 0.05]],
    geo(k) {
      const q = k.q, B2 = lin(P.base2), DK = lin(P.dark), G = P.glow, GND = -0.094;
      const G1 = k.gunSlots(1, { ext: 0.03 }), G2 = k.gunSlots(2, { stow: [-0.13, 0, 0] }), G3 = k.gunSlots(3, { stow: [-0.1, 0, 0], recoil: 0.01 });
      const F = fuselage([
        { x: -0.41, w: 0.048, t: 0.04, b: 0.036, et: 2.2 }, { x: -0.22, w: 0.06, t: 0.05, b: 0.04, et: 2.2 },
        { x: 0.0, w: 0.06, t: 0.052, b: 0.04, et: 2 }, { x: 0.16, w: 0.052, t: 0.044, b: 0.036, et: 1.8, eb: 1.8 },
        { x: 0.27, w: 0.046, t: 0.03, b: 0.028, et: 1.8, eb: 1.8 }, { x: 0.315, w: 0.034, t: 0.02, b: 0.02, et: 2, eb: 2 },
      ], { n: k.seg(24), sub: q >= 1 ? 4 : 2 });
      k.paint(F.tris, { crease: 38 });
      k.paint(fuselage([
        { x: -0.4, w: 0.012, t: 0.006, b: 0.01, y: 0.036 }, { x: -0.2, w: 0.024, t: 0.018, b: 0.01, y: 0.04, et: 2.5 },
        { x: -0.04, w: 0.028, t: 0.026, b: 0.01, y: 0.036, et: 2.5 }, { x: 0.0, w: 0.028, t: 0.026, b: 0.01, y: 0.034, et: 2.5 },
      ], { n: k.seg(12), sub: 3 }).tris, { crease: 38 });
      k.canopy([
        { x: -0.035, w: 0.008, t: 0.004 }, { x: 0.02, w: 0.026, t: 0.026 }, { x: 0.09, w: 0.0295, t: 0.036 },
        { x: 0.16, w: 0.023, t: 0.024 }, { x: 0.205, w: 0.009, t: 0.006 }, { x: 0.218, w: 0.002, t: 0.0015 },
      ], 0.033, { arches: [0.045, 0.158], pilot: 0.095, helmet: 0xc3261a });
      // fork nose: a yoke that widens out of the fuselage into two chisel prongs around the beam emitter
      k.noseAt(0.3, 0.04);
      k.nose(() => {
      k.paint(loft([ringRect(0.19, -0.026, 0.03, -0.05, 0.05, 0.012), ringRect(0.27, -0.024, 0.027, -0.078, 0.078, 0.01), ringRect(0.318, -0.021, 0.023, -0.09, 0.09, 0.008)]), { crease: 30 });
      for (const s of [1, -1]) {
        k.paint(side(loft([ringRect(0.3, -0.021, 0.023, 0.034, 0.09, 0.008), ringRect(0.39, -0.017, 0.019, 0.036, 0.086, 0.007), ringRect(0.46, -0.011, 0.012, 0.04, 0.078, 0.005), ringRect(0.5, -0.003, 0.003, 0.05, 0.064, 0.0012)]), s), { crease: 30 });
        // field coil lining the inside of each prong
        k.glowBox(0.325, 0.455, -0.005, 0.005, s * 0.032, s * 0.0345, G.map((v) => v * 0.16), CH.ACCENT);
        if (q >= 1) for (const cx of [0.34, 0.375, 0.41, 0.445]) k.metal(side(box(cx - 0.004, cx + 0.004, -0.012, 0.012, 0.03, 0.037, 0.0015), s), GUNMETAL, 30);
      }
      k.metal(lathe([[0.3, 0.03], [0.324, 0.03], [0.332, 0.023], [0.326, 0.017], [0.312, 0.014]], k.seg(14), { capA: false, capB: false }), METAL, 28);
      k.glowCone(0.3185, 0.0001, G.map((v) => v * 0.5), 0, 0.3185, 0.017, G.map((v) => v * 0.2), 0, 0, 0, k.seg(14), CH.ACCENT);
      k.emitter(0.3275, 0, 0, 0.0175, { housing: false, hub: 0.52 }); // the iris closes around the spike
      k.metal(lathe([[0.317, 0.0085], [0.4, 0.0055], [0.44, 0.001]], 8, {}), GUNMETAL, 30);
      for (const x of [0.345, 0.37, 0.395]) k.metal(lathe([[x - 0.004, 0.0105], [x + 0.004, 0.0105]], 8, {}), METAL, 30);
      // capacitor bands on the prongs: they light as the beam charges
      for (const s of [1, -1]) for (const cx of [0.34, 0.375, 0.41, 0.445]) k.glowBox(cx - 0.003, cx + 0.003, lerp(0.022, 0.014, (cx - 0.32) / 0.14), lerp(0.022, 0.014, (cx - 0.32) / 0.14) + 0.0016, s * 0.061 - 0.014, s * 0.061 + 0.014, K3(G, 0.5), CH.CHARGE);
      });
      // centre engine
      k.nozzle(-0.5, 0.002, 0, 0.044, 0.12);
      for (const s of [1, -1]) {
        // wing: inboard flap (airbrake) and aileron; all-moving canards
        k.flapWing(WING, s, 0.78, [[0.062, 0.15, [S.BRAKE, 0.6, S.PITCH, -0.14]], [0.16, 0.248, [S.BANK, -s * 0.55, S.PITCH, -0.12]]]);
        k.wingTrim(WING, s, 0.06, 0.255, 0.1);
        k.slab(CAN, s, 0.19, [S.PITCH, 0.34, S.BANK, -s * 0.38]);
        // wingtip engine pods
        k.paint(side(lathe([[-0.435, PR * 0.95], [-0.32, PR * 1.05], [-0.16, PR * 1.0], [-0.1, PR * 0.8]], k.seg(14), { y: 0, z: PZ, capB: false }), s), { crease: 36 });
        k.intakeRound(-0.1, 0, s * PZ, PR * 0.8);
        k.nozzle(-0.5, 0, s * PZ, 0.024, 0.07);
        k.navLight(-0.25, PR + 0.002, s * (PZ + 0.012), s > 0 ? NAV_GREEN : NAV_RED);
        {
          // (rudder; the port one can be shot away)
          k.fin([{ z: 0, xl: -0.28, xt: -0.42, y: 0, th: 0.01 }, { z: 0.07, xl: -0.37, xt: -0.45, y: 0, th: 0.004 }], 70 * DEG, PR * 0.8, PZ, s, { col: DK, brk: s < 0 ? 2 : 0, rot: [S.YAW, -0.3], at: 0.35 });
        }
        // long wing-root cannons; tier 2 runs a pair out of the belly, tier 3 a rail out of each fork prong
        const gi = s > 0 ? 0 : 1, gs = s > 0 ? 'A' : 'B';
        k.solid(side(lathe([[-0.16, 0.004], [-0.1, 0.017], [0.0, 0.017], [0.04, 0.011]], k.seg(10), { y: -0.002, z: 0.092 }), s), DK, { crease: 34 });
        k.gun(G1[gi], -0.02, 0.285, -0.002, s * 0.092, 0.0072, { set: gs, breech: 0.055 });
        k.solid(side(lathe([[-0.17, 0.003], [-0.12, 0.012], [-0.06, 0.012], [-0.03, 0.008]], k.seg(8), { y: -0.004, z: 0.135 }), s), DK, { crease: 34 });
        k.gun(G1[1 - gi], -0.08, 0.14, -0.004, s * 0.135, 0.0055, { set: s > 0 ? 'B' : 'A', breech: -0.02 });
        k.gun(G2[gi], 0.15, 0.31, -0.043, s * 0.0135, 0.0048, { set: gs, tier: 2, breech: 0.212 });
        k.gun(G3[gi], 0.37, 0.5, 0.0, s * 0.061, 0.0042, { set: gs, tier: 3, coil: 2, breech: 0.49 });
        k.vents(-0.3, -0.22, 0.045, s * 0.03 - 0.012, s * 0.03 + 0.012, 3);
        if (q >= 1) k.solid(side(move(rotX(wing([{ z: 0, xl: -0.2, xt: -0.36, y: 0, th: 0.008 }, { z: 0.045, xl: -0.29, xt: -0.38, y: 0, th: 0.004 }]), -75 * DEG), 0, -0.03, 0.03), s), DK, { crease: 26 });
      }
      // tall racing fin: the top is the rudder (and the first thing to go)
      {
        const fin = k.fin([{ z: 0, xl: -0.14, xt: -0.4, y: 0, th: 0.014 }, { z: 0.07, xl: -0.26, xt: -0.43, y: 0, th: 0.01 }, { z: 0.125, xl: -0.36, xt: -0.455, y: 0, th: 0.005 }], 90 * DEG, 0.04, 0, 1, { brk: 1, rot: [S.YAW, -0.34] });
        k.in(fin.part, () => k.navLight(-0.43, 0.17, 0, NAV_WHITE, CH.STROBE, 0.007));
      }
      // overdrive vents and missile bays in the upper wing, battle damage
      k.hatch(-0.26, -0.19, 0.082, 0.12, [wTop(WING, -0.26, 0.1), wTop(WING, -0.19, 0.1)], { sym: true, open: [S.OD, 0.8], glow: K3(GOLDC, 0.5) });
      k.rocketBay(-0.262, -0.185, 0.166, 0.2, [wTop(WING, -0.262, 0.183), wTop(WING, -0.185, 0.183)], {});
      k.tear(1, -0.265, wTop(WING, -0.265, 0.228), -0.228, 0.05, 0.036);
      k.tear(2, 0.26, 0.027, 0.052, 0.05, 0.04, { skew: -0.3 });
      k.scanner(-0.09, 0.058, 0, 0.01);
      k.keel(-0.24, -0.02, -0.052, 0.018, { frames: 3, scoop: 0.215, beacon: -0.13, col: B2 });
      k.gear(0.13, -0.052, 0, GND, { foot: 'wheel', r: 0.0034, w: 0.006 });
      k.gear(-0.25, -PR * 1.05, PZ, GND, { foot: 'skid', r: 0.0036, w: 0.007 });
      k.solid(box(-0.26, 0.2, -0.052, -0.034, -0.026, 0.026, 0.008), B2, { crease: 30 });
      k.muzzles.unshift({ x: 0.44, y: 0, z: 0 });
    },
    liv(L) {
      L.base(P.base, 0.42, 0.3);
      // twin black racing stripes nose to tail, fork prongs black-tipped
      SYM((s) => {
        L.fill([[0.3, s * 0.012], [-0.42, s * 0.012], [-0.42, s * 0.034], [0.3, s * 0.034]], P.dark);
        L.fill([[0.54, s * 0.02], [0.41, s * 0.02], [0.41, s * 0.1], [0.54, s * 0.1]], P.dark);
        L.fill([[0.41, s * 0.02], [0.396, s * 0.02], [0.396, s * 0.1], [0.41, s * 0.1]], P.trim);
        L.fill([[0.34, s * 0.03], [0.3, s * 0.03], [0.26, s * 0.1], [0.3, s * 0.1]], P.accent2);
        L.line([[0.3, s * 0.03], [0.3, s * 0.1]]); L.line([[0.2, s * 0.05], [0.3, s * 0.09]]);
        // wing: black tip, white pinstripe, red leading edge, checker band
        L.fill(wPoly(WING, 0.205, 0.3, -0.02, 1.02, s), P.dark);
        L.fill(wPoly(WING, 0.192, 0.2, -0.02, 1.02, s), P.trim);
        L.fill(wPoly(WING, 0.05, 0.2, -0.02, 0.07, s), P.accent2);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) {
          const z0 = 0.105 + j * 0.022, f0 = 0.5 + i * 0.075;
          if ((i + j) % 2 === 0) L.fill(wPoly(WING, z0, z0 + 0.022, f0, f0 + 0.075, s), P.dark);
          else L.fill(wPoly(WING, z0, z0 + 0.022, f0, f0 + 0.075, s), P.trim);
        }
        // pods black with a gold band, canards black-tipped
        L.fill(L.rect(-0.45, s * (PZ - 0.032), -0.09, s * (PZ + 0.034)), P.dark, { rough: 0.4, metal: 0.4 });
        L.fill(L.rect(-0.2, s * (PZ - 0.032), -0.17, s * (PZ + 0.034)), P.base);
        L.fill(wPoly(CAN, 0.105, 0.17, -0.02, 1.02, s), P.dark);
        L.fill(wPoly(CAN, 0.095, 0.102, -0.02, 1.02, s), P.trim);
        L.line(wLine(WING, 0.055, 0.255, 0.3, s)); L.line(wLine(WING, 0.055, 0.255, 0.74, s));
        for (const z of [0.1, 0.15, 0.205]) L.line([wPt(WING, z, 0.07), wPt(WING, z, 1)].map((p) => [p[0], p[1] * s]));
        L.line(wPoly(WING, 0.06, 0.25, 0.78, 0.97, s), { close: true, w: 2 });
        L.hatch(-0.12, s * 0.06, -0.2, s * 0.085);
        L.rivets([-0.02, s * 0.075], [-0.3, s * 0.075], 16);
        L.shade([[0.04, s * 0.058], [-0.34, s * 0.058]], 0.03, 0.3);
        L.shade([[-0.3, s * 0.262], [-0.1, s * 0.262]], 0.02, 0.25);
      });
      for (const x of [0.25, 0.2, -0.05, -0.16, -0.27, -0.36]) L.line([[x, -0.06], [x, 0.06]], { a: 0.5 });
      L.shade([[0.22, 0], [-0.04, 0]], 0.08, 0.25);
      L.shade([[-0.36, 0], [-0.44, 0]], 0.1, 0.45);
      // race number roundel
      for (const s of [1, -1]) {
        L.a.fillStyle = css(P.trim); L.a.beginPath(); L.a.arc(-0.2, s * 0.155, 0.03, 0, TAU); L.a.fill();
        L.text(P.hull, -0.2, s * 0.155, 0.044, P.dark, s * -Math.PI / 2);
      }
      L.wear(41, 0.8);
    },
  };
}

const DEFS = {
  vanguard: () => defVanguard(),
  player1: () => defVanguard(),
  player2: () => defVanguard({ base: 0x9d8f9c, base2: 0x62536a, accent: 0xff2a9d, accent2: 0xa80f6e, glow: [5.5, 0.9, 3.2], glass: lin(0xb87fa4), hull: '02' }),
  interceptor: defInterceptor,
  juggernaut: defJuggernaut,
  ghost: defGhost,
  ace: defAce,
};
const GEO_KEY = { player1: 'vanguard' };

/* ========================================================================== */
/*  Materials                                                                 */
/* ========================================================================== */

const GLSL_NOISE = `
float s3h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float s3n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(s3h(i), s3h(i + vec2(1.0, 0.0)), f.x), mix(s3h(i + vec2(0.0, 1.0)), s3h(i + vec2(1.0, 1.0)), f.x), f.y); }
float s3f(vec2 p){ return 0.5 * s3n(p) + 0.3 * s3n(p * 2.13 + 7.1) + 0.2 * s3n(p * 4.7 + 3.3); }
`;
// Rig: aRig = (slot, weight). uPa[slot] = quaternion xyz + emissive level, uPb[slot] = offset + scale
// (0 hides the part, anything else scales it across the X axis: the nozzle and emitter irises).
const GLSL_RIG = `
attribute vec2 aRig; uniform vec4 uPa[${NP}]; uniform vec4 uPb[${NP}];
vec3 s3q(vec3 v, vec4 q){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 s3pose(vec3 v, vec4 q, vec4 b){ return s3q(v * vec3(step(1e-4, b.w), b.w, b.w), q) + b.xyz; }
`;
const VERT_HEAD = `
varying vec3 vS3Pos; varying vec3 vS3N; varying float vS3Nb;
${GLSL_RIG}
#ifdef S3_HINGE
varying float vS3Sw;
#endif
`;
const VERT_NORMAL = `
int s3i = int(aRig.x + 0.1);
vec4 s3A = uPa[s3i], s3B = uPb[s3i];
vec4 s3Q = vec4(s3A.xyz, sqrt(max(0.0, 1.0 - dot(s3A.xyz, s3A.xyz))));
vS3N = objectNormal; vS3Nb = step(0.2, aRig.x - float(s3i)); // (slot + 0.25 marks parts the breaches must not burn through)
#ifdef S3_HINGE
vS3Sw = step(0.8, uv.x) * step(0.4, abs(uv.y - 0.5));
#endif
if (s3i > 0) objectNormal = normalize(mix(objectNormal, s3q(objectNormal, s3Q), aRig.y));
`;
const VERT_BEGIN = `
vS3Pos = transformed;
if (s3i > 0) transformed = mix(transformed, s3pose(transformed, s3Q, s3B), aRig.y);
`;
// Plan projection is only right for faces that look up. Faces that look sideways or down take the
// livery's colour blocks (a blurred sample: no smeared lines or chips) and get their own panelling,
// drawn in the plane they actually lie in.
export const GLSL_FACES = `
float s3line(vec2 g, float w0) {
  vec2 f = abs(fract(g) - 0.5), w = fwidth(g);
  vec2 d = (0.5 - f) / max(w, vec2(1e-5));
  return (1.0 - clamp(min(d.x, d.y) - w0, 0.0, 1.0)) * (1.0 - smoothstep(0.2, 0.55, max(w.x, w.y)));
}
// returns albedo multiplier for side (.x weight) and belly (.y weight) faces at object position p
float s3faces(vec3 p, float sideW, float bellyW) {
  float m = 1.0;
  if (sideW > 0.01) {
    vec2 g = vec2(p.x * 8.0, p.y * 27.0 + 0.5); g.x += 0.5 * floor(g.y);
    float l = s3line(g, 0.35);
    float band = step(0.5, fract(p.y * 13.5 + 0.25));
    m *= mix(1.0, (0.9 + 0.1 * band) * (1.0 - 0.5 * l), sideW);
  }
  if (bellyW > 0.01) {
    vec2 g = vec2(p.x * 9.0 + 0.3, abs(p.z) * 15.0); g.x += 0.5 * floor(g.y);
    float l = s3line(g, 0.35);
    float keel = 1.0 - smoothstep(0.004, 0.012, abs(p.z));
    float tile = 0.5 + 0.5 * step(0.5, fract(sin(dot(floor(g), vec2(12.9898, 78.233))) * 43758.5453));
    m *= mix(1.0, (0.6 + 0.12 * tile) * (1.0 - 0.55 * l) * (1.0 - 0.4 * keel), bellyW);
  }
  return m;
}
`;
const FRAG_HEAD = `
uniform float uFlash; uniform float uDamage; uniform vec4 uTint; uniform float uTime; uniform float uFade; uniform vec4 uBr[4]; uniform vec4 uHit[4]; uniform vec4 uSheen;
varying vec3 vS3Pos; varying vec3 vS3N; varying float vS3Nb;
#ifdef S3_HINGE
varying float vS3Sw;
#endif
${GLSL_NOISE}
${GLSL_FACES}
`;
const FRAG_MAP = `
float s3up = 1.0, s3dn = 0.0, s3sd = 0.0;
#ifdef S3_HINGE
{
  vec3 s3n = normalize(vS3N);
  s3up = smoothstep(0.2, 0.5, s3n.y); s3dn = smoothstep(0.2, 0.5, -s3n.y); s3sd = 1.0 - s3up - s3dn;
}
#endif
#ifdef USE_MAP
{
  vec4 s3t = texture2D(map, vMapUv);
  #ifdef S3_HINGE
  if (vS3Sw < 0.5 && s3up < 0.999) s3t = mix(texture2D(map, vMapUv, 3.0), s3t, s3up);
  #endif
  diffuseColor *= s3t;
}
#endif
#ifdef S3_HINGE
if (vS3Sw < 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2))) * 1.1, 0.6 * s3dn); // undersides: low-visibility grey
diffuseColor.rgb *= s3faces(vS3Pos, s3sd, s3dn);
#endif
`;
const FRAG_COLOR = `
float s3soot = 0.0; float s3hot = 0.0; float s3white = 0.0;
{
  #ifdef S3_TINT
  vec3 c0 = diffuseColor.rgb; float mx = max(c0.r, max(c0.g, c0.b)), mn = min(c0.r, min(c0.g, c0.b));
  float tm = smoothstep(0.42, 0.78, (mx - mn) / (mx + 1e-4)) * uTint.a;
  diffuseColor.rgb = mix(c0, uTint.rgb * mx, tm);
  #endif
  vec2 q = vS3Pos.xz;
  float s3fn = smoothstep(0.3, 0.65, abs(normalize(vS3N).y));
  if (uDamage > 0.001) {
    // scorches first: soot dragged aft in streaks, spreading as the hull takes more
    float n = mix(s3f(vec2(q.x * 5.0, q.y * 16.0) + uBr[0].xy * 31.0), s3f(q * 9.0 + 4.0), 0.4);
    float a = mix(0.69, 0.34, uDamage);
    s3soot = smoothstep(a, a + 0.12, n) * 0.85;
    // then the breaches, one after another: burnt skin around a hole with the frames showing and fire underneath.
    // They are punched along Y, so only skin that faces up or down takes them (no smears down a fin).
    float flat_ = s3fn * (1.0 - vS3Nb);
    for (int i = 0; i < 4; i++) {
      float r = uBr[i].z * smoothstep(uBr[i].w, uBr[i].w + 0.28, uDamage) * flat_;
      if (r > 0.0005) {
        float d = length(q - uBr[i].xy) + (s3n(q * 34.0 + float(i) * 9.0) - 0.5) * r * 0.9;
        float core = 1.0 - smoothstep(r * 0.45, r, d);
        s3soot = max(s3soot, 1.0 - smoothstep(r * 0.8, r * 2.3, d));
        float crack = pow(1.0 - abs(2.0 * s3n(q * 42.0 + 3.0) - 1.0), 6.0);
        float rim = smoothstep(r * 0.72, r * 0.92, d) * (1.0 - smoothstep(r * 0.92, r * 1.08, d));
        float frame = s3line(q * 44.0, 0.8);
        float pulse = 0.55 + 0.45 * sin(uTime * 0.013 + float(i) * 2.1 + n * 20.0);
        s3hot += core * (0.03 * pulse + crack * crack * 0.7) * (1.0 - 0.9 * frame) + rim * (0.22 + 0.4 * crack);
        diffuseColor.rgb += vec3(0.05, 0.048, 0.045) * frame * core;
      }
    }
    s3hot *= 0.72 + 0.28 * sin(uTime * 0.011 + n * 40.0);
  }
  // hit marks (the last four): a flash, a white-hot rim that cools through orange, and the scorched pit it leaves
  for (int i = 0; i < 4; i++) {
    float r = uHit[i].z;
    if (r > 0.0) {
      float h = uHit[i].w, kf = 0.4 + 0.6 * s3fn;
      float d = length(q - uHit[i].xy) + (s3n(q * 60.0 + float(i) * 5.0) - 0.5) * r * 0.5;
      float pit = 1.0 - smoothstep(r * 0.3, r * 0.9, d);
      float rim = smoothstep(r * 0.45, r * 0.8, d) * (1.0 - smoothstep(r * 0.8, r * 1.15, d));
      s3soot = max(s3soot, (1.0 - smoothstep(r * 0.6, r * 1.8, d)) * 0.92 * kf);
      s3hot += (rim * 0.8 + pit * 0.35) * h * kf;
      s3white += (rim * h * h * h * 0.55 + (1.0 - smoothstep(0.0, r * 1.7, d)) * pow(h, 10.0) * 0.3) * kf;
    }
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.011, 0.01), s3soot * 0.9);
}
`;

const FRAG_OUT = `
float s3fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
#ifdef S3_HINGE
outgoingLight += mix(uSheen.rgb, uSheen.grb, clamp(s3fr * 1.8, 0.0, 1.0)) * (0.03 + 0.55 * s3fr) * uSheen.a * (1.0 - s3soot);
#endif
outgoingLight = mix(outgoingLight, vec3(1.8), uFlash);
#ifdef S3_GLASS
// tinted glass: clear looking straight in, reflective at grazing angles, opaque only where the sun glints
diffuseColor.a = clamp(diffuseColor.a * (1.0 + 1.3 * s3fr) + s3fr * 0.3 + dot(totalSpecular, vec3(0.5)) * uFade + uFlash, 0.0, 1.0);
#endif
`;
function patchStd(mat, U, kind) { // kind 0 hull, 1 mech, 2 glass
  mat.defines = { ...(mat.defines || {}) };
  if (kind === 0) { mat.defines.S3_HINGE = ''; mat.defines.S3_TINT = ''; }
  if (kind === 2) mat.defines.S3_GLASS = '';
  mat.onBeforeCompile = (sh) => {
    for (const k in U) sh.uniforms[k] = U[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + VERT_NORMAL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BEGIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n#if defined(S3_HINGE) && defined(USE_NORMALMAP_TANGENTSPACE)\nnormal = normalize(mix(nonPerturbedNormal, normal, s3up));\n#endif')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n#if defined(S3_HINGE) && defined(USE_ROUGHNESSMAP)\nvec4 s3orm = texture2D(roughnessMap, vRoughnessMapUv, 3.0);\nif (vS3Sw < 0.5) roughnessFactor = mix(s3orm.g * roughness, roughnessFactor, s3up);\n#endif\nroughnessFactor = mix(roughnessFactor, 0.95, s3soot);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n#if defined(S3_HINGE) && defined(USE_ROUGHNESSMAP)\nif (vS3Sw < 0.5) metalnessFactor = mix(s3orm.b * metalness, metalnessFactor, s3up);\n#endif\nmetalnessFactor *= 1.0 - 0.8 * s3soot;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(5.0, 1.1, 0.14) * s3hot + vec3(7.0, 6.0, 4.6) * s3white;')
      .replace('#include <opaque_fragment>', FRAG_OUT + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 's3d' + kind;
  return mat;
}

// shadow pass: the same pose, or moving parts would cast from their rest position
const DEPTH_BEGIN = `
int s3i = int(aRig.x + 0.1);
vec4 s3A = uPa[s3i], s3B = uPb[s3i];
if (s3i > 0) transformed = mix(transformed, s3pose(transformed, vec4(s3A.xyz, sqrt(max(0.0, 1.0 - dot(s3A.xyz, s3A.xyz)))), s3B), aRig.y);
`;
const EMIS_VERT = `
attribute vec3 aCol; attribute vec2 aCh;
uniform float uLv[${NCH}]; uniform float uFlame; uniform float uTime; uniform vec4 uTint;
varying vec3 vCol;
${GLSL_RIG}
void main() {
  int ch = int(aCh.x + 0.5);
  int s3i = int(aRig.x + 0.1);
  vec4 s3A = uPa[s3i], s3B = uPb[s3i];
  vec3 c = aCol;
  if (ch == 4 || ch == 5) { float mx = max(c.r, max(c.g, c.b)); c = mix(c, uTint.rgb * mx, uTint.a); }
  if (ch == 17) c *= 0.55 + 0.45 * sin(uTime * 0.02 + position.x * 30.0); // charge pulses running forward
  if (ch == 7) c *= 0.5 + 0.5 * sin(uTime * 0.011 + position.x * 75.0 + position.y * 48.0 + position.z * 31.0); // heat haze crawling aft
  c *= s3A.w;
  vCol = c * uLv[ch];
  vec3 p = position;
  p.x -= aCh.y * uFlame * (1.0 + 0.16 * sin(uTime * 0.045 + position.z * 380.0 + position.y * 517.0));
  if (s3i > 0) p = mix(p, s3pose(p, vec4(s3A.xyz, sqrt(max(0.0, 1.0 - dot(s3A.xyz, s3A.xyz)))), s3B), aRig.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (ch == 1 && aCh.y > 0.0) { // plume: seen end-on its layers pile up, so thin it and let the nozzle show through
    vec3 ax = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    vCol = c * min(uLv[1], 1.0 + 0.3 * (uLv[1] - 1.0)) * mix(1.0, 0.22, smoothstep(0.5, 0.95, abs(dot(ax, normalize(mv.xyz)))));
  }
  gl_Position = projectionMatrix * mv;
}`;
const EMIS_FRAG = `
uniform float uFade; uniform float uFlash;
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol * uFade * (1.0 + uFlash), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ========================================================================== */
/*  Public class                                                              */
/* ========================================================================== */

export class Ships3D {
  constructor(THREE, opts = {}) {
    this.T = THREE;
    this.quality = opts.quality === 0.5 || opts.quality < 1 ? 0.5 : 1;
    this.anisotropy = opts.anisotropy ?? 8;
    this.textures = opts.textures !== false && typeof document !== 'undefined';
    this.geo = new Map();   // geometry key → { hull, mech, glass, emis, nozzles, muzzles, stats }
    this.tex = new Map();   // id → { map, orm, normal }
    this.defs = new Map();
    this.live = new Set();  // instance materials, for dispose()
    this.buildMs = {};
  }

  _def(id) {
    let d = this.defs.get(id);
    if (!d) { d = DEFS[id](); this.defs.set(id, d); }
    return d;
  }

  _geometry(id) {
    const key = GEO_KEY[id] || (id === 'player2' ? 'vanguard' : id);
    let g = this.geo.get(key);
    if (g) return g;
    const T = this.T, def = this._def(key);
    const k = new Kit(this.quality, def.zr, def.P);
    def.geo(k);
    // normalise: length exactly 1 on X, centred in x/z
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of [k.hull, k.mech, k.glass]) {
      for (let i = 0; i < b.pos.length; i += 3) {
        const x = b.pos[i], y = b.pos[i + 1], z = b.pos[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    for (const b of [k.hull, k.mech]) { // stowed / hidden parts stay out of the contact shading
      const n = b.pos.length / 3, sk = new Uint8Array(n);
      for (let i = 0; i < n; i++) sk[i] = k.parts[Math.floor(b.rig[i * 2])].ao ? 0 : 1;
      b.skip = sk;
    }
    bakeAO([k.hull, k.mech], { vox: this.quality >= 1 ? 0.0085 : 0.012 });
    // wound sites: the breaches the shader burns through the skin (their height read off the hull), plus the engine that gutters
    const topY = (x, z) => {
      for (const rad of [0.02, 0.04, 0.08]) {
        let y = -Infinity;
        const p = k.hull.pos, rg = k.hull.rig;
        for (let i = 0; i < p.length; i += 3) if ((rg[(i / 3) * 2] < 1 || rg[(i / 3) * 2 + 1] === 0) && Math.abs(p[i] - x) < rad && Math.abs(p[i + 2] - z) < rad && p[i + 1] > y) y = p[i + 1];
        if (y > -Infinity) return y;
      }
      return 0;
    };
    const BR = (def.breach || [[0, 0.1, 0.08], [0.1, -0.05, 0.06]]).slice(0, 4);
    while (BR.length < 4) { const b = BR[BR.length - 2]; BR.push([b[0] - 0.1, -b[1], b[2] * 0.85]); }
    const BT = [0.12, 0.32, 0.52, 0.85];
    const n0 = k.nozzles[0] || { x: -0.5, y: 0, z: 0 };
    const wd = BR.map((b, i) => ({ x: b[0], y: b[3] ?? topY(b[0], b[1]), z: b[1], at: BT[i] }));
    wd.splice(3, 0, { x: n0.x, y: n0.y, z: n0.z, at: 0.7 });
    const sc = 1 / (x1 - x0), ox = (x0 + x1) / 2, oz = (z0 + z1) / 2;
    const fix = (p) => { for (let i = 0; i < p.length; i += 3) { p[i] = (p[i] - ox) * sc; p[i + 1] *= sc; p[i + 2] = (p[i + 2] - oz) * sc; } };
    for (const b of [k.hull, k.mech, k.glass, k.emis]) fix(b.pos);
    for (let i = 1; i < k.emis.ch.length; i += 2) k.emis.ch[i] *= sc;
    const pt = (p) => ({ ...p, x: (p.x - ox) * sc, y: p.y * sc, z: (p.z - oz) * sc, ...(p.r != null ? { r: p.r * sc } : {}) });
    for (const P of k.parts) {
      fix(P.p);
      if (P.mov) for (let i = 0; i < P.mov.length; i += 4) { P.mov[i + 1] *= sc; P.mov[i + 2] *= sc; P.mov[i + 3] *= sc; }
    }
    const mk = (b, extra) => {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(b.pos, 3));
      if (b.nrm) geo.setAttribute('normal', new T.Float32BufferAttribute(b.nrm, 3));
      if (b.nrm) geo.setAttribute('color', new T.Float32BufferAttribute(b.col, 3));
      geo.setAttribute('aRig', new T.Float32BufferAttribute(b.rig, 2));
      if (extra) extra(geo);
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      // moving parts swing outside the rest pose (gear, canopy, plume): pad the culling volume
      geo.boundingSphere.radius *= 1.35;
      return geo;
    };
    // pieces breakOff() sheds: the same triangles as a rigid mesh of its own, centred on itself
    const debris = [];
    for (const brk of [1, 2]) {
      const h = k.hull, pos = [], nrm = [], col = [], uv = [];
      for (const P of k.parts) if (P.brk === brk) for (let r = 0; r < P.range.length; r += 2) for (let v = P.range[r]; v < P.range[r + 1]; v++) {
        pos.push(h.pos[v * 3], h.pos[v * 3 + 1], h.pos[v * 3 + 2]); nrm.push(h.nrm[v * 3], h.nrm[v * 3 + 1], h.nrm[v * 3 + 2]);
        col.push(h.col[v * 3], h.col[v * 3 + 1], h.col[v * 3 + 2]); uv.push(h.uv[v * 2], h.uv[v * 2 + 1]);
      }
      if (!pos.length) continue;
      const c = [0, 0, 0], n = pos.length / 3;
      for (let i = 0; i < pos.length; i += 3) { c[0] += pos[i] / n; c[1] += pos[i + 1] / n; c[2] += pos[i + 2] / n; }
      for (let i = 0; i < pos.length; i += 3) { pos[i] -= c[0]; pos[i + 1] -= c[1]; pos[i + 2] -= c[2]; }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
      geo.setAttribute('aRig', new T.Float32BufferAttribute(new Float32Array(n * 2), 2));
      geo.computeBoundingSphere();
      debris.push({ geo, c, brk, tris: n / 3 });
    }
    g = {
      hull: mk(k.hull, (geo) => geo.setAttribute('uv', new T.Float32BufferAttribute(k.hull.uv, 2))),
      mech: mk(k.mech),
      glass: mk(k.glass),
      emis: mk(k.emis, (geo) => {
        geo.setAttribute('aCol', new T.Float32BufferAttribute(k.emis.col, 3));
        geo.setAttribute('aCh', new T.Float32BufferAttribute(k.emis.ch, 2));
      }),
      nozzles: k.nozzles.map(pt),
      // muzzles: [0] is the centreline reference, then the guns in tier order (stable)
      muzzles: k.muzzles.map((m, i) => ({ part: 0, tier: 1, ...m, i })).sort((a, b) => a.tier - b.tier || a.i - b.i).map(pt),
      breach: BR.map(([x, z, r], i) => [(x - ox) * sc, (z - oz) * sc, r * sc, BT[i]]),
      wounds: wd.map(pt), parts: k.parts, debris, groundY: k.groundY * sc, rocketPort: k.rocketPort ? pt(k.rocketPort) : null,
      size: [1, (y1 - y0) * sc, (z1 - z0) * sc],
      tris: { hull: k.hull.pos.length / 9, mech: k.mech.pos.length / 9, glass: k.glass.pos.length / 9, emis: k.emis.pos.length / 9 },
    };
    g.tris.total = g.tris.hull + g.tris.mech + g.tris.glass + g.tris.emis;
    this.geo.set(key, g);
    return g;
  }

  _textures(id) {
    if (!this.textures) return null;
    const key = GEO_KEY[id] ? GEO_KEY[id] : id;
    let t = this.tex.get(key);
    if (t) return t;
    const def = this._def(key);
    const L = new Livery(document, def.zr, this.quality >= 1 ? 1024 : 512);
    def.liv(L);
    L.swatch();
    t = L.finish(this.T, this.anisotropy);
    this.tex.set(key, t);
    return t;
  }

  /** stats for a ship that has been built: { tris: {hull,mech,glass,emis,total}, drawCalls, parts (rig slots used), size, buildMs } */
  info(id) {
    const g = this._geometry(id);
    return { tris: g.tris, drawCalls: 4, parts: g.parts.length - 1, size: g.size, buildMs: this.buildMs[id] };
  }

  build(id, opts = {}) {
    if (!DEFS[id]) id = 'vanguard';
    const T = this.T, t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const g = this._geometry(id), tex = this._textures(id), def = this._def(GEO_KEY[id] || id);
    if (this.buildMs[id] == null && typeof performance !== 'undefined') this.buildMs[id] = performance.now() - t0;

    const lv = new Array(NCH).fill(0);
    lv[CH.STATIC] = 1;
    // rig pose, shared by all four materials: quaternion xyz + emissive level, offset + scale
    const pa = new Float32Array(NP * 4), pb = new Float32Array(NP * 4), pT = new Float32Array(NP * 3);
    for (let i = 0; i < NP; i++) pa[i * 4 + 3] = pb[i * 4 + 3] = 1;
    const U = {
      uFlash: { value: 0 }, uDamage: { value: 0 }, uTint: { value: new T.Vector4(1, 1, 1, 0) }, uTime: { value: 0 },
      uFade: { value: 1 }, uSheen: { value: new T.Vector4(...(def.P.sheen || [0, 0, 0, 0])) }, uBr: { value: g.breach.map((b) => new T.Vector4(b[0], b[1], b[2], b[3])) },
      uLv: { value: lv }, uFlame: { value: 0.3 }, uPa: { value: pa }, uPb: { value: pb },
      uHit: { value: [0, 1, 2, 3].map(() => new T.Vector4(0, 0, 0, 0)) },
    };
    const hull = patchStd(new T.MeshStandardMaterial({
      vertexColors: true, map: tex ? tex.map : null, normalMap: tex ? tex.normal : null,
      roughnessMap: tex ? tex.orm : null, metalnessMap: tex ? tex.orm : null,
      roughness: tex ? 1 : 0.56, metalness: tex ? 1 : 0.2, envMapIntensity: 1.0,
      color: tex ? 0xdedede : def.P.base,
    }), U, 0);
    if (tex) hull.normalScale.set(1, 1);
    const mech = patchStd(new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.9, envMapIntensity: 1.2 }), U, 1);
    const glass = patchStd(new T.MeshStandardMaterial({
      vertexColors: true, roughness: 0.045, metalness: 0.0, envMapIntensity: 0.3, transparent: true, opacity: GLASS_A, depthWrite: false,
    }), U, 2);
    const emis = new T.ShaderMaterial({
      uniforms: { uLv: U.uLv, uFlame: U.uFlame, uTime: U.uTime, uTint: U.uTint, uFade: U.uFade, uFlash: U.uFlash, uPa: U.uPa, uPb: U.uPb },
      vertexShader: EMIS_VERT, fragmentShader: EMIS_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    // depth material for the shadow pass (one program, shared by every hull): poses the rig like the lit pass
    const depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    depth.onBeforeCompile = (sh) => {
      sh.uniforms.uPa = U.uPa; sh.uniforms.uPb = U.uPb;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL_RIG).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DEPTH_BEGIN);
    };
    depth.customProgramCacheKey = () => 's3dd';
    const mats = [hull, mech, glass, emis, depth];
    for (const m of mats) this.live.add(m);

    const group = new T.Group();
    group.name = 'ship:' + id;
    const mh = new T.Mesh(g.hull, hull), mm = new T.Mesh(g.mech, mech), mg = new T.Mesh(g.glass, glass), me = new T.Mesh(g.emis, emis);
    mg.renderOrder = 1; me.renderOrder = 2;
    // shadows: painted hull and mechanics cast and receive; glass and the additive lights do neither
    mh.castShadow = mm.castShadow = true; mh.receiveShadow = mm.receiveShadow = true;
    mh.customDepthMaterial = mm.customDepthMaterial = mg.customDepthMaterial = depth;
    group.add(mh, mm, mg, me);

    // --- state. Setters only store targets; update() eases the channels and poses the rig. ---
    const feel = def.feel || {}, CTL = feel.ctl ?? 80, ENG = feel.eng ?? 140, TW = feel.twitch ?? 0;
    const parts = g.parts, C = new Float32Array(S.N);
    C[S.ONE] = 1; C[S.GUT] = 1;
    const st = {
      thrust: 1, damage: 0, opacity: 1, time: 0, flick: 1, snap: true,
      bank: 0, pitch: 0, yaw: 0, gearT: 0, gear: 0, canopyT: 0, canopy: 0, laserT: 0, od: 0, tier: 1, w2: 0, w3: 0,
      fireA: 0, fireB: 0, next: 0, heat: 0, rocket: -1, brk: 0, charge: 0, chargeT: 0, kick: 0, hitN: 0,
    };
    const hitAge = [0, 0, 0, 0], HIT_MS = 2500;
    const ud = group.userData;
    const applyEngine = () => {
      const t = st.thrust;
      lv[CH.ENGINE] = (0.22 + 0.8 * t + (t > 1 ? (t - 1) * 0.9 : 0)) * st.flick;
      U.uFlame.value = Math.max(0, t - 0.1) * (t > 1 ? 0.6 + (t - 1) * 0.75 : 0.6) * st.flick;
    };
    const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const sum = (terms, from) => { let v = 0; for (let j = from; j < terms.length; j += 2) v += C[terms[j]] * terms[j + 1]; return v; };
    const pose = () => {
      for (let i = 1; i < parts.length; i++) {
        const P = parts[i], a = P.a;
        let qx = 0, qy = 0, qz = 0, qw = 1;
        if (P.rot) { const h = sum(P.rot, 0) * 0.5, sn = Math.sin(h); qx = a[0] * sn; qy = a[1] * sn; qz = a[2] * sn; qw = Math.cos(h); }
        if (P.rot2) { // second axis, applied after the first: q = q2 * q1
          const h = sum(P.rot2, 0) * 0.5, sn = Math.sin(h), b = P.a2, bx = b[0] * sn, by = b[1] * sn, bz = b[2] * sn, bw = Math.cos(h);
          const x = bw * qx + bx * qw + by * qz - bz * qy, y = bw * qy - bx * qz + by * qw + bz * qx, z = bw * qz + bx * qy - by * qx + bz * qw;
          qw = bw * qw - bx * qx - by * qy - bz * qz; qx = x; qy = y; qz = z;
        }
        let tx = 0, ty = 0, tz = 0;
        if (P.mov) { const m = P.mov; for (let j = 0; j < m.length; j += 4) { const c = C[m[j]]; tx += c * m[j + 1]; ty += c * m[j + 2]; tz += c * m[j + 3]; } }
        let sc = 1;
        if (P.vis) sc = P.vis[0] + sum(P.vis, 1) > 0.001 ? 1 : 0;
        if (P.iris) sc *= Math.max(0.05, 1 + sum(P.iris, 0));
        if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
        // v' = p + t + R((v - p) * s)  →  R(v * s) + [p + t - R(p * s)]
        const px = P.p[0] * (sc > 1e-4 ? 1 : 0), py = P.p[1] * sc, pz = P.p[2] * sc;
        const cx = qy * pz - qz * py + qw * px, cy = qz * px - qx * pz + qw * py, cz = qx * py - qy * px + qw * pz;
        const o = i * 4;
        pa[o] = qx; pa[o + 1] = qy; pa[o + 2] = qz; pa[o + 3] = P.glow ? Math.max(0, P.glow[0] + sum(P.glow, 1)) : 1;
        pb[o] = P.p[0] + tx - (px + 2 * (qy * cz - qz * cy)); pb[o + 1] = P.p[1] + ty - (py + 2 * (qz * cx - qx * cz)); pb[o + 2] = P.p[2] + tz - (pz + 2 * (qx * cy - qy * cx)); pb[o + 3] = sc;
        pT[i * 3] = tx; pT[i * 3 + 1] = ty; pT[i * 3 + 2] = tz;
      }
      const M = ud.muzzles;
      let n = 0;
      for (let i = 0; i < M.length; i++) {
        const m = M[i], r = g.muzzles[i], q = r.part * 3;
        m.x = r.x + pT[q]; m.y = r.y + pT[q + 1]; m.z = r.z + pT[q + 2];
        m.active = r.tier <= 1 || (r.tier === 2 ? C[S.W2] : C[S.W3]) > 0.5;
        if (m.active) n = i + 1;
      }
      ud.muzzleCount = n;
      if (g.rocketPort) { const r = g.rocketPort, q = r.part * 3, o = ud.rocketPort; o.x = r.x + pT[q]; o.y = r.y + pT[q + 1]; o.z = r.z + pT[q + 2]; }
    };
    ud.shipId = id;
    ud.nozzles = g.nozzles.map((n) => ({ ...n }));
    ud.muzzles = g.muzzles.map((m) => ({ x: m.x, y: m.y, z: m.z, tier: m.tier, active: m.tier <= 1 }));
    ud.muzzleCount = ud.muzzles.length;
    ud.size = g.size.slice();
    ud.groundY = g.groundY; // lowest point of the lowered gear: sit the hull at -groundY * scale above a deck
    ud.wounds = g.wounds.map((w) => ({ x: w.x, y: w.y, z: w.z, heat: 0 }));
    ud.woundCount = 0;
    ud.rocketPort = g.rocketPort ? { x: g.rocketPort.x, y: g.rocketPort.y, z: g.rocketPort.z } : { x: 0, y: 0, z: 0 }; // starboard bay; mirror z for port
    const mkPiece = (d) => {
      const m = new T.Mesh(d.geo, hull);
      m.castShadow = m.receiveShadow = true; m.customDepthMaterial = depth;
      m.name = 'debris:' + id; m.userData.center = d.c.slice();
      m.userData.dispose = () => { m.removeFromParent(); }; // geometry and material stay with the hull
      return m;
    };
    const pieces = g.debris.map(mkPiece);
    ud.setThrust = (t) => { st.thrust = clamp(+t || 0, 0, 2); applyEngine(); };
    ud.setBank = (b) => { st.bank = clamp(+b || 0, -1, 1); };
    ud.setPitch = (v) => { st.pitch = clamp(+v || 0, -1, 1); };
    ud.setYaw = (v) => { st.yaw = clamp(+v || 0, -1, 1); };
    ud.setGear = (v) => { st.gearT = clamp(+v || 0, 0, 1); };
    ud.setCanopy = (v) => { st.canopyT = clamp(+v || 0, 0, 1); };
    ud.setWeapon = (tier) => { st.tier = clamp(Math.round(+tier || 1), 1, 3); };
    ud.setFire = () => { if ((st.next ^= 1)) st.fireA = 1; else st.fireB = 1; st.heat = Math.min(1, st.heat + 0.14); };
    ud.setRocket = () => { st.rocket = 0; };
    ud.setLaser = (v) => { v = clamp(+v || 0, 0, 1); if (v >= 0.5 && st.laserT < 0.5) st.kick = 1; st.laserT = v; };
    ud.setLaserCharge = (v) => { st.chargeT = clamp(+v || 0, 0, 1); };
    // Scorch the hull where it was struck (model units, hull-local; only x/z place the mark). The
    // last four marks are kept; each flashes, cools over ~2.5 s and stays as a dark pit until repair().
    ud.hit = (x, y, z, power = 1) => {
      const i = st.hitN++ & 3;
      U.uHit.value[i].set(+x || 0, +z || 0, 0.028 + 0.03 * clamp(+power || 0, 0, 2), 1);
      hitAge[i] = 0;
    };
    ud.setOverdrive = (on) => { st.od = on ? 1 : 0; };
    ud.setFlash = (v) => { U.uFlash.value = clamp(+v || 0, 0, 1); };
    ud.repair = () => {
      st.brk = 0; st.damage = U.uDamage.value = 0; ud.woundCount = 0;
      for (const h of U.uHit.value) h.set(0, 0, 0, 0);
      for (const w of ud.wounds) w.heat = 0; // (pieces already handed out by breakOff() are the caller's: they keep tumbling)
    };
    ud.setDamage = (d) => {
      d = clamp(+d || 0, 0, 1);
      if (d === st.damage) return;
      if (d === 0) { ud.repair(); return; }
      st.damage = U.uDamage.value = d;
      let n = 0;
      for (let i = 0; i < ud.wounds.length; i++) { const h = clamp((d - g.wounds[i].at) / 0.25, 0, 1); ud.wounds[i].heat = h; if (h > 0) n = i + 1; }
      ud.woundCount = n;
    };
    // Shed the next pre-cut piece (two per hull). Returns a parentless mesh of it posed in the hull's
    // local frame — position = where it sat, geometry centred on itself so it tumbles about its own
    // middle — or null when nothing is left to lose. It shares the hull material; the caller parents
    // it, and calls its userData.dispose() when done. repair() / setDamage(0) grow the parts back.
    ud.breakOff = () => {
      if (st.brk >= pieces.length) return null;
      let m = pieces[st.brk];
      if (m.parent) m = pieces[st.brk] = mkPiece(g.debris[st.brk]); // the last one shed is still flying
      const c = m.userData.center;
      st.brk++;
      m.position.set(c[0], c[1], c[2]); m.quaternion.set(0, 0, 0, 1); m.scale.setScalar(1); m.visible = true;
      return m;
    };
    ud.setOpacity = (a) => {
      a = clamp(a == null ? 1 : +a, 0, 1);
      if (a === st.opacity) return;
      const was = st.opacity < 1, now = a < 1;
      st.opacity = a;
      hull.opacity = mech.opacity = a; glass.opacity = GLASS_A * a; U.uFade.value = a;
      if (was !== now) { for (const m of [hull, mech]) { m.transparent = now; m.needsUpdate = true; } }
    };
    ud.setTint = (rgb, amount = 1) => {
      if (!rgb) { U.uTint.value.set(1, 1, 1, 0); return; }
      const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-4);
      U.uTint.value.set(rgb[0] / m, rgb[1] / m, rgb[2] / m, amount);
    };
    ud.update = (dtMs, timeMs) => {
      const dt = clamp(+dtMs || 0, 0, 100), snap = st.snap;
      const t = timeMs == null ? (st.time += dt) : (st.time = timeMs);
      U.uTime.value = t % 1e6;
      const d = st.damage;
      const ease = (tau) => (snap ? 1 : 1 - Math.exp(-dt / tau));
      const toward = (v, to, ms) => (snap ? to : v + clamp(to - v, -dt / ms, dt / ms));
      // controls
      const kc = ease(CTL);
      C[S.BANK] += (st.bank - C[S.BANK]) * kc; C[S.PITCH] += (st.pitch - C[S.PITCH]) * kc; C[S.YAW] += (st.yaw - C[S.YAW]) * kc;
      C[S.BRAKE] += (Math.max(0, -st.pitch) - C[S.BRAKE]) * ease(CTL * 1.6);
      C[S.BANKP] = Math.max(0, C[S.BANK]); C[S.BANKN] = Math.max(0, -C[S.BANK]);
      C[S.TWITCH] = TW * (0.5 * Math.sin(t * 0.031) + 0.5 * Math.sin(t * 0.047 + 1.3)) * Math.min(1, 0.22 + Math.abs(C[S.BANK]) + Math.abs(C[S.PITCH]) + Math.abs(C[S.YAW]));
      C[S.THR] += (Math.min(1, st.thrust) - C[S.THR]) * ease(ENG); C[S.AB] += (clamp(st.thrust - 1, 0, 1) - C[S.AB]) * ease(ENG * 0.7);
      // gear (doors lead the legs), canopy, weapons
      st.gear = toward(st.gear, st.gearT, 700); st.canopy = toward(st.canopy, st.canopyT, 900);
      C[S.GEARD] = sstep(0, 0.45, st.gear); C[S.GEARL] = sstep(0.3, 1, st.gear); C[S.CANOPY] = sstep(0, 1, st.canopy);
      st.w2 = toward(st.w2, st.tier >= 2 ? 1 : 0, 400); st.w3 = toward(st.w3, st.tier >= 3 ? 1 : 0, 400);
      C[S.W2] = sstep(0, 1, st.w2); C[S.W3] = sstep(0, 1, st.w3);
      const fd = Math.exp(-dt / 70);
      C[S.FIREA] = st.fireA; C[S.FIREB] = st.fireB; // (shown at full kick on the frame it fires, then decays)
      lv[CH.FLASHA] = st.fireA * st.fireA; lv[CH.FLASHB] = st.fireB * st.fireB;
      lv[CH.BHEAT] = st.heat;
      st.fireA = st.fireA < 0.01 ? 0 : st.fireA * fd; st.fireB = st.fireB < 0.01 ? 0 : st.fireB * fd;
      st.heat *= Math.exp(-dt / 1700);
      let rk = 0, rail = 0, puff = 0;
      if (st.rocket >= 0) { // launch: door snaps open (50 ms), the rail runs the round out, gas puffs at the breech, rail back, door shut by 400 ms
        const r = st.rocket;
        rk = r < 50 ? r / 50 : r < 310 ? 1 : r < 400 ? 1 - (r - 310) / 90 : 0;
        rail = sstep(40, 140, r) * (1 - sstep(230, 310, r));
        puff = r < 90 ? 0 : Math.exp(-(r - 90) / 70);
        st.rocket = r >= 400 ? -1 : r + dt;
      }
      C[S.ROCKET] = rk; lv[CH.ROCKET] = rk; C[S.RAIL] = rail; lv[CH.PUFF] = puff;
      // beam: charge opens the iris part-way and runs light up the spine coils; firing kicks the nose back
      const lz = toward(st.laserV || 0, st.laserT, 130);
      st.laserV = lz; st.charge = toward(st.charge, st.chargeT, 160);
      C[S.LASER] = Math.max(lz, st.charge * 0.55); C[S.OD] = toward(C[S.OD], st.od, 350);
      C[S.KICK] = snap ? 0 : st.kick + 0.06 * lz * Math.sin(t * 0.11); st.kick = st.kick < 0.01 ? 0 : st.kick * Math.exp(-dt / 170);
      lv[CH.LASER] = lz * (0.85 + 0.15 * Math.sin(t * 0.09)) + st.charge * (1 - lz) * 0.3 * (0.6 + 0.4 * Math.sin(t * 0.05));
      lv[CH.CHARGE] = Math.max(st.charge, lz * 0.75);
      for (let i = 0; i < 4; i++) { // hit marks cool
        const h = U.uHit.value[i];
        if (h.w > 0) { hitAge[i] += dt; const c = Math.max(0, 1 - hitAge[i] / HIT_MS); h.w = c * c; }
      }
      lv[CH.COIL] = C[S.W3] * (0.6 + 0.2 * Math.sin(t * 0.012)) + Math.max(C[S.FIREA], C[S.FIREB]) * 1.4;
      lv[CH.AB] = C[S.AB]; lv[CH.SHIM] = C[S.OD]; lv[CH.GOLD] = C[S.OD] * (0.82 + 0.18 * Math.sin(t * 0.009));
      // idle life
      C[S.SPIN] = (t * 0.0034) % TAU; C[S.BREATHE] = 0.5 + 0.5 * Math.sin(t * 0.0021); C[S.SWEEP] = Math.sin(t * 0.0015);
      // damage stages: panels peel at ~0.45 and ~0.65, one engine gutters from 0.7, pieces go when breakOff() says
      const kd = ease(160);
      C[S.DMG1] += (sstep(0.38, 0.5, d) - C[S.DMG1]) * kd; C[S.DMG2] += (sstep(0.58, 0.7, d) - C[S.DMG2]) * kd;
      C[S.BRK1] = st.brk >= 1 ? 1 : 0; C[S.BRK2] = st.brk >= 2 ? 1 : 0;
      const cough = Math.sin(t * 0.019) * Math.sin(t * 0.0071 + 1.0);
      C[S.GUT] = d >= 0.7 ? 0.05 + 0.4 * Math.max(0, cough) * Math.max(0, cough) + (Math.sin(t * 0.13) > 0.95 ? 0.8 : 0) : 1;
      lv[CH.SPARK] = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.021) * Math.sin(t * 0.0137 + 2.0)) + (Math.sin(t * 0.171) > 0.9 ? 0.9 : 0);
      // engine: fine shimmer, plus sputter when badly hurt
      let f = 1 + 0.05 * Math.sin(t * 0.045) + 0.03 * Math.sin(t * 0.113 + 1.7);
      if (d > 0.45) { const n = Math.sin(t * 0.031) * Math.sin(t * 0.0173 + 2.0); if (n > 1.25 - d) f *= 0.35; }
      st.flick = f; applyEngine();
      // nav lights blink together (red port, green starboard); the white strobes double-flash; damage makes both stutter
      const ph = (t % 1500) / 1500;
      let nav = clamp((Math.sin((t * TAU) / 1300) + 0.45) * 3.5, 0.1, 1), strobe = (ph < 0.05 || (ph > 0.12 && ph < 0.17)) ? 1.6 : 0.04;
      if (d > 0.6 && Math.sin(t * 0.05) * Math.sin(t * 0.023) > 0.2) { nav *= 0.15; strobe *= 0.2; }
      lv[CH.NAV] = nav; lv[CH.STROBE] = strobe;
      lv[CH.ACCENT] = (0.85 + 0.15 * Math.sin(t * 0.0025)) * (d > 0.75 ? 0.5 + 0.5 * Math.sin(t * 0.04) : 1) * (1 + 0.5 * C[S.OD]);
      lv[CH.COCKPIT] = 1 - d * 0.4;
      pose();
      st.snap = false;
    };
    // jump every eased channel straight to its target (after spawning a ship in a given state)
    ud.settle = () => { st.snap = true; st.fireA = st.fireB = st.heat = st.kick = 0; st.rocket = -1; ud.update(0, st.time); };
    ud.dispose = () => { for (const m of mats) { m.dispose(); this.live.delete(m); } };
    if (opts.tint) ud.setTint(opts.tint, opts.tintAmount ?? 1);
    ud.setThrust(opts.thrust ?? 1);
    ud.update(0, 0);
    return group;
  }

  dispose() {
    for (const m of this.live) m.dispose();
    this.live.clear();
    for (const g of this.geo.values()) { g.hull.dispose(); g.mech.dispose(); g.glass.dispose(); g.emis.dispose(); for (const d of g.debris) d.geo.dispose(); }
    for (const t of this.tex.values()) { t.map.dispose(); t.orm.dispose(); t.normal.dispose(); }
    this.geo.clear(); this.tex.clear(); this.defs.clear();
  }
}
