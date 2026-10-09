// cockpit3d.js — first-person cockpit interiors, built entirely in code.
//
// One interior per player hull, assembled from a shared kit: a canopy described
// as a patch of an ellipsoid (glass, sill, struts, roof), a three-facet
// dashboard, side consoles, stick / yoke / throttle with the pilot's gloved
// hands, the ship's own nose and guns ahead, and a set of instrument screens
// painted on two canvases. Everything static merges into one mesh per material;
// the few moving parts (controls, arms, guns) are separate meshes.
//
// The cockpit lives in its own scene with its own camera and is drawn on top
// of the world by a second render pass (clear=false, clearDepth=true).
// Cockpit space: metres, eye at the origin, +X ahead, +Y up, +Z starboard.
// The module imports nothing: it receives THREE.
//
//   const cp = new Cockpit3D(THREE, { renderer, quality: 1 });
//   cp.setShip('ace'); await cp.warmup(renderer);
//   cp.camera.fov = worldCam.fov; cp.camera.aspect = worldCam.aspect;
//   cp.update(dtMs, tMs, state);            // then render cp.scene with cp.camera
//   cp.hit({ side, front, power, shielded }); cp.reset();

export const COCKPIT_IDS = ['vanguard', 'interceptor', 'juggernaut', 'ghost', 'ace'];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
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
// small array-vector helpers (build time only)
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vlerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ========================================================================== */
/*  Triangle-soup modelling kit (flat number arrays, 9 per triangle)          */
/* ========================================================================== */

function tri(t, a, b, c) { t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
function quad(t, a, b, c, d) { tri(t, a, b, c); tri(t, a, c, d); }
function flip(t) {
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
function cat(...ts) { const o = []; for (const t of ts) for (let i = 0; i < t.length; i++) o.push(t[i]); return o; }
function mirrorZ(t) { for (let i = 2; i < t.length; i += 3) t[i] = -t[i]; return flip(t); }
function move(t, dx, dy, dz) { for (let i = 0; i < t.length; i += 3) { t[i] += dx; t[i + 1] += dy; t[i + 2] += dz; } return t; }
function scale(t, sx, sy, sz) { for (let i = 0; i < t.length; i += 3) { t[i] *= sx; t[i + 1] *= sy; t[i + 2] *= sz; } return t; }
// rotate about the X axis through (y0,z0): positive angle swings +Z toward +Y
function rotX(t, ang, y0 = 0, z0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const y = t[i + 1] - y0, z = t[i + 2] - z0;
    t[i + 1] = y0 + y * c + z * s; t[i + 2] = z0 - y * s + z * c;
  }
  return t;
}
// rotate about the Y axis through (x0,z0): positive angle swings +X toward +Z
function rotY(t, ang, x0 = 0, z0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const x = t[i] - x0, z = t[i + 2] - z0;
    t[i] = x0 + x * c - z * s; t[i + 2] = z0 + x * s + z * c;
  }
  return t;
}
// rotate about the Z axis through (x0,y0): positive angle swings +X toward +Y
function rotZ(t, ang, x0 = 0, y0 = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < t.length; i += 3) {
    const x = t[i] - x0, y = t[i + 1] - y0;
    t[i] = x0 + x * c - y * s; t[i + 1] = y0 + x * s + y * c;
  }
  return t;
}

// Skin a stack of closed rings (each an array of [x,y,z], same count). The
// result is oriented outward by signed volume, so ring direction never matters.
function loft(rings, o = {}) {
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
// monotone cubic interpolation (no overshoot)
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
// bottom depth b, exponents et/eb (2 = ellipse, >2 boxy, <2 chined)
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
function fuselage(keys, o = {}) {
  const n = o.n || 24, sub = o.sub || 4;
  const xs = keys.map((k) => k.x), f = {};
  for (const key of FKEYS) f[key] = pchip(xs, keys.map((k) => (k[key] ?? (key === 'b' ? k.t : FDEF[key]))));
  const at = (x) => { const s = {}; for (const key of FKEYS) s[key] = f[key](x); return s; };
  const rings = [];
  for (let i = 0; i < keys.length - 1; i++) {
    for (let k = 0; k < sub; k++) { const x = lerp(xs[i], xs[i + 1], k / sub); rings.push(secRing(x, at(x), n)); }
  }
  rings.push(secRing(xs[xs.length - 1], at(xs[xs.length - 1]), n));
  return loft(rings, o);
}
// body of revolution about an X-parallel axis; profile = [[x, r], ...]
function lathe(profile, n, o = {}) {
  const y0 = o.y || 0, z0 = o.z || 0, sy = o.sy || 1, sz = o.sz || 1, ph = o.phase || 0;
  const rings = profile.map(([x, r]) => {
    const R = [];
    for (let j = 0; j < n; j++) { const a = (j / n) * TAU + ph; R.push([x, y0 + Math.sin(a) * r * sy, z0 + Math.cos(a) * r * sz]); }
    return R;
  });
  return loft(rings, o);
}
// body of revolution about a vertical axis through (x,z); profile = [[y, r], ...]
function latheY(profile, n, x = 0, z = 0, o = {}) {
  const rings = profile.map(([y, r]) => {
    const R = [];
    for (let j = 0; j < n; j++) { const a = (j / n) * TAU; R.push([x + Math.cos(a) * r * (o.sx || 1), y, z + Math.sin(a) * r * (o.sz || 1)]); }
    return R;
  });
  return loft(rings, o);
}
// chamfered rectangle ring in the YZ plane
function ringRect(x, y0, y1, z0, z1, c = 0) {
  if (c <= 0) return [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]];
  return [[x, y0, z0 + c], [x, y0, z1 - c], [x, y0 + c, z1], [x, y1 - c, z1], [x, y1, z1 - c], [x, y1, z0 + c], [x, y1 - c, z0], [x, y0 + c, z0]];
}
// box with chamfered edges all round
function box(x0, x1, y0, y1, z0, z1, bv = 0) {
  if (bv <= 0) return loft([ringRect(x0, y0, y1, z0, z1), ringRect(x1, y0, y1, z0, z1)]);
  return loft([
    ringRect(x0, y0 + bv, y1 - bv, z0 + bv, z1 - bv, bv * 0.5), ringRect(x0 + bv, y0, y1, z0, z1, bv),
    ringRect(x1 - bv, y0, y1, z0, z1, bv), ringRect(x1, y0 + bv, y1 - bv, z0 + bv, z1 - bv, bv * 0.5),
  ]);
}
// picture frame standing on the YZ plane: outer rect → raised rim → inner rect
function bezel(y0, y1, z0, z1, t, h, c = 0.003, rec = 0.0015) {
  return loft([
    ringRect(0, y0 - t, y1 + t, z0 - t, z1 + t, c * 1.6), ringRect(h * 0.7, y0 - t, y1 + t, z0 - t, z1 + t, c * 1.6),
    ringRect(h, y0 - t * 0.72, y1 + t * 0.72, z0 - t * 0.72, z1 + t * 0.72, c * 1.3), ringRect(h, y0 - t * 0.3, y1 + t * 0.3, z0 - t * 0.3, z1 + t * 0.3, c),
    ringRect(-rec, y0, y1, z0, z1, c * 0.7),
  ], { capA: false, capB: false });
}
// tube swept along a polyline; r is a number or one radius per point
function tube(pts, r, n = 6, o = {}) {
  const rings = [];
  let up = [0, 1, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const T = vnorm(vsub(b, a));
    if (Math.abs(vdot(T, up)) > 0.95) up = [1, 0, 0];
    const U = vnorm(vcross(T, up)), W = vcross(U, T);
    up = W;
    const rr = Array.isArray(r) ? r[i] : r, R = [];
    for (let j = 0; j < n; j++) { const an = (j / n) * TAU, c = Math.cos(an) * rr, s = Math.sin(an) * rr * (o.flat || 1); R.push([pts[i][0] + U[0] * c + W[0] * s, pts[i][1] + U[1] * c + W[1] * s, pts[i][2] + U[2] * c + W[2] * s]); }
    rings.push(R);
  }
  return loft(rings, o);
}
// catenary-ish cable between two points
function cable(a, b, sag, r, n = 8, sides = 5) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n, p = vlerp(a, b, t); p[1] -= Math.sin(t * Math.PI) * sag; pts.push(p); }
  return tube(pts, r, sides);
}
// flat quad subdivided nu × nv, wound to face the point `toward`
function gridQuad(a, b, c, d, nu = 1, nv = 1, toward = [0, 0, 0]) {
  const t = [];
  const P = (u, v) => vlerp(vlerp(a, b, u), vlerp(d, c, u), v);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) quad(t, P(i / nu, j / nv), P((i + 1) / nu, j / nv), P((i + 1) / nu, (j + 1) / nv), P(i / nu, (j + 1) / nv));
  const n = vcross(vsub(b, a), vsub(d, a)), m = vlerp(a, c, 0.5);
  return vdot(n, vsub(toward, m)) < 0 ? flip(t) : t;
}
// surface from a point function p(u,v), wound to face `toward`
function gridFn(fn, nu, nv, toward = [0, 0, 0]) {
  const t = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = fn(i / nu, j / nv), b = fn((i + 1) / nu, j / nv), c = fn((i + 1) / nu, (j + 1) / nv), d = fn(i / nu, (j + 1) / nv);
    const q = [];
    quad(q, a, b, c, d);
    const n = vcross(vsub(b, a), vsub(d, a)), m = vlerp(a, c, 0.5);
    if (vdot(n, vsub(toward, m)) < 0) flip(q);
    for (let k = 0; k < q.length; k++) t.push(q[k]);
  }
  return t;
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
    if (!(l > 1e-12)) continue;
    for (let k = 0; k < 9; k++) pos.push(p[i + k]);
    fnx.push(nx); fny.push(ny); fnz.push(nz); fux.push(nx / l); fuy.push(ny / l); fuz.push(nz / l);
  }
  const nv = pos.length / 3;
  const keys = new Array(nv), next = new Int32Array(nv), map = new Map();
  for (let v = 0; v < nv; v++) {
    const key = Math.round(pos[v * 3] * 8000) + ',' + Math.round(pos[v * 3 + 1] * 8000) + ',' + Math.round(pos[v * 3 + 2] * 8000);
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

// Baked contact shading. The shell is voxelised, then every vertex inside the
// bounds is darkened by how much of the hemisphere over it is blocked close by:
// the gap under the coaming, console corners, the well around each switch.
// b: { pos, nrm, col } — col is multiplied in place for vertices [from, to).
function bakeAO(b, o = {}) {
  const vox = o.vox || 0.012, floor = o.floor ?? 0.3, pad = 2;
  const [x0, x1, y0, y1, z0, z1] = o.bounds;
  const nx = Math.ceil((x1 - x0) / vox) + 2 * pad + 1, ny = Math.ceil((y1 - y0) / vox) + 2 * pad + 1, nz = Math.ceil((z1 - z0) / vox) + 2 * pad + 1;
  const occ = new Uint8Array(nx * ny * nz), iv = 1 / vox;
  const at = (x, y, z) => {
    const i = Math.floor((x - x0) * iv) + pad, j = Math.floor((y - y0) * iv) + pad, k = Math.floor((z - z0) * iv) + pad;
    return i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : i + nx * (j + ny * k);
  };
  const p = b.pos, to = o.to ?? p.length;
  for (let t = 0; t < to; t += 9) {
    const ax = p[t], ay = p[t + 1], az = p[t + 2];
    const ux = p[t + 3] - ax, uy = p[t + 4] - ay, uz = p[t + 5] - az, vx = p[t + 6] - ax, vy = p[t + 7] - ay, vz = p[t + 8] - az;
    const m = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
    const n = Math.max(1, Math.min(72, Math.ceil(m / (vox * 0.7))));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, q = at(ax + ux * u + vx * v, ay + uy * u + vy * v, az + uz * u + vz * v);
      if (q >= 0) occ[q] = 1;
    }
  }
  const D = [2.3 * vox, 3.7 * vox, 5.6 * vox, 8.4 * vox], Wt = [1, 0.8, 0.55, 0.32];
  const hit = (x, y, z, dx, dy, dz) => {
    for (let k = 0; k < 4; k++) { const q = at(x + dx * D[k], y + dy * D[k], z + dz * D[k]); if (q >= 0 && occ[q]) return Wt[k]; }
    return 0;
  };
  const nr = b.nrm, c = b.col;
  for (let i = 0; i < to; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2], a = nr[i], bb = nr[i + 1], cc = nr[i + 2];
    if (at(x, y, z) < 0) continue;
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

/* ========================================================================== */
/*  Canopy: a patch of an ellipsoid in (azimuth, elevation) parameters        */
/* ========================================================================== */

// C = { c:[x,y,z] centre, r:[rx,ry,rz], az (max azimuth), sill0/sill1, top0/top1 }
// sill and top run as a + b·sin²(az): the glass sits between them.
const sin2 = (az) => (Math.abs(az) > Math.PI / 2 ? 1 : Math.sin(az) * Math.sin(az));
const sillAt = (C, az) => C.sill0 + (C.sill1 - C.sill0) * sin2(az);
const topAt = (C, az) => C.top0 + (C.top1 - C.top0) * sin2(az);
function canPt(C, az, e, k = 1) {
  const ce = Math.cos(e);
  return [C.c[0] + C.r[0] * k * ce * Math.cos(az), C.c[1] + C.r[1] * k * Math.sin(e), C.c[2] + C.r[2] * k * ce * Math.sin(az)];
}
const canNrm = (C, p) => vnorm([(p[0] - C.c[0]) / (C.r[0] * C.r[0]), (p[1] - C.c[1]) / (C.r[1] * C.r[1]), (p[2] - C.c[2]) / (C.r[2] * C.r[2])]);
// where the ray from `from` along `dir` leaves the ellipsoid → [az, e]
function canHit(C, from, dir) {
  const q = [(from[0] - C.c[0]) / C.r[0], (from[1] - C.c[1]) / C.r[1], (from[2] - C.c[2]) / C.r[2]];
  const d = [dir[0] / C.r[0], dir[1] / C.r[1], dir[2] / C.r[2]];
  const a = vdot(d, d), b = vdot(q, d), c = vdot(q, q) - 1;
  const t = (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a;
  const h = vadd(q, d, t);
  return [Math.atan2(h[2], h[0]), Math.asin(clamp(h[1], -1, 1))];
}
// rectangular bar swept along a curve fn(t) → [az, e] on the inside of the shell
function canBar(C, fn, n, w, d, k = 0.994) {
  const rings = [], c = Math.min(w, d) * 0.24;
  for (let i = 0; i <= n; i++) {
    const t = i / n, [az, e] = fn(t), [az2, e2] = fn(t + 1e-3);
    const P = canPt(C, az, e, k), T = vnorm(vsub(canPt(C, az2, e2, k), P)), N = canNrm(C, P), B = vnorm(vcross(T, N));
    const at = (bu, nu) => [P[0] + B[0] * bu - N[0] * nu, P[1] + B[1] * bu - N[1] * nu, P[2] + B[2] * bu - N[2] * nu];
    const h = w / 2;
    rings.push([at(h, 0), at(h, d - c), at(h - c, d), at(-h + c, d), at(-h, d - c), at(-h, 0)]);
  }
  return loft(rings);
}

/* ========================================================================== */
/*  Builder: buckets of geometry per material / moving part                   */
/* ========================================================================== */

// material presets: colour, roughness, metalness
const M = (hex, r, m = 0, k = 1) => ({ c: lin(hex, k), r, m });
const M_RUBBER = M(0x0c0d0f, 0.92), M_BLACK = M(0x121418, 0.6), M_SCREW = M(0x8d9299, 0.35, 1), M_STEEL = M(0xa4a9b0, 0.3, 1),
  M_GUN = M(0x33373d, 0.42, 1), M_RED = M(0xb3201a, 0.5), M_YELLOW = M(0xd9a514, 0.55), M_WHITE = M(0xc8ccd0, 0.5), M_SOOT = M(0x050506, 0.95);

// glow channels (uniform-driven intensities of the additive emissive mesh)
const CH = { STATIC: 0, ALARM: 1, MUZ_L: 2, MUZ_R: 3, BLINK_A: 4, BLINK_B: 5, EMERG: 6, HUDGLASS: 7, ACCENT: 8 };
// screen ids (per-screen brightness uniforms)
const SID = { TAC: 0, GAUGE: 1, MFD_L: 2, MFD_R: 3, LAMP0: 4, HUD: 10 };
// canvas layouts (pixels)
const CA_W = 768, CA_H = 512, CB_W = 1024, CB_H = 512;
const R_TAC = { x: 0, y: 0, w: 512, h: 416 }, R_HUD = { x: 512, y: 0, w: 256, h: 256 };
const R_GAUGE = [0, 1, 2, 3].map((i) => ({ x: i * 96, y: 416, w: 96, h: 96 }));
const R_MFD_L = { x: 0, y: 0, w: 352, h: 336 }, R_MFD_R = { x: 352, y: 0, w: 352, h: 336 };
const R_LAMP = [0, 1, 2, 3, 4, 5].map((i) => ({ x: 704, y: i * 64, w: 160, h: 64 }));
// decal atlas (pixels, 1024×512): placards and label strips
const DC_W = 1024, DC_H = 512;
const DECALS = {
  eject: { x: 0, y: 0, w: 256, h: 96 }, caution: { x: 256, y: 0, w: 256, h: 96 }, arm: { x: 512, y: 0, w: 256, h: 96 }, plate: { x: 768, y: 0, w: 256, h: 96 },
  hazard: { x: 0, y: 96, w: 512, h: 48 }, labels: { x: 0, y: 144, w: 512, h: 40 }, labels2: { x: 512, y: 144, w: 512, h: 40 }, keypad: { x: 0, y: 192, w: 192, h: 256 },
  noStep: { x: 512, y: 96, w: 256, h: 48 }, rescue: { x: 768, y: 96, w: 256, h: 48 }, tape: { x: 192, y: 192, w: 320, h: 64 }, stencil: { x: 192, y: 256, w: 320, h: 64 },
  breaker: { x: 512, y: 192, w: 512, h: 128 }, kill: { x: 192, y: 320, w: 320, h: 128 }, strip: { x: 512, y: 320, w: 512, h: 64 },
};

class Build {
  constructor(q) {
    this.q = q;
    this.parts = new Map();
    this.cur = 'st'; this.piv = [0, 0, 0];
    this.decal = { pos: [], nrm: [], uv: [], mr: [] };
    this.glow = { pos: [], col: [], ch: [] };
    this.scr = { A: { pos: [], uv: [], luv: [], sid: [] }, B: { pos: [], uv: [], luv: [], sid: [] }, H: { pos: [], uv: [], luv: [], sid: [] } };
    this.emit = [];          // spark emitter points { p, side }
    this.rnd = rng(1234);
  }
  seg(n) { return this.q >= 1 ? n : Math.max(5, Math.round(n * 0.6)); }
  // route following add() calls into a named moving part, positions relative to its pivot
  part(name, piv = [0, 0, 0]) { this.cur = name; this.piv = piv; return this; }
  buf(name) {
    let b = this.parts.get(name);
    if (!b) { b = { pos: [], nrm: [], col: [], mr: [] }; this.parts.set(name, b); }
    return b;
  }
  add(t, m, o = {}) {
    const b = this.buf(this.cur), pv = this.piv;
    const { pos, nrm } = creaseNormals(t, Math.cos((o.crease ?? 34) * DEG));
    // dark interior paints are lifted so they read under cabin light; bright hull paint is left alone
    const lum = m.c[0] * 0.3 + m.c[1] * 0.6 + m.c[2] * 0.1;
    const s = (o.shade ?? 1) * lerp(2.1, 1, smooth(0.015, 0.16, lum));
    for (let i = 0; i < pos.length; i += 3) {
      b.pos.push(pos[i] - pv[0], pos[i + 1] - pv[1], pos[i + 2] - pv[2]);
      b.nrm.push(nrm[i], nrm[i + 1], nrm[i + 2]);
      b.col.push(m.c[0] * s, m.c[1] * s, m.c[2] * s);
      b.mr.push(m.r, m.m);
    }
  }
  // emissive triangles, flat colour
  glowTris(t, col, ch = CH.STATIC) {
    const g = this.glow;
    for (let i = 0; i < t.length; i += 3) { g.pos.push(t[i], t[i + 1], t[i + 2]); g.col.push(col[0], col[1], col[2]); g.ch.push(ch); }
  }
  // emissive fan: bright centre fading to nothing at the rim
  glowFan(c, ring, col, ch = CH.STATIC, rim = 0) {
    const g = this.glow, n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      g.pos.push(c[0], c[1], c[2], a[0], a[1], a[2], b[0], b[1], b[2]);
      g.col.push(col[0], col[1], col[2], col[0] * rim, col[1] * rim, col[2] * rim, col[0] * rim, col[1] * rim, col[2] * rim);
      g.ch.push(ch, ch, ch);
    }
  }
  // instrument quad: corners bl, br, tr, tl; rect in canvas pixels
  screen(which, bl, br, tr, tl, r, sid) {
    const s = this.scr[which], W = which === 'B' ? CB_W : CA_W, Hh = which === 'B' ? CB_H : CA_H;
    const u0 = r.x / W, u1 = (r.x + r.w) / W, v0 = 1 - (r.y + r.h) / Hh, v1 = 1 - r.y / Hh;
    const P = [bl, br, tr, bl, tr, tl], UV = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]], L = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 6; i++) { s.pos.push(P[i][0], P[i][1], P[i][2]); s.uv.push(UV[i][0], UV[i][1]); s.luv.push(L[i][0], L[i][1]); s.sid.push(sid); }
  }
  // placard quad from the decal atlas
  decalQuad(bl, br, tr, tl, name, rough = 0.6) {
    const d = this.decal, r = DECALS[name];
    const u0 = r.x / DC_W, u1 = (r.x + r.w) / DC_W, v0 = 1 - (r.y + r.h) / DC_H, v1 = 1 - r.y / DC_H;
    const n = vnorm(vcross(vsub(br, bl), vsub(tl, bl)));
    const P = [bl, br, tr, bl, tr, tl], UV = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
    for (let i = 0; i < 6; i++) { d.pos.push(P[i][0], P[i][1], P[i][2]); d.nrm.push(n[0], n[1], n[2]); d.uv.push(UV[i][0], UV[i][1]); d.mr.push(rough, 0); }
  }
}

// Local frame of a flat panel: lx out of the panel, ly up along it, lz to the right.
function panelFrame(o, n, v, w) {
  const det = vdot(vcross(n, v), w);
  const pt = (x, y, z) => [o[0] + n[0] * x + v[0] * y + w[0] * z, o[1] + n[1] * x + v[1] * y + w[1] * z, o[2] + n[2] * x + v[2] * y + w[2] * z];
  const place = (t) => {
    for (let i = 0; i < t.length; i += 3) { const p = pt(t[i], t[i + 1], t[i + 2]); t[i] = p[0]; t[i + 1] = p[1]; t[i + 2] = p[2]; }
    return det < 0 ? flip(t) : t;
  };
  return { o, n, v, w, pt, place };
}

/* ---- small parts, modelled in panel space (x out, y up, z right) ---- */

function knobT(r, h, n = 10) {
  return lathe([[0, r * 1.22], [h * 0.16, r * 1.22], [h * 0.22, r], [h * 0.92, r * 0.9], [h, r * 0.78], [h, 0.0001]], n, { capA: false });
}
function toggleT(tilt, k = 1) {
  const base = lathe([[0, 0.0062 * k], [0.003 * k, 0.0062 * k], [0.0034 * k, 0.004 * k], [0.006 * k, 0.0036 * k]], 6, { capA: false });
  const lever = rotZ(lathe([[0.004 * k, 0.0017 * k], [0.017 * k, 0.0024 * k], [0.02 * k, 0.0024 * k], [0.021 * k, 0.0012 * k]], 6), tilt, 0.004 * k, 0);
  return [base, lever];
}
const rivetT = (r = 0.0022) => lathe([[0, r], [r * 0.45, r * 0.8], [r * 0.6, 0.0001]], 5, { capA: false });

/* ========================================================================== */
/*  Pilot's hand and forearm                                                  */
/* ========================================================================== */

// Right hand closed round a vertical grip of radius r (axis Y through the
// origin): palm on the +Z side, fingers wrapping the front, wrist toward −X.
// The index finger (on the trigger) and the thumb come back as separate soups
// with their knuckle pivots so they can move; mirror and rotate as needed.
function handModel(r = 0.019) {
  const glove = [], plate = [], seam = [], index = [], fingers = [], fpads = [];
  const zc = r + 0.017;
  // back of the hand → wrist
  glove.push(...loft([
    ringRect(0.016, -0.04, 0.039, r + 0.005, r + 0.03, 0.008), ringRect(-0.008, -0.043, 0.041, r + 0.001, r + 0.034, 0.009),
    ringRect(-0.045, -0.04, 0.038, r + 0.001, r + 0.035, 0.01), ringRect(-0.078, -0.033, 0.03, r + 0.003, r + 0.033, 0.01), ringRect(-0.094, -0.028, 0.026, r + 0.004, r + 0.032, 0.009),
  ]));
  // palm heel filling the gap to the grip
  glove.push(...box(-0.07, 0.0, -0.036, 0.03, r - 0.004, r + 0.01, 0.004));
  // four fingers: three phalanges each, creased at the joints, wrapping the front of the grip
  let idxPiv = null;
  for (let f = 0; f < 4; f++) {
    const isIdx = f === 3, y = -0.0315 + f * 0.0213, hw = 0.0096, len = f === 0 ? 0.88 : isIdx ? 0.62 : f === 2 ? 1 : 0.96;
    const rings = [], n = 14, p0 = 66 * DEG, p1 = lerp(66, -150, len) * DEG, out = isIdx ? index : fingers;
    for (let i = 0; i <= n; i++) {
      const t = i / n, ph = lerp(p0, p1, t);
      // swell at the knuckles, pinch at the creases between phalanges
      const kn = Math.exp(-Math.pow((t - 0.03) * 8, 2)) * 1.0 + Math.exp(-Math.pow((t - 0.44) * 9, 2)) * 0.6 + Math.exp(-Math.pow((t - 0.78) * 10, 2)) * 0.45;
      const cr = Math.exp(-Math.pow((t - 0.25) * 16, 2)) + Math.exp(-Math.pow((t - 0.62) * 16, 2));
      const tip = t > 0.9 ? 1 - (t - 0.9) * 2.6 : 1;
      const th = (0.0088 + kn * 0.0019 - cr * 0.0009) * tip, rad = r + th + 0.0012 + (isIdx ? t * 0.004 : 0), hh = hw * tip * (1 - cr * 0.06);
      const cx = Math.cos(ph), sz = Math.sin(ph), c = 0.0036 * tip;
      const P = (dr, dy) => [(rad + dr) * cx, y + dy, (rad + dr) * sz];
      rings.push([P(-th, -hh + c), P(-th, hh - c), P(-th + c, hh), P(th - c, hh), P(th, hh - c), P(th, -hh + c), P(th - c, -hh), P(-th + c, -hh)]);
    }
    out.push(...loft(rings));
    // armour pad over the first phalanx and a dome on the knuckle
    const pad = [];
    for (let i = 0; i <= 4; i++) {
      const ph = lerp(58, 22, i / 4) * DEG, ro = r + 0.0205 + Math.sin((i / 4) * Math.PI) * 0.0012, ri = ro - 0.003, cx = Math.cos(ph), sz = Math.sin(ph), h2 = hw * 0.72;
      pad.push([[ri * cx, y - h2, ri * sz], [ri * cx, y + h2, ri * sz], [ro * cx, y + h2 * 0.8, ro * sz], [ro * cx, y - h2 * 0.8, ro * sz]]);
    }
    (isIdx ? index : fpads).push(...loft(pad));
    const ka = 66 * DEG, kr = r + 0.019;
    (isIdx ? index : fingers).push(...tube([[kr * Math.cos(ka) - 0.004, y, kr * Math.sin(ka) + 0.002], [kr * Math.cos(ka) + 0.001, y, kr * Math.sin(ka) + 0.006], [kr * Math.cos(ka) + 0.006, y, kr * Math.sin(ka) + 0.004]], [0.006, 0.0082, 0.006], 7));
    if (isIdx) idxPiv = [(r + 0.011) * Math.cos(p0), 0, (r + 0.011) * Math.sin(p0)];
  }
  // thumb: two joints, lying along the top of the grip
  const thPiv = [-0.05, 0.03, r + 0.014];
  const thumb = tube([thPiv, [-0.03, 0.045, r + 0.01], [-0.012, 0.053, r + 0.002], [0.004, 0.056, r - 0.008], [0.016, 0.056, r - 0.017], [0.024, 0.054, r - 0.022]], [0.0142, 0.0128, 0.0112, 0.0118, 0.0098, 0.0055], 8);
  // back plate, wrist strap, stitched seams between the tendons
  plate.push(...loft([ringRect(-0.052, -0.027, 0.029, r + 0.0335, r + 0.0345, 0.004), ringRect(-0.048, -0.031, 0.032, r + 0.0335, r + 0.0385, 0.005), ringRect(0.002, -0.03, 0.03, r + 0.0325, r + 0.0375, 0.005), ringRect(0.007, -0.026, 0.026, r + 0.0325, r + 0.0335, 0.004)]));
  plate.push(...box(-0.076, -0.063, -0.034, 0.032, r + 0.0015, r + 0.037, 0.003));
  plate.push(...box(-0.074, -0.065, -0.012, 0.008, r + 0.0365, r + 0.0395, 0.0012));
  for (const y of [-0.0205, 0.0008, 0.022]) seam.push(...tube([[-0.062, y * 0.8, r + 0.0352], [-0.052, y * 0.9, r + 0.0356]], 0.0011, 4), ...tube([[0.007, y, r + 0.0325], [0.016, y, r + 0.029]], 0.0011, 4));
  return { glove, plate, seam, index, fingers, fpads, thumb, idxPiv, thPiv, wrist: [-0.088, -0.001, zc] };
}
// forearm from the wrist along unit direction `a`: gauntlet, locking ring, suit sleeve
function forearm(wrist, a, len, up = [0, 1, 0]) {
  const U = vnorm(vcross(a, up)), W = vcross(U, a);
  const ring = (s, ru, rw, n = 14) => {
    const R = [], o = vadd(wrist, a, s);
    for (let j = 0; j < n; j++) { const an = (j / n) * TAU, c = Math.cos(an) * ru, sn = Math.sin(an) * rw; R.push([o[0] + U[0] * c + W[0] * sn, o[1] + U[1] * c + W[1] * sn, o[2] + U[2] * c + W[2] * sn]); }
    return R;
  };
  const cuff = loft([ring(-0.012, 0.024, 0.03), ring(0.012, 0.027, 0.033), ring(0.03, 0.031, 0.037), ring(0.05, 0.035, 0.041), ring(0.058, 0.036, 0.042)]);
  // suit-side ring connector: a machined collar with a locking band
  const collar = loft([ring(0.056, 0.037, 0.043), ring(0.059, 0.0405, 0.0465), ring(0.07, 0.0405, 0.0465), ring(0.073, 0.0385, 0.0445), ring(0.078, 0.0385, 0.0445), ring(0.081, 0.0405, 0.0465), ring(0.086, 0.0405, 0.0465), ring(0.089, 0.036, 0.042)]);
  const band = loft([ring(0.0735, 0.039, 0.045), ring(0.0775, 0.039, 0.045)]);
  const lugs = [];
  for (let i = 0; i < 6; i++) { const an = (i / 6) * TAU + 0.3, o = vadd(wrist, a, 0.0645), c = Math.cos(an) * 0.0405, sn = Math.sin(an) * 0.0465; const p = [o[0] + U[0] * c + W[0] * sn, o[1] + U[1] * c + W[1] * sn, o[2] + U[2] * c + W[2] * sn]; lugs.push(...tube([vadd(p, a, -0.004), vadd(p, a, 0.004)], 0.0032, 5)); }
  const sl = [[0.086, 0.035, 0.041]];
  const nW = Math.round(len / 0.04);
  for (let i = 1; i <= nW; i++) {
    const s = 0.086 + (len - 0.086) * (i / nW), g = 0.036 + 0.02 * (i / nW);
    sl.push([s - 0.014, g * 0.98, g * 1.1], [s, g * 1.1, g * 1.22]);
  }
  const sleeve = loft(sl.map(([s, ru, rw]) => ring(s, ru, rw)));
  const strap = loft([ring(0.022, 0.0305, 0.0365), ring(0.036, 0.0335, 0.0395)]);
  return { cuff, sleeve, strap, collar, band, lugs };
}

/* ========================================================================== */
/*  Hull definitions                                                          */
/* ========================================================================== */

// canopy: eye-space elevations (degrees) of the sill and of the top rail, dead
// ahead and abeam; struts are [azimuth°, width m] pairs mirrored port/starboard.
const HULLS = {
  vanguard: {
    can: { c: [-0.1, -0.25, 0], r: [1.3, 0.75, 0.55], az: 118, sill: [-13.15, -30], top: [28.6, 27], struts: [[60, 0.03]], bar: 0.032, depth: 0.036, roof: true },
    pal: {
      frame: M(0x2a3039, 0.46, 0.25), panel: M(0x191c22, 0.7), panel2: M(0x272c34, 0.58), trim: M(0x66707e, 0.4, 0.8), accent: M(0x1c6dff, 0.45),
      deck: M(0x0b0c0f, 0.96), wall: M(0x1e2228, 0.82), suit: M(0x35455a, 0.9), glove: M(0x2b2e34, 0.58), plate: M(0x5b6675, 0.38, 0.6),
      hull: M(0x8d99aa, 0.46, 0.35), hull2: M(0x56616f, 0.5, 0.35), stripe: M(0x1c6dff, 0.45, 0.2),
    },
    ui: { main: 0x58d8ff, dim: 0x1b5a7a, bg: 0x020a10, hi: 0xeafcff },
    dash: { cz: 0.21, wing: 0.275, toe: 22, tac: 'rect', gauge: 'round', stick: 'side', chunk: 1, hud: 'frame', mirror: true },
    nose: {
      keys: [{ x: 1.22, w: 0.5, t: 0.14, b: 0.3, y: -0.5, et: 2.4 }, { x: 2.0, w: 0.36, t: 0.115, b: 0.22, y: -0.52, et: 2.3 }, { x: 2.9, w: 0.15, t: 0.06, b: 0.1, y: -0.625 }, { x: 3.45, w: 0.012, t: 0.008, b: 0.01, y: -0.675 }],
      guns: [{ z: 0.5, y: -0.535, x0: 1.25, x1: 2.72, r: 0.021 }], stripe: 0.07,
    },
  },
  interceptor: {
    can: { c: [-0.05, -0.27, 0], r: [1.22, 0.8, 0.52], az: 125, sill: [-13.15, -36], top: [120, 120], struts: [[66, 0.02]], bar: 0.022, depth: 0.026, roof: false },
    pal: {
      frame: M(0xb9c4c8, 0.38, 0.25), panel: M(0x0d1b1f, 0.62), panel2: M(0x14272c, 0.55), trim: M(0x9fb0b4, 0.35, 0.85), accent: M(0x1d97a6, 0.45),
      deck: M(0x08110f, 0.96), wall: M(0x101f23, 0.8), suit: M(0xc9ced2, 0.88), glove: M(0x2b2e34, 0.55), plate: M(0x1d97a6, 0.4, 0.3),
      hull: M(0x1d97a6, 0.42, 0.35), hull2: M(0x0f5f6c, 0.5, 0.35), stripe: M(0xbfcdd0, 0.4, 0.3),
    },
    ui: { main: 0x5cffd6, dim: 0x18705f, bg: 0x020d0b, hi: 0xeafff9 },
    dash: { cz: 0.2, wing: 0.245, toe: 26, tac: 'oct', gauge: 'round', stick: 'centre', chunk: 0.85, hud: 'holo' },
    nose: {
      keys: [{ x: 1.2, w: 0.3, t: 0.12, b: 0.24, y: -0.46 }, { x: 2.0, w: 0.2, t: 0.09, b: 0.16, y: -0.5 }, { x: 3.2, w: 0.075, t: 0.04, b: 0.05, y: -0.655 }, { x: 4.3, w: 0.008, t: 0.006, b: 0.006, y: -0.835 }],
      guns: [{ z: 0.26, y: -0.515, x0: 1.2, x1: 2.55, r: 0.015 }], stripe: 0.03, pitot: true,
    },
  },
  juggernaut: {
    can: { c: [-0.12, -0.26, 0], r: [1.32, 0.78, 0.6], az: 112, sill: [-13.15, -27], top: [28.2, 21], struts: [[45, 0.042], [66, 0.07], [90, 0.07]], bar: 0.06, depth: 0.06, roof: true, bolts: true },
    pal: {
      frame: M(0x4b4f55, 0.55, 0.25), panel: M(0x1c1e22, 0.72), panel2: M(0x2c2f34, 0.6), trim: M(0x7c8086, 0.45, 0.8), accent: M(0xff8a12, 0.5),
      deck: M(0x0d0c0b, 0.96), wall: M(0x26282c, 0.8), suit: M(0x6a5a36, 0.9), glove: M(0x2b2e34, 0.6), plate: M(0x7c8086, 0.42, 0.6),
      hull: M(0x7c8086, 0.5, 0.4), hull2: M(0x4b4f55, 0.55, 0.4), stripe: M(0xff8a12, 0.5, 0.15),
    },
    ui: { main: 0xffb347, dim: 0x7a4a12, bg: 0x0d0702, hi: 0xfff3dc },
    dash: { cz: 0.22, wing: 0.3, toe: 16, tac: 'rect', gauge: 'tape', stick: 'yoke', chunk: 1.45, hud: 'frame' },
    nose: {
      keys: [{ x: 1.2, w: 0.82, t: 0.1, b: 0.34, y: -0.56, et: 4, eb: 3 }, { x: 2.0, w: 0.74, t: 0.085, b: 0.3, y: -0.57, et: 4, eb: 3 }, { x: 2.5, w: 0.56, t: 0.06, b: 0.2, y: -0.585, et: 3.2 }, { x: 2.72, w: 0.3, t: 0.03, b: 0.08, y: -0.6, et: 3 }],
      guns: [{ z: 0.45, y: -0.575, x0: 1.3, x1: 2.95, r: 0.028 }, { z: 0.82, y: -0.6, x0: 1.2, x1: 2.75, r: 0.024 }], stripe: 0.12, slab: true,
    },
  },
  ghost: {
    can: { c: [-0.08, -0.27, 0], r: [1.36, 0.72, 0.56], az: 116, sill: [-13.15, -28], top: [28.4, 31], struts: [[49, 0.024], [72, 0.034]], bar: 0.034, depth: 0.03, roof: true, facet: true },
    pal: {
      frame: M(0x17161d, 0.36, 0.25), panel: M(0x121117, 0.55), panel2: M(0x1d1b26, 0.5), trim: M(0x3c3850, 0.35, 0.85), accent: M(0x8f4dff, 0.4),
      deck: M(0x070709, 0.96), wall: M(0x15141b, 0.75), suit: M(0x23212b, 0.88), glove: M(0x2b2e34, 0.5), plate: M(0x3c3850, 0.35, 0.7),
      hull: M(0x2a2733, 0.36, 0.6), hull2: M(0x17161d, 0.4, 0.6), stripe: M(0x8f4dff, 0.4, 0.3),
    },
    ui: { main: 0xc79bff, dim: 0x4a2f86, bg: 0x07040d, hi: 0xf6edff },
    dash: { cz: 0.21, wing: 0.275, toe: 24, tac: 'hex', gauge: 'tape', stick: 'side', chunk: 0.9, hud: 'holo' },
    nose: {
      keys: [{ x: 1.2, w: 0.66, t: 0.07, b: 0.2, y: -0.47, et: 1.25, eb: 1.3 }, { x: 2.0, w: 0.46, t: 0.055, b: 0.15, y: -0.5, et: 1.2, eb: 1.3 }, { x: 3.0, w: 0.2, t: 0.03, b: 0.07, y: -0.62, et: 1.2, eb: 1.2 }, { x: 3.7, w: 0.01, t: 0.004, b: 0.006, y: -0.72 }],
      guns: [{ z: 0.4, y: -0.52, x0: 1.4, x1: 2.4, r: 0.016, slot: true }], stripe: 0.02, n: 8,
    },
  },
  ace: {
    can: { c: [-0.1, -0.25, 0], r: [1.26, 0.78, 0.54], az: 120, sill: [-13.15, -32], top: [28.6, 50], struts: [[45, 0.02], [64, 0.034]], bar: 0.03, depth: 0.034, roof: true },
    pal: {
      frame: M(0x8e1d1d, 0.42, 0.25), panel: M(0x17181b, 0.68), panel2: M(0x2a2b2f, 0.58), trim: M(0xb7b2a4, 0.38, 0.8), accent: M(0xd12a22, 0.45),
      deck: M(0x0c0b0b, 0.96), wall: M(0x24201f, 0.8), suit: M(0x5a4a32, 0.9), glove: M(0x4a2f1c, 0.55), plate: M(0xb7b2a4, 0.4, 0.6),
      hull: M(0xb8232a, 0.4, 0.3), hull2: M(0xd8d4c8, 0.45, 0.3), stripe: M(0xe9e4d6, 0.45, 0.2),
    },
    ui: { main: 0x8dff6a, dim: 0x2c7a1c, bg: 0x030c02, hi: 0xf0ffe8 },
    dash: { cz: 0.21, wing: 0.26, toe: 20, tac: 'round', gauge: 'round', stick: 'centre', chunk: 1.1, hud: 'frame', mirror: true },
    nose: {
      keys: [{ x: 1.2, w: 0.4, t: 0.15, b: 0.3, y: -0.5 }, { x: 2.0, w: 0.33, t: 0.13, b: 0.26, y: -0.535 }, { x: 2.7, w: 0.2, t: 0.085, b: 0.16, y: -0.6 }, { x: 3.15, w: 0.05, t: 0.03, b: 0.04, y: -0.63 }],
      guns: [{ z: 0.2, y: -0.4, x0: 1.25, x1: 2.05, r: 0.014, cowl: true }], stripe: 0.09, spinner: true,
    },
  },
};
// co-op second seat: the vanguard interior in green trim
HULLS.player2 = {
  ...HULLS.vanguard,
  pal: { ...HULLS.vanguard.pal, accent: M(0x2bd05a, 0.45), suit: M(0x35553c, 0.9), plate: M(0x4f7458, 0.4, 0.5), hull: M(0x8ea592, 0.46, 0.35), hull2: M(0x55695a, 0.5, 0.35), stripe: M(0x2bd05a, 0.45, 0.2) },
  ui: { main: 0x6dff8e, dim: 0x1f7a3a, bg: 0x020d05, hi: 0xeaffef },
};
const HULL_KEY = { player1: 'vanguard' };

// resolve the eye-space canopy description into ellipsoid parameters
function resolveCanopy(def) {
  const C = { c: def.c, r: def.r, az: def.az * DEG };
  const solve = (az, elDeg) => {
    if (elDeg >= 90) return 2;
    let lo = -0.9, hi = 1.5;
    for (let i = 0; i < 40; i++) {
      const e = (lo + hi) / 2, p = canPt(C, az, e), el = Math.atan2(p[1], Math.hypot(p[0], p[2]));
      if (el < elDeg * DEG) lo = e; else hi = e;
    }
    return (lo + hi) / 2;
  };
  C.sill0 = solve(0, def.sill[0]); C.sill1 = solve(Math.PI / 2, def.sill[1]);
  // the rail hangs below the glass edge: lift the edge so its underside stays at the asked elevation
  const lift = def.roof ? (def.bar * 0.65 + def.depth * 0.6) / 0.72 : 0;
  C.top0 = solve(0, def.top[0]) + lift; C.top1 = solve(Math.PI / 2, def.top[1]) + lift;
  return C;
}

/* ========================================================================== */
/*  Interior builder                                                          */
/* ========================================================================== */

// orthonormal right-handed frame at P with local x along n
function onFrame(P, n, hint = [0, 1, 0]) {
  n = vnorm(n);
  let v = vsub(hint, [n[0] * vdot(n, hint), n[1] * vdot(n, hint), n[2] * vdot(n, hint)]);
  if (Math.hypot(v[0], v[1], v[2]) < 1e-4) v = [1, 0, 0];
  v = vnorm(v);
  return panelFrame(P, n, v, vcross(n, v));
}
const LIP_X = 0.66, LIP_Y = -0.171;
const PANEL_O = [0.635, -0.31, 0], PANEL_N = vnorm([-0.909, 0.4167, 0]), PANEL_V = vnorm([0.4167, 0.909, 0]);

function buildInterior(b, H) {
  const C = H.C, P = H.pal, D = H.dash, q = b.q, k = D.chunk, R = b.rnd;
  const toe = D.toe * DEG;
  const FC = panelFrame(PANEL_O, PANEL_N, PANEL_V, [0, 0, 1]);
  // wings are the centre facet swung about the vertical, hinged at its top corners: the
  // coaming edge stays level and the facets meet along a slightly raked seam
  const wingFrame = (s) => {
    const c = Math.cos(toe), sn = Math.sin(toe) * s;
    const ry = (v) => [v[0] * c - v[2] * sn, v[1], v[0] * sn + v[2] * c];
    const v = ry(PANEL_V), top = vadd(vadd(PANEL_O, PANEL_V, 0.132), [0, 0, 1], s * D.cz);
    return panelFrame(vadd(top, v, -0.132), ry(PANEL_N), v, ry([0, 0, 1]));
  };
  const FR = wingFrame(1), FL = wingFrame(-1);
  // the wings carry on outboard until they meet the cockpit wall
  let WL = D.wing;
  for (; WL < 0.6; WL += 0.01) { const p = FR.pt(0, 0.1, WL); if (Math.hypot((p[0] - C.c[0]) / C.r[0], (p[1] - C.c[1]) / C.r[1], (p[2] - C.c[2]) / C.r[2]) > 0.955) break; }
  const W = D.cz + WL * Math.cos(toe);
  const out = { controls: [], muzzles: [], C, lights: {} };

  /* ---- canopy frame ---- */
  const nBar = C.facet ? 3 : b.seg(14);
  const sillBar = canBar(C, (t) => { const az = lerp(-C.az, C.az, t); return [az, sillAt(C, az) - 0.012]; }, b.seg(56), H.can.bar * 1.25, H.can.depth * 1.15);
  b.add(sillBar, P.frame, { crease: 40 });
  for (const [A, w] of H.can.struts) {
    for (const s of A === 0 ? [1] : [1, -1]) {
      const az = A * DEG * s;
      b.add(canBar(C, (t) => [az, lerp(sillAt(C, az) - 0.02, Math.min(topAt(C, az) + 0.03, 1.5), t)], nBar, w, H.can.depth), P.frame, { crease: 40 });
      // gusset where the strut meets the sill
      const base = canPt(C, az, sillAt(C, az) + 0.02, 0.985), N = canNrm(C, base);
      const F = onFrame(vadd(base, N, -H.can.depth), vsub([0, 0, 0], N), [0, 1, 0]);
      b.add(F.place(box(0, 0.006, -0.03, 0.03, -w * 0.9, w * 0.9, 0.003)), P.trim, { crease: 40 });
      for (const [yy, zz] of [[-0.018, -w * 0.55], [-0.018, w * 0.55], [0.018, -w * 0.55], [0.018, w * 0.55]]) b.add(F.place(move(rivetT(0.0028 * k), 0.006, yy, zz)), M_SCREW);
    }
  }
  b.add(canBar(C, (t) => [C.az * (t < 0.5 ? -1 : 1), lerp(sillAt(C, C.az) - 0.02, 1.45, Math.abs(t - 0.5) * 2)], 8, 0.05, H.can.depth), P.frame);
  if (H.can.roof) {
    b.add(canBar(C, (t) => { const az = lerp(-C.az, C.az, t); return [az, topAt(C, az)]; }, C.facet ? 12 : b.seg(48), H.can.bar * 1.3, H.can.depth * 1.2), P.frame, { crease: 40 });
    b.add(gridFn((u, v) => { const az = lerp(-C.az, C.az, u); return canPt(C, az, lerp(topAt(C, az) + 0.02, 1.52, v), 0.992); }, b.seg(28), 5, [0.2, -0.2, 0]), P.wall, { crease: 60 });
    // overhead switch panel peeking in at the top of the frame
    const pc = canPt(C, 0, C.top0 + 0.11, 0.975), Fo = onFrame(pc, vsub([0.25, -0.1, 0], pc), [-1, 0, 0]);
    b.add(Fo.place(box(0, 0.012, -0.03, 0.03, -0.13, 0.13, 0.004)), P.panel2);
    for (let i = 0; i < 7; i++) { const [tb, tl] = toggleT((i % 3 - 1) * 0.4, k); b.add(Fo.place(move(tb, 0.012, 0, -0.105 + i * 0.035)), M_SCREW); b.add(Fo.place(move(tl, 0.012, 0, -0.105 + i * 0.035)), M_STEEL); }
    out.emitTop = Fo.pt(0.02, 0, 0.05);
  }
  // rivets along the sill rail
  {
    const n = Math.round((q >= 1 ? 46 : 20));
    for (let i = 1; i < n; i++) {
      const az = lerp(-C.az * 0.9, C.az * 0.9, i / n), e = sillAt(C, az) - 0.012;
      const p = canPt(C, az, e, 0.994), N = canNrm(C, p);
      const F = onFrame(vadd(p, N, -H.can.depth * 1.15), vsub([0, 0, 0], N));
      b.add(F.place(rivetT((H.can.bolts ? 0.0042 : 0.0024))), M_SCREW);
    }
  }
  // side walls below the sill
  for (const s of [1, -1]) {
    b.add(gridFn((u, v) => {
      const az = lerp(18 * DEG, C.az, u) * s, e0 = sillAt(C, az) - 0.02;
      return canPt(C, az, lerp(e0, e0 - 0.62, v), 0.985);
    }, b.seg(18), 6, [0.2, -0.2, 0]), P.wall, { crease: 60 });
    // stringers and a cable run on the wall
    for (const de of [0.14, 0.3]) b.add(canBar(C, (t) => { const az = lerp(40 * DEG, C.az * 0.96, t) * s; return [az, sillAt(C, az) - de]; }, 10, 0.014, 0.012, 0.984), P.trim);
    if (q >= 1) b.add(tube(Array.from({ length: 12 }, (_, i) => { const az = lerp(46 * DEG, C.az * 0.9, i / 11) * s; return canPt(C, az, sillAt(C, az) - 0.2 - Math.sin(i * 1.3) * 0.012, 0.972); }), 0.0045, 5), M_RUBBER);
    // emergency light strip under the sill
    const st = [];
    for (let i = 0; i < 10; i++) {
      const a0 = lerp(34, 96, i / 10) * DEG * s, a1 = lerp(34, 96, (i + 0.8) / 10) * DEG * s;
      const p0 = canPt(C, a0, sillAt(C, a0) - 0.055, 0.972), p1 = canPt(C, a1, sillAt(C, a1) - 0.055, 0.972), p2 = canPt(C, a1, sillAt(C, a1) - 0.066, 0.972), p3 = canPt(C, a0, sillAt(C, a0) - 0.066, 0.972);
      quad(st, p0, p1, p2, p3); quad(st, p0, p3, p2, p1);
    }
    b.glowTris(st, [1.6, 0.06, 0.03], CH.EMERG);
  }

  /* ---- glare shield: deck, padded lip, underside ---- */
  const lipX = (z) => { const a = Math.abs(z); return a <= D.cz ? LIP_X : LIP_X - (a - D.cz) * Math.tan(toe); };
  const deckFar = (z) => {
    let az = Math.asin(clamp(z / C.r[2], -0.999, 0.999));
    for (let i = 0; i < 4; i++) az = Math.asin(clamp(z / (C.r[2] * Math.cos(sillAt(C, az))), -0.999, 0.999));
    return canPt(C, az, sillAt(C, az) + 0.004, 0.99);
  };
  b.add(gridFn((u, v) => {
    const z = lerp(-W, W, u), p = vlerp([lipX(z) + 0.004, LIP_Y - 0.003, z], deckFar(z), v);
    p[1] += Math.sin(v * Math.PI) * 0.01;
    return p;
  }, b.seg(30), 6, [0.5, 2, 0]), P.deck, { crease: 60 });
  const lipPts = [];
  for (let i = 0; i <= 28; i++) { const z = lerp(-W - 0.02, W + 0.02, i / 28); lipPts.push([lipX(z), LIP_Y - 0.004, z]); }
  b.add(tube(lipPts, 0.0115, 8), M(0x0e0f12, 0.7), { crease: 60 });
  b.add(gridFn((u, v) => { const z = lerp(-W, W, u); return vlerp([lipX(z) + 0.002, LIP_Y - 0.012, z], [lipX(z) + 0.034, -0.192, z], v); }, 14, 1, [0, -2, 0]), P.deck);
  // defog vents and bolts on the deck
  for (const s of [1, -1]) {
    const Fv = onFrame([0.9, -0.218, s * 0.24], [0.1, 1, 0], [1, 0, 0]);
    b.add(Fv.place(box(0, 0.004, -0.04, 0.04, -0.07, 0.07, 0.002)), M(0x1c1e22, 0.9));
    for (let i = 0; i < 6; i++) b.add(Fv.place(box(0.003, 0.0045, -0.032, 0.032, -0.058 + i * 0.021, -0.048 + i * 0.021)), M_SOOT);
  }

  /* ---- dashboard: centre facet and two toed-in wings ---- */
  const YT = 0.132, YB = -0.21;
  b.add(FC.place(gridQuad([0, YB, -D.cz], [0, YB, D.cz], [0, YT, D.cz], [0, YT, -D.cz], 8, 7, [1, 0, 0])), P.panel);
  b.add(FR.place(gridQuad([0, YB, 0], [0, YB, WL], [0, YT, WL], [0, YT, 0], 8, 7, [1, 0, 0])), P.panel);
  b.add(FL.place(gridQuad([0, YB, -WL], [0, YB, 0], [0, YT, 0], [0, YT, -WL], 8, 7, [1, 0, 0])), P.panel);
  // seam trims between the facets
  out.emitPts = [FC.pt(0.01, 0.0, 0), FL.pt(0.01, 0.02, -D.wing * 0.5), FR.pt(0.01, 0.02, D.wing * 0.5)];

  const bz = 0.0075 * k, bh = 0.0065 * k;
  const scr = (F, which, y0, y1, z0, z1, rect, sid) => b.screen(which, F.pt(0.0006, y0, z0), F.pt(0.0006, y0, z1), F.pt(0.0006, y1, z1), F.pt(0.0006, y1, z0), rect, sid);
  const screws = (F, y0, y1, z0, z1, d) => { for (const [y, z] of [[y0 - d, z0 - d], [y0 - d, z1 + d], [y1 + d, z0 - d], [y1 + d, z1 + d]]) b.add(F.place(move(rivetT(0.0024 * k), 0.0002, y, z)), M_SCREW); };

  // tactical display
  const TY0 = -0.047, TY1 = 0.112, TZ = 0.0975;
  scr(FC, 'A', TY0, TY1, -TZ, TZ, R_TAC, SID.TAC);
  if (D.tac === 'rect') b.add(FC.place(bezel(TY0, TY1, -TZ, TZ, bz, bh, 0.004)), P.panel2, { crease: 50 });
  else {
    // shaped bezel: a ring from an outer outline to the screen rectangle, corners masked
    const cut = D.tac === 'oct' ? 0.03 : D.tac === 'hex' ? 0.045 : 0.05;
    const hy = (TY1 - TY0) / 2, cy = (TY1 + TY0) / 2;
    const outline = (x, g, c) => {
      const y0 = cy - hy - g, y1 = cy + hy + g, z0 = -TZ - g, z1 = TZ + g;
      if (D.tac === 'hex') return [[x, y0, z0 + c], [x, y0, z1 - c], [x, cy, z1 + c * 0.25], [x, y1, z1 - c], [x, y1, z0 + c], [x, cy, z0 - c * 0.25]];
      if (D.tac === 'round') { const Rr = []; for (let i = 0; i < 20; i++) { const a = (i / 20) * TAU + TAU / 40; const ca = Math.cos(a), sa = Math.sin(a), e = 4; Rr.push([x, cy + (hy + g) * Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e), (TZ + g) * Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e)]); } return Rr; }
      return [[x, y0, z0 + c], [x, y0, z1 - c], [x, y0 + c, z1], [x, y1 - c, z1], [x, y1, z1 - c], [x, y1, z0 + c], [x, y1 - c, z0], [x, y0 + c, z0]];
    };
    b.add(FC.place(loft([outline(0, bz * 1.3, cut), outline(bh, bz * 1.3, cut), outline(bh, bz * 0.45, cut), outline(0.0012, 0, cut * 0.82)], { capA: false, capB: false })), P.panel2, { crease: 50 });
    // corner masks over the screen
    if (D.tac !== 'round') {
      const c = cut * 0.82;
      for (const sy of [1, -1]) for (const sz of [1, -1]) {
        const t = [];
        const A = [0.0012, cy + sy * hy, sz * TZ], B = [0.0012, cy + sy * hy, sz * (TZ - c)], Cc = [0.0012, cy + sy * (hy - c), sz * TZ];
        tri(t, A, B, Cc); if (sy * sz < 0) flip(t);
        if (D.tac === 'oct') b.add(FC.place(t), P.panel2);
      }
    }
  }
  screws(FC, TY0, TY1, -TZ, TZ, bz * 0.62);

  // ambient gauges flanking the tactical display
  const gr = Math.min(0.034, (D.cz - 0.02 - TZ - bz) / 2.3), gz = TZ + bz + 0.004 + gr * 1.16;
  const centre = D.stick === 'centre';      // the starboard gauge pair gives way to the offset stick
  const gSpots = centre ? [[FC, 0.07, -gz, gr], [FC, -0.01, -gz, gr]]
    : [[FC, 0.07, -gz, gr], [FC, -0.01, -gz, gr], [FC, 0.07, gz, gr], [FC, -0.01, gz, gr]];
  gSpots.forEach(([F, y, z, g2], i) => {
    scr(F, 'A', y - g2, y + g2, z - g2, z + g2, R_GAUGE[i], SID.GAUGE);
    if (D.gauge === 'round') b.add(F.place(lathe([[0, g2 * 1.24], [bh * 0.8, g2 * 1.24], [bh, g2 * 1.14], [bh, g2 * 1.04], [0.001, g2 * 0.985]], b.seg(22), { y, z, capA: false, capB: false })), P.trim, { crease: 50 });
    else b.add(F.place(bezel(y - g2 * 0.96, y + g2 * 0.96, z - g2 * 0.96, z + g2 * 0.96, bz * 0.6, bh * 0.8, 0.003)), P.panel2, { crease: 50 });
  });
  if (centre) {      // what is left beside the scope: a small arming panel above the hand
    b.add(FC.place(box(0, 0.003, 0.05, 0.112, TZ + bz + 0.008, D.cz - 0.03, 0.0015)), P.panel2);
    for (let i = 0; i < 2; i++) { const [tb, tl] = toggleT(0.42 * (i ? 1 : -1), k); const z = TZ + bz + 0.03 + i * 0.032; b.add(FC.place(move(tb, 0.003, 0.072, z)), M_SCREW); b.add(FC.place(move(tl, 0.003, 0.072, z)), M_RED); }
    b.decalQuad(FC.pt(0.0034, 0.094, TZ + bz + 0.012), FC.pt(0.0034, 0.094, D.cz - 0.034), FC.pt(0.0034, 0.107, D.cz - 0.034), FC.pt(0.0034, 0.107, TZ + bz + 0.012), 'hazard');
  }
  // MFDs, annunciators and switchgear on the wings
  const MY0 = -0.047, MY1 = 0.079, MZa = 0.03;
  for (const s of [1, -1]) {
    // beside an offset stick the starboard display moves outboard, clear of the hand
    const MZ0 = MZa + (centre && s > 0 ? 0.045 : 0), MZ1 = Math.min(MZ0 + 0.132, D.wing - 0.03), mfdW = MZ1 - MZ0;
    const F = s > 0 ? FR : FL, z0 = s > 0 ? MZ0 : -MZ1, z1 = s > 0 ? MZ1 : -MZ0;
    scr(F, 'B', MY0, MY1, z0, z1, s > 0 ? R_MFD_R : R_MFD_L, s > 0 ? SID.MFD_R : SID.MFD_L);
    b.add(F.place(bezel(MY0, MY1, z0, z1, bz, bh, 0.0035)), P.panel2, { crease: 50 });
    screws(F, MY0, MY1, z0, z1, bz * 0.62);
    // bezel keys with backlit legends
    for (let i = 0; i < 5; i++) for (const e of [z0 - bz * 0.5, z1 + bz * 0.5]) {
      const y = lerp(MY0 + 0.012, MY1 - 0.012, i / 4);
      b.add(F.place(box(bh, bh + 0.0018, y - 0.004, y + 0.004, e - 0.0028 * k, e + 0.0028 * k, 0.0006)), M_BLACK);
      b.glowTris(F.place(gridQuad([bh + 0.002, y - 0.0012, e - 0.0016], [bh + 0.002, y - 0.0012, e + 0.0016], [bh + 0.002, y + 0.0012, e + 0.0016], [bh + 0.002, y + 0.0012, e - 0.0016], 1, 1, [1, 0, 0])), lin(H.ui.main, 0.55), CH.STATIC);
    }
    // annunciator lamps
    const lw = mfdW / 3;
    for (let i = 0; i < 3; i++) {
      const a = (s > 0 ? MZ0 : -MZ1) + i * lw + 0.002, c = a + lw - 0.004, idx = s > 0 ? 3 + i : i;
      scr(F, 'B', 0.0925, 0.1105, a, c, R_LAMP[idx], SID.LAMP0 + idx);
      b.add(F.place(bezel(0.0925, 0.1105, a, c, 0.0022, 0.0035, 0.001, 0.0005)), M_BLACK, { crease: 50 });
    }
    // outer switch field
    const o0 = s > 0 ? MZ1 + 0.02 : -D.wing + 0.012, o1 = s > 0 ? D.wing - 0.012 : -MZ1 - 0.02, oc = (o0 + o1) / 2, ow = o1 - o0;
    if (ow > 0.03) {
      b.add(F.place(box(0, 0.003, -0.05, 0.112, o0, o1, 0.0015)), P.panel2);
      const cols = ow > 0.055 ? 3 : 2;
      for (let r = 0; r < 3; r++) for (let c = 0; c < cols; c++) {
        const y = 0.09 - r * 0.036, z = o0 + ow * (c + 0.5) / cols;
        const [tb, tl] = toggleT((R() < 0.5 ? -1 : 1) * 0.42, k * 0.9);
        b.add(F.place(move(tb, 0.003, y, z)), M_SCREW); b.add(F.place(move(tl, 0.003, y, z)), M_STEEL);
        b.glowFan(F.pt(0.0045, y + 0.012, z), [[-0.002, -0.002], [0.002, -0.002], [0.002, 0.002], [-0.002, 0.002]].map(([dy, dz]) => F.pt(0.0045, y + 0.012 + dy, z + dz)), R() < 0.7 ? [0.15, 1.3, 0.3] : [1.5, 0.7, 0.1], r === 1 && c === 0 ? CH.BLINK_A : CH.STATIC, 0.3);
      }
      b.add(F.place(move(knobT(0.011 * k, 0.014 * k, b.seg(12)), 0.003, -0.028, oc)), M_BLACK, { crease: 50 });
      b.add(F.place(box(0.003 + 0.014 * k, 0.0035 + 0.014 * k, -0.029, -0.027, oc, oc + 0.01 * k)), M_WHITE);
      b.decalQuad(F.pt(0.0034, 0.1, o0 + 0.004), F.pt(0.0034, 0.1, o1 - 0.004), F.pt(0.0034, 0.108, o1 - 0.004), F.pt(0.0034, 0.108, o0 + 0.004), s > 0 ? 'labels' : 'labels2');
    }
    out.emit = out.emit || [];
  }
  // lower centre panel (seen when the head moves or on tall screens)
  for (let i = 0; i < 5; i++) {
    const z = -0.14 + i * 0.07;
    b.add(FC.place(move(knobT(0.012 * k, 0.015 * k, b.seg(12)), 0, -0.085, z)), M_BLACK, { crease: 50 });
    b.add(FC.place(box(0.015 * k, 0.0155 * k, -0.086, -0.084, z, z + 0.011 * k)), M_WHITE);
  }
  b.decalQuad(FC.pt(0.0008, -0.2, -0.06), FC.pt(0.0008, -0.2, 0.06), FC.pt(0.0008, -0.11, 0.06), FC.pt(0.0008, -0.11, -0.06), 'breaker');
  b.decalQuad(FC.pt(0.0008, -0.07, -0.18), FC.pt(0.0008, -0.07, 0.18), FC.pt(0.0008, -0.058, 0.18), FC.pt(0.0008, -0.058, -0.18), 'strip');
  b.decalQuad(FC.pt(0.0008, -0.2, 0.08), FC.pt(0.0008, -0.2, 0.19), FC.pt(0.0008, -0.115, 0.19), FC.pt(0.0008, -0.115, 0.08), 'kill');
  b.decalQuad(FC.pt(0.0008, -0.2, -0.19), FC.pt(0.0008, -0.2, -0.08), FC.pt(0.0008, -0.1, -0.08), FC.pt(0.0008, -0.1, -0.19), 'keypad');
  // master alarm beacon on the coaming
  {
    const bx = LIP_X + 0.03, bzz = -D.cz * 0.62, by = LIP_Y - 0.002;
    b.add(latheY([[by, 0.016], [by + 0.006, 0.016], [by + 0.008, 0.012]], 10, bx, bzz), M_BLACK);
    b.add(latheY([[by + 0.008, 0.0115], [by + 0.016, 0.0105], [by + 0.021, 0.006], [by + 0.022, 0.0001]], 10, bx, bzz, { capA: false }), M(0x4a0d0a, 0.25));
    const ring = []; for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; ring.push([bx + Math.cos(a) * 0.017, by + 0.014 + Math.sin(a) * 0.017, bzz]); }
    b.glowFan([bx - 0.012, by + 0.016, bzz], ring.map((p) => [p[0] - 0.012, p[1], p[2] + 0]), [2.2, 0.12, 0.06], CH.ALARM, 0);
    const ring2 = []; for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; ring2.push([bx - 0.012, by + 0.016 + Math.sin(a) * 0.017, bzz + Math.cos(a) * 0.017]); }
    b.glowFan([bx - 0.012, by + 0.016, bzz], ring2, [2.2, 0.12, 0.06], CH.ALARM, 0);
    out.alarmAt = [bx, by + 0.03, bzz];
  }

  /* ---- dressing: wing ends, pillar furniture, mirrors, standby compass ---- */
  for (const s of [1, -1]) {
    const F = s > 0 ? FR : FL, e0 = D.wing + 0.006, e1 = WL - 0.014;
    if (e1 - e0 > 0.04) {
      const a = s > 0 ? e0 : -e1, c = s > 0 ? e1 : -e0, m = (a + c) / 2, hw = Math.min((c - a) / 2 - 0.004, 0.05);
      b.add(F.place(box(0, 0.004, 0.03, 0.105, m - hw, m + hw, 0.002)), P.panel2);
      for (let i = 0; i < 6; i++) b.add(F.place(box(0.003, 0.0046, 0.038 + i * 0.011, 0.044 + i * 0.011, m - hw + 0.006, m + hw - 0.006)), M_SOOT);
      b.decalQuad(F.pt(0.001, -0.042, m - hw), F.pt(0.001, -0.042, m + hw), F.pt(0.001, -0.042 + hw * 0.75, m + hw), F.pt(0.001, -0.042 + hw * 0.75, m - hw), s > 0 ? 'caution' : 'arm');
      screws(F, 0.03, 0.105, m - hw, m + hw, 0.005);
    }
  }
  {
    // the windscreen arch: the strut nearest 62 degrees
    const [A, w] = H.can.struts.reduce((m, x) => (Math.abs(x[0] - 62) < Math.abs(m[0] - 62) ? x : m));
    for (const s of [1, -1]) {
      const az = A * DEG * s, at = (de) => { const p = canPt(C, az, sillAt(C, az) + de, 0.994), N = canNrm(C, p); return { p: vadd(p, N, -H.can.depth), N }; };
      const lo = at(0.3), hi = at(0.52), F = onFrame(at(0.16).p, vsub([0, 0, 0], at(0.16).N), [0, 1, 0]);
      // hazard band at the foot of the pillar
      b.decalQuad(F.pt(0.0012, -0.06, -w * 0.42), F.pt(0.0012, 0.06, -w * 0.42), F.pt(0.0012, 0.06, w * 0.42), F.pt(0.0012, -0.06, w * 0.42), 'hazard');
      if (s > 0) {      // grab handle
        b.add(tube([lo.p, vadd(lo.p, lo.N, -0.032), vadd(hi.p, hi.N, -0.032), hi.p], 0.0058 * k, 7), M_STEEL, { crease: 60 });
        for (const e of [lo, hi]) b.add(onFrame(e.p, vsub([0, 0, 0], e.N)).place(lathe([[0, 0.012 * k], [0.004, 0.012 * k], [0.005, 0.008 * k]], 8, { capA: false })), P.trim);
      } else {          // canopy latch
        const G = onFrame(lo.p, vsub([0, 0, 0], lo.N), [0, 1, 0]);
        b.add(G.place(box(0, 0.012, -0.035, 0.035, -w * 0.4, w * 0.4, 0.003)), P.trim, { crease: 50 });
        b.add(tube([G.pt(0.012, 0.0, 0), G.pt(0.03, 0.03, 0), G.pt(0.04, 0.07, 0)], 0.0045 * k, 6), M_STEEL, { crease: 60 });
        b.add(tube([G.pt(0.04, 0.066, 0), G.pt(0.041, 0.086, 0)], [0.009 * k, 0.0075 * k], 8), M_RED, { crease: 60 });
      }
    }
    {      // a tag on a lanyard looped round the port pillar: sways with every manoeuvre
      const az = -A * DEG, e = Math.min(sillAt(C, az) + 0.62, topAt(C, az) - 0.1), p0 = canPt(C, az, e, 0.994), N0 = canNrm(C, p0), pp = vadd(p0, N0, -H.can.depth - 0.012);
      out.dangle = pp;
      b.part('dangle', pp);
      b.add(tube([pp, vadd(pp, [0, -0.035, 0.002]), vadd(pp, [0, -0.07, 0])], 0.0012, 5), M(0x8a2a22, 0.8));
      b.add(box(pp[0] - 0.001, pp[0] + 0.001, pp[1] - 0.1, pp[1] - 0.07, pp[2] - 0.009, pp[2] + 0.009, 0.0007), M(0x8f1d18, 0.6), { crease: 50 });
      b.add(box(pp[0] - 0.0013, pp[0] + 0.0013, pp[1] - 0.095, pp[1] - 0.087, pp[2] - 0.0065, pp[2] + 0.0065), M_WHITE);
      b.add(tube([vadd(pp, [0, -0.07, -0.003]), vadd(pp, [0, -0.07, 0.003])], 0.002, 6), M_STEEL);
      b.part('st');
      b.add(tube([vadd(pp, [0.004, 0.003, 0]), vadd(pp, [-0.004, 0.003, 0])], 0.004, 6), M_STEEL);
    }
    if (D.mirror) for (const s of [1, -1]) {
      const az = 57 * DEG * s, p = canPt(C, az, topAt(C, az) - 0.085, 0.95), F = onFrame(p, vsub([-0.05, -0.1, 0], p), [0, 1, 0]);
      b.add(F.place(box(-0.012, 0, -0.017, 0.017, -0.036, 0.036, 0.005)), P.frame, { crease: 50 });
      b.add(F.place(gridQuad([0.0006, -0.013, -0.032], [0.0006, -0.013, 0.032], [0.0006, 0.013, 0.032], [0.0006, 0.013, -0.032], 1, 1, [1, 0, 0])), M(0xc6d6e6, 0.06, 1));
      b.add(tube([F.pt(-0.006, 0.015, 0), canPt(C, az, topAt(C, az) - 0.01, 0.97)], 0.004, 6), P.trim);
    }
    // standby compass on the coaming
    const cz = -0.165, cx = 0.84, cy = -0.207;
    b.add(box(cx - 0.012, cx + 0.03, cy, cy + 0.034, cz - 0.03, cz + 0.03, 0.006), P.panel2, { crease: 50 });
    const face = []; quad(face, [cx - 0.0125, cy + 0.008, cz + 0.022], [cx - 0.0125, cy + 0.008, cz - 0.022], [cx - 0.0125, cy + 0.027, cz - 0.022], [cx - 0.0125, cy + 0.027, cz + 0.022]);
    b.glowTris(face, lin(H.ui.main, 0.16), CH.STATIC);
    for (let i = 0; i < 5; i++) { const t = []; const z = cz - 0.016 + i * 0.008; quad(t, [cx - 0.013, cy + 0.011, z + 0.001], [cx - 0.013, cy + 0.011, z - 0.001], [cx - 0.013, cy + (i % 2 ? 0.018 : 0.023), z - 0.001], [cx - 0.013, cy + (i % 2 ? 0.018 : 0.023), z + 0.001]); b.glowTris(t, lin(H.ui.hi, 0.6), CH.STATIC); }
  }

  /* ---- side consoles, pedestal, floor, seat, legs ---- */
  const CY = -0.345;
  for (const s of [1, -1]) {
    const z0 = s * 0.3, z1 = s * (C.r[2] * 0.97);
    b.add(box(-0.3, 0.6, -0.8, CY, Math.min(z0, z1), Math.max(z0, z1), 0.01), P.panel, { crease: 50 });
    const F = onFrame([0.2, CY, (z0 + z1) / 2], [0, 1, 0], [1, 0, 0]);   // lx up, ly forward, lz to port
    b.add(F.place(box(0, 0.003, -0.02, 0.2, -0.08, 0.08, 0.0015)), P.panel2);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) {
      const [tb, tl] = toggleT((R() < 0.5 ? -1 : 1) * 0.4, k);
      b.add(F.place(move(tb, 0.003, 0.03 + c * 0.035, -0.03 + r * 0.06)), M_SCREW); b.add(F.place(move(tl, 0.003, 0.03 + c * 0.035, -0.03 + r * 0.06)), M_STEEL);
    }
    b.decalQuad(F.pt(0.0036, 0.01, 0.07), F.pt(0.0036, 0.19, 0.07), F.pt(0.0036, 0.19, 0.054), F.pt(0.0036, 0.01, 0.054), 'labels');
    out.emitPts.push([0.45, CY + 0.02, s * 0.42]);
    // seat bolster
    b.add(box(-0.3, 0.22, -0.56, -0.46, s * 0.2 - 0.03, s * 0.2 + 0.03, 0.012), M(0x1a1b1f, 0.85), { crease: 50 });
    // thigh and shin
    const lg = D.stick === 'centre' ? -0.09 : 0;      // knees sit lower under the offset stick
    b.add(tube([[-0.12, -0.5 + lg * 0.3, s * 0.11], [0.15, -0.47 + lg * 0.7, s * 0.125], [0.37, -0.43 + lg, s * 0.14], [0.5, -0.56 + lg, s * 0.135], [0.6, -0.8, s * 0.13]], [0.085, 0.078, 0.066, 0.058, 0.05], 10), P.suit, { crease: 70 });
    // rudder pedal
    b.add(box(0.64, 0.66, -0.78, -0.62, s * 0.13 - 0.05, s * 0.13 + 0.05, 0.004), P.trim);
  }
  b.add(box(0.44, 0.6, -0.8, -0.45, -0.075, 0.075, 0.008), P.panel2, { crease: 50 });
  b.add(gridQuad([-0.3, -0.8, -0.6], [0.9, -0.8, -0.6], [0.9, -0.8, 0.6], [-0.3, -0.8, 0.6], 4, 4, [0, 1, 0]), M(0x0a0b0d, 0.9));
  b.add(gridQuad([0.72, -0.8, -0.6], [0.72, -0.8, 0.6], [0.72, -0.2, 0.6], [0.72, -0.2, -0.6], 4, 3, [0, -0.4, 0]), M(0x0a0b0d, 0.9));
  // cable looms under the dash
  if (q >= 1) for (const s of [1, -1]) {
    b.add(cable(FC.pt(-0.01, -0.2, s * 0.17), [0.5, CY - 0.02, s * 0.31], 0.05, 0.005), M_RUBBER);
    b.add(cable(FC.pt(-0.01, -0.2, s * 0.12), [0.52, -0.5, s * 0.07], 0.04, 0.004), M(0x3a0f0c, 0.7));
  }
  // placards on the walls by the pillars
  for (const s of [1, -1]) {
    const az = 52 * DEG * s, e = sillAt(C, az) - 0.085;
    const a = canPt(C, az - 0.1 * s, e, 0.97), c = canPt(C, az + 0.1 * s, e, 0.97), up = [0, 0.036, 0];
    const bl = s > 0 ? a : c, br = s > 0 ? c : a;
    b.decalQuad(bl, br, vadd(br, up), vadd(bl, up), s > 0 ? 'rescue' : 'noStep');
  }

  /* ---- controls and hands ---- */
  const addArm = (name, G, elbow, opt = {}) => {
    const hm = handModel(0.0195), soups = [hm.glove, hm.plate, hm.seam, hm.index, hm.fingers, hm.fpads, hm.thumb];
    // points carried through the same transforms: wrist, knuckle pivot (+ its axis), thumb pivot (+ its axis)
    let pts = [...hm.wrist, ...hm.idxPiv, ...vadd(hm.idxPiv, [0, 1, 0]), ...hm.thPiv, ...vadd(hm.thPiv, [1, 0, 0])];
    const apply = (fn) => { soups.forEach(fn); pts = fn(pts.slice()); };
    if (opt.left) { soups.forEach(mirrorZ); for (let i = 2; i < pts.length; i += 3) pts[i] = -pts[i]; }
    if (opt.onTop) apply((t) => rotX(t, opt.left ? -Math.PI / 2 : Math.PI / 2));
    const d = vsub(elbow, G);
    if (opt.onTop) apply((t) => rotZ(t, Math.atan2(-d[1], -d[0]) * 0.75));
    else apply((t) => rotY(t, -Math.atan2(d[2], -d[0]) * 0.8));
    const wrist = pts.slice(0, 3), kPiv = pts.slice(3, 6), kAx = vsub(pts.slice(6, 9), kPiv), thPiv = pts.slice(9, 12), tAx = vsub(pts.slice(12, 15), thPiv);
    const a = vnorm(vsub(d, wrist));
    const fa = forearm(wrist, a, Math.hypot(d[0], d[1], d[2]) + 0.06, opt.onTop ? [0, 0, opt.left ? -1 : 1] : [0, 1, 0]);
    const SEAM = M(0x6d7078, 0.6), sg = opt.left ? -1 : 1, digits = [];
    b.part(name, [0, 0, 0]);
    b.add(hm.glove, P.glove, { crease: 62 }); b.add(hm.plate, P.plate, { crease: 40 }); b.add(hm.seam, SEAM);
    b.add(fa.cuff, P.glove, { crease: 62 }); b.add(fa.strap, M_BLACK); b.add(fa.sleeve, P.suit, { crease: 62 });
    b.add(fa.collar, M_STEEL, { crease: 40 }); b.add(fa.band, P.accent); b.add(fa.lugs, M_GUN);
    // fingers hinge at the knuckles so the hand can open; on a stick hand the index works the trigger on its own
    b.part(name + 'F', kPiv); b.add(hm.fingers, P.glove, { crease: 62 }); b.add(hm.fpads, P.plate, { crease: 40 });
    if (opt.anim) { b.part(name + 'I', kPiv); b.add(hm.index, P.glove, { crease: 62 }); digits.push({ part: name + 'I', piv: kPiv, axis: kAx, kind: 'trigger', sg }); }
    else b.add(hm.index, P.glove, { crease: 62 });
    b.part(name + 'T', thPiv); b.add(hm.thumb, P.glove, { crease: 62 });
    digits.push({ part: name + 'F', piv: kPiv, axis: kAx, kind: 'fingers', sg }, { part: name + 'T', piv: thPiv, axis: tAx, kind: opt.anim ? 'thumb' : 'thumbIdle', sg });
    b.part('st');
    return { part: name, elbow, digits };
  };
  const stickGeo = (name, piv, L) => {
    b.part(name, piv);
    const [px, py, pz] = piv;
    b.add(latheY([[py, 0.042], [py + 0.01, 0.04], [py + 0.018, 0.03], [py + 0.027, 0.035], [py + 0.036, 0.024], [py + 0.046, 0.028], [py + 0.056, 0.015]], b.seg(12), px, pz), M_RUBBER, { crease: 30 });
    b.add(latheY([[py + 0.05, 0.0085], [py + L - 0.06, 0.0085]], 8, px, pz, { capA: false, capB: false }), M_STEEL);
    b.add(latheY([[py + L - 0.066, 0.013], [py + L - 0.056, 0.0195], [py + L - 0.02, 0.0185], [py + L + 0.02, 0.019], [py + L + 0.044, 0.0205], [py + L + 0.054, 0.025], [py + L + 0.07, 0.023], [py + L + 0.078, 0.013]], b.seg(14), px, pz, { sx: 1.12 }), M(0x101114, 0.5), { crease: 50 });
    // hat switch, weapon release, trigger
    b.add(latheY([[py + L + 0.078, 0.006], [py + L + 0.086, 0.007], [py + L + 0.088, 0.004]], 8, px - 0.004, pz + 0.004), M_STEEL);
    b.add(latheY([[py + L + 0.076, 0.0055], [py + L + 0.082, 0.005]], 8, px + 0.004, pz - 0.011), M_RED);
    b.add(box(px + 0.02, px + 0.032, py + L + 0.022, py + L + 0.052, pz - 0.005, pz + 0.005, 0.002), M_RED);
    b.part('st');
  };
  if (D.stick === 'side' || D.stick === 'centre') {
    const side = D.stick === 'side';
    const L = side ? 0.125 : 0.165, piv = side ? [0.475, CY, 0.34] : [0.47, -0.405, 0.135];
    stickGeo('stick', piv, L);
    const G = [piv[0], piv[1] + L, piv[2]];
    const arm = addArm('armR', G, side ? [0.13, -0.45, 0.4] : [0.12, -0.5, 0.33], { anim: true });
    out.controls.push({ part: 'stick', type: 'stick', piv, grips: [{ ...arm, at: [0, L, 0], G }] });
    if (side) b.add(latheY([[CY, 0.055], [CY + 0.004, 0.052]], 14, piv[0], piv[2]), P.trim);
    else {
      // the stick stands on a bracket off the pedestal, just right of the scope
      b.add(box(0.435, 0.62, -0.432, -0.405, piv[2] - 0.04, piv[2] + 0.04, 0.007), P.panel2, { crease: 50 });
      b.add(box(0.5, 0.62, -0.6, -0.42, piv[2] - 0.025, piv[2] + 0.025, 0.006), P.panel, { crease: 50 });
      b.add(latheY([[-0.405, 0.05], [-0.401, 0.047]], 14, piv[0], piv[2]), P.trim);
    }
  }
  // throttle quadrant on the port console
  {
    const T = [0.465, CY, -0.345], hasHand = D.stick !== 'yoke', gy = 0.1;
    b.add(box(T[0] - 0.09, T[0] + 0.09, CY, CY + 0.012, T[2] - 0.045, T[2] + 0.045, 0.004), P.panel2, { crease: 50 });
    b.add(box(T[0] - 0.07, T[0] + 0.07, CY + 0.0125, CY + 0.013, T[2] - 0.006, T[2] + 0.006), M_SOOT);
    b.decalQuad([T[0] - 0.07, CY + 0.0126, T[2] + 0.04], [T[0] + 0.07, CY + 0.0126, T[2] + 0.04], [T[0] + 0.07, CY + 0.0126, T[2] + 0.024], [T[0] - 0.07, CY + 0.0126, T[2] + 0.024], 'strip');
    b.part('thr', T);
    b.add(box(T[0] - 0.006, T[0] + 0.006, CY + 0.004, CY + gy - 0.012, T[2] - 0.012, T[2] + 0.012, 0.003), M_STEEL);
    const gripT = rotY(lathe([[-0.05, 0.012], [-0.046, 0.0195], [-0.03, 0.0185], [0.03, 0.0185], [0.046, 0.0195], [0.05, 0.012]], b.seg(12)), Math.PI / 2);
    b.add(move(gripT, T[0], CY + gy, T[2]), M(0x101114, 0.5), { crease: 50 });
    b.add(box(T[0] + 0.012, T[0] + 0.022, CY + gy - 0.004, CY + gy + 0.006, T[2] + 0.03, T[2] + 0.044, 0.002), M_YELLOW);
    if (D.stick === 'yoke') {      // twin levers on the heavy hull
      b.add(box(T[0] - 0.006, T[0] + 0.006, CY + 0.004, CY + gy - 0.012, T[2] - 0.04, T[2] - 0.028, 0.003), M_STEEL);
      b.add(latheY([[CY + gy - 0.014, 0.012], [CY + gy + 0.012, 0.016], [CY + gy + 0.02, 0.01]], 10, T[0], T[2] - 0.034), M_RED);
    }
    b.part('st');
    const G = [T[0], CY + gy, T[2]];
    const grips = hasHand ? [{ ...addArm('armL', G, [0.12, -0.45, -0.41], { left: true, onTop: true }), at: [0, gy, 0], G }] : [];
    out.controls.push({ part: 'thr', type: 'throttle', piv: T, grips });
  }
  if (D.stick === 'yoke') {
    const piv = FC.pt(0, -0.125, 0), n = PANEL_N, col = 0.165, gz = 0.165, up = 0.085;
    b.part('yoke', piv);
    const end = vadd(piv, n, col);
    b.add(tube([piv, end], 0.018, 10), M_STEEL);
    b.add(tube([vadd(piv, n, 0.01), vadd(piv, n, 0.05)], 0.027, 10), M_RUBBER);
    b.add(tube([[end[0], end[1], -gz], [end[0], end[1], gz]], 0.014, 8), M_BLACK);
    b.add(box(end[0] - 0.02, end[0] + 0.012, end[1] - 0.03, end[1] + 0.03, -0.05, 0.05, 0.006), P.panel2, { crease: 50 });
    b.decalQuad([end[0] - 0.0205, end[1] - 0.02, 0.04], [end[0] - 0.0205, end[1] - 0.02, -0.04], [end[0] - 0.0205, end[1] + 0.02, -0.04], [end[0] - 0.0205, end[1] + 0.02, 0.04], 'plate');
    const grips = [];
    for (const s of [1, -1]) {
      b.add(latheY([[end[1] - 0.02, 0.013], [end[1] + 0.01, 0.0195], [end[1] + up + 0.045, 0.0195], [end[1] + up + 0.058, 0.024], [end[1] + up + 0.07, 0.014]], b.seg(12), end[0], s * gz), M(0x101114, 0.5), { crease: 50 });
      b.add(latheY([[end[1] + up + 0.07, 0.006], [end[1] + up + 0.078, 0.005]], 8, end[0], s * gz), s > 0 ? M_RED : M_YELLOW);
    }
    b.part('st');
    for (const s of [1, -1]) {
      const G = [end[0], end[1] + up, s * gz];
      grips.push({ ...addArm(s > 0 ? 'armR' : 'armL', G, [0.12, -0.47, s * 0.31], { left: s < 0, anim: s > 0 }), at: vsub(G, piv), G });
    }
    out.controls.push({ part: 'yoke', type: 'yoke', piv, axis: n, grips });
  }

  /* ---- HUD combiner on the coaming ---- */
  {
    const hx = 0.8, y0 = -0.172, y1 = -0.008, hw = 0.082, tilt = 0.035;
    b.screen('H', [hx + tilt, y0, -hw], [hx + tilt, y0, hw], [hx - tilt * 0.2, y1, hw], [hx - tilt * 0.2, y1, -hw], R_HUD, SID.HUD);
    const g = []; quad(g, [hx + tilt, y0, -hw], [hx + tilt, y0, hw], [hx - tilt * 0.2, y1, hw], [hx - tilt * 0.2, y1, -hw]);
    b.glowTris(g, [0.004, 0.009, 0.008], CH.HUDGLASS);
    out.hudPiv = [hx, -0.19, 0];
    b.part('hud', out.hudPiv);
    if (D.hud === 'frame') {
      for (const s of [1, -1]) b.add(tube([[hx + tilt + 0.004, -0.2, s * (hw + 0.004)], [hx + tilt, y0, s * (hw + 0.004)], [hx - tilt * 0.2, y1, s * (hw + 0.004)]], 0.0028, 5), P.trim);
      b.add(tube([[hx - tilt * 0.2, y1, -hw - 0.004], [hx - tilt * 0.2, y1, hw + 0.004]], 0.0022, 5), P.trim);
      b.part('st');
    } else {
      b.part('st');
      for (const s of [1, -1]) b.add(box(hx + 0.02, hx + 0.05, -0.2, -0.178, s * hw - 0.008, s * hw + 0.008, 0.003), P.trim);
    }
    b.add(box(0.87, 0.99, -0.228, -0.196, -0.05, 0.05, 0.006), M(0x0c0d10, 0.9), { crease: 50 });
    const lens = []; for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; lens.push([0.885 + Math.cos(a) * 0.008, -0.1955, Math.sin(a) * 0.008]); }
    b.glowFan([0.885, -0.1955, 0], lens.reverse(), lin(H.ui.main, 0.07), CH.STATIC, 0);
  }
  return out;
}
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

// the ship's own nose and guns, seen through the windscreen
function buildNose(b, H, out) {
  const N = H.nose, P = H.pal, q = b.q;
  const n = N.n || (q >= 1 ? 22 : 12);
  b.add(fuselage(N.keys, { n, sub: q >= 1 ? 4 : 2, capA: false }), P.hull, { crease: N.n ? 20 : 50 });
  const top = (x) => { const xs = N.keys.map((k2) => k2.x); return pchip(xs, N.keys.map((k2) => k2.y + k2.t))(x); };
  const wid = (x) => { const xs = N.keys.map((k2) => k2.x); return pchip(xs, N.keys.map((k2) => k2.w))(x); };
  const x0 = N.keys[0].x, x1 = N.keys[N.keys.length - 1].x;
  // painted spine stripe and panel breaks, laid just above the skin
  const strip = (xa, xb, z0f, z1f, m, lift = 0.004) => b.add(gridFn((u, v) => {
    const x = lerp(xa, xb, u), w = wid(x), z = lerp(z0f, z1f, v) * w, r = Math.min(0.999, Math.abs(z) / Math.max(w, 1e-4));
    return [x, top(x) - (1 - Math.sqrt(1 - r * r)) * (top(x) - pchip(N.keys.map((k2) => k2.x), N.keys.map((k2) => k2.y))(x)) + lift, z];
  }, 10, 2, [2, 5, 0]), m);
  strip(x0 + 0.3, x1 - 0.05, -N.stripe / 0.3, N.stripe / 0.3, P.stripe);
  for (const xb of [1.9, 2.35, 2.75]) if (xb < x1 - 0.2) strip(xb, xb + 0.012, -0.8, 0.8, M_SOOT, 0.003);
  if (N.slab) for (const s of [1, -1]) b.add(box(1.5, 2.45, top(2) - 0.01, top(2) + 0.018, s * 0.5 - 0.14, s * 0.5 + 0.14, 0.008), P.hull2, { crease: 50 });
  if (N.pitot) b.add(tube([[x1 - 0.3, top(x1 - 0.3), 0], [x1 + 0.55, top(x1) - 0.09, 0]], [0.008, 0.003], 6), M_STEEL);
  if (N.spinner) b.add(lathe([[x1 - 0.06, 0.07], [x1 + 0.05, 0.05], [x1 + 0.14, 0.008]], 12, { y: top(x1) - 0.03, capA: false }), P.hull2);
  // gun fairings (static) and barrels (recoiling part)
  for (const g of N.guns) for (const s of [1, -1]) {
    const z = g.z * s;
    b.add(box(g.x0 - 0.05, g.x0 + (g.x1 - g.x0) * 0.42, g.y - g.r * 2.4, g.y + g.r * 2.2, z - g.r * 2.6, z + g.r * 2.6, g.r * 1.1), P.hull2, { crease: 50 });
    b.part('guns', [0, 0, 0]);
    if (g.slot) b.add(box(g.x0 + 0.3, g.x1, g.y - g.r, g.y + g.r, z - g.r * 2.2, z + g.r * 2.2, g.r * 0.5), M_GUN, { crease: 50 });
    else {
      b.add(lathe([[g.x0 + 0.1, g.r * 1.55], [g.x0 + (g.x1 - g.x0) * 0.5, g.r * 1.55], [g.x0 + (g.x1 - g.x0) * 0.52, g.r], [g.x1 - 0.14, g.r], [g.x1 - 0.12, g.r * 1.4], [g.x1, g.r * 1.4], [g.x1, g.r * 0.7], [g.x1 - 0.06, g.r * 0.6]], b.seg(10), { y: g.y, z }), M_GUN, { crease: 40 });
      for (let i = 0; i < 4; i++) b.add(lathe([[g.x1 - 0.5 + i * 0.07, g.r * 1.22], [g.x1 - 0.47 + i * 0.07, g.r * 1.22]], 8, { y: g.y, z }), M_BLACK);
    }
    b.part('st');
    // muzzle flash: a soft round burst facing the pilot and a short forward tongue
    const mx = g.x1 + 0.03, ch = s < 0 ? CH.MUZ_L : CH.MUZ_R, k2 = g.r / 0.02, halo = [], core = [], cone = [];
    for (let i = 0; i < 14; i++) { const a = (i / 14) * TAU, rr = (0.085 + (i % 2) * 0.02) * k2; halo.push([mx, g.y + Math.sin(a) * rr, z + Math.cos(a) * rr]); core.push([mx - 0.002, g.y + Math.sin(a) * rr * 0.32, z + Math.cos(a) * rr * 0.32]); }
    b.glowFan([mx, g.y, z], halo, [0.9, 0.5, 0.16], ch, 0);
    b.glowFan([mx - 0.002, g.y, z], core, [1.5, 1.05, 0.5], ch, 0.1);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; cone.push([mx + 0.32, g.y + Math.sin(a) * 0.012, z + Math.cos(a) * 0.012]); }
    b.glowFan([mx, g.y, z], cone, [1.2, 0.8, 0.3], ch, 0);
    b.glowFan([mx, g.y, z], cone.slice().reverse(), [1.2, 0.8, 0.3], ch, 0);
    out.muzzles.push([mx, g.y, z]);
  }
}

/* ========================================================================== */
/*  Painted textures                                                          */
/* ========================================================================== */

const FONT = 'ui-monospace, Menlo, Consolas, monospace';
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// tiling wear map multiplied into every painted surface: grain, scuffs, smears
function paintDetail(size) {
  const cv = mkCanvas(size, size), c = cv.getContext('2d'), R = rng(77);
  c.fillStyle = '#d9d9d9'; c.fillRect(0, 0, size, size);
  const img = c.getImageData(0, 0, size, size), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = 205 + R() * 36; d[i] = d[i + 1] = d[i + 2] = n; }
  c.putImageData(img, 0, 0);
  const wrap = (fn) => { for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) { c.save(); c.translate(ox, oy); fn(); c.restore(); } };
  for (let i = 0; i < 46; i++) {
    const x = R() * size, y = R() * size, r = 20 + R() * 90, a = 0.05 + R() * 0.1, dark = R() < 0.7;
    wrap(() => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, dark ? `rgba(60,60,60,${a})` : `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(128,128,128,0)'); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); });
  }
  for (let i = 0; i < 150; i++) {
    const x = R() * size, y = R() * size, an = R() * TAU, l = 6 + R() * R() * 90, li = R() < 0.6;
    wrap(() => { c.strokeStyle = li ? `rgba(255,255,255,${0.1 + R() * 0.25})` : `rgba(30,30,30,${0.08 + R() * 0.18})`; c.lineWidth = 0.6 + R() * 0.9; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(an) * l, y + Math.sin(an) * l); c.stroke(); });
  }
  for (let i = 0; i < 260; i++) { c.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(20,20,20,0.3)'; c.fillRect(R() * size, R() * size, 1 + R() * 2, 1 + R() * 2); }
  return cv;
}

// canopy dirt: R = fine scratches, G = dust and smears (tiling)
function paintDirt(size) {
  const cv = mkCanvas(size, size), c = cv.getContext('2d'), R = rng(909);
  c.fillStyle = '#000'; c.fillRect(0, 0, size, size);
  c.globalCompositeOperation = 'lighter';
  const wrap = (fn) => { for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) { c.save(); c.translate(ox, oy); fn(); c.restore(); } };
  for (let i = 0; i < 240; i++) {
    const x = R() * size, y = R() * size, an = R() * TAU, l = 10 + R() * R() * 160, a = 0.15 + R() * 0.6, cur = (R() - 0.5) * 60, w = 0.5 + R() * 0.6;
    wrap(() => { c.strokeStyle = `rgba(255,0,0,${a})`; c.lineWidth = w; c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(an) * l * 0.5 + cur, y + Math.sin(an) * l * 0.5 - cur, x + Math.cos(an) * l, y + Math.sin(an) * l); c.stroke(); });
  }
  for (let i = 0; i < 60; i++) {
    const x = R() * size, y = R() * size, r = 14 + R() * 80, a = 0.04 + R() * 0.14;
    wrap(() => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(0,255,0,${a})`); g.addColorStop(1, 'rgba(0,255,0,0)'); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); });
  }
  for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(0,255,0,${0.2 + R() * 0.6})`; c.beginPath(); c.arc(R() * size, R() * size, 0.4 + R() * 1.1, 0, TAU); c.fill(); }
  return cv;
}

// placards, label strips and stencils
function paintDecals() {
  const cv = mkCanvas(DC_W, DC_H), c = cv.getContext('2d'), R = rng(31);
  c.fillStyle = '#1b1d21'; c.fillRect(0, 0, DC_W, DC_H);
  const text = (s, x, y, px, col, align = 'center') => { c.fillStyle = col; c.font = `bold ${px}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(s, x, y); };
  const hazard = (r, col = '#d9a514', w = 22) => {
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    c.fillStyle = col; c.fillRect(r.x, r.y, r.w, r.h); c.fillStyle = '#111';
    for (let x = r.x - r.h; x < r.x + r.w + r.h; x += w * 2) { c.beginPath(); c.moveTo(x, r.y + r.h); c.lineTo(x + w, r.y + r.h); c.lineTo(x + w + r.h, r.y); c.lineTo(x + r.h, r.y); c.fill(); }
    c.restore();
  };
  const frame = (r, col, bg) => { c.fillStyle = bg; c.fillRect(r.x, r.y, r.w, r.h); c.strokeStyle = col; c.lineWidth = 5; c.strokeRect(r.x + 6, r.y + 6, r.w - 12, r.h - 12); };
  let r = DECALS.eject; hazard(r); c.fillStyle = '#d9a514'; c.fillRect(r.x + 26, r.y + 20, r.w - 52, r.h - 40); text('EJECT', r.x + r.w / 2, r.y + r.h / 2 + 2, 44, '#111');
  r = DECALS.caution; frame(r, '#d9a514', '#16171a'); text('CAUTION', r.x + r.w / 2, r.y + 32, 30, '#d9a514'); text('CANOPY JETTISON', r.x + r.w / 2, r.y + 66, 20, '#c9ccd0');
  r = DECALS.arm; frame(r, '#c22', '#16171a'); text('MASTER ARM', r.x + r.w / 2, r.y + 34, 30, '#e33'); text('SAFE · ARM · LIVE', r.x + r.w / 2, r.y + 68, 19, '#c9ccd0');
  r = DECALS.plate; c.fillStyle = '#8b9096'; c.fillRect(r.x, r.y, r.w, r.h); c.fillStyle = '#6f747a'; c.fillRect(r.x + 5, r.y + 5, r.w - 10, r.h - 10);
  text('SV-MK IV  HULL 0417', r.x + r.w / 2, r.y + 30, 19, '#1c1e21'); text('ORBITAL YARD 7', r.x + r.w / 2, r.y + 56, 17, '#1c1e21'); text('CHK ▢ ▢ ▣', r.x + r.w / 2, r.y + 78, 14, '#1c1e21');
  hazard(DECALS.hazard, '#d9a514', 20);
  r = DECALS.noStep; frame(r, '#c9ccd0', '#16171a'); text('NO HANDHOLD', r.x + r.w / 2, r.y + r.h / 2 + 1, 24, '#c9ccd0');
  r = DECALS.rescue; c.fillStyle = '#b3201a'; c.fillRect(r.x, r.y, r.w, r.h); text('RESCUE ▶', r.x + r.w / 2, r.y + r.h / 2 + 1, 28, '#f1ede2');
  const strip = (rr, words, px = 20) => { c.fillStyle = '#16171a'; c.fillRect(rr.x, rr.y, rr.w, rr.h); const n = words.length; words.forEach((w, i) => text(w, rr.x + rr.w * (i + 0.5) / n, rr.y + rr.h / 2 + 1, px, '#c9ccd0')); c.fillStyle = '#c9ccd0'; c.fillRect(rr.x + 4, rr.y + rr.h - 4, rr.w - 8, 2); };
  strip(DECALS.labels, ['PWR', 'NAV', 'COM', 'ECM', 'AUX']); strip(DECALS.labels2, ['FUEL', 'O2', 'HYD', 'APU', 'ICE']);
  r = DECALS.keypad; c.fillStyle = '#0f1013'; c.fillRect(r.x, r.y, r.w, r.h);
  '123456789*0#'.split('').forEach((ch, i) => { const x = r.x + 10 + (i % 3) * 58, y = r.y + 10 + ((i / 3) | 0) * 60; c.fillStyle = '#2c2f35'; c.fillRect(x, y, 52, 54); c.fillStyle = '#3a3e45'; c.fillRect(x + 3, y + 3, 46, 44); text(ch, x + 26, y + 26, 26, '#d4d8dc'); });
  r = DECALS.tape; c.fillStyle = '#c9c2a8'; c.fillRect(r.x, r.y, r.w, r.h); text('INOP — DO NOT USE', r.x + r.w / 2, r.y + r.h / 2 + 2, 24, '#30281a');
  r = DECALS.stencil; c.fillStyle = '#1b1d21'; c.fillRect(r.x, r.y, r.w, r.h); text('LIFT HERE ▲', r.x + r.w / 2, r.y + r.h / 2 + 2, 30, '#8f959c');
  r = DECALS.breaker; c.fillStyle = '#121316'; c.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 3; j++) { const x = r.x + 18 + i * 31, y = r.y + 24 + j * 38, out = R() < 0.12; c.fillStyle = '#060607'; c.beginPath(); c.arc(x, y, 11, 0, TAU); c.fill(); c.fillStyle = out ? '#d8d8d8' : '#2b2d32'; c.beginPath(); c.arc(x, y, 8, 0, TAU); c.fill(); c.fillStyle = out ? '#fff' : '#3d4047'; c.beginPath(); c.arc(x - 2, y - 2, 4, 0, TAU); c.fill(); }
  r = DECALS.kill; frame(r, '#c22', '#16171a'); text('FIRE SUPPR', r.x + r.w / 2, r.y + 40, 34, '#e33'); text('PULL TO DISCHARGE', r.x + r.w / 2, r.y + 86, 22, '#c9ccd0');
  r = DECALS.strip; c.fillStyle = '#16171a'; c.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i <= 20; i++) { c.fillStyle = i % 5 ? '#8f959c' : '#e8eaec'; c.fillRect(r.x + 10 + i * 24.6, r.y + (i % 5 ? 30 : 16), 3, i % 5 ? 20 : 40); }
  // general grime over the lot
  for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(0,0,0,${R() * 0.25})`; c.fillRect(R() * DC_W, R() * DC_H, 1 + R() * 5, 1 + R() * 2); }
  for (let i = 0; i < 200; i++) { c.strokeStyle = `rgba(210,210,210,${R() * 0.18})`; c.lineWidth = 1; const x = R() * DC_W, y = R() * DC_H; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (R() - 0.5) * 40, y + (R() - 0.5) * 12); c.stroke(); }
  return cv;
}

// One impact in thick laminated glass. R = fracture lines, G = the crushed,
// whitened glass along them: a small star at the point of impact, a few long
// radial cracks with slight kinks, one or two rings stepping from ray to ray.
function paintCrack(c, x, y, pw, R, sc) {
  c.globalCompositeOperation = 'lighter'; c.lineCap = 'round'; c.lineJoin = 'round';
  const rad = (50 + pw * 68) * sc;
  const g = c.createRadialGradient(x, y, 0, x, y, rad * 0.3);
  g.addColorStop(0, 'rgba(0,255,0,0.75)'); g.addColorStop(0.3, 'rgba(0,255,0,0.2)'); g.addColorStop(1, 'rgba(0,255,0,0)');
  c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  const nR = 4 + ((R() * 2.4) | 0) + (pw > 0.75 ? 1 : 0), rays = [], a0 = R() * TAU;
  const path = (pts, w, style) => { c.strokeStyle = style; c.lineWidth = w; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.stroke(); };
  for (let i = 0; i < nR; i++) {
    let an = a0 + ((i + (R() - 0.5) * 0.55) / nR) * TAU, px = x + Math.cos(an) * 3 * sc, py = y + Math.sin(an) * 3 * sc;
    const len = rad * (i % 2 ? 0.5 + R() * 0.35 : 0.8 + R() * 0.45), kinks = 2 + ((R() * 2) | 0), pts = [[px, py]];
    for (let k = 0; k <= kinks; k++) { an += (R() - 0.5) * 0.3; const st = (len / (kinks + 1)) * (0.75 + R() * 0.5); px += Math.cos(an) * st; py += Math.sin(an) * st; pts.push([px, py]); }
    path(pts, 9 * sc + 2, 'rgba(0,255,0,0.1)'); path(pts, 4.5 * sc + 1, 'rgba(0,255,0,0.22)');
    for (let k = 0; k < pts.length - 1; k++) { const t = k / (pts.length - 1); path([pts[k], pts[k + 1]], (2.2 - t * 1.3) * sc + 0.45, `rgba(255,0,0,${0.95 - t * 0.3})`); }
    rays.push(pts);
  }
  // point at a fraction of the way along a ray
  const along = (pts, f) => { const n = pts.length - 1, u = clamp(f, 0, 0.999) * n, k = u | 0, t = u - k; return [lerp(pts[k][0], pts[k + 1][0], t), lerp(pts[k][1], pts[k + 1][1], t)]; };
  for (const [f, p] of [[0.3, 0.85], [0.62, pw > 0.5 ? 0.55 : 0.25]]) for (let i = 0; i < nR; i++) {
    if (R() > p) continue;
    const A = along(rays[i], f + (R() - 0.5) * 0.08), B = along(rays[(i + 1) % nR], f + (R() - 0.5) * 0.08);
    const m = [(A[0] + B[0]) / 2 + (A[0] + B[0] - 2 * x) * 0.05, (A[1] + B[1]) / 2 + (A[1] + B[1] - 2 * y) * 0.05];
    if (Math.hypot(A[0] - B[0], A[1] - B[1]) > rad * 1.25) continue;
    path([A, m, B], 4 * sc + 1, 'rgba(0,255,0,0.14)'); path([A, m, B], 1.5 * sc + 0.4, 'rgba(255,0,0,0.85)');
  }
  // crushed star at the point of impact
  for (let i = 0; i < 11; i++) { const an = R() * TAU, l0 = R() * 3 * sc, l1 = (5 + R() * 9) * sc; path([[x + Math.cos(an) * l0, y + Math.sin(an) * l0], [x + Math.cos(an) * l1, y + Math.sin(an) * l1]], 1.5 * sc + 0.4, 'rgba(255,90,0,0.9)'); }
  c.fillStyle = 'rgba(255,255,0,1)'; c.beginPath(); c.arc(x, y, 3 * sc + 1, 0, TAU); c.fill();
  c.globalCompositeOperation = 'source-over';
}

/* ---- instruments ---- */

const COL_BLIP = ['#ff4b3a', '#ffb53a', '#b9a58a', '#ff2a6a', '#5dff8a', '#ffe04a', '#5ab4ff'];
const TAC_S = 330, TAC_OX = 256, TAC_OY = 346;

function paintTactical(c, s, th, t, ion, hullStrip) {
  const { x: X, y: Y, w, h } = R_TAC;
  c.save(); c.beginPath(); c.rect(X, Y, w, h); c.clip(); c.translate(X, Y);
  c.fillStyle = css(th.bg); c.fillRect(0, 0, w, h);
  const g = c.createRadialGradient(TAC_OX, TAC_OY, 10, TAC_OX, TAC_OY, 420);
  g.addColorStop(0, rgba(th.dim, 0.42)); g.addColorStop(1, rgba(th.dim, 0.04));
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  // range rings and bearing lines
  c.lineWidth = 2; c.strokeStyle = rgba(th.main, 0.34);
  for (let i = 1; i <= 4; i++) { c.beginPath(); c.arc(TAC_OX, TAC_OY, i * 0.25 * TAC_S, Math.PI, TAU); c.stroke(); }
  c.strokeStyle = rgba(th.main, 0.2);
  for (const a of [-60, -30, 0, 30, 60]) { const r = a * DEG; c.beginPath(); c.moveTo(TAC_OX, TAC_OY); c.lineTo(TAC_OX + Math.sin(r) * 420, TAC_OY - Math.cos(r) * 420); c.stroke(); }
  c.fillStyle = rgba(th.main, 0.6); c.font = `bold 15px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle';
  for (let i = 1; i <= 3; i++) c.fillText(String(i * 25), TAC_OX + 6, TAC_OY - i * 0.25 * TAC_S + 10);
  // lane edges (field boundary relative to the ship)
  const lL = s.laneL ?? -0.3, lR = s.laneR ?? 0.3;
  c.strokeStyle = rgba(th.hi, 0.75); c.lineWidth = 3; c.setLineDash([14, 8]);
  for (const l of [lL, lR]) { const x = TAC_OX + l * TAC_S; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  c.setLineDash([]);
  c.fillStyle = rgba(th.main, 0.07); c.fillRect(0, 0, TAC_OX + lL * TAC_S, h); c.fillRect(TAC_OX + lR * TAC_S, 0, w, h);
  // sweep
  const sw = ((((t * 0.55) % 1) + 1) % 1) * 1.15 * TAC_S;
  c.strokeStyle = rgba(th.hi, 0.22); c.lineWidth = 5; c.beginPath(); c.arc(TAC_OX, TAC_OY, sw, Math.PI, TAU); c.stroke();
  // contacts
  const bl = s.blips, n = Math.min(s.blipCount | 0, bl ? (bl.length / 4) | 0 : 0);
  const pulse = 0.5 + 0.5 * Math.sin(t * 9);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    const kind = bl[i * 4 + 2] | 0;
    if ((pass === 0) !== (kind === 2 || kind === 1)) continue;      // rocks and shots under, craft on top
    let fw = bl[i * 4], lat = bl[i * 4 + 1];
    const sz = bl[i * 4 + 3];
    if (ion > 0) { const j = Math.sin(i * 12.9898 + Math.floor(t * 9) * 78.233) * 43758.5453; const f = j - Math.floor(j); if (f < ion * 0.5) continue; fw += (f - 0.5) * 0.08 * ion; lat += (0.5 - f) * 0.08 * ion; }
    const x = TAC_OX + lat * TAC_S, y = TAC_OY - fw * TAC_S;
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
    const col = COL_BLIP[kind] || '#fff';
    c.fillStyle = col; c.strokeStyle = col;
    if (kind === 1) { c.beginPath(); c.arc(x, y, 3.6, 0, TAU); c.fill(); }
    else if (kind === 2) { const r = clamp(sz * TAC_S, 5, 34); c.lineWidth = 2.5; c.globalAlpha = 0.3; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); c.globalAlpha = 1; c.stroke(); }
    else if (kind === 3) {
      const r = clamp(sz * TAC_S, 20, 60);
      c.globalAlpha = 0.25 + 0.2 * pulse; c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.fill(); c.globalAlpha = 1;
      c.lineWidth = 4; c.stroke();
      c.lineWidth = 3; const q2 = r + 9; for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { c.beginPath(); c.moveTo(x + sx * q2, y + sy * q2 * 0.5); c.lineTo(x + sx * q2, y + sy * q2); c.lineTo(x + sx * q2 * 0.5, y + sy * q2); c.stroke(); }
    } else if (kind === 4) { const r = 8 + pulse * 2; c.lineWidth = 3.5; c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke(); c.lineWidth = 2; c.beginPath(); c.arc(x, y, r + 3, 0, TAU); c.stroke(); }
    else if (kind === 5) { const r = 7; c.lineWidth = 3.5; c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); c.stroke(); }
    else if (kind === 6) { const r = 10; c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r * 0.8, y + r * 0.8); c.lineTo(x, y + r * 0.3); c.lineTo(x - r * 0.8, y + r * 0.8); c.closePath(); c.fill(); }
    else {      // enemy: wedge pointing at us, ringed when close
      const r = clamp(sz * TAC_S * 0.9, 8, 20);
      c.beginPath(); c.moveTo(x, y + r); c.lineTo(x + r * 0.9, y - r * 0.8); c.lineTo(x, y - r * 0.35); c.lineTo(x - r * 0.9, y - r * 0.8); c.closePath(); c.fill();
      if (fw > 0 && fw < 0.22 && Math.abs(lat) < 0.12) { c.lineWidth = 2.5; c.globalAlpha = 0.5 + 0.5 * pulse; c.beginPath(); c.arc(x, y, r + 7, 0, TAU); c.stroke(); c.globalAlpha = 1; }
    }
  }
  // own ship and gun line
  c.strokeStyle = rgba(th.hi, 0.35); c.lineWidth = 2; c.setLineDash([4, 10]); c.beginPath(); c.moveTo(TAC_OX, TAC_OY - 18); c.lineTo(TAC_OX, 0); c.stroke(); c.setLineDash([]);
  c.fillStyle = css(th.hi); c.beginPath(); c.moveTo(TAC_OX, TAC_OY - 17); c.lineTo(TAC_OX + 13, TAC_OY + 12); c.lineTo(TAC_OX, TAC_OY + 4); c.lineTo(TAC_OX - 13, TAC_OY + 12); c.closePath(); c.fill();
  // frame text
  if (hullStrip) {
    // narrow screens lose the side displays: hull points ride along the bottom of the scope
    const hp = Math.max(0, s.hp ?? 3), hpMax = Math.max(1, s.hpMax ?? 3), col = hp <= 1 ? '#ff4b3a' : hp / hpMax <= 0.5 ? '#ffb53a' : '#5dff8a';
    c.fillStyle = 'rgba(0,0,0,0.72)'; c.fillRect(0, h - 40, w, 40);
    c.fillStyle = col; c.font = `bold 22px ${FONT}`; c.textAlign = 'left'; c.fillText('HULL', 10, h - 19);
    const x0 = 82, pw = Math.min(54, (w - x0 - 96 - (hpMax - 1) * 7) / hpMax);
    for (let i = 0; i < hpMax; i++) { const x = x0 + i * (pw + 7); c.fillStyle = i < hp ? col : 'rgba(255,255,255,0.1)'; c.fillRect(x, h - 32, pw, 24); c.strokeStyle = col; c.lineWidth = 2.5; c.strokeRect(x, h - 32, pw, 24); }
    if (s.shield) { c.fillStyle = '#5ab4ff'; c.textAlign = 'right'; c.fillText('SHLD', w - 10, h - 19); }
    else { c.fillStyle = rgba(th.main, 0.9); c.textAlign = 'right'; c.fillText('R' + (s.rockets ?? 0), w - 10, h - 19); }
  } else {
    c.fillStyle = rgba(th.main, 0.9); c.font = `bold 17px ${FONT}`; c.textAlign = 'left'; c.fillText('TAC', 10, h - 14);
    c.textAlign = 'right'; c.fillText('LV ' + String(s.level ?? 1).padStart(2, '0'), w - 10, h - 14);
  }
  // boss health
  if ((s.bossHp ?? -1) >= 0) {
    const bw = w - 150, bx = 110, by = 12;
    c.fillStyle = 'rgba(40,0,10,0.85)'; c.fillRect(0, 0, w, 44);
    c.fillStyle = '#ff2a6a'; c.font = `bold 24px ${FONT}`; c.textAlign = 'left'; c.fillText('BOSS', 12, 23);
    c.strokeStyle = '#ff2a6a'; c.lineWidth = 2.5; c.strokeRect(bx, by, bw, 22);
    c.fillStyle = s.bossHp < 0.25 ? (pulse > 0.5 ? '#ffd0dc' : '#ff2a6a') : '#ff2a6a'; c.fillRect(bx + 3, by + 3, (bw - 6) * sat(s.bossHp), 16);
    c.fillStyle = 'rgba(40,0,10,0.9)'; for (let i = 1; i < 10; i++) c.fillRect(bx + (bw * i) / 10 - 1, by + 3, 2, 16);
  }
  if (ion > 0.05) {
    for (let i = 0; i < 60 * ion; i++) { const j = Math.sin(i * 91.7 + Math.floor(t * 15) * 13.1) * 43758.5453, f = j - Math.floor(j), k2 = Math.sin(i * 17.3 + Math.floor(t * 15) * 7.7) * 24634.63, f2 = k2 - Math.floor(k2); c.fillStyle = rgba(th.hi, 0.25 + f * 0.4); c.fillRect(f * w, f2 * h, 20 + f2 * 90, 2 + f * 3); }
    if (pulse > 0.35) { c.fillStyle = 'rgba(0,0,0,0.7)'; c.fillRect(96, h / 2 - 22, w - 192, 44); c.fillStyle = '#ffb53a'; c.font = `bold 26px ${FONT}`; c.textAlign = 'center'; c.fillText('ION INTERFERENCE', w / 2, h / 2 + 1); }
  }
  c.restore();
}

function paintGauges(c, th, vals, style) {
  const LAB = ['SPD', 'THR', 'PWR', 'TMP'];
  for (let i = 0; i < 4; i++) {
    const r = R_GAUGE[i], v = sat(vals[i]), cx = r.x + 48, cy = r.y + 50;
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    c.fillStyle = css(th.bg); c.fillRect(r.x, r.y, r.w, r.h);
    const hot = i === 3 && v > 0.72;
    if (style === 'tape') {
      c.fillStyle = rgba(th.dim, 0.5); c.fillRect(r.x + 34, r.y + 8, 28, 62);
      c.fillStyle = hot ? '#ff4b3a' : css(th.main); c.fillRect(r.x + 34, r.y + 8 + 62 * (1 - v), 28, 62 * v);
      c.fillStyle = css(th.bg); for (let k = 1; k < 8; k++) c.fillRect(r.x + 34, r.y + 8 + k * 7.75 - 1, 28, 2);
      c.fillStyle = rgba(th.hi, 0.8); for (let k = 0; k <= 4; k++) c.fillRect(r.x + 66, r.y + 8 + k * 15.2, k % 2 ? 6 : 12, 2.5);
    } else {
      c.strokeStyle = rgba(th.dim, 0.9); c.lineWidth = 7; c.beginPath(); c.arc(cx, cy, 33, Math.PI * 0.75, Math.PI * 2.25); c.stroke();
      c.strokeStyle = '#ff4b3a'; c.beginPath(); c.arc(cx, cy, 33, Math.PI * 1.95, Math.PI * 2.25); c.stroke();
      c.strokeStyle = hot ? '#ff4b3a' : css(th.main); c.beginPath(); c.arc(cx, cy, 33, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * v)); c.stroke();
      c.strokeStyle = css(th.hi); c.lineWidth = 2;
      for (let k = 0; k <= 6; k++) { const a = Math.PI * (0.75 + 0.25 * k); c.beginPath(); c.moveTo(cx + Math.cos(a) * 25, cy + Math.sin(a) * 25); c.lineTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30); c.stroke(); }
      const a = Math.PI * (0.75 + 1.5 * v);
      c.lineWidth = 4.5; c.beginPath(); c.moveTo(cx - Math.cos(a) * 6, cy - Math.sin(a) * 6); c.lineTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30); c.stroke();
      c.fillStyle = css(th.hi); c.beginPath(); c.arc(cx, cy, 5, 0, TAU); c.fill();
    }
    c.fillStyle = rgba(th.hi, 0.9); c.font = `bold 15px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(LAB[i], cx, r.y + 85);
    c.restore();
  }
}

function paintHud(c, s, th, t, v) {
  const { x: X, y: Y, w, h } = R_HUD;
  c.save(); c.beginPath(); c.rect(X, Y, w, h); c.clip(); c.translate(X, Y);
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const col = css(th.main), hi = css(th.hi);
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 3; c.font = `bold 20px ${FONT}`; c.textBaseline = 'middle';
  // corner brackets
  for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const x = sx ? w - 8 : 8, y = sy ? h - 8 : 8, dx = sx ? -24 : 24, dy = sy ? -24 : 24; c.beginPath(); c.moveTo(x + dx, y); c.lineTo(x, y); c.lineTo(x, y + dy); c.stroke(); }
  // speed tape (left) and thrust tape (right)
  const tape = (x, val, lab, flipS) => {
    c.strokeStyle = col; c.lineWidth = 2.5; c.beginPath(); c.moveTo(x, 48); c.lineTo(x, 208); c.stroke();
    const off = (val * 400) % 20;
    for (let k = -1; k < 9; k++) { const y = 48 + k * 20 + off; if (y < 48 || y > 208) continue; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (flipS ? -1 : 1) * (((k + Math.floor(val * 20)) % 2) ? 8 : 14), y); c.stroke(); }
    c.fillStyle = hi; const y = 208 - 160 * sat(val);
    c.beginPath(); c.moveTo(x + (flipS ? 4 : -4), y); c.lineTo(x + (flipS ? 18 : -18), y - 8); c.lineTo(x + (flipS ? 18 : -18), y + 8); c.closePath(); c.fill();
    c.fillStyle = col; c.textAlign = flipS ? 'right' : 'left'; c.fillText(lab, flipS ? x + 20 : x - 20, 30);
  };
  tape(34, v.spd, 'SPD', false); tape(w - 34, v.thr, 'THR', true);
  // bank scale across the top
  c.strokeStyle = col; c.lineWidth = 2.5;
  for (let k = -3; k <= 3; k++) { const a = -Math.PI / 2 + k * 0.17; c.beginPath(); c.moveTo(w / 2 + Math.cos(a) * 92, 122 + Math.sin(a) * 92); c.lineTo(w / 2 + Math.cos(a) * (k % 3 ? 100 : 106), 122 + Math.sin(a) * (k % 3 ? 100 : 106)); c.stroke(); }
  { const a = -Math.PI / 2 + clamp(v.bank, -0.55, 0.55); c.fillStyle = hi; c.beginPath(); c.moveTo(w / 2 + Math.cos(a) * 90, 122 + Math.sin(a) * 90); c.lineTo(w / 2 + Math.cos(a - 0.07) * 76, 122 + Math.sin(a - 0.07) * 76); c.lineTo(w / 2 + Math.cos(a + 0.07) * 76, 122 + Math.sin(a + 0.07) * 76); c.closePath(); c.fill(); }
  // status line
  let msg = '';
  if (s.ion > 0.3) msg = 'GUNS OFFLINE'; else if (s.warp > 0.1) msg = 'HYPERSPACE'; else if (s.overdriveOn) msg = 'OVERDRIVE'; else if (s.boost) msg = 'BOOST'; else if ((s.overdrive ?? 0) >= 1) msg = 'OVD READY';
  if (msg) { c.fillStyle = s.ion > 0.3 ? '#ffb53a' : hi; c.textAlign = 'center'; c.font = `bold 22px ${FONT}`; c.fillText(msg, w / 2, h - 30); }
  c.restore();
}

// what is left of a display after the blast: unlit glass, a web of cracks, on a dial the needle stuck where it died
function paintDeadGlass(c, rects, black, style, R) {
  if (black) { c.fillStyle = '#000'; c.fillRect(black.x, black.y, black.w, black.h); }
  for (const r of rects) {
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    const g = c.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    g.addColorStop(0, '#1a1f26'); g.addColorStop(0.45, '#080a0d'); g.addColorStop(0.55, '#10141a'); g.addColorStop(1, '#050608');
    c.fillStyle = g; c.fillRect(r.x, r.y, r.w, r.h);
    const dial = r.w <= 100 && r.h <= 100, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (dial) {
      c.strokeStyle = '#3b424b'; c.lineWidth = 6;
      if (style === 'tape') { c.strokeRect(r.x + 34, r.y + 8, 28, 62); c.fillStyle = '#59616b'; c.fillRect(r.x + 34, r.y + 8 + 62 * R(), 28, 4); }
      else {
        c.beginPath(); c.arc(cx, cy + 2, 33, Math.PI * 0.75, Math.PI * 2.25); c.stroke();
        const a = Math.PI * (0.75 + 1.5 * R());
        c.strokeStyle = '#9aa1a9'; c.lineWidth = 4.5; c.beginPath(); c.moveTo(cx, cy + 2); c.lineTo(cx + Math.cos(a) * 29, cy + 2 + Math.sin(a) * 29); c.stroke();
        c.fillStyle = '#9aa1a9'; c.beginPath(); c.arc(cx, cy + 2, 5, 0, TAU); c.fill();
      }
    } else if (r.w > 200) {      // ghost of the last picture burnt into the phosphor
      c.strokeStyle = 'rgba(120,140,150,0.16)'; c.lineWidth = 2;
      for (let i = 1; i <= 3; i++) { c.beginPath(); c.arc(cx, r.y + r.h * 0.85, i * r.h * 0.22, Math.PI, TAU); c.stroke(); }
    }
    // impact star and long cracks to the edges
    const ix = r.x + r.w * (0.25 + R() * 0.5), iy = r.y + r.h * (0.25 + R() * 0.5), n = dial ? 5 : 7, k = Math.max(r.w, r.h);
    c.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      let an = (i / n) * TAU + R() * 0.7, x = ix, y = iy;
      c.strokeStyle = `rgba(210,222,232,${0.55 + R() * 0.35})`; c.lineWidth = dial ? 1.6 : 2.4; c.beginPath(); c.moveTo(x, y);
      for (let j = 0; j < 4; j++) { an += (R() - 0.5) * 0.5; x += Math.cos(an) * k * 0.2; y += Math.sin(an) * k * 0.2; c.lineTo(x, y); }
      c.stroke();
    }
    c.strokeStyle = 'rgba(210,222,232,0.5)'; c.lineWidth = dial ? 1.2 : 1.8;
    c.beginPath(); for (let i = 0; i <= 8; i++) { const an = (i / 8) * TAU + 0.3, rr = k * (0.1 + R() * 0.04); if (i) c.lineTo(ix + Math.cos(an) * rr, iy + Math.sin(an) * rr); else c.moveTo(ix + Math.cos(an) * rr, iy + Math.sin(an) * rr); } c.stroke();
    c.fillStyle = 'rgba(230,238,245,0.8)'; c.beginPath(); c.arc(ix, iy, dial ? 2.5 : 4, 0, TAU); c.fill();
    c.restore();
  }
}

function paintStatus(c, s, th, t, lamps) {
  const text = (str, x, y, px, col, align = 'left') => { c.fillStyle = col; c.font = `bold ${px}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(str, x, y); };
  const main = css(th.main), hi = css(th.hi), dim = rgba(th.dim, 0.9);
  const head = (r, title) => { c.fillStyle = css(th.bg); c.fillRect(r.x, r.y, r.w, r.h); c.fillStyle = rgba(th.dim, 0.75); c.fillRect(r.x, r.y, r.w, 40); text(title, r.x + 12, r.y + 21, 24, hi); };
  const bar = (x, y, w, h, v, col) => { c.strokeStyle = col; c.lineWidth = 3; c.strokeRect(x, y, w, h); c.fillStyle = col; c.fillRect(x + 5, y + 5, (w - 10) * sat(v), h - 10); };
  const hp = Math.max(0, s.hp ?? 3), hpMax = Math.max(1, s.hpMax ?? 3), frac = hp / hpMax;
  const hcol = hp <= 1 ? '#ff4b3a' : frac <= 0.5 ? '#ffb53a' : '#5dff8a';
  // ---- left: hull, shield, ordnance ----
  let r = R_MFD_L;
  c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
  head(r, 'HULL');
  text(hp + '/' + hpMax, r.x + r.w - 12, r.y + 21, 26, hcol, 'right');
  const pw = (r.w - 24 - (hpMax - 1) * 8) / hpMax;
  for (let i = 0; i < hpMax; i++) {
    const x = r.x + 12 + i * (pw + 8);
    c.fillStyle = i < hp ? hcol : 'rgba(255,255,255,0.08)'; c.fillRect(x, r.y + 52, pw, 54);
    c.strokeStyle = i < hp ? hcol : dim; c.lineWidth = 3; c.strokeRect(x, r.y + 52, pw, 54);
  }
  // ship plan with the damaged sections lit
  { const cx = r.x + 84, cy = r.y + 216; c.strokeStyle = hcol; c.lineWidth = 4; c.fillStyle = hp <= 1 ? 'rgba(255,75,58,0.3)' : 'rgba(255,255,255,0.05)';
    c.beginPath(); c.moveTo(cx, cy - 86); c.lineTo(cx + 18, cy - 20); c.lineTo(cx + 66, cy + 44); c.lineTo(cx + 22, cy + 40); c.lineTo(cx + 12, cy + 76); c.lineTo(cx - 12, cy + 76); c.lineTo(cx - 22, cy + 40); c.lineTo(cx - 66, cy + 44); c.lineTo(cx - 18, cy - 20); c.closePath(); c.fill(); c.stroke();
    if (s.shield) { c.strokeStyle = '#5ab4ff'; c.lineWidth = 5; c.beginPath(); c.ellipse(cx, cy - 2, 78, 98, 0, 0, TAU); c.stroke(); } }
  const xr = r.x + 180;
  text('SHLD', xr, r.y + 142, 22, main); text(s.shield ? 'UP' : '--', r.x + r.w - 12, r.y + 142, 26, s.shield ? '#5ab4ff' : dim, 'right');
  text('RKT', xr, r.y + 190, 22, main); text(String(s.rockets ?? 0).padStart(2, '0'), r.x + r.w - 12, r.y + 190, 30, (s.rockets ?? 0) > 0 ? hi : dim, 'right');
  text('LSR', xr, r.y + 238, 22, main); text(String(s.lasers ?? 0), r.x + r.w - 12, r.y + 238, 30, (s.lasers ?? 0) > 0 ? hi : dim, 'right');
  bar(xr, r.y + 262, r.w - 192, 26, s.laserCharge ?? 0, (s.laserCharge ?? 0) >= 1 ? hi : main);
  text('GUN MK ' + ['I', 'II', 'III'][clamp((s.fireTier ?? 1) - 1, 0, 2)], xr, r.y + 312, 20, main);
  c.restore();
  // ---- right: score, level, overdrive ----
  r = R_MFD_R;
  c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
  head(r, 'SCORE');
  text(String(Math.max(0, s.score | 0)).padStart(8, '0'), r.x + r.w / 2, r.y + 84, 56, hi, 'center');
  text('LEVEL', r.x + 14, r.y + 146, 22, main); text(String(s.level ?? 1).padStart(2, '0'), r.x + r.w - 14, r.y + 146, 34, hi, 'right');
  text('COMBO', r.x + 14, r.y + 194, 22, main);
  text(String(s.combo ?? 0), r.x + 190, r.y + 194, 34, (s.combo ?? 0) > 0 ? hi : dim, 'right'); text('x' + (s.mult ?? 1), r.x + r.w - 14, r.y + 194, 34, (s.mult ?? 1) > 1 ? '#ffe04a' : dim, 'right');
  const od = s.overdrive ?? 0, odc = s.overdriveOn ? '#ffe04a' : od >= 1 ? hi : main;
  text('OVERDRIVE', r.x + 14, r.y + 244, 22, main); text(s.overdriveOn ? 'ACTIVE' : od >= 1 ? 'READY' : Math.round(od * 100) + '%', r.x + r.w - 14, r.y + 244, 22, odc, 'right');
  bar(r.x + 14, r.y + 266, r.w - 28, 46, s.overdriveOn ? 1 : od, odc);
  c.restore();
  // ---- annunciators ----
  const L = [['MASTER', 'CAUTION', (s.hp ?? 3) <= 1 ? '#ff3b2a' : '#ffab2e'], ['FIRE', '', '#ff3b2a'], ['BOSS', '', '#ff2a6a'], ['ION', '', '#ffb53a'], ['SHIELD', '', '#5ab4ff'], ['OVER', 'DRIVE', '#ffe04a']];
  for (let i = 0; i < 6; i++) {
    const q = R_LAMP[i], on = lamps[i];
    c.fillStyle = on ? L[i][2] : '#0c0d10'; c.fillRect(q.x, q.y, q.w, q.h);
    c.strokeStyle = on ? '#fff' : '#33363c'; c.lineWidth = 3; c.strokeRect(q.x + 3, q.y + 3, q.w - 6, q.h - 6);
    const tc = on ? '#140404' : '#4a4d54';
    if (L[i][1]) { text(L[i][0], q.x + q.w / 2, q.y + 21, 22, tc, 'center'); text(L[i][1], q.x + q.w / 2, q.y + 45, 22, tc, 'center'); }
    else text(L[i][0], q.x + q.w / 2, q.y + 33, 30, tc, 'center');
  }
}

/* ========================================================================== */
/*  Shaders                                                                   */
/* ========================================================================== */

// Fake sun shadows inside the cabin: the ray from a fragment toward the sun is
// intersected with the canopy ellipsoid and tested against the same analytic
// sill / roof / strut layout the frame geometry was built from.
const CK_FRAG = `
varying vec2 vMr;
varying vec3 vCk;
uniform vec3 uCkC, uCkR, uSunL;
uniform vec4 uCkWin;
uniform float uCkAz;
uniform vec2 uCkStrut[6];
uniform vec3 uFly;
float ckLit = 1.0;
float ckShadow() {
  // something big passing close: its shadow sweeps across the cabin from one side
  float fl = 1.0 - uFly.z * (1.0 - smoothstep(uFly.y * 0.55, uFly.y, abs(vCk.z - uFly.x)));
  vec3 q = (vCk - uCkC) / uCkR;
  float qq = dot(q, q);
  if (qq >= 1.0) return fl;
  vec3 d = uSunL / uCkR;
  float a = dot(d, d), b = dot(q, d), c = qq - 1.0;
  float t = (-b + sqrt(max(0.0, b * b - a * c))) / a;
  vec3 h = normalize(q + d * t);
  float e = asin(clamp(h.y, -1.0, 1.0)), A = atan(h.z, h.x), sA = sin(A);
  float s2 = abs(A) > 1.5708 ? 1.0 : sA * sA;
  float sill = uCkWin.x + uCkWin.y * s2, top = uCkWin.z + uCkWin.w * s2;
  float lit = smoothstep(sill, sill + 0.012, e) * (1.0 - smoothstep(top - 0.012, top, e)) * (1.0 - smoothstep(uCkAz - 0.05, uCkAz, abs(A)));
  float ce = cos(e);
  for (int i = 0; i < 6; i++) {
    vec2 s = uCkStrut[i];
    if (s.y > 0.0) lit *= smoothstep(s.y, s.y + 0.007, abs(abs(A) - s.x) * ce);
  }
  ckLit = lit * fl;
  return mix(0.02, 1.0, lit) * fl;
}`;

// The dashboard buckling in the final explosion: everything standing on the
// panel (meshes that live in cockpit space) sags and crumples with it.
const BUCKLE = `
uniform vec2 uBuckle;
vec3 ckBuckle(vec3 p) {
  float w = smoothstep(0.5, 0.57, p.x) * smoothstep(0.84, 0.74, p.x) * step(p.y, -0.16) * step(-0.62, p.y) * uBuckle.x;
  if (w > 0.0) {
    float u = clamp((p.z * uBuckle.y + 0.5), 0.0, 1.1);
    p.y -= w * (0.085 * u * u + 0.012 * sin(p.z * 21.0 + 1.0));
    p.x += w * (0.03 * u - 0.012 * sin(p.z * 15.0));
  }
  return p;
}`;

const GLOW_VERT = `
attribute vec3 gcol; attribute float ch;
uniform float uCh[10];
varying vec3 vC;
${BUCKLE}
void main() { vC = gcol * uCh[int(ch + 0.5)]; gl_Position = projectionMatrix * modelViewMatrix * vec4(ckBuckle(position), 1.0); }`;
const GLOW_FRAG = `
varying vec3 vC;
void main() { gl_FragColor = vec4(vC, 1.0); }`;

const SCR_VERT = `
attribute vec2 luv; attribute float sid;
uniform float uScr[12];
varying vec2 vUv, vL; varying float vB, vG;
${BUCKLE}
void main() { vUv = uv; vL = luv; vG = sid < 0.5 ? 0.3 : 1.0; vB = uScr[int(sid + 0.5)]; gl_Position = projectionMatrix * modelViewMatrix * vec4(ckBuckle(position), 1.0); }`;
const SCR_FRAG = `
uniform sampler2D map;
uniform float uTime, uGlitch, uGain, uWashAmt, uBase;
uniform vec3 uWash;
varying vec2 vUv, vL; varying float vB, vG;
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  float gl = uGlitch * vG;
  float row = floor(vL.y * 30.0), tk = floor(uTime * 22.0);
  float g = step(1.0 - gl * 0.5, h1(row * 1.7 + tk * 3.1));
  uv.x += g * (h1(row + tk) - 0.5) * 0.035 * gl;
  vec3 c = texture2D(map, uv).rgb;
  float n = h1(dot(floor(vL * vec2(80.0, 60.0)), vec2(1.0, 57.0)) + tk);
  c += gl * step(0.93, n) * vec3(0.16, 0.2, 0.24);
  float roll = 0.93 + 0.07 * sin(vL.y * 5.0 - uTime * 2.6);
  float vig = smoothstep(0.0, 0.05, vL.x) * smoothstep(0.0, 0.05, 1.0 - vL.x) * smoothstep(0.0, 0.05, vL.y) * smoothstep(0.0, 0.05, 1.0 - vL.y);
  float lum = dot(c, vec3(0.3, 0.6, 0.1));
  c = mix(c, uWash * (lum * 1.6 + 0.04), uWashAmt);
  c = c * vB * roll * (0.7 + 0.3 * vig) * uGain + uBase * vec3(0.012, 0.016, 0.02) * (0.5 + vL.y);
  gl_FragColor = vec4(c, 1.0);
}`;

const GLASS_VERT = `
attribute vec3 cen, rnd, bary;
attribute float edge;
uniform float uShat;
varying vec3 vD, vN, vB; varying float vFade, vE;
mat3 rotAxis(vec3 a, float ang) {
  float s = sin(ang), c = cos(ang), o = 1.0 - c;
  return mat3(o * a.x * a.x + c, o * a.x * a.y + a.z * s, o * a.z * a.x - a.y * s,
              o * a.x * a.y - a.z * s, o * a.y * a.y + c, o * a.y * a.z + a.x * s,
              o * a.z * a.x + a.y * s, o * a.y * a.z - a.x * s, o * a.z * a.z + c);
}
void main() {
  vec3 p = position, n = normal;
  vD = position; vB = bary; vFade = 1.0; vE = edge;
  if (uShat > 0.0) {
    float t = max(0.0, uShat - rnd.x * 0.07);
    mat3 R = rotAxis(normalize(rnd * 2.0 - 1.0 + 0.001), t * (2.0 + rnd.y * 7.0));
    p = cen + R * (p - cen);
    // blown outward by the cabin air, then left behind as the wreck tumbles on
    vec3 v = normalize(cen - vec3(-0.1, -0.3, 0.0)) * (2.2 + rnd.z * 4.5);
    p += v * t + vec3(3.0 + rnd.y * 5.0, 0.8, 0.0) * t * t;
    n = R * n;
    vFade = 1.0 - smoothstep(1.0, 1.6, t);
  }
  vN = n;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const GLASS_FRAG = `
uniform sampler2D uCrack, uDirt, uInst;
uniform vec3 uSunL, uSunC, uExtC, uExtD, uAmb, uGlow;
uniform float uWarp, uTime, uShat, uFire, uCab, uMuz, uFrost, uSoot;
varying vec3 vD, vN, vB; varying float vFade, vE;
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  vec3 D = normalize(vD), N = normalize(vN);
  float ndv = abs(dot(N, D)), fr = pow(1.0 - ndv, 3.0);
  vec3 Rr = reflect(D, N);
  // faint reflection of the lit cabin
  vec3 col = (uAmb * 0.3 + uGlow * smoothstep(0.25, -0.75, Rr.y) + uFire * vec3(1.0, 0.3, 0.05) * smoothstep(0.2, -0.6, Rr.x)) * (0.012 + 0.4 * fr);
  // scratches and dust catching the sun and outside flashes
  vec2 ang = vec2(atan(D.z, D.x), asin(clamp(D.y, -1.0, 1.0)));
  vec4 dt = texture2D(uDirt, ang * vec2(2.6, 2.6));
  float sd = max(dot(D, uSunL), 0.0);
  // scratches only catch the light in a tight halo round the sun's glare (about 12 degrees); elsewhere the glass is clean
  float halo = smoothstep(0.974, 0.9985, sd);
  vec4 mt = texture2D(uDirt, ang * 7.0);
  col += uSunC * (halo * (mt.r * 0.11 + mt.g * 0.03 + dt.g * 0.02) + halo * halo * 0.02 + sd * sd * sd * 0.004);
  // outside flashes light the dirt on the side they come from
  float ed = max(dot(D, uExtD), 0.0);
  vec3 extC = uExtC * (0.12 + 0.88 * ed * ed * ed);
  col += extC * (0.012 + dt.g * 0.04);      // a soft veil only: flashes must not light up scratches all over the canopy
  // fractures
  vec2 cuv = vec2(ang.x / 3.4907 + 0.5, (ang.y + 0.45) / 1.45);
  // the cabin mirrored in the canopy: a blurred ghost of the scope above the coaming, the visor
  // and the gloves as faint shapes; all of it drowns when the outside is bright
  float dim = uCab / (1.0 + 7.0 * sd * sd * sd + 5.0 * (extC.r + extC.g));
  vec2 rv = vec2(ang.x / 0.62 + 0.5, (ang.y + 0.2) / 0.3);
  float rm = smoothstep(0.0, 0.18, rv.x) * smoothstep(1.0, 0.82, rv.x) * smoothstep(0.0, 0.25, rv.y) * smoothstep(1.0, 0.5, rv.y);
  col += texture2D(uInst, vec2(rv.x * 0.6667, 1.0 - clamp(rv.y, 0.0, 1.0) * 0.8125), 3.5).rgb * (rm * dim * 0.085);
  float he = length(vec2(ang.x / 0.21, (ang.y - 0.33) / 0.15)), hq = (he - 1.0) * 5.0;
  float hands = exp(-dot(vec2((abs(ang.x) - 0.36) / 0.09, (ang.y + 0.13) / 0.06), vec2((abs(ang.x) - 0.36) / 0.09, (ang.y + 0.13) / 0.06)));
  col += (uGlow * 0.6 + uAmb * 0.25 + vec3(0.012)) * dim * (exp(-hq * hq * 0.35) * 0.014 + smoothstep(1.0, 0.3, he) * 0.012 + hands * 0.024);
  // gun flashes run up the inside of the glass; outside flashes kindle a streak toward their side
  float mq = (ang.y + 0.17 - 0.32 * (1.0 - uMuz)) * 11.0;
  col += vec3(1.0, 0.68, 0.32) * uMuz * exp(-mq * mq) * exp(-ang.x * ang.x * 3.0) * (0.03 + mt.r * 0.08 + dt.g * 0.05);
  col += extC * pow(ed, 40.0) * (0.15 + 0.5 * mt.r);
  // the inner ply cracks along the same lines a few millimetres deeper: a fainter, offset twin
  vec4 ck = texture2D(uCrack, cuv), ck2 = texture2D(uCrack, cuv + vec2(0.0016, -0.0024) * (0.6 + ndv));
  float inner = ck2.r * (1.0 - ck.r);
  vec3 ckc = uAmb * 0.5 + uSunC * (0.1 + 0.95 * sd * sd * sd) * (0.75 + 0.6 * dt.r) + extC * 2.0 + uGlow * 0.25;
  col += ckc * (ck.r * 0.48 + inner * 0.14 + ck.g * 0.11);
  float a = 0.03 + fr * 0.1 + dt.g * 0.025 + ck.g * 0.13 + ck.r * 0.3 + inner * 0.14;
  // frost left by a jump: grows in from the frame, melts back to it
  if (uFrost > 0.0) {
    float fn = dt.g * 0.7 + mt.r * 0.5 + mt.g * 0.4;
    float fa = smoothstep(uFrost * 0.42, uFrost * 0.08, vE * (0.6 + fn * 0.9)) * min(1.0, uFrost * 3.0) * (0.35 + 0.65 * fn);
    col += (uAmb * 0.5 + uSunC * (0.04 + 0.3 * sd * sd) + uGlow * 0.1) * fa * 0.42;
    a += fa * 0.1;
  }
  // soot settling on the lower glass while the cabin burns
  float so = uSoot * smoothstep(0.12, -0.28, ang.y) * (0.25 + 0.9 * dt.g + 0.5 * mt.g);
  col *= 1.0 - so * 0.4; a += so * 0.3;
  // hyperspace streaks sliding over the canopy
  if (uWarp > 0.0) {
    float rad = length(D.yz), an = atan(D.z, D.y) * 22.0;
    float id = floor(an), fa = pow(1.0 - abs(fract(an) - 0.5) * 2.0, 3.0);
    float k = fract(rad * 1.3 - uTime * (1.5 + 2.5 * h1(id * 3.7)) + h1(id));
    float st = smoothstep(0.0, 0.06, k) * smoothstep(0.4, 0.08, k) * step(0.55, h1(id * 9.1)) * fa;
    col += vec3(0.2, 0.42, 1.0) * st * uWarp * smoothstep(0.1, 0.6, rad) * 0.4;
    col += vec3(0.1, 0.2, 0.5) * uWarp * fr * 0.1;
  }
  if (uShat > 0.0) {
    // splinters show their edges; the large plates read as tumbling panes catching the light
    float edge = vB.x > 1.5 ? 0.16 + 0.3 * fr + 0.5 * pow(abs(dot(N, normalize(uSunL + vec3(0.0, 0.4, 0.0)))), 12.0) : 1.0 - smoothstep(0.0, 0.07, min(vB.x, min(vB.y, vB.z)));
    col = (col + (uAmb + uSunC * 0.35 + uFire * vec3(2.4, 0.9, 0.25)) * (edge * 0.7 + 0.07)) * vFade;
    a = (a + 0.12 + edge * 0.5) * vFade;
  }
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
}`;

const SHIELD_VERT = `
varying vec3 vP;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SHIELD_FRAG = `
uniform float uOn, uTime;
uniform vec4 uRip[3];
uniform vec3 uCol;
varying vec3 vP;
float hex(vec2 p) { p.x *= 1.1547; p.y += mod(floor(p.x), 2.0) * 0.5; p = abs(mod(p, 1.0) - 0.5); return abs(max(p.x * 1.5 + p.y, p.y * 2.0) - 1.0); }
void main() {
  vec3 D = normalize(vP);
  vec2 uv = vec2(atan(D.z, D.x), asin(clamp(D.y, -1.0, 1.0))) * 10.0;
  float line = smoothstep(0.06, 0.0, hex(uv));
  float shim = 0.5 + 0.5 * sin(uv.x * 1.3 + uv.y * 0.7 - uTime * 2.2);
  float rim = smoothstep(0.9, 0.2, D.x);
  vec3 c = uCol * uOn * (0.004 + line * (0.008 + 0.03 * shim * shim * shim) * (0.3 + rim) + rim * 0.01);
  for (int i = 0; i < 3; i++) {
    vec4 r = uRip[i];
    if (r.w >= 0.0) {
      float d = acos(clamp(dot(D, r.xyz), -1.0, 1.0)), fade = max(0.0, 1.0 - r.w / 0.7);
      float rq = (d - r.w * 1.5) * 11.0, ring = exp(-rq * rq);
      c += uCol * (ring * (0.06 + line * 0.7) + exp(-d * d * 40.0) * fade * fade * 0.4) * fade;
    }
  }
  gl_FragColor = vec4(c, 1.0);
}`;

const FX_VERT = `
attribute vec3 aVel, aCol; attribute vec4 aPar; attribute vec2 corner;
varying vec2 vC; varying vec3 vCol; varying vec4 vPar;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec2 off = corner * aPar.x;
  if (aPar.y > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    float sp = length(vv.xy);
    vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(1.0, 0.0);
    off = dir * corner.x * aPar.x * (1.0 + min(aPar.y * sp / max(aPar.x, 1e-5), 7.0)) + vec2(-dir.y, dir.x) * corner.y * aPar.x;
  }
  mv.xy += off;
  vC = corner; vCol = aCol; vPar = aPar;
  gl_Position = projectionMatrix * mv;
}`;
const FX_FRAG = `
varying vec2 vC; varying vec3 vCol; varying vec4 vPar;
void main() {
  float core = smoothstep(1.0, 0.0, length(vC));
  float sh = mix(core * core, core, vPar.w);
  gl_FragColor = vec4(vCol * sh * mix(1.0, vPar.z, vPar.w), sh * vPar.z * vPar.w);
}`;

const OVL_VERT = `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const OVL_FRAG = `
uniform float uHaze, uVig, uRed, uFire, uWarp, uTime, uAspect, uFlashSide, uBlack;
uniform vec3 uFlash, uHazeCol;
varying vec2 vUv;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  vec2 p = vUv * 2.0 - 1.0; p.x *= uAspect;
  float l = length(p * vec2(0.8, 1.0));
  float n = vn(p * 1.6 + vec2(uTime * 0.07, -uTime * 0.11)) * 0.6 + vn(p * 3.7 - vec2(uTime * 0.13, uTime * 0.05)) * 0.4;
  float haze = uHaze * (0.2 + 0.8 * n) * (0.55 + 0.45 * vUv.y);
  vec3 col = uHazeCol * haze;
  float vig = smoothstep(0.55, 1.5, l);
  float a = haze + uVig * vig;
  col += vec3(0.9, 0.03, 0.02) * uRed * (0.01 + vig * 0.5);
  col += uFlash * (0.3 + 0.7 * vig) * clamp(1.0 + uFlashSide * p.x * 0.55, 0.3, 1.7);
  col += vec3(1.0, 0.3, 0.05) * uFire * smoothstep(0.1, -1.0, p.y) * (0.4 + 0.6 * n);
  col += vec3(0.1, 0.3, 1.0) * uWarp * vig * 0.22;
  col *= 1.0 - uBlack;
  gl_FragColor = vec4(col, clamp(max(a, uBlack), 0.0, 1.0));
}`;

/* ========================================================================== */
/*  Cockpit3D                                                                 */
/* ========================================================================== */

const EMPTY = Object.freeze({});
const CR_AZ = 3.4907, CR_E0 = -0.45, CR_ER = 1.45;
const hash1 = (n) => { const v = Math.sin(n * 127.1) * 43758.5453; return v - Math.floor(v); };
const wob = (t, f, p) => Math.sin(t * f + p) * 0.6 + Math.sin(t * f * 1.71 + p * 2.3) * 0.4;

export class Cockpit3D {
  constructor(THREE, opts = {}) {
    const T = (this.T = THREE);
    this.q = opts.quality ?? 1;
    this.renderer = opts.renderer || null;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(60, 16 / 9, 0.02, 30);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(1, 0, 0);
    this.scene.add(this.camera);
    this.root = new T.Group();
    this.scene.add(this.root);

    // a fixed light rig: counts never change, so programs never recompile
    this.sun = new T.DirectionalLight(0xffffff, 1);
    this.hemi = new T.HemisphereLight(0xffffff, 0x000000, 1);
    this.scene.add(this.sun, this.hemi);
    const pl = (x, y, z, dist) => { const l = new T.PointLight(0xffffff, 0, dist, 2); l.position.set(x, y, z); this.root.add(l); return l; };
    this.lCabin = pl(0.12, 0.2, 0, 2.6);      // instrument glow / emergency red
    this.lFlash = pl(0.5, -0.2, 0, 3);         // sparks and impacts
    this.lExt = pl(1.0, 0.4, 1.4, 8);          // explosions outside
    this.lFire = pl(-0.2, -0.3, 0.25, 3);      // fire behind the seat
    this.lMuz = pl(3.0, 0.45, 0, 7);          // own guns

    const v3 = () => new T.Vector3();
    this.U = {
      ck: {
        uRootInv: { value: new T.Matrix4() }, uCkC: { value: v3() }, uCkR: { value: new T.Vector3(1, 1, 1) }, uSunL: { value: new T.Vector3(0.4, 0.7, 0.5).normalize() },
        uCkWin: { value: new T.Vector4(0, 0, 1, 0) }, uCkAz: { value: 2 }, uCkStrut: { value: [0, 1, 2, 3, 4, 5].map(() => new T.Vector2(0, 0)) },
      },
      uCh: { value: new Float32Array(10) }, uScr: { value: new Float32Array(12).fill(1) },
      uTime: { value: 0 }, uGlitch: { value: 0 }, uWash: { value: new T.Vector3(0.3, 0.6, 1.4) }, uWashAmt: { value: 0 },
      uSunC: { value: new T.Vector3(1, 1, 1) }, uExtC: { value: v3() }, uExtD: { value: new T.Vector3(0.6, 0.2, 0.77) }, uAmb: { value: v3() }, uGlow: { value: v3() },
      uWarp: { value: 0 }, uShat: { value: 0 }, uFire: { value: 0 },
      uOn: { value: 0 }, uRip: { value: [0, 1, 2].map(() => new T.Vector4(1, 0, 0, -1)) }, uCol: { value: new T.Vector3(0.25, 0.6, 1.5) },
      uHaze: { value: 0 }, uVig: { value: 0 }, uRed: { value: 0 }, uCab: { value: 1 }, uMuz: { value: 0 }, uFrost: { value: 0 }, uSoot: { value: 0 }, uFly: { value: v3() }, uFlash: { value: v3() }, uFlashSide: { value: 0 }, uBlack: { value: 0 }, uBuckle: { value: new T.Vector2(0, 1) }, uBkOn: { value: 1 }, uBkOff: { value: 0 }, uHazeCol: { value: new T.Vector3(0.1, 0.1, 0.11) }, uAspect: { value: 1.78 },
    };

    this._textures();
    this._materials();
    this._env();
    this._fxInit(this.q >= 1 ? 280 : 140);
    this._extras();

    // animation state
    this.A = {
      pos: new Float32Array(5), vel: new Float32Array(5), tgt: new Float32Array(5),
      stickX: 0, stickY: 0, thr: 0, boost: 0, steerLag: 0, thrLag: 0,
      fireStamp: null, rocketStamp: null, trig: 0, thumb: 0, open: 0, dCr: 0, dFlags: 0, dSide: 1, deadPaint: false, frost: 0, warpArm: false, soot: 0, flyDone: false, dang: 0, dangV: 0, dang2: 0, dang2V: 0, lookY: 0, lookP: 0, recoil: 0, muzL: 0, muzR: 0, gunSide: 1,
      hitGlitch: 0, haze: 0, emerg: 0, power: 1, deadT: -1, sparkIn: 3, flash: 0, extPrev: 0, shieldOn: 0, tickIn: 0,
      lastA: -1e9, lastB: -1e9, dirtyA: true, dirtyB: true, sig: new Float64Array(4), lamps: [false, false, false, false, false, false], gv: new Float32Array(4), hud: { spd: 0, thr: 0, bank: 0 },
    };
    this.flashCol = new T.Vector3(); this.ovFlash = new T.Vector3();
    this.rand = rng(4242);
    this.cracks = 0; this.crackAt = new Float32Array(36);
    this.lastSide = 0.6; this.lastFront = 0.6;
    this.ships = new Map();
    this.cur = null; this.curId = null;
    this.basePitch = 0; this._lf = -1; this._la = -1;
    this.t = 0;
    this._v = v3(); this._v2 = v3(); this._v3 = v3(); this._q = new T.Quaternion(); this._q2 = new T.Quaternion(); this._ident = new T.Quaternion();
    this._sunDef = new T.Vector3(0.45, 0.62, 0.5).normalize(); this._sunColDef = new T.Color(1.0, 0.94, 0.84); this._ambDef = new T.Color(0.2, 0.25, 0.34);
    this._cTheme = new T.Vector3(); this._cRed = new T.Vector3(1, 0.05, 0.03);
  }

  /* ---- shared resources ---- */

  _textures() {
    const T = this.T, hi = this.q >= 1;
    const tex = (cv, srgb, repeat) => {
      const t = new T.CanvasTexture(cv);
      t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
      t.anisotropy = hi ? 8 : 2;
      return t;
    };
    this.tDetail = tex(paintDetail(hi ? 512 : 256), true, true);
    this.tDirt = tex(paintDirt(hi ? 512 : 256), false, true);
    this.tDecal = tex(paintDecals(), true, false);
    this.cvA = mkCanvas(CA_W, CA_H); this.cxA = this.cvA.getContext('2d'); this.tA = tex(this.cvA, true, false);
    this.cvB = mkCanvas(CB_W, CB_H); this.cxB = this.cvB.getContext('2d'); this.tB = tex(this.cvB, true, false);
    this.cxA.fillStyle = '#000'; this.cxA.fillRect(0, 0, CA_W, CA_H); this.cxB.fillStyle = '#000'; this.cxB.fillRect(0, 0, CB_W, CB_H);
    this.crW = hi ? 2048 : 1024; this.crH = this.crW / 2;
    this.cvC = mkCanvas(this.crW, this.crH); this.cxC = this.cvC.getContext('2d');
    this.cxC.fillStyle = '#000'; this.cxC.fillRect(0, 0, this.crW, this.crH);
    this.tCrack = tex(this.cvC, false, false);
  }

  _materials() {
    const T = this.T, U = this.U;
    const patch = (m) => {
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U.ck, { uFly: U.uFly, uBuckle: U.uBuckle, uBk: m.userData.bk ? U.uBkOn : U.uBkOff });
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 mr;\nvarying vec2 vMr;\nvarying vec3 vCk;\nuniform mat4 uRootInv;\nuniform float uBk;' + BUCKLE)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (uBk > 0.5) transformed = ckBuckle(transformed);')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvMr = mr;\nvCk = (uRootInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\n' + CK_FRAG)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vMr.x;')
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vMr.y;')
          // no surface of the cabin or the nose may blow out into bloom, whatever the sun does
          .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(0.85));\n#include <dithering_fragment>')
          // sunlight scattered through the canopy: lets the frame's shadow read even on faces turned from the sun
          .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n#if NUM_DIR_LIGHTS > 0\n{ float wr = clamp(dot(normal, directionalLights[0].direction) * 0.5 + 0.62, 0.0, 1.0); reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * (ckLit * step(dot(vCk - uCkC, vCk - uCkC), 4.0) * wr * wr * 0.1); }\n#endif')
          .replace('#include <lights_fragment_begin>', 'float ckSun = ckShadow();\n' + T.ShaderChunk.lights_fragment_begin.replace(
            'getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\ndirectLight.color *= ckSun;'));
      };
      m.customProgramCacheKey = () => 'cockpit-ck';
      return m;
    };
    this.mStruct = patch(new T.MeshStandardMaterial({ vertexColors: true, map: this.tDetail, roughness: 1, metalness: 1, userData: { bk: 1 } }));
    // same program, for the parts that move in their own frame (controls, arms, debris)
    this.mPart = patch(new T.MeshStandardMaterial({ vertexColors: true, map: this.tDetail, roughness: 1, metalness: 1 }));
    this.mDecal = patch(new T.MeshStandardMaterial({ map: this.tDecal, color: 0x9a9a9a, roughness: 1, metalness: 1, userData: { bk: 1 }, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.mGlow = new T.ShaderMaterial({ uniforms: { uCh: U.uCh, uBuckle: U.uBuckle }, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, blending: T.AdditiveBlending, depthWrite: false, transparent: true, side: T.DoubleSide });
    const scrU = (map, gain, base) => ({ uBuckle: U.uBuckle, map: { value: map }, uScr: U.uScr, uTime: U.uTime, uGlitch: U.uGlitch, uWash: U.uWash, uWashAmt: U.uWashAmt, uGain: { value: gain }, uBase: { value: base } });
    this.mScrA = new T.ShaderMaterial({ uniforms: scrU(this.tA, 1.25, 1), vertexShader: SCR_VERT, fragmentShader: SCR_FRAG });
    this.mScrB = new T.ShaderMaterial({ uniforms: scrU(this.tB, 1.25, 1), vertexShader: SCR_VERT, fragmentShader: SCR_FRAG });
    this.mHud = new T.ShaderMaterial({ uniforms: scrU(this.tA, 0.34, 0), vertexShader: SCR_VERT, fragmentShader: SCR_FRAG, blending: T.AdditiveBlending, depthWrite: false, transparent: true, side: T.DoubleSide });
    const premult = { blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneMinusSrcAlphaFactor, transparent: true, depthWrite: false };
    this.mGlass = new T.ShaderMaterial({
      uniforms: { uCrack: { value: this.tCrack }, uDirt: { value: this.tDirt }, uInst: { value: this.tA }, uCab: U.uCab, uMuz: U.uMuz, uFrost: U.uFrost, uSoot: U.uSoot, uSunL: U.ck.uSunL, uSunC: U.uSunC, uExtC: U.uExtC, uExtD: U.uExtD, uAmb: U.uAmb, uGlow: U.uGlow, uWarp: U.uWarp, uTime: U.uTime, uShat: U.uShat, uFire: U.uFire },
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, side: T.DoubleSide, ...premult,
    });
    this.mShield = new T.ShaderMaterial({ uniforms: { uOn: U.uOn, uTime: U.uTime, uRip: U.uRip, uCol: U.uCol }, vertexShader: SHIELD_VERT, fragmentShader: SHIELD_FRAG, blending: T.AdditiveBlending, depthWrite: false, transparent: true, side: T.BackSide });
    this.mFx = new T.ShaderMaterial({ uniforms: {}, vertexShader: FX_VERT, fragmentShader: FX_FRAG, ...premult });
    this.mOvl = new T.ShaderMaterial({
      uniforms: { uHaze: U.uHaze, uVig: U.uVig, uRed: U.uRed, uFire: U.uFire, uWarp: U.uWarp, uTime: U.uTime, uAspect: U.uAspect, uFlash: U.uFlash, uHazeCol: U.uHazeCol, uFlashSide: U.uFlashSide, uBlack: U.uBlack },
      vertexShader: OVL_VERT, fragmentShader: OVL_FRAG, depthTest: false, ...premult,
    });
  }

  // a small prefiltered studio so metal and gloss have something to reflect
  _env() {
    const T = this.T;
    if (!this.renderer) return;
    const sc = new T.Scene(), geo = new T.SphereGeometry(6, 24, 12), col = [], p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) / 6, k = y > 0 ? lerp(0.5, 0.16, y) : lerp(0.5, 0.03, -y * 2.5 > 1 ? 1 : -y * 2.5); col.push(k * 0.85, k * 0.95, k * 1.15); }
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    const m1 = new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide }), bg = new T.BoxGeometry(1, 1, 1);
    const m2 = new T.MeshBasicMaterial({ color: new T.Color(9, 8.4, 7.4) }), m3 = new T.MeshBasicMaterial({ color: new T.Color(1.2, 2.2, 3.4) });
    const b1 = new T.Mesh(bg, m2), b2 = new T.Mesh(bg, m3), b3 = new T.Mesh(bg, m3);
    b1.position.set(2.5, 4, 2.5); b1.scale.set(2, 0.3, 2); b2.position.set(3, -0.5, -4); b2.scale.set(3, 1.2, 0.3); b3.position.set(-2, 0.5, 4.5); b3.scale.set(4, 1, 0.3);
    sc.add(new T.Mesh(geo, m1), b1, b2, b3);
    const pm = new T.PMREMGenerator(this.renderer);
    this.envRT = pm.fromScene(sc, 0.04);
    pm.dispose(); geo.dispose(); bg.dispose(); m1.dispose(); m2.dispose(); m3.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.3;
  }

  // shield dome, particle pool, full-frame haze
  _extras() {
    const T = this.T;
    this.shield = new T.Mesh(new T.SphereGeometry(4, this.q >= 1 ? 40 : 24, this.q >= 1 ? 20 : 12), this.mShield);
    this.shield.position.set(0.2, -0.2, 0); this.shield.renderOrder = 1; this.shield.frustumCulled = false; this.shield.visible = false;
    this.root.add(this.shield);
    const og = new T.BufferGeometry();
    og.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.ovl = new T.Mesh(og, this.mOvl);
    this.ovl.frustumCulled = false; this.ovl.renderOrder = 9;
    this.scene.add(this.ovl);
    // loose things for the final explosion: panels, bezels, knobs, papers, a strap, two cable ends
    const mk = (tris, m, kind) => {
      const b = new Build(this.q);
      for (let i = 0; i < tris.length; i++) b.add(tris[i], m[i] || m[0], { crease: 50 });
      const mesh = new T.Mesh(this._geo(b.buf('st')), this.mPart);
      mesh.frustumCulled = false; mesh.visible = false; this.root.add(mesh);
      this.debris.push({ mesh, kind, vel: new T.Vector3(), axis: new T.Vector3(1, 0, 0), spin: 0, at: 0, home: new T.Vector3() });
    };
    this.debris = [];
    const PL = M(0x2c3038, 0.55), DK = M(0x15171b, 0.6), PAPER = M(0xcfcab8, 0.9), n = this.q >= 1 ? 1 : 0;
    for (let i = 0; i < 2 + n; i++) mk([box(-0.002, 0.002, -0.03 - i * 0.008, 0.03 + i * 0.008, -0.05, 0.05, 0.0012), move(rivetT(0.003), 0.002, 0.02, 0.04), move(rivetT(0.003), 0.002, -0.02, -0.04)], [PL, M_SCREW, M_SCREW], 'plate');
    for (let i = 0; i < 1 + n; i++) mk([bezel(-0.035, 0.035, -0.042, 0.042, 0.008, 0.007, 0.004)], [DK], 'plate');
    for (let i = 0; i < 1 + n; i++) mk([knobT(0.012, 0.016, 10), box(0.016, 0.0165, -0.001, 0.001, 0, 0.011)], [DK, M_WHITE], 'bit');
    for (let i = 0; i < 1 + n; i++) mk([tube([[-0.07, 0, 0], [0, 0.006, 0], [0.07, -0.004, 0.01]], 0.0045, 6)], [M_STEEL], 'bit');
    for (let i = 0; i < 2 + n; i++) mk([box(-0.0004, 0.0004, -0.07, 0.07, -0.05, 0.05), box(0.0004, 0.0006, 0.03, 0.05, -0.04, 0.02), box(0.0004, 0.0006, -0.02, 0.01, -0.04, 0.04)], [PAPER, DK, M(0x8a8676, 0.9)], 'paper');
    mk([box(-0.001, 0.001, -0.011, 0.011, -0.13, 0.13), box(-0.003, 0.003, -0.014, 0.014, -0.02, 0.012, 0.002)], [M(0x3a3320, 0.9), M_STEEL], 'paper');
    for (let i = 0; i < 2; i++) mk([tube([[0, 0, 0], [0.004, -0.06, 0.006], [-0.006, -0.13, 0.002], [0.008, -0.2, -0.008], [0.002, -0.26, 0.004]], [0.0055, 0.005, 0.005, 0.0045, 0.006], 6), tube([[0.002, -0.26, 0.004], [0.003, -0.285, 0.005]], 0.0025, 5)], [M_RUBBER, M(0xb87333, 0.3, 1)], 'cable');
  }

  _fxInit(N) {
    const T = this.T;
    this.P = {
      n: N, next: 0, x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      life: new Float32Array(N), max: new Float32Array(N), size: new Float32Array(N), kind: new Uint8Array(N), r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N), seed: new Float32Array(N),
    };
    const g = new T.BufferGeometry(), corner = new Float32Array(N * 8), idx = new Uint16Array(N * 6);
    for (let i = 0; i < N; i++) {
      corner.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const dyn = (n) => { const a = new T.BufferAttribute(new Float32Array(N * 4 * n), n); a.setUsage(T.DynamicDrawUsage); return a; };
    g.setAttribute('position', (this.fxPos = dyn(3))); g.setAttribute('aVel', (this.fxVel = dyn(3))); g.setAttribute('aPar', (this.fxPar = dyn(4))); g.setAttribute('aCol', (this.fxCol = dyn(3)));
    g.setAttribute('corner', new T.BufferAttribute(corner, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    this.fx = new T.Mesh(g, this.mFx);
    this.fx.frustumCulled = false; this.fx.renderOrder = 5;
    this.root.add(this.fx);
    this.nDust = this.q >= 1 ? 26 : 10;
    this._seedDust();
  }
  _seedDust() {
    const P = this.P, R = rng(99);
    for (let i = 0; i < P.n; i++) P.life[i] = 0;
    for (let i = 0; i < this.nDust; i++) {
      P.kind[i] = 3; P.life[i] = 1; P.max[i] = 1; P.x[i] = 0.25 + R() * 0.55; P.y[i] = -0.14 + R() * 0.4; P.z[i] = (R() - 0.5) * 0.8;
      P.vx[i] = (R() - 0.5) * 0.012; P.vy[i] = (R() - 0.5) * 0.008; P.vz[i] = (R() - 0.5) * 0.012; P.size[i] = 0.0007 + R() * 0.0011; P.seed[i] = R() * 10; P.r[i] = P.g[i] = P.b[i] = 1;
    }
  }
  _spawn(kind, x, y, z, vx, vy, vz, life, size, r, g, b) {
    const P = this.P;
    for (let k = 0; k < P.n; k++) {
      const i = P.next; P.next = (P.next + 1) % P.n;
      if (i < this.nDust || P.life[i] > 0) continue;
      P.kind[i] = kind; P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz; P.life[i] = P.max[i] = life; P.size[i] = size; P.r[i] = r; P.g[i] = g; P.b[i] = b; P.seed[i] = this.rand() * 10;
      return;
    }
  }
  _sparks(p, n, pw, r = 1, g = 0.75, b = 0.35) {
    const R = this.rand;
    for (let i = 0; i < n; i++) {
      const sp = 0.5 + R() * 2.2 * (0.6 + pw);
      this._spawn(0, p[0], p[1], p[2], -(0.2 + R()) * sp, (R() * 1.3 - 0.2) * sp, (R() - 0.5) * 1.8 * sp, 0.25 + R() * 0.6, 0.0014 + R() * 0.0016, r * 6, g * 6, b * 6);
    }
  }

  /* ---- hull interiors ---- */

  _geo(b, decal) {
    const T = this.T, g = new T.BufferGeometry(), n = b.pos.length / 3, uv = decal ? b.uv : new Float32Array(n * 2);
    if (!decal) {
      for (let i = 0; i < n; i++) {
        const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2], ax = Math.abs(b.nrm[i * 3]), ay = Math.abs(b.nrm[i * 3 + 1]), az = Math.abs(b.nrm[i * 3 + 2]);
        if (ay >= ax && ay >= az) { uv[i * 2] = x * 2.3; uv[i * 2 + 1] = z * 2.3; } else if (ax >= az) { uv[i * 2] = z * 2.3; uv[i * 2 + 1] = y * 2.3; } else { uv[i * 2] = x * 2.3; uv[i * 2 + 1] = y * 2.3; }
      }
      g.setAttribute('color', new T.Float32BufferAttribute(b.col, 3));
    }
    g.setAttribute('position', new T.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setAttribute('mr', new T.Float32BufferAttribute(b.mr, 2));
    return g;
  }
  _glassGeo(C, struts) {
    const T = this.T, hi = this.q >= 1, nA = hi ? 46 : 26, nE = hi ? 15 : 9, R = rng(5);
    const P = [];
    for (let i = 0; i <= nA; i++) {
      P.push([]);
      for (let j = 0; j <= nE; j++) {
        const ja = i > 0 && i < nA ? (R() - 0.5) * 0.7 : 0, je = j > 0 && j < nE ? (R() - 0.5) * 0.7 : 0;
        const az = lerp(-C.az, C.az, (i + ja) / nA), e = lerp(sillAt(C, az) - 0.01, Math.min(topAt(C, az) + 0.02, 1.5), (j + je) / nE);
        P[i].push(canPt(C, az, e));
      }
    }
    const pos = [], nrm = [], cen = [], rnd = [], bary = [], edge = [];
    // how far a point of the glass is from the nearest piece of frame (0 at the frame … 1 mid-pane)
    const frameDist = (p) => {
      const [az, e] = canHit(C, C.c, vsub(p, C.c));
      let dmin = Math.min(e - sillAt(C, az), C.az - Math.abs(az));
      if (topAt(C, az) < 1.5) dmin = Math.min(dmin, topAt(C, az) - e);
      for (const [A] of struts) dmin = Math.min(dmin, Math.abs(Math.abs(az) - A * DEG) * Math.cos(e));
      return sat(dmin / 0.3);
    };
    // most of the canopy leaves in large plates (blocks of cells sharing one motion), the rest as splinters
    const blocks = new Map();
    const put = (a, b, c, bi, bj) => {
      let cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3, r0 = R(), r1 = R(), r2 = R();
      const key = bi + ',' + bj;
      let blk = blocks.get(key);
      if (!blk) { const pc = P[Math.min(nA, bi * 3 + 1)][Math.min(nE, bj * 3 + 1)]; blk = { big: R() < 0.72, c: pc, r: [R(), R(), R()] }; blocks.set(key, blk); }
      if (blk.big) { cx = blk.c[0]; cy = blk.c[1]; cz = blk.c[2]; r0 = blk.r[0]; r1 = blk.r[1]; r2 = blk.r[2]; }
      [a, b, c].forEach((p, k) => { const n = canNrm(C, p); pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); cen.push(cx, cy, cz); rnd.push(r0, r1, r2); edge.push(frameDist(p)); if (blk.big) bary.push(2, 2, 2); else bary.push(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0); });
    };
    for (let i = 0; i < nA; i++) for (let j = 0; j < nE; j++) {
      const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j + 1], d = P[i][j + 1], bi = (i / 3) | 0, bj = (j / 3) | 0;
      if ((i + j) % 2) { put(a, b, c, bi, bj); put(a, c, d, bi, bj); } else { put(a, b, d, bi, bj); put(b, c, d, bi, bj); }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    g.setAttribute('cen', new T.Float32BufferAttribute(cen, 3)); g.setAttribute('rnd', new T.Float32BufferAttribute(rnd, 3)); g.setAttribute('bary', new T.Float32BufferAttribute(bary, 3)); g.setAttribute('edge', new T.Float32BufferAttribute(edge, 1));
    return g;
  }

  _build(key) {
    const T = this.T, H0 = HULLS[key], C = resolveCanopy(H0.can);
    C.facet = !!H0.can.facet;
    const H = { ...H0, C }, b = new Build(this.q);
    const out = buildInterior(b, H), st = b.buf('st');
    bakeAO(st, { bounds: [-0.45, 1.35, -0.85, 0.82, -0.72, 0.72], vox: this.q >= 1 ? 0.012 : 0.02, to: st.pos.length });
    buildNose(b, H, out);
    const group = new T.Group(), meshes = {};
    let tris = 0;
    const add = (geo, mat, order = 0) => { const m = new T.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = order; group.add(m); tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3; return m; };
    for (const [name, buf] of b.parts) meshes[name] = add(this._geo(buf), name === 'st' ? this.mStruct : this.mPart);
    add(this._geo(b.decal, true), this.mDecal);
    const gg = new T.BufferGeometry();
    gg.setAttribute('position', new T.Float32BufferAttribute(b.glow.pos, 3)); gg.setAttribute('gcol', new T.Float32BufferAttribute(b.glow.col, 3)); gg.setAttribute('ch', new T.Float32BufferAttribute(b.glow.ch, 1));
    add(gg, this.mGlow, 3);
    const sg = (s) => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(s.pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(s.uv, 2)); g.setAttribute('luv', new T.Float32BufferAttribute(s.luv, 2)); g.setAttribute('sid', new T.Float32BufferAttribute(s.sid, 1)); return g; };
    add(sg(b.scr.A), this.mScrA); add(sg(b.scr.B), this.mScrB);
    // the combiner (glass and frame) hangs in its own group so it can be torn off
    const hud = new T.Group(), hp = out.hudPiv, hg = sg(b.scr.H);
    hg.translate(-hp[0], -hp[1], -hp[2]);
    const hscr = add(hg, this.mHud, 4);
    group.remove(hscr); hud.add(hscr);
    if (meshes.hud) { group.remove(meshes.hud); hud.add(meshes.hud); }
    hud.position.fromArray(hp); group.add(hud);
    const glass = add(this._glassGeo(C, H0.can.struts), this.mGlass, 2);
    const V = (a) => new T.Vector3(a[0], a[1], a[2]);
    const digits = [];
    const controls = out.controls.map((c) => {
      const obj = meshes[c.part];
      obj.position.fromArray(c.piv);
      return {
        obj, type: c.type, piv: V(c.piv), axis: c.axis ? V(c.axis) : null,
        grips: c.grips.map((g) => {
          const arm = meshes[g.part];
          arm.position.fromArray(g.G);
          for (const dg of g.digits || []) { const m = meshes[dg.part]; group.remove(m); arm.add(m); m.position.fromArray(dg.piv); digits.push({ obj: m, axis: V(vnorm(dg.axis)), kind: dg.kind, sg: dg.sg }); }
          return { obj: arm, at: V(g.at), elbow: V(g.elbow), rest: V(vnorm(vsub(g.elbow, g.G))), sgn: g.G[2] < -0.02 ? -1 : 1, from: new T.Vector3() };
        }),
      };
    });
    if (meshes.dangle) meshes.dangle.position.fromArray(out.dangle);
    return { key, group, glass, controls, digits, hud, hudPiv: V(hp), dangle: meshes.dangle || null, guns: meshes.guns, C, H, ui: H0.ui, emitPts: out.emitPts.concat(out.emitTop ? [out.emitTop] : []), muzzles: out.muzzles, tris: Math.round(tris), draws: group.children.length + digits.length + hud.children.length + 2 };
  }

  // build (cached) the interior for a hull and show it; cheap if unchanged
  setShip(id) {
    const key = HULLS[id] ? (HULL_KEY[id] || id) : (HULL_KEY[id] || 'vanguard');
    if (this.cur && this.cur.key === key) return;
    let ship = this.ships.get(key);
    if (!ship) { ship = this._build(key); this.ships.set(key, ship); }
    if (this.cur) this.root.remove(this.cur.group);
    this.root.add(ship.group);
    this.cur = ship; this.curId = id;
    const C = ship.C, ck = this.U.ck;
    ck.uCkC.value.fromArray(C.c); ck.uCkR.value.fromArray(C.r);
    ck.uCkWin.value.set(C.sill0, C.sill1 - C.sill0, C.top0, C.top1 - C.top0);
    ck.uCkAz.value = C.az;
    const st = ship.H.can.struts;
    for (let i = 0; i < 6; i++) { if (i < st.length) ck.uCkStrut.value[i].set(st[i][0] * DEG, st[i][1] * 0.5 / 0.62); else ck.uCkStrut.value[i].set(0, 0); }
    const m = lin(ship.ui.main);
    this._cTheme.set(m[0], m[1], m[2]);
    this.A.dirtyA = this.A.dirtyB = true;
  }
  info() { const s = this.cur; return s ? { id: s.key, tris: s.tris + 2 * this.P.n + 1 + this.shield.geometry.index.count / 3, draws: s.draws } : null; }

  /* ---- per frame ---- */

  // The cockpit keeps its own apparent size whatever the world camera's fov is
  // (zoom), shrinks and drops on narrow screens so the dash never covers the view.
  _layout() {
    const cam = this.camera, f = cam.fov, a = cam.aspect;
    if (f === this._lf && a === this._la) return;
    this._lf = f; this._la = a;
    const th = Math.tan((f * DEG) / 2), ref = Math.tan(30 * DEG);
    // a little, not a lot: a wider cockpit angle would also drag the roof down into the frame
    const zh = clamp((a * ref) / Math.tan(21 * DEG), 0.86, 1);
    cam.zoom = (th / ref) * zh;
    const ny = 0.448 - (1 - zh) * 0.28;
    this.basePitch = -(Math.atan((ny * ref) / zh) - 14.5 * DEG);
    cam.updateProjectionMatrix();
    this.U.uAspect.value = a;
    this.portrait = a < 1;
    this.A.dirtyA = this.A.dirtyB = true;
  }

  update(dtMs, tMs, s) {
    s = s || EMPTY;
    if (!this.cur) this.setShip('vanguard');
    let dt = clamp(dtMs || 0, 0, 50) / 1000;
    const t = (tMs || 0) / 1000, A = this.A, U = this.U, ship = this.cur, R = this.rand;
    this.t = t;
    this._layout();
    const steer = clamp(s.steer ?? 0, -1, 1), thr = clamp(s.throttle ?? 0, -1, 1), bank = s.bank ?? 0, boost = s.boost ? 1 : 0, warp = sat(s.warp ?? 0);
    const ion = sat(s.ion ?? 0), hp = s.hp ?? 3, hpMax = Math.max(1, s.hpMax ?? 3), dead = !!s.dead;
    const d = dead ? 1 : hpMax > 1 ? sat(1 - (hp - 1) / (hpMax - 1)) : hp <= 1 ? 1 : 0, crit = hp <= 1;
    // the death sequence runs on its own clock: the game slows the sim down around it
    if (dead && dt > 0) dt = Math.max(dt, 1 / 60);
    if (dead) {
      if (A.deadT < 0) { A.deadT = 0; this._deathStart(); }
      A.deadT = s.deadMs !== undefined ? Math.max(A.deadT, s.deadMs / 1000) : A.deadT + dt;
    } else if (A.deadT >= 0) this._deathClear();
    const td = A.deadT, sd = A.dSide;
    const ex = (k) => 1 - Math.exp(-dt * k);

    /* controls */
    A.stickX += (steer - A.stickX) * ex(14); A.stickY += (thr - A.stickY) * ex(14);
    A.thr += ((boost ? 1 : thr * 0.7) - A.thr) * ex(9); A.boost += (boost - A.boost) * ex(5);
    A.steerLag += (steer - A.steerLag) * ex(3); A.thrLag += (thr - A.thrLag) * ex(2.5);
    if (dead) A.thr += (-1 - A.thr) * ex(22);      // the throttle slams back
    A.open = dead ? smooth(0.03, 0.22, td) : 0;
    for (const c of ship.controls) {
      const o = c.obj;
      if (c.type === 'stick') {
        if (dead) { const k = smooth(0, 0.25, td), w = Math.sin(td * 17) * Math.exp(-td * 3.5) * 0.2; o.rotation.set(lerp(A.stickX * 0.24, -sd * 0.45, k) + w, 0, lerp(-A.stickY * 0.15, 0.3, k) + w * 0.6); }      // flops free
        else o.rotation.set(A.stickX * 0.24, 0, -A.stickY * 0.15);
      } else if (c.type === 'throttle') o.position.set(c.piv.x + A.thr * 0.045, c.piv.y, c.piv.z);
      else { o.quaternion.setFromAxisAngle(c.axis, dead ? sd * 0.7 * smooth(0, 0.3, td) : -A.stickX * 0.6); o.position.copy(c.piv).addScaledVector(c.axis, dead ? -0.03 * smooth(0, 0.2, td) : -A.stickY * 0.022); }
      for (const g of c.grips) {
        if (dead) {
          // thrown off the controls: flung up in front of the visor, then limp, drifting toward the breach
          const k1 = smooth(0.02, 0.24, td), k2 = smooth(0.6, 1.1, td), u = smooth(0.7, 2.2, td), z = g.sgn, bl = z * sd > 0 ? 1 : 0.55;
          const p = this._v.set(0.37, -0.09 + 0.04 * bl, z * 0.13 - sd * 0.05 * bl);
          p.lerpVectors(g.from, p, k1);
          this._v2.set(0.45 + 0.07 * u, -0.04 + 0.09 * u + 0.012 * Math.sin(td * 2.3 + z), z * (0.21 + 0.03 * Math.sin(td * 1.7 + z * 2)));
          p.lerp(this._v2, k2);
          g.obj.position.copy(p);
          const e = this._v2.copy(g.elbow);
          this._v3.set(0.1, -0.4, z * 0.3); e.lerp(this._v3, k1);
          this._v3.set(0.15 + 0.05 * u, -0.34 + 0.05 * u, z * 0.36); e.lerp(this._v3, k2);
          e.sub(p).normalize();
          g.obj.quaternion.setFromUnitVectors(g.rest, e);
          continue;
        }
        const p = this._v.copy(g.at).applyQuaternion(o.quaternion).add(o.position);
        g.obj.position.copy(p);
        this._v2.copy(g.elbow).sub(p).normalize();
        this._q.setFromUnitVectors(g.rest, this._v2);
        g.obj.quaternion.copy(this._ident).slerp(o.quaternion, 0.75).premultiply(this._q);
      }
    }

    /* guns */
    if (s.fireStamp !== undefined && s.fireStamp !== A.fireStamp) {
      if (A.fireStamp !== null) {
        A.recoil = 1; A.trig = 1;
        A.gunSide = -A.gunSide;
        const both = (s.fireTier ?? 1) >= 2 ? 1 : 0.4;      // both barrels flash, the lead alternates
        A.muzL = Math.max(A.muzL, A.gunSide < 0 ? 1 : both); A.muzR = Math.max(A.muzR, A.gunSide < 0 ? both : 1);
      }
      A.fireStamp = s.fireStamp;
    }
    if (s.rocketStamp !== undefined && s.rocketStamp !== A.rocketStamp) {
      if (A.rocketStamp !== null) { A.vel[4] += 0.22; A.vel[0] -= 0.12; A.muzL = Math.max(A.muzL, 0.6); A.muzR = Math.max(A.muzR, 0.6); A.thumb = 1; }
      A.rocketStamp = s.rocketStamp;
    }
    A.recoil *= Math.exp(-dt * 15); A.muzL *= Math.exp(-dt * 42); A.muzR *= Math.exp(-dt * 42);
    if (ship.guns) ship.guns.position.x = -A.recoil * 0.075;
    // the trigger finger squeezes with every shot, the thumb reaches for the rocket button
    A.trig *= Math.exp(-dt * 16); A.thumb *= Math.exp(-dt * 3.5);
    for (const dg of ship.digits) {
      const k = dg.kind, o = A.open;
      const a = k === 'trigger' ? 0.1 + Math.min(1, A.trig * 1.6) * 0.3 + (s.firing ? 0.06 : 0) - o * 1.6 : k === 'fingers' ? -o * 1.5 : (k === 'thumb' ? -Math.min(1, A.thumb * 1.8) * 0.5 : 0) + o * 0.85;
      dg.obj.quaternion.setFromAxisAngle(dg.axis, a * dg.sg);
    }
    const laser = sat(s.laser ?? 0), lz = laser * (0.3 + 0.12 * wob(t, 61, 0));
    this.lMuz.intensity = Math.max(A.muzL, A.muzR) * 2.2 + laser * 1.2;
    this.lMuz.color.setRGB(1 - laser * 0.6, 0.75, 0.4 + laser * 0.6);

    /* damage state */
    A.hitGlitch *= Math.exp(-dt * 3.2);
    if (!dead) A.haze += ((crit ? 0.06 : 0) - A.haze) * ex(0.9);
    A.emerg += ((crit ? 1 : 0) - A.emerg) * ex(3);      // red lighting belongs to the last life only
    if (dead) {
      A.power = td < 0.2 ? (hash1(Math.floor(t * 30)) < 0.5 ? 0.9 : 0.1) : 0;
      if (dt > 0) this._death(dt, t, td);
    } else A.power = 1;
    U.uShat.value = Math.max(0, td - 0.55);
    ship.glass.visible = td < 2.3;
    A.haze += ((dead ? (td < 0.55 ? 0.3 * smooth(0.1, 0.45, td) : td < 0.72 ? 0.26 : 0.02) : A.haze) - A.haze) * ex(10);
    // arcing from a damaged panel now and then
    if (d > 0.3 && !dead && dt > 0) {
      A.sparkIn -= dt;
      if (A.sparkIn <= 0) {
        A.sparkIn = lerp(5.5, 1.4, d) * (0.6 + R() * 0.8);
        const p = ship.emitPts[(R() * ship.emitPts.length) | 0];
        this._sparks(p, 5 + ((R() * 8) | 0), 0.3, 0.7, 0.85, 1);
        this._flashAt(p, 0.7, 0.6, 0.8, 1);
        A.hitGlitch = Math.max(A.hitGlitch, 0.5);
        if (crit) this._spawn(1, p[0], p[1], p[2], -0.05, 0.12, (R() - 0.5) * 0.1, 2.2, 0.05, 1, 1, 1);
      }
    }
    // smoke wisps from behind the panels when it is bad
    if (crit && !dead && dt > 0 && R() < dt * 1.3) {
      const p = ship.emitPts[(R() * ship.emitPts.length) | 0];
      this._spawn(1, p[0] - 0.02, p[1], p[2], -0.04 - R() * 0.05, 0.1 + R() * 0.08, (R() - 0.5) * 0.08, 2.5 + R(), 0.035 + R() * 0.03, 1, 1, 1);
    }

    /* fly-bys, head look, frost, soot */
    const fb = s.flyby || null, fbS = fb ? sat(fb.size ?? 0.5) : 0, fbE = fb ? Math.sin(Math.PI * sat(fb.t ?? 0)) : 0, fbSide = fb ? clamp(fb.side ?? 0, -1, 1) : 0;
    if (fb) {
      const over = fb.above || Math.abs(fbSide) < 0.1;
      U.uFly.value.set(over ? 0 : fbSide * (1.5 - 3 * sat(fb.t ?? 0)), over ? 2 : 0.4 + 0.5 * fbS, (0.5 + 0.42 * fbS) * Math.min(1, fbE * 2.5));
      if ((fb.t ?? 0) >= 0.42 && !A.flyDone) {      // the wake hits as it passes
        A.flyDone = true;
        A.vel[2] -= fbSide * 0.4 * fbS; A.vel[1] += (fb.above ? -0.3 : 0.15) * fbS; A.vel[3] += (fbSide || 0.4) * 0.6 * fbS; A.dangV += (fbSide || 1) * 5 * fbS;
        if (fbS > 0.7) A.hitGlitch = Math.max(A.hitGlitch, 0.85);
      }
      if ((fb.t ?? 0) < 0.2) A.flyDone = false;
    } else { U.uFly.value.z = 0; A.flyDone = false; }
    const lk = s.look;
    A.lookY += ((lk ? lk.yaw || 0 : 0) - A.lookY) * ex(12); A.lookP += ((lk ? lk.pitch || 0 : 0) - A.lookP) * ex(12);
    if (warp > 0.5) A.warpArm = true;
    else if (A.warpArm && warp < 0.04) { A.warpArm = false; A.frost = 1; }
    A.frost = Math.max(0, A.frost - dt / 4.2);
    U.uFrost.value = dead ? 0 : A.frost < 0.85 ? A.frost / 0.85 : (1 - A.frost) / 0.15;      // creeps in fast, melts over four seconds
    A.soot += ((crit && !dead ? 1 : 0) - A.soot) * ex(crit ? 0.35 : 1.5);
    U.uSoot.value = A.soot;
    // the pendant: a damped pendulum driven by the cabin's own lurches
    A.dangV += (-38 * A.dang - 1.3 * A.dangV - A.vel[2] * 260 - steer * 2.2 + (A.steerLag) * 2.2) * dt; A.dang = clamp(A.dang + A.dangV * dt, -1.2, 1.2);
    A.dang2V += (-38 * A.dang2 - 1.3 * A.dang2V - A.vel[0] * 260 + A.boost * 6) * dt; A.dang2 = clamp(A.dang2 + A.dang2V * dt, -1, 1);
    if (ship.dangle) ship.dangle.rotation.set(A.dang + (dead ? smooth(0.55, 0.9, td) * 0.4 : 0), 0, A.dang2 - (dead ? smooth(0.55, 0.9, td) * 1.3 : 0));

    /* head inertia, vibration, jolts */
    A.tgt[0] = (thr - A.thrLag) * 0.014 + A.boost * 0.022;
    A.tgt[2] = (steer - A.steerLag) * 0.024;
    A.tgt[3] = -steer * 0.022 - bank * 0.08;
    A.tgt[4] = (thr - A.thrLag) * 0.006 - A.boost * 0.007;
    for (let i = 0; i < 5; i++) { A.vel[i] += (-95 * (A.pos[i] - A.tgt[i]) - 13 * A.vel[i]) * dt; A.pos[i] += A.vel[i] * dt; }
    const amp = 0.00035 + A.boost * 0.0013 + warp * 0.0028 + sat(s.shake ?? 0) * 0.007 + fbS * fbE * 0.0045 + (dead ? (td < 0.7 ? 0.007 : 0.0015) : 0);
    // the wreck starts to tumble: the cockpit rolls against the horizon outside
    const tum = dead ? Math.pow(sat((td - 0.4) / 1.8), 1.5) : 0;
    // turning the head moves the eyes a few centimetres: the cabin slides the other way
    this.root.position.set(A.pos[0] + amp * 0.5 * wob(t, 43, 3.3) + Math.abs(A.lookY) * 0.03, A.pos[1] + amp * wob(t, 47, 0) - A.lookP * 0.1, A.pos[2] + amp * wob(t, 53, 2.1) - A.lookY * 0.13);
    this.root.rotation.set(A.pos[3] + amp * 1.4 * wob(t, 41, 5.2) + tum * sd * 0.5, tum * sd * 0.1, this.basePitch + A.pos[4] + amp * 0.8 * wob(t, 37, 1.1) - tum * 0.13);
    this.root.updateMatrix();
    U.ck.uRootInv.value.copy(this.root.matrix).invert();

    /* lighting */
    const sunDir = s.sunDir || this._sunDef, sunC = s.sunColor || this._sunColDef, amb = s.ambient || this._ambDef, pw = A.power;
    this.sun.position.copy(sunDir); this.sun.color.copy(sunC); this.sun.intensity = 7.5 * (dead ? 1 - 0.5 * smooth(0.6, 1.4, td) : 1);
    U.ck.uSunL.value.copy(sunDir).transformDirection(U.ck.uRootInv.value);
    this.hemi.color.copy(amb); this.hemi.groundColor.copy(amb).multiplyScalar(0.35); this.hemi.intensity = 2.0 * (dead ? 1 - 0.75 * smooth(0.5, 1.3, td) : 1) * (1 - 0.6 * fbS * fbE);
    const pulse = 0.55 + 0.45 * Math.sin(t * 5.5), em = A.emerg, th = this._cTheme, wsh = warp * 0.7;
    this.lCabin.color.setRGB(lerp(lerp(th.x, 0.3, wsh), 1, em), lerp(lerp(th.y, 0.6, wsh), 0.04, em), lerp(lerp(th.z, 1.4, wsh), 0.03, em));
    this.lCabin.intensity = (dead ? Math.max(pw, em * 0.35 * Math.max(0, 1 - A.deadT)) : 1) * (0.5 + em * 0.3 * pulse + warp * 0.4);
    A.flash *= Math.exp(-dt * 9);
    this.lFlash.intensity = A.flash * 2.2; this.lFlash.color.setRGB(this.flashCol.x, this.flashCol.y, this.flashCol.z);
    const ext = s.extLight, ei = ext ? ext.i || 0 : 0;
    if (ext) { this.lExt.position.set(0.9, 0.35, (ext.side || 0) * 1.5); this.lExt.color.setRGB(ext.r, ext.g, ext.b); }
    this.lExt.intensity = ei * 2.4;
    if (ext) U.uExtD.value.set(0.62, 0.2, (ext.side || 0) * 0.76).normalize();
    if (ei > 0.55 && A.extPrev <= 0.55 && dt > 0) {      // blast debris ticking off the canopy
      const sd = ext.side || 0;
      for (let i = 0; i < (this.q >= 1 ? 7 : 3); i++) this._spawn(4, 1.25, -0.1 + R() * 0.5, sd * 0.35 + (R() - 0.5) * 0.6, -(7 + R() * 6), 0.5 + R() * 2, (R() - 0.5) * 3 - sd, 0.16 + R() * 0.14, 0.003 + R() * 0.003, 3 + ext.r * 3, 2 + ext.g * 2, 1 + ext.b);
    }
    A.extPrev = ei;
    const fire = dead ? smooth(0.08, 0.22, td) * (1 - 0.72 * smooth(0.55, 1.3, td)) * (1 - 0.6 * smooth(1.4, 2.2, td)) * (0.75 + 0.25 * wob(t, 19, 1.7)) : crit ? 0.75 + 0.25 * wob(t, 17, 1.7) : 0;
    this.lFire.intensity = fire * (dead ? 2.6 : 0.9); this.lFire.color.setRGB(1, 0.36, 0.06);
    if (dead) this.lFire.position.set(0.3, -0.26, sd * 0.42); else this.lFire.position.set(-0.2, -0.3, 0.25);
    if (this.scene.environment) this.scene.environmentIntensity = (1 - 0.55 * fbS * fbE) * 0.6 * Math.min(1.6, (amb.r + amb.g + amb.b) * 1.3);

    /* uniforms */
    U.uTime.value = t;
    const burst = d > 0.4 && hash1(Math.floor(t * 1.7) + 11) < (crit ? 0.4 : 0.12) ? 1 : 0;
    U.uGlitch.value = dead ? (td < 0.24 ? 1 : 0) : Math.max(A.hitGlitch, ion * 0.85, burst * 0.55);
    U.uWashAmt.value = wsh;
    const flick = A.hitGlitch > 0.25 && hash1(Math.floor(t * 40)) < A.hitGlitch * 0.6 ? 0.2 : 1;
    const scr = U.uScr.value, alarm = dead ? td < 0.12 : crit;
    scr[SID.TAC] = pw * Math.max(flick, 0.65) * (burst ? 0.85 : 1);
    scr[SID.GAUGE] = pw * (crit && hash1(Math.floor(t * 11) + 5) < 0.3 ? 0.25 : 1);
    scr[SID.MFD_L] = pw * flick * (crit && hash1(Math.floor(t * 13) + 3) < 0.25 ? 0.2 : 1);
    scr[SID.MFD_R] = pw * flick * (crit ? (hash1(Math.floor(t * 9) + 7) < 0.6 ? 0.05 : 0.7) : 1);
    scr[SID.LAMP0] = pw * (crit ? (Math.sin(t * 15) > 0 ? 1.25 : 0.3) : 1);      // amber and steady until the last life
    scr[SID.LAMP0 + 1] = pw * (Math.sin(t * 24) > 0 ? 1.25 : 0.35);
    scr[SID.LAMP0 + 2] = pw * (Math.sin(t * 19) > 0 ? 1.25 : 0.3);
    scr[SID.LAMP0 + 3] = pw * (0.8 + 0.4 * hash1(Math.floor(t * 20)));
    scr[SID.LAMP0 + 4] = pw; scr[SID.LAMP0 + 5] = pw * (0.9 + 0.25 * Math.sin(t * 9));
    scr[SID.HUD] = pw * flick * (ion > 0.3 && hash1(Math.floor(t * 17)) < 0.4 ? 0.3 : 1);
    if (dead) for (let i = 0; i < 11; i++) scr[i] = td < 0.05 + ((i * 7) % 5) * 0.035 ? (hash1(Math.floor(t * 45) + i * 3) < 0.45 ? 0.15 : 1.1) : A.deadPaint && i < 10 ? 0.1 + fire * 0.75 : 0;      // glitch, die one after another, then just dead glass in the firelight
    const ch = U.uCh.value;
    ch[CH.STATIC] = pw; ch[CH.ALARM] = alarm ? (Math.sin(t * 13) > 0 ? 1 : 0.04) : 0;
    ch[CH.MUZ_L] = A.muzL + lz; ch[CH.MUZ_R] = A.muzR + lz;
    ch[CH.BLINK_A] = pw * (Math.sin(t * 3.1) > 0 ? 1 : 0.1); ch[CH.BLINK_B] = pw * (Math.sin(t * 4.7) > 0 ? 1 : 0.1);
    ch[CH.EMERG] = em * (0.55 + 0.45 * pulse) * (dead ? Math.max(0, 1 - A.deadT * 0.5) : 1);
    ch[CH.HUDGLASS] = dead && td > 0.16 ? 0 : pw; ch[CH.ACCENT] = pw * (1 - em * 0.75);
    U.uSunC.value.set(sunC.r, sunC.g, sunC.b);
    U.uAmb.value.set(amb.r, amb.g, amb.b);
    const fl = A.flash * 0.12;
    U.uExtC.value.set((ext ? ext.r * ei : 0) * 0.22 + this.flashCol.x * fl, (ext ? ext.g * ei : 0) * 0.22 + this.flashCol.y * fl, (ext ? ext.b * ei : 0) * 0.22 + this.flashCol.z * fl);
    U.uGlow.value.set(lerp(th.x * 0.35, 0.9, em * pulse) * pw, lerp(th.y * 0.35, 0.03, em) * pw, lerp(th.z * 0.35, 0.02, em) * pw);
    U.uCab.value = pw * (1 + em * 0.4) + A.flash * 0.6 + fire * (dead ? 1.5 : 0.5); U.uMuz.value = Math.max(A.muzL, A.muzR);
    U.uWarp.value = warp; U.uFire.value = fire * (dead ? 0.3 : 0.12);
    U.uHaze.value = A.haze; U.uVig.value = em * 0.16 + warp * 0.15 + (dead ? 0.3 * smooth(0.9, 2.0, td) : 0);
    U.uBlack.value = dead ? smooth(1.85, 2.2, td) : 0;
    U.uBuckle.value.set(dead ? smooth(0.1, 0.36, td) : 0, sd);
    U.uFlashSide.value = dead ? sd : 0;
    U.uRed.value = em * pulse * 0.13 * (dead ? Math.max(0, 1 - A.deadT) : 1);
    this.ovFlash.multiplyScalar(Math.exp(-dt * 8));
    if (dead) { if (td < 0.08) this.ovFlash.set(0.5, 0.4, 0.26); else { const o = this.ovFlash; o.set(Math.min(o.x, 0.12), Math.min(o.y, 0.075), Math.min(o.z, 0.035)); } }      // one hard flash, never a white-out
    U.uFlash.value.copy(this.ovFlash);
    const vap = dead && td > 0.5 && td < 0.85 ? 0.09 : 0, fh = dead ? 0.12 : 0.03;      // fire-lit smoke, then a white burst of vapour
    U.uHazeCol.value.set(0.05 + amb.r * 0.25 + em * pulse * 0.04 + fire * fh + vap, 0.05 + amb.g * 0.25 + fire * fh * 0.3 + vap, 0.055 + amb.b * 0.25 + vap);
    // shield dome and impact ripples
    A.shieldOn += ((s.shield && !dead ? 1 : 0) - A.shieldOn) * ex(6);
    U.uOn.value = A.shieldOn;
    let rip = false;
    for (const r of U.uRip.value) if (r.w >= 0) { r.w += dt; if (r.w > 0.7) r.w = -1; else rip = true; }
    this.shield.visible = A.shieldOn > 0.01 || rip;

    this._fxUpdate(dt, t, dead, dead && td >= 0.55, sunC);
    this._instruments(t, tMs || 0, s, d, crit, ion);
  }

  _flashAt(p, k, r, g, b) {
    if (k >= this.A.flash) { this.A.flash = k; this.lFlash.position.set(p[0] - 0.05, p[1] + 0.03, p[2]); this.flashCol.set(r, g, b); }
  }

  _fxUpdate(dt, t, dead, breach, sunC) {
    const P = this.P, pos = this.fxPos.array, vel = this.fxVel.array, par = this.fxPar.array, col = this.fxCol.array, U = this.U;
    const hz = U.uHazeCol.value, suck = breach ? 1 : 0;
    for (let i = 0; i < P.n; i++) {
      let size = 0, st = 0, al = 0, bl = 0, r = 0, g = 0, b = 0;
      if (P.life[i] > 0) {
        const k = P.kind[i];
        if (k === 3) {      // dust drifting in the sunlight
          P.x[i] += (P.vx[i] + suck * 2) * dt; P.y[i] += (P.vy[i] + Math.sin(t * 0.7 + P.seed[i]) * 0.004) * dt; P.z[i] += P.vz[i] * dt;
          if (!dead) { if (P.x[i] < 0.22) P.x[i] += 0.6; if (P.x[i] > 0.84) P.x[i] -= 0.6; if (P.y[i] > 0.28) P.y[i] -= 0.44; if (P.y[i] < -0.16) P.y[i] += 0.44; if (P.z[i] > 0.42) P.z[i] -= 0.84; if (P.z[i] < -0.42) P.z[i] += 0.84; }
          const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + P.seed[i] * 3);
          size = P.size[i]; r = sunC.r * 0.5 * tw; g = sunC.g * 0.5 * tw; b = sunC.b * 0.5 * tw;
        } else {
          P.life[i] -= dt;
          const f = Math.max(0, P.life[i] / P.max[i]);
          if (k === 0 || k === 4) {
            if (k === 0) { P.vy[i] -= 4.5 * dt; const dr = Math.exp(-dt * 1.4); P.vx[i] *= dr; P.vy[i] *= dr; P.vz[i] *= dr; P.vx[i] += suck * 14 * dt; }
            size = P.size[i]; st = k === 4 ? 0.016 : 0.011; r = P.r[i] * f; g = P.g[i] * f * f; b = P.b[i] * f * f * f;
          } else if (k === 1) {
            P.vx[i] += suck * 12 * dt; P.vy[i] *= Math.exp(-dt * 0.4);
            size = P.size[i] * (1 + (1 - f) * 2.4); al = Math.sin(Math.PI * Math.min(1, (1 - f) * 1.15)) * 0.2; bl = 1; r = hz.x * 2.2 * P.r[i]; g = hz.y * 2.2 * P.g[i]; b = hz.z * 2.2 * P.b[i];
          } else if (k === 5) {      // fire: bright core cooling to sooty red as it rolls
            P.vy[i] += 0.9 * dt; P.vx[i] += suck * 11 * dt; const dr = Math.exp(-dt * 1.6); P.vy[i] *= dr; P.vz[i] *= dr;
            size = P.size[i] * (0.55 + (1 - f) * 1.5); al = 0.5 * f; bl = 0.45;
            r = 0.45 + 0.75 * f; g = 0.08 + 0.42 * f * f; b = 0.02 + 0.12 * f * f * f;
          } else if (k === 6) {      // embers
            P.vy[i] += 0.12 * dt; P.vx[i] += suck * 1.2 * dt; P.vz[i] += Math.sin(t * 5 + P.seed[i] * 9) * 0.3 * dt;
            const tw = 0.5 + 0.5 * Math.sin(t * 17 + P.seed[i] * 11);
            size = P.size[i]; st = 0.004; r = 2.2 * f * tw; g = 0.7 * f * tw; b = 0.12 * f * tw;
          } else {      // canopy fragments
            P.vx[i] += 13 * dt; P.vy[i] -= 1.2 * dt;
            const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 23 + P.seed[i] * 7));
            size = P.size[i]; st = 0.006; r = (0.25 + sunC.r) * tw * f; g = (0.3 + sunC.g) * tw * f; b = (0.35 + sunC.b) * tw * f;
          }
          P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
        }
      }
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 3, o4 = (i * 4 + c) * 4;
        pos[o] = P.x[i]; pos[o + 1] = P.y[i]; pos[o + 2] = P.z[i];
        vel[o] = P.vx[i]; vel[o + 1] = P.vy[i]; vel[o + 2] = P.vz[i];
        par[o4] = size; par[o4 + 1] = st; par[o4 + 2] = al; par[o4 + 3] = bl;
        col[o] = r; col[o + 1] = g; col[o + 2] = b;
      }
    }
    this.fxPos.needsUpdate = this.fxVel.needsUpdate = this.fxPar.needsUpdate = this.fxCol.needsUpdate = true;
  }

  // repaint the instrument canvases: tactical at ~15 Hz, status only on change
  _instruments(t, tMs, s, d, crit, ion) {
    const A = this.A, th = this.cur.ui;
    if (A.deadPaint) return;
    if (A.dirtyA || Math.abs(tMs - A.lastA) >= 66) {
      A.lastA = tMs; A.dirtyA = false;
      const c = this.cxA;
      paintTactical(c, s, th, t, ion, this.portrait);
      A.gv[0] = sat(s.speed ?? 0); A.gv[1] = sat(Math.abs(A.thr)); A.gv[2] = sat(Math.max(s.overdrive ?? 0, A.boost)); A.gv[3] = sat(0.25 + A.boost * 0.35 + d * 0.45 + (s.warp ?? 0) * 0.3);
      paintGauges(c, th, A.gv, this.cur.H.dash.gauge);
      A.hud.spd = sat(s.speed ?? 0); A.hud.thr = sat(0.5 + A.thr * 0.5); A.hud.bank = (s.bank ?? 0) + A.stickX * 0.2;
      paintHud(c, s, th, t, A.hud);
      this.tA.needsUpdate = true;
    }
    const hp = s.hp ?? 3, hpMax = s.hpMax ?? 3, L = A.lamps;
    const l0 = hp <= 1 || (hp < hpMax && hp <= 2) || hp / hpMax <= 0.5, l1 = crit, l2 = !!s.warning || (s.bossHp ?? -1) >= 0, l3 = ion > 0.1, l4 = !!s.shield, l5 = !!s.overdriveOn || (s.overdrive ?? 0) >= 1;
    const bits = (l0 ? 1 : 0) | (l1 ? 2 : 0) | (l2 ? 4 : 0) | (l3 ? 8 : 0) | (l4 ? 16 : 0) | (l5 ? 32 : 0);
    const s0 = hp + hpMax * 16 + (this.portrait ? 8388608 : 0) + (s.rockets ?? 0) * 256 + (s.lasers ?? 0) * 65536 + (s.fireTier ?? 1) * 1048576;
    const s1 = s.score | 0, s2 = (s.level ?? 1) + (s.combo ?? 0) * 128 + (s.mult ?? 1) * 1048576;
    const s3 = Math.round((s.laserCharge ?? 0) * 20) + Math.round((s.overdrive ?? 0) * 100) * 32 + (s.overdriveOn ? 8192 : 0) + bits * 16384;
    if (A.dirtyB || ((s0 !== A.sig[0] || s1 !== A.sig[1] || s2 !== A.sig[2] || s3 !== A.sig[3]) && Math.abs(tMs - A.lastB) >= 66)) {
      A.sig[0] = s0; A.sig[1] = s1; A.sig[2] = s2; A.sig[3] = s3; A.lastB = tMs; A.dirtyB = false;
      L[0] = l0; L[1] = l1; L[2] = l2; L[3] = l3; L[4] = l4; L[5] = l5;
      paintStatus(this.cxB, s, th, t, L);
      this.tB.needsUpdate = true;
    }
  }

  /* ---- events ---- */

  // side -1 port..+1 starboard, front -1 rear..+1 ahead, power 0..1
  hit(o = EMPTY) {
    if (!this.cur) return;
    const A = this.A, R = this.rand, ship = this.cur;
    const side = clamp(o.side ?? 0, -1, 1), front = clamp(o.front ?? 1, -1, 1), pw = clamp(o.power ?? 0.6, 0, 1);
    if (Math.abs(side) > 0.1) this.lastSide = side;
    this.lastFront = front;
    // jolt away from the impact
    A.vel[2] -= side * (0.22 + pw * 0.5); A.vel[0] -= front * (0.1 + pw * 0.28); A.vel[1] += (R() - 0.5) * 0.25 * pw;
    A.vel[3] += (side || R() - 0.5) * (0.35 + pw * 0.7); A.vel[4] += front * 0.2 * pw + (R() - 0.5) * 0.3 * pw;
    // where the blow shows on the canopy, as seen from the seat
    // a few candidate spots near the blow; take the one farthest from the fractures already there
    let az = 0, el = 0, far = -1;
    for (let k = 0; k < 6; k++) {
      let a = Math.abs(side) < 0.15 ? (R() - 0.5) * 70 : side * (16 + 30 * (1 - front) * 0.5) + (R() - 0.5) * 30;
      a = clamp(a, -54, 54);
      // keep the fight visible: dead ahead the glass only breaks above the horizon band
      const e = Math.abs(a) < 24 ? lerp(16, 27, R()) : lerp(-7, 25, R());
      let dmin = 99;
      for (let i = 0; i < this.cracks && i < 18; i++) dmin = Math.min(dmin, Math.hypot(a - this.crackAt[i * 2], e - this.crackAt[i * 2 + 1]));
      if (dmin > far) { far = dmin; az = a; el = e; }
      if (o.shielded || dmin > 16) break;
    }
    if (!o.shielded && this.cracks < 18) { this.crackAt[this.cracks * 2] = az; this.crackAt[this.cracks * 2 + 1] = el; }
    az *= DEG; el *= DEG;
    const dx = Math.cos(el) * Math.cos(az), dy = Math.sin(el), dz = Math.cos(el) * Math.sin(az);
    if (o.shielded) {
      const rp = this.U.uRip.value;
      let slot = rp[0];
      for (const r of rp) { if (r.w < 0) { slot = r; break; } if (r.w > slot.w) slot = r; }
      slot.set(dx, dy, dz, 0);
      this.ovFlash.set(0.008 + pw * 0.008, 0.02 + pw * 0.02, 0.05 + pw * 0.05);
      this._flashAt([0.8, 0.2, dz * 0.6], 0.5 + pw * 0.5, 0.3, 0.6, 1.4);
      return;
    }
    // a new fracture in the glass
    if (this.cracks < 18) {
      const u = az / CR_AZ + 0.5, v = (el - CR_E0) / CR_ER, c = this.cxC, sc = this.crW / 2048;
      c.save(); c.translate(u * this.crW, (1 - v) * this.crH); c.scale(1, 1.2);
      paintCrack(c, 0, 0, pw * (this.cracks > 5 ? 0.45 : 1), R, sc);
      c.restore();
      this.tCrack.needsUpdate = true;
      this.cracks++;
    }
    // sparks from the nearest panel, a flash, screens drop out for a moment
    let best = ship.emitPts[0], bd = 1e9;
    for (const p of ship.emitPts) { const dd = Math.abs(p[2] - side * 0.4) + R() * 0.25; if (dd < bd) { bd = dd; best = p; } }
    this._sparks(best, Math.round((10 + pw * 16) * (this.q >= 1 ? 1 : 0.5)), pw);
    this._flashAt(best, 0.9 + pw * 0.8, 1, 0.75, 0.4);
    this.ovFlash.set(0.05 + pw * 0.05, 0.032 + pw * 0.025, 0.014 + pw * 0.01);
    A.hitGlitch = 1;
    for (let i = 0; i < 2; i++) this._spawn(1, best[0], best[1], best[2], -0.06 - R() * 0.06, 0.1 + R() * 0.1, (R() - 0.5) * 0.12, 2 + R(), 0.04 + R() * 0.03, 1, 1, 1);
  }

  // the killing blow: jolt from the side it came from, a hard flash, everything loose lets go
  _deathStart() {
    const A = this.A, R = this.rand, ship = this.cur, sd = this.lastSide < 0 ? -1 : 1;
    A.dSide = sd; A.dCr = 0; A.dFlags = 0;
    A.vel[2] -= sd * 1.3; A.vel[3] += sd * 1.7; A.vel[0] -= this.lastFront * 0.5; A.vel[4] += 0.5; A.vel[1] += 0.3;
    this._flashAt([0.6, 0.05, sd * 0.55], 3.2, 1, 0.72, 0.4);
    for (const c of ship.controls) for (const g of c.grips) g.from.copy(g.obj.position);
    for (const p of ship.emitPts) this._sparks(p, 7, 0.9);
    // debris waits behind the panels for its moment
    let i = 0;
    for (const d of this.debris) {
      const p = ship.emitPts[i % ship.emitPts.length];
      d.at = d.kind === 'paper' ? 0.5 + R() * 0.15 : d.kind === 'cable' ? 0.12 : 0.1 + R() * 0.32;
      if (d.kind === 'cable') d.home.set(0.655, -0.2, (i % 2 ? 1 : -1) * (0.2 + R() * 0.12));
      else if (d.kind === 'paper') d.home.set(0.3 + R() * 0.2, -0.3, -sd * (0.25 + R() * 0.1));
      else d.home.set(p[0] - 0.01, p[1] + (R() - 0.5) * 0.08, p[2] + (R() - 0.5) * 0.1);
      d.mesh.position.copy(d.home); d.mesh.quaternion.set(0, 0, 0, 1); d.mesh.visible = false;
      d.vel.set(-(0.5 + R() * 1.6), 0.5 + R() * 1.8, -sd * (0.3 + R() * 1.6) + (R() - 0.5));
      d.axis.set(R() - 0.5, R() - 0.5, R() - 0.5).normalize(); d.spin = 4 + R() * 12;
      i++;
    }
    this.hudVel = this.hudVel || new this.T.Vector3();
    this.hudVel.set(-0.5, 1.5, -sd * 0.9);
  }

  // per frame while dead; td = seconds since the blow
  _death(dt, t, td) {
    const A = this.A, R = this.rand, ship = this.cur, sd = A.dSide, hi = this.q >= 1 ? 1 : 0.5;
    const fx = 0.36, fy = -0.3, fz = sd * 0.4, once = (bit) => { if (A.dFlags & bit) return false; A.dFlags |= bit; return true; };
    // fire bursting through the side console, sparks showering, smoke rolling across the view
    if (td > 0.08 && td < 0.62) {
      for (let n = R() < dt * 70 * hi ? 2 : 0; n > 0; n--) this._spawn(5, fx + (R() - 0.5) * 0.15, fy + R() * 0.08, fz + (R() - 0.5) * 0.08, -0.25 + R() * 0.5, 0.5 + R() * 0.9, -sd * (0.3 + R() * 1.0), 0.3 + R() * 0.4, 0.05 + R() * 0.06, 1, 1, 1);
      if (R() < dt * 26 * hi) this._spawn(1, fx + (R() - 0.5) * 0.2, fy + 0.05, fz * (0.4 + R() * 0.6), (R() - 0.5) * 0.3, 0.15 + R() * 0.25, -sd * (0.3 + R() * 0.5), 1 + R() * 0.6, 0.09 + R() * 0.07, 1, 1, 1);
      if (R() < dt * 34) this._sparks(ship.emitPts[(R() * ship.emitPts.length) | 0], 3, 0.9, 1, 0.7, 0.3);
    } else if (td >= 0.62) {
      if (R() < dt * 9 * hi) this._spawn(5, fx + (R() - 0.5) * 0.1, fy, fz + (R() - 0.5) * 0.06, 0.1, 0.3 + R() * 0.3, -sd * 0.1, 0.3 + R() * 0.3, 0.025 + R() * 0.02, 1, 1, 1);      // dying fire
      if (R() < dt * 11 * hi) this._spawn(6, fx + (R() - 0.5) * 0.3, fy + R() * 0.15, fz * R(), 0.1 + R() * 0.3, 0.05 + R() * 0.3, (R() - 0.5) * 0.4, 0.9 + R() * 0.9, 0.0012 + R() * 0.0012, 1, 1, 1);
    }
    if (td > 0.22 && once(8)) {      // every display is now a dark, cracked pane
      paintDeadGlass(this.cxA, [R_TAC, ...R_GAUGE], R_HUD, this.cur.H.dash.gauge, R);
      paintDeadGlass(this.cxB, [R_MFD_L, R_MFD_R, ...R_LAMP], null, '', R);
      this.tA.needsUpdate = this.tB.needsUpdate = true; A.deadPaint = true;
    }
    // the cracks race across the canopy, then it goes
    while (A.dCr < 7 && td > 0.3 + A.dCr * 0.033) {
      const c = this.cxC, sc = this.crW / 2048, az = (-42 + A.dCr * 14 + (R() - 0.5) * 8) * DEG, el = (3 + ((A.dCr * 5) % 3) * 9 + R() * 4) * DEG;
      c.save(); c.translate((az / CR_AZ + 0.5) * this.crW, (1 - (el - CR_E0) / CR_ER) * this.crH); c.scale(1.7, 2.0);
      paintCrack(c, 0, 0, 1, R, sc);
      c.restore(); this.tCrack.needsUpdate = true; A.dCr++;
    }
    if (td >= 0.55 && once(1)) {      // explosive decompression: glitter, a burst of vapour, everything heads for the breach
      const C = ship.C;
      for (let i = 0; i < 60 * hi; i++) {
        const az = (R() - 0.5) * 2 * 60 * DEG, p = canPt(C, az, lerp(sillAt(C, az), Math.min(topAt(C, az), 1.3), R()), 0.97);
        this._spawn(2, p[0], p[1], p[2], 1 + R() * 3, (R() - 0.3) * 2.5, (R() - 0.5) * 4, 0.6 + R() * 0.9, 0.002 + R() * 0.005, 1, 1, 1);
      }
      for (let i = 0; i < 16 * hi; i++) this._spawn(1, 0.35 + R() * 0.4, -0.2 + R() * 0.35, (R() - 0.5) * 0.8, 1 + R() * 2, 0.1, (R() - 0.5) * 0.5, 0.3 + R() * 0.25, 0.09 + R() * 0.07, 1.0, 1.05, 1.15);
      A.vel[0] += 0.7; A.vel[4] -= 0.6; A.vel[3] += sd * 0.8;
      this._flashAt([0.8, 0.2, 0], 1.2, 0.7, 0.8, 1);
    }
    // a last console arcing in the dark
    if ((td >= 1.35 && once(2)) || (td >= 1.78 && once(4))) { const p = ship.emitPts[td < 1.5 ? 1 : 2] || ship.emitPts[0]; this._sparks(p, 9, 0.4, 0.6, 0.8, 1); this._flashAt(p, 1.3, 0.5, 0.7, 1); }
    // panels, bezels and papers
    for (const d of this.debris) {
      if (td < d.at) continue;
      const m = d.mesh;
      m.visible = true;
      if (d.kind === 'cable') {      // a torn loom whipping about, then streaming toward the breach
        const w = Math.exp(-(td - d.at) * 1.6), out = smooth(0.55, 0.8, td);
        m.rotation.set(Math.sin(td * 23 + d.home.z * 9) * 0.9 * w, 0, Math.sin(td * 19 + 1) * 0.8 * w + out * (1.25 + 0.15 * Math.sin(td * 14)));
        continue;
      }
      const paper = d.kind === 'paper';
      if (td >= 0.55) { d.vel.x += (paper ? 16 : 9) * dt; d.vel.y += (0.25 - m.position.y) * 4 * dt; d.vel.z -= m.position.z * 3 * dt; }
      else { d.vel.y -= 2.5 * dt; d.vel.multiplyScalar(Math.exp(-dt * (paper ? 3 : 1.2))); }
      if (paper) { d.vel.y += Math.sin(td * 21 + d.spin) * 2 * dt; d.vel.z += Math.cos(td * 17 + d.spin) * 2 * dt; }
      m.position.addScaledVector(d.vel, dt);
      m.rotateOnAxis(d.axis, d.spin * dt);
      if (m.position.x > 5) m.visible = false;
    }
    // the HUD combiner snaps off its mounts
    if (td > 0.16) {
      const h = ship.hud;
      if (td >= 0.55) this.hudVel.x += 10 * dt; else this.hudVel.y -= 3 * dt;
      h.position.addScaledVector(this.hudVel, dt);
      h.rotation.x += sd * 5 * dt; h.rotation.z += 7 * dt;
      if (h.position.x > 5) h.visible = false;
    }
  }

  // back to a living cockpit (respawn without a full reset still has to look right)
  _deathClear() {
    const A = this.A;
    A.deadT = -1; A.open = 0; A.dFlags = 0; A.dCr = 0; A.deadPaint = false; A.dirtyA = A.dirtyB = true;
    for (const d of this.debris) d.mesh.visible = false;
    for (const sh of this.ships.values()) { sh.hud.position.copy(sh.hudPiv); sh.hud.rotation.set(0, 0, 0); sh.hud.visible = true; sh.glass.visible = true; }
    this.U.uBuckle.value.x = 0; this.U.uBlack.value = 0; this.U.uFlashSide.value = 0; this.U.uShat.value = 0;
  }

  // new run / respawn: repair the glass, clear smoke, settle the head
  reset() {
    const A = this.A;
    this.cxC.globalCompositeOperation = 'source-over'; this.cxC.fillStyle = '#000'; this.cxC.fillRect(0, 0, this.crW, this.crH);
    this.tCrack.needsUpdate = true; this.cracks = 0;
    this._deathClear();
    A.pos.fill(0); A.vel.fill(0); A.hitGlitch = 0; A.haze = 0; A.emerg = 0; A.power = 1; A.deadT = -1; A.sparkIn = 3; A.flash = 0; A.recoil = A.muzL = A.muzR = 0;
    A.fireStamp = null; A.rocketStamp = null; A.extPrev = 0; A.dirtyA = A.dirtyB = true;
    this.ovFlash.set(0, 0, 0);
    for (const r of this.U.uRip.value) r.w = -1;
    this.U.uShat.value = 0;
    if (this.cur) this.cur.glass.visible = true;
    this._seedDust();
    this.rand = rng(4242);
  }

  // compile every program against the CURRENT render target and upload the textures
  warmup(renderer) {
    renderer = renderer || this.renderer;
    if (!this.cur) this.setShip('vanguard');
    if (!renderer) return Promise.resolve();
    const sv = this.shield.visible, gv = this.cur.glass.visible;
    this.shield.visible = true; this.cur.glass.visible = true;
    for (const t of [this.tDetail, this.tDirt, this.tDecal, this.tA, this.tB, this.tCrack]) renderer.initTexture(t);
    let job;
    try {
      if (renderer.compileAsync) {
        job = renderer.compileAsync(this.scene, this.camera);
        renderer.getContext().flush();      // parallel compile only starts once the commands are flushed
      } else renderer.compile(this.scene, this.camera);
    } finally { this.shield.visible = sv; this.cur.glass.visible = gv; }
    // never hold up loading: a driver that does not report completion just links on first use
    return job ? Promise.race([job, new Promise((res) => setTimeout(res, 5000))]).then(() => {}) : Promise.resolve();
  }

  dispose() {
    for (const s of this.ships.values()) s.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.ships.clear();
    if (this.cur) this.root.remove(this.cur.group);
    this.cur = null;
    this.fx.geometry.dispose(); this.shield.geometry.dispose(); this.ovl.geometry.dispose();
    for (const d of this.debris) d.mesh.geometry.dispose();
    for (const m of [this.mStruct, this.mPart, this.mDecal, this.mGlow, this.mScrA, this.mScrB, this.mHud, this.mGlass, this.mShield, this.mFx, this.mOvl]) m.dispose();
    for (const t of [this.tDetail, this.tDirt, this.tDecal, this.tA, this.tB, this.tCrack]) t.dispose();
    if (this.envRT) { this.envRT.dispose(); this.scene.environment = null; }
  }
}
