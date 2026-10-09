// enemies3d.js — the hostile fleet, built entirely in code.
//
// Ten enemy types modelled with the same kit as the player ships (ships3d.js):
// lofted faceted hulls, bevelled blade wings, lathed thrusters and barrels. One
// faction, one design language — charcoal structure, forward-raked claws, a dark
// visor with red slit "eyes", orange-red engines — and one loud family colour
// per type so the threat reads from straight above at 50 px.
//
// Two draw calls per ship: an opaque hull (painted panels, bare metal and visor
// glass share one geometry and one generated detail texture set; the colour
// blocks are vertex colours) and an additive HDR emissive pass (eyes, engines,
// light bars, weapon charge, elite gold). Every instance of every type runs on
// the same two shader programs; state is per-instance uniforms.
//
// The hulls are rigged, not static. Every vertex belongs to a rigid part and the
// vertex shader carries one matrix per part, so turrets traverse, barrels recoil,
// bay doors swing, nozzle petals breathe and flaps deflect without a single extra
// draw call. The same mechanism removes the pre-cut break-away parts (they collapse
// onto their pivot and uncover a torn stump that was hidden inside them), and
// breakOff() hands the lost piece back as a standalone mesh.
//
// Damage is a material state: scorch and dents first, then wounds burn through the
// skin (the hull is double-sided, so a hole shows a charred, glowing inside and the
// ribs, reactor lumps and sparking cables modelled under each wound), then whole
// plates go missing. userData.wounds lists where to hang smoke and fire.
//
// Model space: +X nose, +Y up, +Z starboard. A built group is exactly 1 long on
// X, centred on the origin. The module receives THREE; from ships3d.js it takes only
// the pure modelling helpers, the livery painter and the shared panelling shader —
// the build kit below is its own.
//
//   const fleet = new Enemies3D(THREE, { quality: 1 });
//   const g = fleet.build('sniper', { elite: false });
//   g.userData.{nozzles,muzzles,glow,setThrust,setFlash,setDim,setDamage,setWarp,setOpacity,setCharge,update,dispose}
//   g.userData.{wounds,woundCount,breakOff,partsLeft,setAim,setRoll,setFire,setDeath,settle}

import {
  tri, quad, flip, mirrorZ, move, rotX, rotY, rotZ, loft, fuselage, wing, wAt, lathe, latheY, ringRect, box, plate, Livery, bakeAO, GLSL_FACES,
} from './ships3d.js';

export const ENEMY_IDS = ['basic', 'weaver', 'hunter', 'tank', 'sniper', 'carrier', 'shieldbearer', 'strafer', 'brood', 'drone'];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex, k = 1) => [s2l(((hex >> 16) & 255) / 255) * k, s2l(((hex >> 8) & 255) / 255) * k, s2l((hex & 255) / 255) * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const PAINT_K = 0.72; // family paints sit a stop under the heroes' so the lights do the talking
const paint = (hex) => mul(lin(hex), PAINT_K);
const side = (t, s) => (s < 0 ? mirrorZ(t) : t);
const SYM = (f) => { f(1); f(-1); };

// emissive channels (index into uLv)
const CH = { STATIC: 0, ENGINE: 1, EYE: 2, STROBE: 3, ACCENT: 4, COCKPIT: 5, CHARGE: 6, GOLD: 7, BIO: 8, ENGINE2: 9 }; // ENGINE2: port-side burners, the ones that die first
const NP = 20;      // part matrices per hull (0 = the body)
const NW = 5;       // wounds per hull
const GUT = { RIB: 2, CORE: 3, CABLE: 4 }; // aTrim values past 1: internals, never cut away by damage
const UV_X0 = 0.54, UV_XW = 1.08; // must match ships3d's Livery / Kit

/* ---- faction palette ---- */
const DARK = lin(0x24272d), DARK2 = lin(0x14161a), PITCH = lin(0x07080a), STEEL = lin(0x747a84), GUN = lin(0x3b3f47);
const TRIM = lin(0x41454d);        // becomes gold on elites
const VISOR = lin(0x0b0d12);
const HEAT = lin(0x4c3f36);
const EYE = [8.5, 0.62, 0.18];
const AMBER = [7, 3.0, 0.35];
const GOLD_GLOW = [3.6, 2.0, 0.28];
const ENG = { hot: [10, 7.6, 4.6], mid: [7.5, 2.5, 0.5], rim: [4.5, 0.9, 0.15] };

// blade aerofoil: flat facets, knife edges
const EPROF = [[0, 0], [0.28, 1], [0.72, 0.62], [1, 0.1], [1, -0.1], [0.72, -0.5], [0.28, -0.7]];
const blade = (st, o = {}) => wing(st, { prof: EPROF, ...o });
const profH = (f) => (f < 0.28 ? f / 0.28 : f < 0.72 ? lerp(1, 0.62, (f - 0.28) / 0.44) : lerp(0.62, 0.1, (f - 0.72) / 0.28));
// vertical fin standing on y0 at z: root chord x0..x1, raked tip
const fin = (xl, xt, h, rake, th, y0, z = 0, cant = 90) =>
  move(rotX(blade([{ z: 0, xl, xt, y: 0, th }, { z: h, xl: xl - rake, xt: xt - rake * 0.35, y: 0, th: th * 0.45 }]), cant * DEG), 0, y0, z);
// closed band around the vertical axis through (cx, cz): hexagonal section, flat top
function torusY(cx, cy, cz, R, a, b, n, a0 = 0, a1 = TAU) {
  const rings = [], full = Math.abs(a1 - a0 - TAU) < 1e-6;
  for (let i = 0; i <= n; i++) {
    const an = lerp(a0, a1, i / n), c = Math.cos(an), s = Math.sin(an);
    rings.push([[R + a, 0], [R + a * 0.4, b], [R - a * 0.4, b], [R - a, 0], [R - a * 0.4, -b], [R + a * 0.4, -b]].map(([r, y]) => [cx + c * r, cy + y, cz + s * r]));
  }
  return loft(rings, { capA: !full, capB: !full });
}
// triangle fan disc in the YZ plane
function disc(x, y, z, r, n) {
  const t = [];
  for (let j = 0; j < n; j++) {
    const a0 = (j / n) * TAU, a1 = ((j + 1) / n) * TAU;
    t.push(x, y, z, x, y + Math.sin(a0) * r, z + Math.cos(a0) * r, x, y + Math.sin(a1) * r, z + Math.cos(a1) * r);
  }
  return t;
}

/* ========================================================================== */
/*  Build kit: triangle soup in, two buffers out (hull + emissive)            */
/* ========================================================================== */

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

class EKit {
  constructor(q, zr, P) {
    this.q = q; this.zr = zr; this.P = P;
    this.hull = { pos: [], nrm: [], col: [], uv: [], tr: [], pa: [] };
    this.emis = { pos: [], col: [], ch: [], pa: [] };
    this.nozzles = []; this.muzzles = [];
    this._trim = 0;
    this.parts = [{ name: 'body', pivot: [0, 0, 0], parent: 0 }];
    this._part = 0;
    this.wounds = []; this.stumps = [];
    this._r = 7;
    this.swP = this.sw = [(0.495 + UV_X0) / UV_XW, 1 - 0.03 / (2 * zr)];     // flat paint
    this.swM = [(0.495 + UV_X0) / UV_XW, 1 - (2 * zr - 0.03) / (2 * zr)];      // bare metal
    this.swG = [(0.385 + UV_X0) / UV_XW, 1 - 0.03 / (2 * zr)];                 // visor glass
  }
  seg(n) { return this.q >= 1 ? n : Math.max(6, Math.round(n * 0.55)); }
  // mode 0: plan-projected livery UVs; mode 1: the current flat swatch
  _emit(b, t, col, crease, mode) {
    const { pos, nrm } = creaseNormals(t, Math.cos((crease ?? 32) * DEG));
    const zr = this.zr, tr = this._trim;
    for (let i = 0; i < pos.length; i += 3) {
      b.pos.push(pos[i], pos[i + 1], pos[i + 2]);
      b.nrm.push(nrm[i], nrm[i + 1], nrm[i + 2]);
      b.col.push(col[0], col[1], col[2]);
      b.tr.push(tr);
      if (mode === 1) b.uv.push(this.sw[0], this.sw[1]);
      else b.uv.push((pos[i] + UV_X0) / UV_XW, 1 - (pos[i + 2] + zr) / (2 * zr));
    }
  }
  // hull part in one flat colour (fins, vertical faces, recesses)
  solid(t, col, o = {}) { this._emit(this.hull, t, col, o.crease, 1); }

  /* ---- emissives (additive, HDR) ---- */
  glow(a, b, c, ca, cb, cc, ch, ea = 0, eb = 0, ec = 0) {
    const E = this.emis;
    E.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    E.col.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    E.ch.push(ch, ea, ch, eb, ch, ec);
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
  // disc of concentric emissive rings in the YZ plane: stops = [[r, col], ...] from the centre out
  glowDisc(x, y, z, stops, n, ch, sy = 1, sz = 1, e = 0) {
    for (let i = 0; i < stops.length - 1; i++) this.glowCone(x, Math.max(1e-5, stops[i][0]), stops[i][1], e, x, stops[i + 1][0], stops[i + 1][1], e, y, z, n, ch, sy, sz);
  }
  // shaped exhaust flame behind an exit plane at x: sheath, core spike and shock diamonds. Every
  // vertex carries a thrust extension (> 0 marks it as plume, which the shader fades end-on).
  flame(x, y, z, r, E, n, sy = 1, sz = 1, o = {}) {
    const k = o.k ?? 1, K = (c, m) => [c[0] * m * k, c[1] * m * k, c[2] * m * k], Z = [0, 0, 0], e0 = 1e-4, CE = o.ch ?? CH.ENGINE;
    const xb = x + r * 0.12;
    this.glowCone(xb, r * 0.76, K(E.mid, 0.08), e0, x - r * 0.1, r * 0.7, K(E.mid, 0.065), r * 0.55, y, z, n, CE, sy, sz);
    this.glowCone(x - r * 0.1, r * 0.7, K(E.mid, 0.065), r * 0.55, x - r * 0.3, r * 0.05, Z, r * 2.1, y, z, n, CE, sy, sz);
    this.glowCone(xb, r * 0.4, K(E.hot, 0.045), e0, x - r * 0.05, r * 0.3, K(E.hot, 0.04), r * 0.3, y, z, n, CE, sy, sz);
    this.glowCone(x - r * 0.05, r * 0.3, K(E.hot, 0.04), r * 0.3, x - r * 0.2, r * 0.03, Z, r * 1.35, y, z, n, CE, sy, sz);
    const nd = o.diamonds ?? (this.q >= 1 ? 3 : 2), m = Math.max(6, n >> 1);
    for (let i = 0; i < nd; i++) {
      const ec = r * (0.42 + 0.46 * i), h = r * 0.2, w = r * (0.3 - 0.06 * i), c = K(E.hot, 0.1 - 0.02 * i);
      this.glowCone(x - r * 0.06, r * 0.04, Z, ec - h, x - r * 0.08, w, c, ec, y, z, m, CE, sy, sz);
      this.glowCone(x - r * 0.08, w, c, ec, x - r * 0.1, r * 0.04, Z, ec + h, y, z, m, CE, sy, sz);
    }
  }
  // rectangular intake mouth: lip ring + dark duct. ring = outer front ring pts
  duct(ring, depth, lip, o = {}) {
    const n = ring.length, c = [0, 0, 0];
    for (const p of ring) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
    const inner = ring.map((p) => { const dy = p[1] - c[1], dz = p[2] - c[2], l = Math.hypot(dy, dz) || 1, k = Math.max(0.2, 1 - lip / l); return [p[0] - lip * 0.3, c[1] + dy * k, c[2] + dz * k]; });
    const back = inner.map((p) => [p[0] - depth, c[1] + (p[1] - c[1]) * 0.7, c[2] + (p[2] - c[2]) * 0.7]);
    const lipT = [];
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; quad(lipT, ring[j], ring[j2], inner[j2], inner[j]); }
    const nx = (lipT[4] - lipT[1]) * (lipT[8] - lipT[2]) - (lipT[5] - lipT[2]) * (lipT[7] - lipT[1]);
    if (nx < 0) flip(lipT); // face +X
    this.solid(lipT, o.lipCol || lin(0x2a2f37), { crease: 20 });
    this.solid(loft([inner, back], { capA: false, inward: true }), o.col || PITCH, { crease: 30 });
    if (o.glow) { // faint turbine glow deep inside
      const bc = [0, 0, 0];
      for (const p of back) { bc[0] += p[0] / n; bc[1] += p[1] / n; bc[2] += p[2] / n; }
      for (let j = 0; j < n; j++) this.glow([bc[0] + 0.002, bc[1], bc[2]], [back[j][0] + 0.002, back[j][1], back[j][2]], [back[(j + 1) % n][0] + 0.002, back[(j + 1) % n][1], back[(j + 1) % n][2]], o.glow, [0, 0, 0], [0, 0, 0], CH.ACCENT);
    }
  }
  // guide vanes standing in an intake mouth at x, between y0..y1 and z0..z1
  vanes(x, y0, y1, z0, z1, n) {
    for (let i = 0; i < n; i++) { const z = lerp(z0, z1, (i + 1) / (n + 1)); this.metal(box(x - 0.03, x, y0, y1, z - 0.0022, z + 0.0022), GUN, 30); }
  }
  // elite horn: a raked gold blade with a light at its point. z carries the side.
  horn(xl, xt, h, rake, th, z, cant, y0 = 0.01) {
    const s = z < 0 ? -1 : 1, za = Math.abs(z);
    this.trim(side(fin(xl, xt, h, rake, th, y0, za, cant), s), { crease: 24 });
    this.lamp(lerp(xl, xt, 0.3) - rake, y0 + h * Math.sin(cant * DEG), s * (za + h * Math.cos(cant * DEG)), 0.008, GOLD_GLOW, CH.GOLD);
  }
  // gun turret on a deck at (x, y): drum, mantlet, sight and twin barrels that elevate and recoil
  turret(x, y, r, h, len, gr, ca, cb) {
    this.on('turret', { pivot: [x, y, 0] }, () => {
      this.col(latheY([[y - 0.004, r * 1.1], [y + h * 0.25, r * 1.12], [y + h * 0.8, r], [y + h, r * 0.72], [y + h, 0.0005]], 8, x, 0), ca, { crease: 30, trim: 1 });
      this.solid(box(x + r * 0.45, x + r * 1.22, y + h * 0.1, y + h * 0.94, -r * 0.62, r * 0.62, r * 0.1), DARK, { crease: 26 });
      this.col(box(x - r * 1.3, x - r * 0.6, y, y + h * 0.7, -r * 0.5, r * 0.5, r * 0.1), cb, { crease: 26 });
      this.glassy(box(x - r * 0.5, x + r * 0.2, y + h - 0.001, y + h + r * 0.3, r * 0.16, r * 0.6, r * 0.06));
      this.lamp(x + r * 0.2, y + h + r * 0.15, r * 0.38, r * 0.13, mul(EYE, 0.7));
      this.on('tguns', { pivot: [x + r * 0.85, y + h * 0.52, 0], recoil: len * 0.24 }, () => {
        for (const s of [1, -1]) this.gun(x + r * 0.85, x + r * 0.85 + len, y + h * 0.52, s * r * 0.34, gr, { n: 8 });
      });
    });
  }
  _rand() { return (this._r = (this._r * 16807) % 2147483647) / 2147483647; }
  _sync() {
    const h = this.hull, e = this.emis, p = this._part;
    for (let n = h.pos.length / 3; h.pa.length < n;) h.pa.push(p);
    for (let n = e.pos.length / 3; e.pa.length < n;) e.pa.push(p);
  }
  // Everything emitted inside fn belongs to one rigid part. o: { pivot, axis (hinge for the part's own angle),
  // detach: n (n-th piece to break away), stump: {p,u,v,w,len}, bend: [rx,ry,rz] (pose of a wrecked hull),
  // recoil: slide on fire, spin: rad/s about axis, elite: only exists on elites }. Parts nest: a part opened
  // inside another rides on it.
  on(name, o, fn) {
    this._sync();
    let i = this.parts.findIndex((p) => p.name === name);
    if (i < 0) {
      if (o.stump) this.stump(o.stump);
      this._sync();
      i = this.parts.length;
      this.parts.push({ name, pivot: [0, 0, 0], axis: [0, 0, 1], parent: this._part, ...o });
    }
    const prev = this._part, m0 = this.muzzles.length, n0 = this.nozzles.length;
    this._part = i; fn(); this._sync(); this._part = prev;
    for (let j = m0; j < this.muzzles.length; j++) this.muzzles[j].part ??= i;
    for (let j = n0; j < this.nozzles.length; j++) this.nozzles[j].part ??= i;
    return i;
  }
  // internals: bare metal that damage never cuts away and that glows once the hull is opened
  gut(t, col, kind = GUT.RIB) { this._trim = kind; this._sw(this.swM, t, col, 30); this._trim = 0; }
  // torn root left behind by a lost part: ragged shards standing out along u from the tear line (p ± v·w),
  // over a bed of embers. It lies inside the part, so it is invisible until the part goes.
  stump({ p, u, v, w, len, n = 5 }) {
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const at = (a, b, c) => [p[0] + v[0] * a * w + u[0] * b * len + nx * c, p[1] + v[1] * a * w + u[1] * b * len + ny * c, p[2] + v[2] * a * w + u[2] * b * len + nz * c];
    const t = [], e = [];
    for (let i = 0; i < n; i++) {
      const a = -1 + (2 * i) / n, b = -1 + (2 * (i + 1)) / n, m = lerp(a, b, 0.2 + 0.6 * this._rand()), L = 0.4 + 0.6 * this._rand(), c = (this._rand() - 0.5) * len * 0.22;
      tri(t, at(a, -0.5, 0), at(b, -0.5, 0), at(m, L, c));
    }
    quad(e, at(-0.8, -0.4, 0), at(0.8, -0.4, 0), at(0.7, 0.16, 0), at(-0.7, 0.16, 0));
    this.gut(t, DARK2, GUT.RIB); this.gut(e, DARK2, GUT.CORE);
    this.stumps.push({ x: p[0] + u[0] * len * 0.3, y: p[1] + u[1] * len * 0.3, z: p[2] + u[2] * len * 0.3, part: this.parts.length });
  }
  // A wound: where damage burns through the skin (in the order they open), with the internals it uncovers —
  // ribs, a reactor lump that glows and a pair of cables that spark. (x,y,z) is on the skin; the guts fill
  // yc ± h under it.
  wound(x, y, z, r, o = {}) {
    const h = o.h ?? r * 0.42, yc = o.yc ?? y - r * 0.6, zs = o.zs ?? 0.62;
    this.wounds.push([x, y, z, r]);
    for (const dx of [-0.52, 0.02, 0.56]) this.gut(box(x + dx * r - 0.003, x + dx * r + 0.003, yc - h, yc + h * 0.55, z - r * zs, z + r * zs), DARK2, GUT.RIB);
    this.gut(lathe([[x - r * 0.3, r * 0.03], [x - r * 0.16, h * 0.62], [x + r * 0.2, h * 0.62], [x + r * 0.34, r * 0.03]], 6, { y: yc - h * 0.25, z: z + r * 0.12 }), DARK2, GUT.CORE);
    for (const [dz, a] of [[-0.34, 0.3], [0.38, -0.22]]) {
      this.gut(rotY(lathe([[x - r * 0.75, 0.0026], [x + r * 0.75, 0.0026]], 4, { y: yc + h * 0.3, z: z + dz * r }), a, x, z + dz * r), GUN, GUT.CABLE);
    }
  }
  // trailing-edge control surface on a blade wing between stations za..zb, chord c; hinged on the trailing edge
  flap(st, s, za, zb, c) {
    const A = wAt(st, za), B = wAt(st, zb), ym = (A.y + B.y) / 2, ax = B.xt - A.xt, az = (zb - za) * s, al = Math.hypot(ax, az);
    this.on('flap' + (s > 0 ? 'R' : 'L'), { pivot: [(A.xt + B.xt) / 2 + 0.008, ym, (s * (za + zb)) / 2], axis: [ax / al, 0, az / al], flap: s }, () => {
      this.trim(side(plate([[A.xt + 0.014, za], [B.xt + 0.014, zb], [B.xt - c, zb - 0.004], [A.xt - c, za + 0.004]], ym - 0.0045, ym + 0.0055, 0.002), s), { crease: 24 });
    });
  }
  // elite regalia: geometry that only exists on elite hulls
  ornate(fn) { this.on('ornate', { elite: 1 }, fn); }
  // a row of raked gold blades along a spine
  crest(x0, x1, y, n, h, z = 0) {
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? i / (n - 1) : 0, x = lerp(x0, x1, u), hh = h * (1 - 0.45 * Math.abs(u - 0.35) / 0.65), c = h * 0.8;
      this.trim(fin(x + c * 0.5, x - c * 0.5, hh, hh * 0.9, 0.009, y, z), { crease: 24 });
    }
  }
  _sw(sw, t, col, crease) { this.sw = sw; this._emit(this.hull, t, col, crease, 1); this.sw = this.swP; }
  // everything lands in the hull draw call
  metal(t, col = STEEL, crease) { this._sw(this.swM, t, col, crease ?? 30); }
  glassy(t, col) { this._sw(this.swG, t, col || VISOR, 40); }
  // panel in a family colour, carrying the plan-projected detail texture
  // o.trim: the panel turns to gold plate on elites
  col(t, c, o = {}) { this._trim = o.trim ? 1 : 0; this._emit(this.hull, t, c, o.crease ?? 30, 0); this._trim = 0; }
  // trim: dark steel edging that turns to gold on elites
  trim(t, o = {}) { this._trim = 1; this._sw(this.swM, t, o.col || TRIM, o.crease ?? 30); this._trim = 0; }
  // charge-channel emissive; ph 0..1 = when in the charge-up this element lights
  charge(t, col, ph = 0) {
    for (let i = 0; i < t.length; i += 9) this.glow([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]], col, col, col, CH.CHARGE, ph, ph, ph);
  }
  // angular thruster: exit plane at x (opening toward -X), body reaches x + len
  // Burners on the port side run on their own channel (they are the ones that die in a wreck), and every
  // thruster wears a ring of nozzle petals that is its own part: it opens with thrust and vectors with roll.
  thruster(x, y, z, r, len, o = {}) {
    const n = o.n || this.seg(10), sy = o.sy || 1, sz = o.sz || 1, L = { y, z, sy, sz, phase: o.phase ?? TAU / (2 * n) }, E = ENG, g = o.glow ?? 1;
    const e0 = this.emis.ch.length, port = z < -1e-4;
    this.metal(lathe([[x + len, r * 0.82], [x + len * 0.55, r * 1.1], [x + len * 0.16, r * 1.06], [x, r * 0.93], [x + len * 0.05, r * 0.8], [x + len * 0.5, r * 0.6], [x + len * 0.53, 0.0005]], n, { ...L, capA: false, capB: false }), o.col || HEAT, 24);
    this.metal(lathe([[x + len * 0.62, r * 1.13], [x + len * 0.5, r * 1.19], [x + len * 0.36, r * 1.19], [x + len * 0.3, r * 1.08]], n, { ...L, capA: false, capB: false }), GUN, 24);
    const xc = x + len * 0.5;
    if (this.q >= 1 && r > 0.036) { // burner cross, black against the fire
      const fh = [];
      for (let j = 0; j < 4; j++) for (const t of rotX(box(xc - len * 0.1, xc - len * 0.01, -r * 0.04, r * 0.04, r * 0.1, r * 0.62), (j / 4) * TAU + TAU / 8)) fh.push(t);
      for (const t of lathe([[xc, r * 0.16], [xc - len * 0.22, r * 0.012]], 6, { capA: false })) fh.push(t);
      for (let i = 0; i < fh.length; i += 3) { fh[i + 1] = y + fh[i + 1] * sy; fh[i + 2] = z + fh[i + 2] * sz; }
      this.solid(fh, PITCH, { crease: 30 });
    }
    // burner face, afterburner ring, glowing walls, shaped plume
    this.glowDisc(xc - 0.0006, y, z, [[0, mul(E.hot, 0.3 * g)], [r * 0.16, mul(E.hot, 0.24 * g)], [r * 0.32, mul(E.mid, 0.42 * g)], [r * 0.48, mul(E.mid, 0.17 * g)], [r * 0.6, mul(E.rim, 0.14 * g)]], n, CH.ENGINE, sy, sz);
    this.glowCone(x + len * 0.3, r * 0.6, mul(E.hot, 0.05 * g), 0, x + len * 0.27, r * 0.665, mul(E.hot, 0.4 * g), 0, y, z, n, CH.ENGINE, sy, sz);
    this.glowCone(x + len * 0.27, r * 0.665, mul(E.hot, 0.4 * g), 0, x + len * 0.24, r * 0.72, mul(E.mid, 0.08 * g), 0, y, z, n, CH.ENGINE, sy, sz);
    this.glowCone(xc, r * 0.6, mul(E.mid, 0.24 * g), 0, x + len * 0.05, r * 0.8, mul(E.rim, 0.05 * g), 0, y, z, n, CH.ENGINE, sy, sz);
    this.flame(x, y, z, r * 0.92, E, n, sy, sz, { k: g, diamonds: this.q >= 1 ? 2 : 1 });
    if (port) { const ch = this.emis.ch; for (let i = e0; i < ch.length; i += 2) if (ch[i] === CH.ENGINE) ch[i] = CH.ENGINE2; }
    const nz = { x, y, z, r: r * 0.9 * Math.max(sy, sz), on: 1, port };
    this.nozzles.push(nz);
    if (o.petals !== false) {
      const np = o.np || (this.q >= 1 ? 6 : 4), w = r * 1.14 * Math.tan(Math.PI / np) * 0.86;
      nz.eng = this.on('eng' + this.nozzles.length, { pivot: [x + len * 0.44, y, z], eng: z }, () => {
        for (let j = 0; j < np; j++) {
          const t = rotX(loft([ringRect(x + len * 0.44, r * 1.12, r * 1.2, -w, w), ringRect(x + len * 0.12, r * 1.08, r * 1.15, -w * 0.94, w * 0.94), ringRect(x - len * 0.06, r * 0.98, r * 1.03, -w * 0.74, w * 0.74)]), (j / np) * TAU + TAU / (2 * np));
          for (let i = 0; i < t.length; i += 3) { t[i + 1] = y + t[i + 1] * sy; t[i + 2] = z + t[i + 2] * sz; }
          this.metal(t, j % 2 ? HEAT : GUN, 24);
        }
      });
    }
  }
  // light gun: breech x0 → muzzle x1, hexagonal
  gun(x0, x1, y, z, r, o = {}) {
    const n = o.n || 6;
    this.metal(lathe([[x0, r * 1.5], [x0 + r * 2.2, r * 1.5], [x0 + r * 2.8, r], [x1 - r * 4, r], [x1 - r * 3.6, r * 1.4], [x1, r * 1.4], [x1 - r * 0.4, r * 0.7]], n, { y, z, capB: false }), o.col || GUN, 30);
    this.solid(lathe([[x1 - r * 0.4, r * 0.7], [x1 - r * 3.4, r * 0.6]], n, { y, z, capA: false, capB: false, inward: true }), PITCH, { crease: 30 }); // the bore
    this.glowTris(disc(x1 - r * 2.6, y, z, r * 0.6, n), mul(this.P.glow, 0.4), CH.ACCENT);
    if (o.muzzle !== false) this.muzzles.push({ x: x1, y, z });
  }
  // visor hood with a pair of slanted slit eyes on its raked face
  eyes(x0, x1, yb, yt0, yt1, hw0, hw1, o = {}) {
    const z = o.z || 0, c0 = hw0 * 0.22, c1 = hw1 * 0.22, col = o.col || EYE;
    this.glassy(loft([ringRect(x0, yb, yt0, z - hw0, z + hw0, c0), ringRect(x1, yb, yt1, z - hw1, z + hw1, c1)]), VISOR);
    const u = (x) => (x - x0) / (x1 - x0), yAt = (x) => lerp(yt0, yt1, u(x)) + 0.0028, hwAt = (x) => lerp(hw0 - c0, hw1 - c1, u(x));
    const L = x1 - x0, xi = x0 + L * 0.88, xo = x0 + L * 0.34, th = L * (o.th ?? 0.26);
    for (const s of [1, -1]) {
      const zi = hwAt(xi) * 0.16, zo = hwAt(xo) * 0.97;
      const A = [xi, yAt(xi), z + s * zi], B = [xi - th * 0.7, yAt(xi - th * 0.7), z + s * zi];
      const C = [xo - th, yAt(xo - th), z + s * zo], D = [xo, yAt(xo), z + s * zo];
      this.glow(A, B, C, col, col, col, CH.EYE); this.glow(A, C, D, col, col, col, CH.EYE);
    }
    // the slit seen from dead ahead
    this.glowBox(x1 - 0.001, x1 + 0.0025, lerp(yb, yt1, 0.5), lerp(yb, yt1, 0.86), z - (hw1 - c1) * 0.9, z + (hw1 - c1) * 0.9, mul(col, 0.8), CH.EYE);
  }
  // glowing bar lying on a (flat) blade wing between chord fractions f0..f1
  bar(st, s, z0, z1, f0, f1, col, ch = CH.ACCENT, ph = 0) {
    const zs = [z0];
    for (const w of st) if (w.z > z0 + 1e-6 && w.z < z1 - 1e-6) zs.push(w.z);
    zs.push(z1);
    const pt = (z, f) => { const w = wAt(st, z); return [lerp(w.xl, w.xt, f), w.y + w.th * 0.5 * profH(f) + 0.0028, z * s]; };
    for (let i = 0; i < zs.length - 1; i++) {
      const A = pt(zs[i], f0), B = pt(zs[i + 1], f0), C = pt(zs[i + 1], f1), D = pt(zs[i], f1);
      this.glow(A, B, C, col, col, col, ch, ph, ph, ph); this.glow(A, C, D, col, col, col, ch, ph, ph, ph);
    }
  }
  // flat glowing strip on a horizontal surface (two-sided)
  strip(x0, x1, y, z0, z1, col, ch = CH.ACCENT, ph = 0) {
    const A = [x0, y, z0], B = [x1, y, z0], C = [x1, y, z1], D = [x0, y, z1];
    this.glow(A, B, C, col, col, col, ch, ph, ph, ph); this.glow(A, C, D, col, col, col, ch, ph, ph, ph);
  }
  // glowing quad through four points (two-sided)
  quad(A, B, C, D, col, ch = CH.ACCENT, ph = 0) { this.glow(A, B, C, col, col, col, ch, ph, ph, ph); this.glow(A, C, D, col, col, col, ch, ph, ph, ph); }
  // flat ring of light facing ±X at x (r0 inner, r1 outer)
  halo(x, y, z, r0, r1, col, n, ch = CH.ACCENT, ph = 0, sy = 1, sz = 1) {
    for (let j = 0; j < n; j++) {
      const a0 = (j / n) * TAU, a1 = ((j + 1) / n) * TAU, p = (r, a) => [x, y + Math.sin(a) * r * sy, z + Math.cos(a) * r * sz];
      this.quad(p(r0, a0), p(r0, a1), p(r1, a1), p(r1, a0), col, ch, ph);
    }
  }
  // ventral kit: a hanging armour plate split by seams, a recessed weapon bay with a sullen light, and a chin scoop
  belly(x0, x1, y, hw, c, o = {}) {
    const d = o.d ?? 0.012, xm = lerp(x0, x1, 0.5), bw = hw * (o.bay ?? 0.5);
    for (const [xa, xb, w] of [[x0, xm - 0.006, hw * 0.88], [xm + 0.006, x1, hw]]) {
      this.col(plate([[xb, -w * 0.62], [xb, w * 0.62], [xb - 0.03, w], [xa + 0.02, w], [xa, w * 0.8], [xa, -w * 0.8], [xa + 0.02, -w], [xb - 0.03, -w]], y + 0.006, y - d, 0.005), c, { crease: 24 });
    }
    // bay doors + the gap between them
    const bx0 = lerp(x0, x1, 0.14), bx1 = lerp(x0, x1, 0.44);
    this.solid(box(bx0, bx1, y - d - 0.004, y - d + 0.002, -bw, bw, 0.002), PITCH, { crease: 30 });
    for (const s of [1, -1]) this.metal(box(bx0 + 0.004, bx1 - 0.004, y - d - 0.007, y - d - 0.002, s * bw * 0.12, s * bw * 0.92, 0.002), GUN, 30);
    this.strip(bx0 + 0.008, bx1 - 0.008, y - d - 0.0045, -bw * 0.08, bw * 0.08, o.glow || [1.6, 0.3, 0.08], CH.EYE);
    if (o.scoop !== false) { // chin scoop facing forward
      const sx = lerp(x0, x1, 0.86), sw = hw * 0.5, r = ringRect(sx, y - d - 0.026, y - d + 0.002, -sw, sw, 0.007);
      this.col(loft([ringRect(sx - 0.1, y - d - 0.008, y - d + 0.002, -sw * 0.6, sw * 0.6, 0.003), r], { capB: false }), c, { crease: 26 });
      this.duct(r, 0.05, 0.005, { glow: [1.3, 0.35, 0.08], lipCol: DARK });
    }
  }
  lamp(x, y, z, r, col, ch = CH.EYE) { this.glowBall(x, y, z, r, col === AMBER ? mul(AMBER, 0.55) : col, ch); }
  // elite-only gold light strip
  gold(x0, x1, y, z0, z1) { this.strip(x0, x1, y, z0, z1, GOLD_GLOW, CH.GOLD); }
}

/* ========================================================================== */
/*  Detail texture: neutral panel map multiplied by the vertex colour blocks  */
/* ========================================================================== */

// o: { xs: [x…] transverse panel lines, zs: [z…] longitudinal (mirrored), hw: half-width the lines span,
//      tone: [[poly, grey]…] tonal panels, soot: [[x,z]…] engine soot centres, seed }
function detail(L, o) {
  L.base(0xd8d8d8, 0.42, 0.34);
  const hw = o.hw ?? L.zr;
  for (const [poly, g, m] of o.tone || []) {
    const v = Math.round(g * 255);
    L.fill(poly, (v << 16) | (v << 8) | v, { rough: m ? 0.3 : 0.5, metal: m ? 0.7 : 0.3 });
    L.line(poly, { close: true, w: 1.3, a: 0.5 });
  }
  for (const x of o.xs || []) L.line([[x, -hw], [x, hw]], { a: 0.55, w: 1.6 });
  for (const z of o.zs || []) for (const s of [1, -1]) L.line([[-0.52, z * s], [0.52, z * s]], { a: 0.45, w: 1.4 });
  for (const h of o.hatch || []) for (const s of [1, -1]) L.hatch(h[0], h[1] * s, h[2], h[3] * s);
  for (const [x, z] of o.soot || []) for (const s of z ? [1, -1] : [1]) L.shade([[x + 0.06, z * s], [x - 0.08, z * s]], 0.11, 0.55);
  if (o.extra) o.extra(L);
  L.wear(o.seed || 11, o.wear ?? 0.7);
  // material swatches (clean, after the wear pass)
  const zr = L.zr, sw = (p, r, m) => { L.fill(p, 0xffffff, { rough: r, metal: m }); L._path(L.h, p, true); L.h.fillStyle = '#808080'; L.h.fill(); };
  sw(L.rect(0.45, -zr, 0.54, -zr + 0.06), 0.56, 0.2);
  sw(L.rect(0.45, zr - 0.06, 0.54, zr), 0.34, 0.92);
  sw(L.rect(0.34, -zr, 0.43, -zr + 0.06), 0.1, 0.9);
}
// hazard chevrons pointing +X, centred on (x, z)
function chevrons(L, x, z, w, n, gap, grey = 0x202020) {
  for (let i = 0; i < n; i++) {
    const xx = x - i * gap, t = gap * 0.42;
    L.fill([[xx, z], [xx - w * 0.6, z + w], [xx - w * 0.6 - t, z + w], [xx - t, z], [xx - w * 0.6 - t, z - w], [xx - w * 0.6, z - w]], grey, { rough: 0.7, metal: 0.1 });
  }
}

/* ========================================================================== */
/*  The fleet                                                                 */
/* ========================================================================== */

const pal = (base, base2, glow, o = {}) => ({ base, base2, glow, eng: ENG, glass: VISOR, ...o });

/* -------------------------------- BASIC ---------------------------------- */
// Mass-produced line fighter: a wedge hull, two claw wings, one engine.
// Breaks: starboard wing tip, port wing tip, dorsal fin.
function defBasic() {
  const P = pal(0x789a42, 0x425c24, [2.6, 5.5, 0.5]);
  const WING = [
    { z: 0.06, xl: 0.15, xt: -0.37, y: -0.004, th: 0.036 },
    { z: 0.2, xl: 0.04, xt: -0.2, y: -0.004, th: 0.026 },
    { z: 0.3, xl: 0.15, xt: -0.02, y: -0.004, th: 0.014 },
  ];
  return {
    zr: 0.42, P,
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.41, w: 0.07, t: 0.046, b: 0.04, et: 1.7, eb: 1.7 }, { x: -0.16, w: 0.1, t: 0.062, b: 0.046, et: 1.5, eb: 1.6 },
        { x: 0.12, w: 0.08, t: 0.05, b: 0.04, et: 1.4, eb: 1.5 }, { x: 0.36, w: 0.044, t: 0.026, b: 0.024, et: 1.3, eb: 1.4 },
        { x: 0.5, w: 0.006, t: 0.004, b: 0.004, et: 1.5, eb: 1.5 },
      ], { n: k.seg(12), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C, { crease: 26 });
      k.eyes(0.08, 0.3, 0.02, F.top(0.08) + 0.02, F.top(0.3) + 0.006, 0.05, 0.026);
      const fy = F.top(-0.29);
      k.on('fin', { pivot: [-0.27, fy - 0.006, 0], detach: 3, bend: [0.6, 0, 0.1], stump: { p: [-0.3, fy - 0.004, 0], u: [0, 1, 0], v: [1, 0, 0], w: 0.07, len: 0.034 } },
        () => k.trim(fin(-0.1, -0.4, 0.11, 0.18, 0.018, 0.04)));
      k.gold(-0.36, -0.06, F.top(-0.2) + 0.004, 0.02, 0.03); k.gold(-0.36, -0.06, F.top(-0.2) + 0.004, -0.03, -0.02);
      SYM((s) => {
        k.col(side(blade([WING[0], WING[1]], { tip: false }), s), C2, { crease: 24, trim: 1 });
        k.bar(WING, s, 0.09, 0.2, 0.3, 0.44, mul(G, 0.34));
        k.on(s > 0 ? 'wingR' : 'wingL', { pivot: [-0.08, -0.004, s * 0.2], detach: s > 0 ? 1 : 2, stump: { p: [-0.05, -0.004, s * 0.2], u: [0, 0, s], v: [1, 0, 0], w: 0.07, len: 0.03 } }, () => {
          k.col(side(blade([WING[1], WING[2]]), s), C2, { crease: 24, trim: 1 });
          // tip claw pod + gun
          k.trim(side(lathe([[-0.07, 0.004], [-0.03, 0.019], [0.13, 0.019], [0.17, 0.011]], 6, { y: -0.004, z: 0.3 }), s));
          k.gun(0.14, 0.26, -0.004, s * 0.3, 0.0065);
          k.bar(WING, s, 0.2, 0.27, 0.3, 0.44, mul(G, 0.34));
          k.lamp(-0.06, 0.016, s * 0.3, 0.011, AMBER);
        });
        k.flap(WING, s, 0.125, 0.195, 0.045);
        // cheek intakes
        k.col(side(loft([ringRect(-0.32, -0.04, 0.014, 0.05, 0.115, 0.01), ringRect(0.15, -0.038, 0.012, 0.06, 0.122, 0.008)], { capB: false }), s), C, { crease: 26 });
        k.duct(ringRect(0.15, -0.038, 0.012, 0.06, 0.122, 0.008).map((p) => [p[0], p[1], p[2] * s]), 0.07, 0.007, { glow: [1.6, 0.5, 0.1] });
        k.vanes(0.118, -0.034, 0.008, s * 0.066, s * 0.116, 3);
        k.trim(side(box(-0.3, 0.1, 0.012, 0.02, 0.108, 0.12, 0.003), s));
        // ventral strake
        k.solid(side(fin(-0.16, -0.38, 0.06, 0.1, 0.012, -0.03, 0.05, -62), s), DARK, { crease: 24 });
      });
      k.on('gun', { recoil: 0.03 }, () => k.gun(0.3, 0.47, -0.026, 0, 0.0075));
      k.muzzles.unshift(k.muzzles.pop());
      k.belly(-0.3, 0.2, -0.046, 0.046, C2, { scoop: false });
      k.thruster(-0.5, 0.002, 0, 0.06, 0.13);
      k.wound(-0.1, F.top(-0.1, 0.035), 0.035, 0.055);
      k.wound(0.02, 0.014, -0.088, 0.045, { yc: -0.012, h: 0.016 });
      k.wound(-0.12, 0.012, 0.135, 0.05, { yc: -0.004, h: 0.006, zs: 0.5 });
      k.wound(-0.3, F.top(-0.3, -0.02), -0.025, 0.05);
      k.wound(0.2, F.top(0.2), 0.005, 0.04);
      k.ornate(() => {
        SYM((s) => k.horn(0.12, -0.04, 0.1, -0.13, 0.012, s * 0.1, 38));
        k.crest(0.05, -0.07, F.top(0) + 0.012, 3, 0.04);
      });
    },
    liv(L) {
      detail(L, {
        xs: [0.3, 0.1, -0.08, -0.26], zs: [0.06, 0.2], seed: 3, soot: [[-0.4, 0]], hatch: [[-0.12, 0.13, -0.2, 0.17]],
        tone: [[[[0.04, -0.04], [-0.38, -0.03], [-0.38, 0.03], [0.04, 0.04]], 0.6]],
        extra(l) { for (const s of [1, -1]) chevrons(l, -0.02, s * 0.25, 0.022, 2, 0.04); },
      });
    },
  };
}

/* -------------------------------- DRONE ---------------------------------- */
// The swarm unit: a bone-white wedge with a black nose, one staring eye and one hot engine.
// Breaks: starboard wing, port wing.
function defDrone() {
  const P = pal(0xe0d8ba, 0x34382f, [8.5, 2.6, 0.3]);
  const WING = [{ z: 0.09, xl: -0.02, xt: -0.4, y: -0.006, th: 0.034 }, { z: 0.2, xl: -0.12, xt: -0.4, y: -0.02, th: 0.022 }, { z: 0.275, xl: -0.05, xt: -0.3, y: -0.034, th: 0.01 }];
  const EYE1 = [9.5, 2.6, 0.22];
  return {
    zr: 0.4, P,
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2);
      const F = fuselage([
        { x: -0.4, w: 0.13, t: 0.05, b: 0.046, et: 1.15, eb: 1.15 }, { x: -0.12, w: 0.175, t: 0.078, b: 0.052, et: 1.15, eb: 1.15 },
        { x: 0.24, w: 0.085, t: 0.04, b: 0.03, et: 1.15, eb: 1.15 }, { x: 0.5, w: 0.006, t: 0.004, b: 0.004, et: 1.2, eb: 1.2 },
      ], { n: 8, sub: 2 });
      k.col(F.tris, C, { crease: 20 });
      // eye turret: a dark collar with a single amber lens that looks up and ahead
      const ex = 0.1, ey = F.top(0.1);
      k.solid(latheY([[ey - 0.03, 0.058], [ey + 0.006, 0.054], [ey + 0.014, 0.04]], 8, ex, 0), PITCH, { crease: 30 });
      k.glowBall(ex + 0.006, ey + 0.016, 0, 0.036, EYE1, CH.EYE);
      k.glowDisc(ex + 0.062, ey - 0.004, 0, [[0, mul(EYE1, 0.8)], [0.02, mul(EYE1, 0.3)], [0.03, [0, 0, 0]]], 8, CH.EYE, 0.7, 1);
      SYM((s) => {
        k.on(s > 0 ? 'wingR' : 'wingL', { pivot: [-0.24, -0.014, s * 0.15], detach: s > 0 ? 1 : 2, bend: [s * 0.25, 0, 0], stump: { p: [-0.25, -0.016, s * 0.168], u: [0, -0.1, s], v: [1, 0, 0], w: 0.09, len: 0.028, n: 4 } }, () => {
          k.col(side(blade(WING), s), C2, { crease: 24, trim: 1 });
          k.bar(WING, s, 0.11, 0.26, 0.5, 0.64, mul(AMBER, 0.3));
        });
        k.solid(side(fin(-0.2, -0.38, 0.05, 0.08, 0.012, -0.02, 0.07, -64), s), DARK, { crease: 24 });
      });
      k.on('fin', { pivot: [-0.27, 0.05, 0], bend: [0.7, 0, 0] }, () => k.trim(fin(-0.12, -0.4, 0.1, 0.16, 0.02, 0.04)));
      k.gold(-0.34, -0.1, F.top(-0.2) + 0.003, 0.03, 0.05); k.gold(-0.34, -0.1, F.top(-0.2) + 0.003, -0.05, -0.03);
      // engine: a collar as wide as the tail, one big burner
      k.solid(lathe([[-0.3, 0.07], [-0.4, 0.098], [-0.46, 0.094]], 8, { y: 0.004, sy: 0.72, capA: false, capB: false, phase: TAU / 16 }), DARK, { crease: 24 });
      k.thruster(-0.5, 0.004, 0, 0.082, 0.15, { n: 8, glow: 1.2, np: 4 });
      k.solid(box(-0.26, 0.16, -0.05, -0.034, -0.03, 0.03, 0.006), DARK, { crease: 28 });
      k.muzzles.push({ x: 0.5, y: 0, z: 0 });
      k.wound(-0.12, F.top(-0.12, 0.06), 0.06, 0.07);
      k.wound(0.16, F.top(0.16, -0.02), -0.02, 0.05);
      k.wound(-0.3, F.top(-0.3, -0.05), -0.05, 0.06);
      k.ornate(() => k.crest(0.0, -0.1, F.top(-0.05) + 0.004, 2, 0.05));
    },
    liv(L) {
      detail(L, {
        xs: [0.2, -0.05, -0.26], zs: [0.07], seed: 5, soot: [[-0.4, 0]], wear: 0.5,
        tone: [
          [[[0.52, -0.06], [0.52, 0.06], [0.27, 0.085], [0.24, 0], [0.27, -0.085]], 0.13],   // black nose
          [[[-0.2, -0.2], [-0.2, 0.2], [-0.25, 0.2], [-0.25, -0.2]], 0.16],                   // tail band
        ],
        extra(l) { for (const s of [1, -1]) chevrons(l, -0.02, s * 0.1, 0.03, 2, 0.05, 0x26221c); },
      });
    },
  };
}

/* -------------------------------- WEAVER --------------------------------- */
// Light fighter that carves S-turns: slim spine, long scimitar wings, all-moving canards.
// Breaks: starboard outer wing, port outer wing, starboard canard.
function defWeaver() {
  const P = pal(0x18c2a8, 0x0c7566, [0.3, 6, 4.4]);
  const WING = [
    { z: 0.04, xl: 0.2, xt: -0.17, y: 0, th: 0.032 },
    { z: 0.17, xl: 0.02, xt: -0.22, y: 0, th: 0.024 },
    { z: 0.29, xl: -0.19, xt: -0.36, y: 0, th: 0.016 },
    { z: 0.37, xl: -0.38, xt: -0.47, y: 0, th: 0.008 },
  ];
  const CAN = [{ z: 0.03, xl: 0.31, xt: 0.2, y: 0.002, th: 0.016 }, { z: 0.13, xl: 0.43, xt: 0.36, y: 0.002, th: 0.008 }];
  return {
    zr: 0.46, P,
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.42, w: 0.04, t: 0.034, b: 0.03, et: 1.6, eb: 1.6 }, { x: -0.15, w: 0.058, t: 0.046, b: 0.036, et: 1.5, eb: 1.5 },
        { x: 0.15, w: 0.048, t: 0.038, b: 0.03, et: 1.4, eb: 1.4 }, { x: 0.38, w: 0.022, t: 0.016, b: 0.015, et: 1.4, eb: 1.4 },
        { x: 0.5, w: 0.004, t: 0.003, b: 0.003, et: 1.5, eb: 1.5 },
      ], { n: k.seg(10), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C2, { crease: 26 });
      k.eyes(0.1, 0.3, 0.014, F.top(0.1) + 0.018, F.top(0.3) + 0.006, 0.036, 0.02);
      const WM = wAt(WING, 0.2);
      SYM((s) => {
        k.col(side(blade([WING[0], WING[1], WM], { tip: false }), s), C, { crease: 24 });
        k.bar(WING, s, 0.07, 0.2, 0.06, 0.2, mul(G, 0.34));
        k.on(s > 0 ? 'wingR' : 'wingL', { pivot: [-0.15, 0, s * 0.2], detach: s > 0 ? 1 : 2, stump: { p: [-0.155, 0, s * 0.2], u: [-0.7, 0, s * 0.7], v: [1, 0, 0], w: 0.075, len: 0.04 } }, () => {
          k.col(side(blade([WM, WING[2], WING[3]]), s), C, { crease: 24, trim: 1 });
          k.bar(WING, s, 0.2, 0.36, 0.06, 0.2, mul(G, 0.34));
          k.lamp(-0.42, 0.006, s * 0.375, 0.009, mul(G, 1.1), CH.ACCENT);
        });
        k.flap(WING, s, 0.105, 0.195, 0.04);
        k.on(s > 0 ? 'canR' : 'canL', { pivot: [0.27, 0.002, s * 0.04], detach: s > 0 ? 3 : 0, stump: { p: [0.276, 0.002, s * 0.046], u: [0.6, 0, s * 0.8], v: [1, 0, 0], w: 0.036, len: 0.02, n: 4 } },
          () => k.trim(side(blade(CAN), s), { crease: 24 }));
        // engine pods hugging the spine
        k.col(side(lathe([[-0.42, 0.03], [-0.3, 0.036], [-0.12, 0.03], [-0.02, 0.012]], k.seg(8), { y: 0.002, z: 0.062, phase: TAU / 16 }), s), C2, { crease: 26 });
        k.thruster(-0.5, 0.002, s * 0.062, 0.032, 0.09, { n: k.seg(8) });
        k.on('guns', { recoil: 0.025 }, () => k.gun(0.04, 0.2, -0.012, s * 0.088, 0.0055));
        k.trim(side(fin(-0.24, -0.43, 0.085, 0.13, 0.012, 0.022, 0.062, 62), s));
        k.solid(side(fin(-0.26, -0.42, 0.06, 0.1, 0.01, -0.018, 0.062, -62), s), DARK, { crease: 24 });
        k.gold(-0.3, -0.08, 0.04, s * 0.062 - 0.006, s * 0.062 + 0.006);
        // pod intake lips, seen head-on
        k.duct(ringRect(-0.03, -0.022, 0.024, 0.04, 0.086, 0.006).map((p) => [p[0], p[1], p[2] * s]), 0.05, 0.005, { glow: mul(G, 0.25), lipCol: DARK });
      });
      k.belly(-0.26, 0.16, -0.03, 0.034, C, { scoop: false, d: 0.008 });
      k.muzzles.unshift({ x: 0.5, y: 0, z: 0 });
      k.wound(-0.12, 0.012, 0.13, 0.05, { yc: 0, h: 0.006, zs: 0.5 });
      k.wound(-0.08, F.top(-0.08), 0.0, 0.042, { h: 0.014 });
      k.wound(-0.26, 0.036, -0.062, 0.04, { yc: 0.004, h: 0.014, zs: 0.4 });
      k.wound(0.03, 0.012, -0.1, 0.045, { yc: 0, h: 0.006, zs: 0.5 });
      k.wound(0.2, F.top(0.2), 0.0, 0.034, { h: 0.01, zs: 0.4 });
      k.ornate(() => {
        SYM((s) => k.horn(-0.1, -0.24, 0.1, 0.14, 0.01, s * 0.062, 50));
        k.crest(0.06, -0.12, F.top(-0.03) + 0.002, 4, 0.036);
      });
    },
    rig(P, ix, S) {
      const a = S.roll * 0.4 + 0.03 * Math.sin(S.t * 0.003);
      P.a[ix.canR] = a; P.a[ix.canL] = -a - 0.5 * S.wreck;
    },
    liv(L) {
      detail(L, {
        xs: [0.26, 0.08, -0.1, -0.28], zs: [0.1, 0.24], seed: 9, soot: [[-0.42, 0.062]], wear: 0.55,
        tone: [[[[-0.03, 0.2], [-0.22, 0.31], [-0.36, 0.31], [-0.23, 0.2]], 0.5], [[[-0.03, -0.2], [-0.22, -0.31], [-0.36, -0.31], [-0.23, -0.2]], 0.5]],
      });
    },
  };
}

/* -------------------------------- HUNTER --------------------------------- */
// Kamikaze: a black ram spearhead on a blood-red dart, forward-swept blades and one enormous engine.
// Breaks: starboard blade, port blade, dorsal fin.
function defHunter() {
  const P = pal(0xe01208, 0x70080a, [8, 1.3, 0.25]);
  const BLK = lin(0x0c0c0e);
  const WING = [
    { z: 0.055, xl: -0.06, xt: -0.4, y: 0, th: 0.036 },
    { z: 0.15, xl: 0.0, xt: -0.25, y: 0, th: 0.026 },
    { z: 0.235, xl: 0.19, xt: 0.06, y: 0, th: 0.01 },
  ];
  return {
    zr: 0.36, P,
    geo(k) {
      const C = mul(lin(P.base), 0.86), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.4, w: 0.098, t: 0.086, b: 0.08, et: 1.9, eb: 1.9 }, { x: -0.24, w: 0.094, t: 0.08, b: 0.07, et: 1.7, eb: 1.7 },
        { x: 0.0, w: 0.064, t: 0.05, b: 0.044, et: 1.4, eb: 1.4 }, { x: 0.2, w: 0.042, t: 0.032, b: 0.03, et: 1.3, eb: 1.3 },
        { x: 0.32, w: 0.03, t: 0.02, b: 0.02, et: 1.3, eb: 1.3 },
      ], { n: k.seg(12), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C, { crease: 26 });
      // ram: barbed spearhead + vertical keel, black iron (gold on elites), with a collar where it bites into the hull
      const SP = [[0.5, 0], [0.33, 0.1], [0.24, 0.068], [0.265, 0.036], [0.17, 0.03], [0.17, -0.03], [0.265, -0.036], [0.24, -0.068], [0.33, -0.1]];
      k.trim(plate(SP, 0, 0.017, 0.007), { col: BLK, crease: 24 }); k.trim(plate(SP, 0, -0.017, 0.007), { col: BLK, crease: 24 });
      k.trim(loft([ringRect(0.14, -0.058, 0.058, -0.013, 0.013, 0.004), ringRect(0.36, -0.036, 0.036, -0.009, 0.009, 0.003), ringRect(0.495, -0.003, 0.003, -0.002, 0.002, 0.0006)]), { col: BLK, crease: 24 });
      k.solid(lathe([[0.12, 0.05], [0.15, 0.054], [0.19, 0.046]], 8, { sy: 0.86, capA: false, capB: false }), BLK, { crease: 26 });
      k.lamp(0.492, 0, 0, 0.007, mul(EYE, 0.6));
      k.eyes(-0.08, 0.12, 0.02, F.top(-0.08) + 0.02, F.top(0.12) + 0.01, 0.046, 0.026);
      SYM((s) => {
        k.col(side(blade([WING[0], WING[1]], { tip: false }), s), C, { crease: 24 });
        k.bar(WING, s, 0.08, 0.15, 0.3, 0.5, mul(G, 0.3));
        k.on(s > 0 ? 'wingR' : 'wingL', { pivot: [-0.12, 0, s * 0.15], detach: s > 0 ? 1 : 2, stump: { p: [-0.11, 0, s * 0.15], u: [0.75, 0, s * 0.66], v: [1, 0, 0], w: 0.08, len: 0.04 } }, () => {
          k.col(side(blade([WING[1], WING[2]]), s), C, { crease: 24, trim: 1 });
          k.bar(WING, s, 0.15, 0.225, 0.3, 0.5, mul(G, 0.3));
        });
        // shoulder intakes feeding the burner
        const r0 = ringRect(-0.06, -0.012, 0.05, 0.05, 0.1, 0.008);
        k.col(side(loft([ringRect(-0.34, 0.0, 0.05, 0.06, 0.1, 0.01), r0], { capB: false }), s), C2, { crease: 26 });
        k.duct(r0.map((p) => [p[0], p[1], p[2] * s]), 0.06, 0.006, { glow: [1.8, 0.4, 0.08], lipCol: BLK });
        k.vanes(-0.085, -0.008, 0.046, s * 0.056, s * 0.094, 3);
        k.gold(-0.3, 0.0, F.top(-0.15) + 0.002, s * 0.02, s * 0.032);
        k.solid(side(fin(-0.2, -0.4, 0.07, 0.11, 0.012, -0.03, 0.05, -58), s), BLK, { crease: 24 });
      });
      const fy = F.top(-0.3);
      k.on('fin', { pivot: [-0.28, fy - 0.006, 0], detach: 3, bend: [-0.6, 0, 0.1], stump: { p: [-0.31, fy - 0.004, 0], u: [0, 1, 0], v: [1, 0, 0], w: 0.07, len: 0.036 } },
        () => k.trim(fin(-0.1, -0.4, 0.13, 0.2, 0.018, 0.06), { crease: 24 }));
      k.solid(fin(-0.16, -0.4, 0.09, 0.14, 0.014, -0.05, 0, -90), BLK, { crease: 24 });
      // the engine: an oversized cowl and a burner half the width of the ship
      k.col(lathe([[-0.22, 0.09], [-0.32, 0.112], [-0.4, 0.116]], k.seg(12), { capA: false, capB: false, phase: TAU / 24 }), C2, { crease: 26 });
      k.solid(lathe([[-0.4, 0.116], [-0.43, 0.118], [-0.47, 0.106]], k.seg(12), { capA: false, capB: false, phase: TAU / 24 }), BLK, { crease: 26 });
      k.thruster(-0.5, 0, 0, 0.102, 0.17, { n: k.seg(12), glow: 1.25, np: 8 });
      k.muzzles.push({ x: 0.5, y: 0, z: 0 });
      k.wound(-0.16, F.top(-0.16, 0.04), 0.04, 0.06);
      k.wound(-0.05, 0.016, -0.11, 0.045, { yc: 0, h: 0.008, zs: 0.5 });
      k.wound(0.06, F.top(0.06), -0.01, 0.04, { h: 0.014 });
      k.wound(-0.32, F.top(-0.32, -0.05), -0.05, 0.065);
      k.wound(-0.2, 0.05, 0.085, 0.05, { yc: 0.02, h: 0.018 });
      k.ornate(() => {
        SYM((s) => k.horn(0.02, -0.14, 0.12, -0.16, 0.012, s * 0.05, 48));
        k.crest(-0.06, -0.2, F.top(-0.13) + 0.002, 3, 0.05);
      });
    },
    liv(L) {
      detail(L, {
        xs: [0.14, -0.08, -0.26], zs: [0.055, 0.15], seed: 13, soot: [[-0.4, 0]], wear: 0.7,
        tone: [[[[0.3, -0.007], [-0.4, -0.012], [-0.4, 0.012], [0.3, 0.007]], 0.14]],
        extra(l) { for (const s of [1, -1]) chevrons(l, 0.1, s * 0.185, 0.032, 2, 0.07, 0x141210); },
      });
    },
  };
}

/* --------------------------------- TANK ---------------------------------- */
// Armoured gunship: a slab hull under layered plates, rocket pods on pylons behind clamshell hatches,
// a twin-gun turret on the deck.
// Breaks: starboard pod armour, port side skirt, the whole port rocket pod.
function defTank() {
  const P = pal(0x9a5cf0, 0x4d2a8c, [4.2, 1.1, 9]);
  const PZ0 = 0.2, PZ1 = 0.335, PC = (PZ0 + PZ1) / 2;
  return {
    zr: 0.44, P, aim: { max: 2.7, rate: 2.6 },
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
      const F = fuselage([
        { x: -0.42, w: 0.125, t: 0.058, b: 0.056, et: 4, eb: 4 }, { x: -0.1, w: 0.16, t: 0.072, b: 0.062, et: 4, eb: 4 },
        { x: 0.2, w: 0.15, t: 0.068, b: 0.06, et: 3.6, eb: 3.6 }, { x: 0.39, w: 0.1, t: 0.046, b: 0.05, et: 3, eb: 3 },
        { x: 0.47, w: 0.062, t: 0.026, b: 0.036, et: 3, eb: 3 },
      ], { n: k.seg(16), sub: 2 });
      k.col(F.tris, C2, { crease: 26 });
      // layered armour: glacis, deck
      k.col(plate([[0.37, -0.085], [0.37, 0.085], [0.12, 0.14], [-0.3, 0.14], [-0.37, 0.105], [-0.37, -0.105], [-0.3, -0.14], [0.12, -0.14]], 0.04, 0.086, 0.008), C, { crease: 24 });
      k.col(plate([[0.1, -0.075], [0.1, 0.075], [-0.02, 0.1], [-0.28, 0.1], [-0.28, -0.1], [-0.02, -0.1]], 0.08, 0.108, 0.007), C2, { crease: 24, trim: 1 });
      k.trim(plate([[-0.17, -0.022], [-0.17, 0.022], [-0.27, 0.03], [-0.27, -0.03]], 0.1, 0.113, 0.004));
      k.eyes(0.24, 0.42, 0.04, 0.104, 0.058, 0.07, 0.048, { th: 0.22 });
      const pod = (s) => {
        k.col(side(box(-0.27, 0.2, -0.052, 0.052, PZ0, PZ1, 0.012), s), C2, { crease: 26 });
        const top = () => k.col(side(plate([[0.17, PZ0 + 0.012], [0.17, PZ1 - 0.012], [-0.24, PZ1 - 0.012], [-0.24, PZ0 + 0.012]], 0.045, 0.066, 0.006), s), C, { crease: 24, trim: 1 });
        const bar = () => k.bar([{ z: PZ0 + 0.03, xl: 0.14, xt: -0.2, y: 0.066, th: 0 }, { z: PZ1 - 0.03, xl: 0.14, xt: -0.2, y: 0.066, th: 0 }], s, PZ0 + 0.058, PZ1 - 0.058, 0, 1, mul(G, 0.3));
        if (s > 0) k.on('plateR', { pivot: [-0.03, 0.05, PC], detach: 1, stump: { p: [-0.08, 0.055, PC], u: [1, 0, 0], v: [0, 0, 1], w: 0.04, len: 0.07 } }, () => { top(); bar(); });
        else { top(); bar(); }
        k.col(side(plate([[0.15, PZ0 + 0.016], [0.15, PZ1 - 0.016], [-0.2, PZ1 - 0.016], [-0.2, PZ0 + 0.016]], -0.045, -0.062, 0.006), s), C2, { crease: 24 });
        k.trim(side(box(-0.26, 0.19, 0.03, 0.06, PZ1 - 0.006, PZ1 + 0.008, 0.004), s));
        k.solid(side(box(0.192, 0.204, -0.04, 0.04, PZ0 + 0.012, PZ1 - 0.012), s), PITCH);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
          const y = (r - 0.5) * 0.038, z = lerp(PZ0 + 0.03, PZ1 - 0.03, c / 2);
          k.solid(side(lathe([[0.19, 0.0135], [0.218, 0.0135], [0.228, 0.009]], 6, { y, z, capB: false }), s), lin(0xc9c4bc), { crease: 30 });
          k.solid(side(lathe([[0.228, 0.009], [0.246, 0.002]], 6, { y, z, capA: false }), s), lin(0xe8421c), { crease: 30 });
          if (q >= 1 || (r === 0 && c === 1)) k.charge(side(disc(0.2055, y, z, 0.017, 6), s), mul(AMBER, 0.5), 0.3 + 0.1 * (r * 3 + c));
        }
        // clamshell launcher hatch: two leaves hinged on the pod's top and bottom edges
        for (const up of [1, -1]) {
          k.on('hat' + (s > 0 ? 'R' : 'L') + (up > 0 ? 'U' : 'D'), { pivot: [0.203, up * 0.047, s * PC] }, () => {
            const y0 = Math.min(up * 0.0015, up * 0.05), y1 = Math.max(up * 0.0015, up * 0.05);
            k.col(side(box(0.2, 0.258, up > 0 ? 0.041 : -0.05, up > 0 ? 0.05 : -0.041, PZ0 + 0.006, PZ1 - 0.006, 0.003), s), C, { crease: 26 });
            k.col(side(box(0.25, 0.258, y0, y1, PZ0 + 0.006, PZ1 - 0.006, 0.003), s), C2, { crease: 26, trim: 1 });
          });
        }
        k.muzzles.push({ x: 0.245, y: 0, z: s * PC });
        k.thruster(-0.36, 0, s * PC, 0.04, 0.1, { n: k.seg(8) });
        k.lamp(-0.25, 0.062, s * (PZ1 - 0.02), 0.012, AMBER, CH.STROBE);
      };
      SYM((s) => {
        // rocket pod on a pylon
        k.solid(side(box(-0.16, 0.1, -0.022, 0.022, 0.13, PZ0 + 0.01, 0.006), s), DARK, { crease: 28 });
        if (s < 0) k.on('podL', { pivot: [-0.03, 0, -PC], detach: 3, stump: { p: [-0.03, 0, -(PZ0 + 0.004)], u: [0, 0, -1], v: [1, 0, 0], w: 0.11, len: 0.04, n: 7 } }, () => pod(s));
        else pod(s);
        // chin cannons, side skirt, main engines
        k.on('guns', { recoil: 0.03 }, () => k.gun(0.3, 0.5, -0.034, s * 0.042, 0.0085, { n: 8 }));
        const skirt = () => k.col(side(box(-0.32, 0.26, -0.072, -0.01, 0.15, 0.166, 0.006), s), C, { crease: 26 });
        if (s < 0) k.on('skirtL', { pivot: [-0.03, -0.02, -0.158], detach: 2, stump: { p: [-0.03, -0.024, -0.158], u: [0, -1, 0], v: [1, 0, 0], w: 0.24, len: 0.03, n: 9 } }, skirt);
        else skirt();
        k.thruster(-0.5, 0, s * 0.062, 0.05, 0.1, { n: k.seg(10) });
        k.gold(-0.26, 0.08, 0.1095, s * 0.082, s * 0.094);
      });
      k.solid(box(-0.44, -0.37, -0.03, 0.04, -0.03, 0.03, 0.006), DARK, { crease: 28 }); // mine chute
      k.belly(-0.34, 0.3, -0.064, 0.11, C, { bay: 0.6 });
      // deck turret: drum, mantlet, sight, twin guns
      k.turret(-0.06, 0.106, 0.058, 0.034, 0.16, 0.0085, C, C2);
      k.wound(0.2, 0.088, 0.06, 0.065, { yc: 0.03, h: 0.03 });
      k.wound(-0.2, 0.108, -0.07, 0.06, { yc: 0.04, h: 0.03 });
      k.wound(0.02, 0.054, 0.27, 0.06, { yc: 0, h: 0.03 });
      k.wound(-0.3, 0.088, 0.08, 0.06, { yc: 0.02, h: 0.03 });
      k.wound(0.32, F.top(0.32, -0.04), -0.04, 0.06);
      k.ornate(() => {
        SYM((s) => { k.horn(0.2, 0.04, 0.11, -0.12, 0.014, s * 0.12, 42, 0.06); k.crest(0.1, -0.2, 0.066, 4, 0.04, s * PC); });
      });
    },
    rig(P, ix, S) {
      P.r[ix.turret * 3 + 1] = -S.aim;
      P.a[ix.tguns] = 0.05 - 0.4 * S.wreck;
      const o = 1.3 * smooth(S.charge / 0.55), w = S.wreck;
      P.a[ix.hatRU] = Math.max(o, 0.5 * w); P.a[ix.hatRD] = -o; P.a[ix.hatLU] = o; P.a[ix.hatLD] = -Math.max(o, 0.9 * w);
    },
    liv(L) {
      detail(L, {
        xs: [0.26, 0.1, -0.08, -0.2], zs: [0.14, 0.2], seed: 17, soot: [[-0.42, 0.062], [-0.3, 0.268]], wear: 0.9,
        hatch: [[0.3, 0.02, 0.2, 0.07], [-0.3, 0.04, -0.36, 0.09]],
        extra(l) { for (const s of [1, -1]) { chevrons(l, 0.12, s * 0.268, 0.03, 3, 0.05); l.rivets([0.34, s * 0.09], [0.13, s * 0.132], 8); l.rivets([0.1, s * 0.132], [-0.29, s * 0.132], 14); } },
      });
    },
  };
}

/* -------------------------------- SNIPER --------------------------------- */
// A rail gun with an engine bolted on. Long and thin from above; head-on it is a
// gunsight — capacitor hoops shrinking toward the muzzle, a scope eye over the bore,
// four radiator blades in an X and a deep keel under them. The whole gun traverses a few
// degrees on its breech; charging spreads the rails and the radiators and spins the hoop collars.
// Breaks: upper starboard radiator, lower port radiator, keel.
function defSniper() {
  const P = pal(0x3a52e8, 0x1c2a8c, [1.1, 2.2, 10]);
  const RAIL = [1.3, 4.2, 10];
  const HOOP = [[-0.03, 0.084], [0.1, 0.072], [0.22, 0.061], [0.335, 0.051]]; // x, radius
  const FN = { xl: -0.19, xt: -0.43, h: 0.215, rake: -0.17, th: 0.022, y0: 0.026, z0: 0.04 };
  // a point on a radiator blade: chord fraction f, distance zl out along it, height off its surface
  const fp = (f, zl, cant, s, up) => {
    const u = zl / FN.h, x = lerp(FN.xl - FN.rake * u, FN.xt - FN.rake * 0.35 * u, f), th = lerp(FN.th, FN.th * 0.45, u);
    const off = up > 0 ? th * 0.5 + 0.0015 : up < 0 ? -(th * 0.36 + 0.0015) : 0, ca = Math.cos(cant * DEG), sa = Math.sin(cant * DEG);
    return [x, (cant > 0 ? FN.y0 : -FN.y0) + off * ca + zl * sa, s * (FN.z0 - off * sa + zl * ca)];
  };
  const RAD = (cant, s) => 'rad' + (s > 0 ? 'R' : 'L') + (cant > 0 ? 'U' : 'D');
  return {
    zr: 0.34, P, aim: { max: 0.13, rate: 0.5 },
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q, n8 = k.seg(8);
      const F = fuselage([
        { x: -0.46, w: 0.044, t: 0.042, b: 0.04, et: 1.6, eb: 1.6 }, { x: -0.36, w: 0.07, t: 0.06, b: 0.056, et: 1.5, eb: 1.5 },
        { x: -0.2, w: 0.074, t: 0.064, b: 0.058, et: 1.5, eb: 1.5 }, { x: -0.06, w: 0.054, t: 0.046, b: 0.044, et: 1.6, eb: 1.6 },
        { x: 0.05, w: 0.036, t: 0.028, b: 0.028, et: 2.4, eb: 2.4 },
      ], { n: k.seg(10), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C, { crease: 26 });
      // scope: a hooded tube on the spine with one great lens staring down the barrel
      const SY = 0.1, SR = 0.04;
      k.glassy(lathe([[-0.24, SR * 0.5], [-0.2, SR], [0.03, SR], [0.05, SR * 0.86], [0.035, SR * 0.8]], n8, { y: SY, phase: TAU / 16, capB: false }), VISOR);
      k.trim(lathe([[0.0, SR + 0.006], [0.058, SR + 0.006], [0.058, SR * 0.9], [0.0, SR * 0.9], [0.0, SR + 0.006]], n8, { y: SY, phase: TAU / 16, capA: false, capB: false }));
      k.solid(box(-0.2, 0.0, 0.04, SY - SR * 0.5, -0.014, 0.014, 0.004), DARK, { crease: 26 });
      k.glowDisc(0.038, SY, 0, [[0, mul(EYE, 1.25)], [SR * 0.28, EYE], [SR * 0.5, mul(EYE, 0.2)], [SR * 0.62, mul(EYE, 0.55)], [SR * 0.8, [0, 0, 0]]], n8, CH.EYE);
      k.strip(-0.17, 0.0, SY + SR + 0.0015, -0.006, 0.006, mul(EYE, 0.8), CH.EYE);
      k.charge(disc(0.0395, SY, 0, SR * 0.7, n8), [3, 4.5, 8], 0.08);
      SYM((s) => {
        // capacitor banks
        k.col(side(lathe([[-0.4, 0.016], [-0.37, 0.027], [-0.16, 0.027], [-0.12, 0.014]], n8, { y: 0.004, z: 0.09, phase: TAU / 16 }), s), C2, { crease: 26 });
        for (let i = 0; i < 3; i++) {
          const x = -0.34 + i * 0.07;
          k.metal(side(lathe([[x - 0.008, 0.031], [x + 0.008, 0.031]], n8, { y: 0.004, z: 0.09, phase: TAU / 16 }), s), GUN, 26);
          k.charge(side(lathe([[x + 0.009, 0.0295], [x + 0.022, 0.0295]], n8, { y: 0.004, z: 0.09, capA: false, capB: false, phase: TAU / 16 }), s), mul(RAIL, 0.55), 0.04 + i * 0.05);
        }
        // radiator blades: an X seen from ahead, forward-raked claws from above
        for (const cant of [50, -50]) {
          const up = cant > 0 ? 1 : -1, det = cant > 0 && s > 0 ? 1 : cant < 0 && s < 0 ? 2 : 0, sa = Math.sin(cant * DEG), ca = Math.cos(cant * DEG);
          const root = fp(0.5, 0.032, cant, s, 0), dir = [0.3, sa * 0.82, s * ca * 0.82];
          k.on(RAD(cant, s), { pivot: [-0.31, up * FN.y0, s * FN.z0], axis: [1, 0, 0], detach: det, bend: det ? null : [s * up * 0.4, 0, 0], stump: det ? { p: root, u: dir, v: [1, 0, 0], w: 0.085, len: 0.04 } : null }, () => {
            k.col(side(fin(FN.xl, FN.xt, FN.h, FN.rake, FN.th, cant > 0 ? FN.y0 : -FN.y0, FN.z0, cant), s), cant > 0 ? C : C2, { crease: 24, trim: cant > 0 ? 1 : 0 });
            for (const u of [1, -1]) k.quad(fp(0.27, 0.03, cant, s, u), fp(0.27, FN.h * 0.94, cant, s, u), fp(0.42, FN.h * 0.94, cant, s, u), fp(0.42, 0.03, cant, s, u), mul(G, 0.3));
            // heat-sink pod on the tip, its lamp pointing at you
            const tp = fp(0.3, FN.h, cant, 1, 0);
            k.trim(side(lathe([[tp[0] - 0.09, 0.004], [tp[0] - 0.05, 0.015], [tp[0] + 0.05, 0.015], [tp[0] + 0.075, 0.009]], 6, { y: tp[1], z: tp[2] }), s));
            k.lamp(tp[0] + 0.074, tp[1], s * tp[2], 0.011, mul(G, 0.95), CH.ACCENT);
          });
        }
        k.gold(-0.36, -0.14, 0.032, s * 0.09 - 0.005, s * 0.09 + 0.005);
      });
      // the gun: rails, hoops, bed and bore traverse together on the breech
      k.on('rail', { pivot: [-0.08, 0, 0], recoil: 0.04 }, () => {
        SYM((s) => k.on(s > 0 ? 'railR' : 'railL', { pivot: [0, 0, 0] }, () => {
          k.metal(side(loft([ringRect(-0.08, -0.022, 0.022, 0.01, 0.034, 0.004), ringRect(0.4, -0.017, 0.017, 0.01, 0.03, 0.004), ringRect(0.5, -0.009, 0.009, 0.01, 0.02, 0.002)]), s), GUN, 26);
          k.trim(side(box(0.44, 0.492, -0.024, 0.024, 0.03, 0.04, 0.004), s)); // muzzle brake
        }));
        // capacitor hoops: closed rings on four spokes; their forward faces light breech → muzzle as the shot charges
        HOOP.forEach(([x, R], i) => {
          const t = 0.013, ph = 0.16 + 0.2 * i;
          k.metal(lathe([[x - 0.014, R - t], [x - 0.008, R], [x + 0.008, R], [x + 0.014, R - t], [x + 0.008, R - 2 * t], [x - 0.008, R - 2 * t], [x - 0.014, R - t]], n8, { capA: false, capB: false, phase: TAU / 16 }), i % 2 ? GUN : DARK, 26);
          for (let j = 0; j < 4; j++) k.solid(rotX(box(x - 0.006, x + 0.006, 0.016, R - t, -0.005, 0.005, 0.002), (j / 4) * TAU + TAU / 8), i % 2 ? DARK : C2, { crease: 26 });
          k.halo(x + 0.0148, 0, 0, R - 2 * t + 0.003, R - 0.003, mul(RAIL, 0.5), n8, CH.CHARGE, ph);
          // collar: lugs and light bands that wind round the hoop as the capacitors spool
          k.on('hoops', { pivot: [0, 0, 0], axis: [1, 0, 0] }, () => {
            for (let j = 0; j < 4; j++) k.trim(rotX(box(x - 0.011, x + 0.011, R - 0.002, R + 0.011, -0.012, 0.012, 0.003), (j / 4) * TAU + i * 0.5));
            k.glowTris(lathe([[x - 0.004, R + 0.0012], [x + 0.004, R + 0.0012]], n8, { capA: false, capB: false, phase: TAU / 16 }), mul(G, 0.22), CH.ACCENT);
            k.charge(lathe([[x - 0.007, R + 0.0016], [x + 0.007, R + 0.0016]], n8, { capA: false, capB: false, phase: TAU / 16 }), mul(RAIL, 0.4), ph);
          });
        });
        // rail bed
        const NB = q >= 1 ? 5 : 3;
        for (let i = 0; i < NB; i++) {
          const x = lerp(0.03, 0.43, i / (NB - 1));
          k.solid(box(x - 0.014, x + 0.014, -0.032, -0.016, -0.044, 0.044, 0.004), DARK, { crease: 26 });
          SYM((s) => k.on(s > 0 ? 'railR' : 'railL', {}, () => k.charge(box(x - 0.008, x + 0.008, 0.0222, 0.0245, s * 0.012, s * 0.032), mul(RAIL, 0.6), 0.2 + 0.62 * (i / (NB - 1)))));
        }
        // the bore: a ribbon of plasma that fills breech → muzzle as the shot charges
        const NS = q >= 1 ? 12 : 6;
        for (let i = 0; i < NS; i++) {
          const x0 = lerp(-0.06, 0.49, i / NS), x1 = lerp(-0.06, 0.49, (i + 1) / NS), ph = 0.14 + 0.7 * (i / (NS - 1));
          k.strip(x0, x1, 0.0, -0.0095, 0.0095, RAIL, CH.CHARGE, ph);
          k.charge([x0, -0.017, 0, x1, -0.017, 0, x1, 0.017, 0, x0, -0.017, 0, x1, 0.017, 0, x0, 0.017, 0], mul(RAIL, 0.7), ph);
        }
        // the glare in the bore and the star that burns at full charge
        k.charge(disc(0.501, 0, 0, 0.03, 8), mul(RAIL, 0.9), 0.5);
        const MS = [2.2, 6, 12], mx = 0.5;
        for (const [dy, dz] of [[0.11, 0], [0, 0.11], [0.06, 0.06], [0.06, -0.06]]) {
          k.charge([mx, -dy, -dz, mx + 0.012, 0, 0, mx, dy, dz, mx, -dy, -dz, mx - 0.012, 0, 0, mx, dy, dz], MS, 0.97);
          k.charge([mx - 0.05, 0, 0, mx, dy * 0.16, dz * 0.16, mx + 0.04, 0, 0, mx - 0.05, 0, 0, mx, -dy * 0.16, -dz * 0.16, mx + 0.04, 0, 0], MS, 0.97);
        }
        k.muzzles.push({ x: 0.5, y: 0, z: 0 });
      });
      // breech block the gun turns in
      k.solid(lathe([[-0.1, 0.05], [-0.07, 0.056], [-0.04, 0.05]], n8, { capA: false, capB: false, phase: TAU / 16 }), DARK, { crease: 26 });
      // keel: a long blade under the breech carrying the coolant line
      k.on('keel', { pivot: [-0.2, -0.05, 0], detach: 3, stump: { p: [-0.21, -0.058, 0], u: [0, -1, 0], v: [1, 0, 0], w: 0.13, len: 0.03, n: 7 } }, () => {
        k.solid(fin(0.0, -0.4, 0.15, 0.03, 0.022, -0.04, 0, -90), DARK, { crease: 24 });
        k.trim(lathe([[-0.34, 0.005], [-0.3, 0.017], [-0.06, 0.017], [-0.01, 0.008]], 6, { y: -0.19 }));
        k.lamp(-0.012, -0.19, 0, 0.011, mul(G, 0.9), CH.ACCENT);
        k.strip(-0.3, -0.06, -0.19 - 0.018, -0.005, 0.005, mul(G, 0.3));
      });
      k.trim(fin(-0.26, -0.44, 0.07, 0.1, 0.012, 0.05, 0, 90));
      k.thruster(-0.5, 0, 0, 0.05, 0.1, { n: n8 });
      k.wound(-0.26, F.top(-0.26, 0.04), 0.04, 0.05);
      k.wound(-0.24, 0.03, -0.092, 0.042, { yc: 0.004, h: 0.014, zs: 0.4 });
      k.wound(-0.12, F.top(-0.12, -0.02), -0.02, 0.045, { h: 0.016 });
      k.wound(-0.36, F.top(-0.36, 0.03), 0.03, 0.045, { h: 0.016 });
      k.wound(-0.2, 0.03, 0.092, 0.042, { yc: 0.004, h: 0.014, zs: 0.4 });
      k.ornate(() => {
        k.crest(-0.26, -0.4, F.top(-0.33) - 0.004, 3, 0.05, 0.0);
        SYM((s) => k.horn(-0.1, -0.2, 0.09, -0.14, 0.01, s * 0.09, 20, 0.02));
      });
    },
    rig(P, ix, S) {
      const c = smooth(S.charge), w = S.wreck;
      P.r[ix.rail * 3 + 1] = -S.aim; P.r[ix.rail * 3 + 2] = -0.07 * w;
      P.p[ix.railR * 3 + 2] = 0.013 * c; P.p[ix.railL * 3 + 2] = -0.013 * c;
      S.acc[0] += S.dt * 0.001 * (0.5 + 9 * S.charge * S.charge) * (1 - w);
      P.a[ix.hoops] = S.acc[0] % TAU;
      const o = 0.2 * c + 0.012 * Math.sin(S.t * 0.002);
      P.a[ix.radRU] += o; P.a[ix.radLD] += o; P.a[ix.radRD] -= o; P.a[ix.radLU] -= o;
    },
    liv(L) {
      detail(L, { xs: [-0.1, -0.2, -0.3], zs: [0.05, 0.13], seed: 19, soot: [[-0.42, 0]], wear: 0.5, tone: [[[[-0.06, -0.03], [-0.44, -0.03], [-0.44, 0.03], [-0.06, 0.03]], 0.55]] });
    },
  };
}

/* -------------------------------- CARRIER -------------------------------- */
// Drone tender: a broad flight deck over two hangar bays behind blast doors, lit launch ramps,
// a point-defence turret on the island and a radar turning on the mast.
// Breaks: starboard claw sponson, port claw sponson, mast.
function defCarrier() {
  const P = pal(0xf08a14, 0x94500c, [8, 3.4, 0.35]);
  const BZ0 = 0.095, BZ1 = 0.25, BC = (BZ0 + BZ1) / 2;
  const CLAW = [{ z: 0.262, xl: 0.02, xt: -0.34, y: -0.004, th: 0.04 }, { z: 0.31, xl: 0.06, xt: -0.2, y: -0.004, th: 0.028 }, { z: 0.345, xl: 0.2, xt: 0.04, y: -0.004, th: 0.012 }];
  return {
    zr: 0.46, P, aim: { max: 2.0, rate: 3 },
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
      const F = fuselage([
        { x: -0.44, w: 0.2, t: 0.042, b: 0.046, et: 4, eb: 4 }, { x: -0.2, w: 0.27, t: 0.05, b: 0.052, et: 4, eb: 4 },
        { x: 0.08, w: 0.275, t: 0.05, b: 0.052, et: 4, eb: 4 }, { x: 0.2, w: 0.262, t: 0.046, b: 0.05, et: 4, eb: 4 },
      ], { n: k.seg(16), sub: 2 });
      k.col(F.tris, C, { crease: 26 });
      // command prow
      const N = fuselage([
        { x: 0.02, w: 0.085, t: 0.074, b: 0.05, et: 2.4, eb: 2.4 }, { x: 0.24, w: 0.07, t: 0.056, b: 0.044, et: 1.8, eb: 2 },
        { x: 0.42, w: 0.034, t: 0.026, b: 0.024, et: 1.5, eb: 1.5 }, { x: 0.5, w: 0.006, t: 0.004, b: 0.004, et: 1.5, eb: 1.5 },
      ], { n: k.seg(10), sub: 2 });
      k.col(N.tris, C2, { crease: 26, trim: 1 });
      k.eyes(0.14, 0.36, 0.03, N.top(0.14) + 0.016, N.top(0.36) + 0.008, 0.052, 0.03);
      // island + mast with a turning radar
      k.solid(box(-0.34, -0.1, 0.04, 0.1, -0.06, 0.06, 0.012), DARK, { crease: 26 });
      k.trim(box(-0.3, -0.14, 0.098, 0.116, -0.036, 0.036, 0.006));
      k.glowBox(-0.1005, -0.097, 0.066, 0.084, -0.046, 0.046, mul(G, 0.5), CH.ACCENT);
      k.on('mast', { pivot: [-0.272, 0.116, 0], detach: 3, bend: [0.5, 0, -0.3], stump: { p: [-0.272, 0.118, 0], u: [0, 1, 0], v: [1, 0, 0], w: 0.011, len: 0.02, n: 3 } }, () => {
        k.solid(box(-0.286, -0.258, 0.112, 0.142, -0.013, 0.013, 0.004), GUN, { crease: 30 });
        k.solid(box(-0.276, -0.268, 0.14, 0.2, -0.004, 0.004), GUN, { crease: 30 });
        k.lamp(-0.272, 0.205, 0, 0.008, AMBER, CH.STROBE);
        k.on('dish', { pivot: [-0.272, 0.166, 0], axis: [0, 1, 0], spin: 2.4 }, () => {
          k.trim(box(-0.279, -0.265, 0.158, 0.174, -0.04, 0.04, 0.002));
          k.solid(box(-0.264, -0.26, 0.16, 0.172, -0.036, 0.036, 0.001), PITCH, { crease: 30 });
        });
      });
      SYM((s) => {
        // hangar mouth in the bow face + launch ramp running forward out of it
        k.duct(ringRect(0.2, -0.038, 0.034, BZ0, BZ1, 0.008).map((p) => [p[0], p[1], p[2] * s]), 0.14, 0.009, { glow: mul(G, 0.75), lipCol: DARK });
        k.solid(side(loft([ringRect(0.16, -0.05, -0.034, BZ0 + 0.006, BZ1 - 0.006, 0.004), ringRect(0.345, -0.05, -0.038, BZ0 + 0.02, BZ1 - 0.02, 0.003)]), s), DARK, { crease: 26 });
        const NL = q >= 1 ? 4 : 2;
        for (let i = 0; i < NL; i++) {
          const x = lerp(0.225, 0.325, NL > 1 ? i / (NL - 1) : 0), ph = 0.15 + 0.65 * (i / NL);
          for (const z of [BZ0 + 0.03, BZ1 - 0.03]) k.charge(box(x - 0.007, x + 0.007, -0.0338, -0.031, s * z - 0.006, s * z + 0.006), mul(AMBER, 1.1), ph);
        }
        k.strip(0.21, 0.335, -0.0335, s * BC - 0.004, s * BC + 0.004, mul(G, 0.3));
        // blast door: hinged along the top of the mouth, it lifts into an awning as the bay readies a drone
        k.on(s > 0 ? 'doorR' : 'doorL', { pivot: [0.204, 0.032, s * BC] }, () => {
          k.col(side(box(0.201, 0.208, -0.03, 0.032, BZ0 + 0.007, BZ1 - 0.007, 0.002), s), C2, { crease: 26 });
          k.trim(side(box(0.207, 0.211, -0.03, -0.02, BZ0 + 0.012, BZ1 - 0.012, 0.001), s));
          for (let i = 0; i < 3; i++) k.solid(side(box(0.2075, 0.2105, -0.012 + i * 0.014, -0.006 + i * 0.014, BZ0 + 0.016, BZ1 - 0.016, 0.001), s), DARK, { crease: 30 });
        });
        // deck plate over the bay with a guide light line
        k.col(side(plate([[0.19, BZ0 - 0.004], [0.19, BZ1 + 0.004], [-0.3, BZ1 + 0.004], [-0.36, BZ1 - 0.04], [-0.36, BZ0 - 0.004]], 0.03, 0.062, 0.007), s), C, { crease: 24 });
        k.strip(-0.3, 0.17, 0.0645, s * BC - 0.0045, s * BC + 0.0045, mul(G, 0.5));
        k.trim(side(box(-0.34, 0.19, 0.04, 0.07, BZ1 + 0.002, BZ1 + 0.014, 0.004), s));
        k.gold(-0.3, 0.17, 0.0645, s * (BZ1 - 0.012), s * (BZ1 - 0.004));
        // claw sponsons
        k.on(s > 0 ? 'clawR' : 'clawL', { pivot: [-0.16, -0.004, s * 0.27], detach: s > 0 ? 1 : 2, stump: { p: [-0.16, -0.004, s * 0.274], u: [0.2, 0, s], v: [1, 0, 0], w: 0.13, len: 0.028, n: 7 } }, () => {
          k.col(side(blade(CLAW), s), C2, { crease: 24, trim: 1 });
          k.lamp(0.19, 0.004, s * 0.345, 0.011, AMBER, CH.STROBE);
        });
        k.thruster(-0.5, 0, s * 0.15, 0.046, 0.1, { n: k.seg(8) });
        k.muzzles.push({ x: 0.33, y: -0.02, z: s * BC });
        // belly: bay floor plate with a drop hatch
        k.col(side(plate([[0.14, BZ0 + 0.004], [0.14, BZ1 - 0.004], [-0.32, BZ1 - 0.004], [-0.32, BZ0 + 0.004]], -0.045, -0.064, 0.006), s), C2, { crease: 24 });
        k.solid(side(box(-0.2, 0.04, -0.068, -0.062, BZ0 + 0.03, BZ1 - 0.03, 0.002), s), PITCH, { crease: 30 });
        k.strip(-0.19, 0.03, -0.0685, s * BC - 0.004, s * BC + 0.004, mul(G, 0.25));
      });
      k.thruster(-0.5, 0, 0, 0.055, 0.11, { n: k.seg(10) });
      k.belly(-0.32, 0.2, -0.05, 0.075, C2, { bay: 0.45 });
      k.turret(-0.165, 0.115, 0.032, 0.022, 0.1, 0.006, C2, C);
      k.wound(0.0, 0.064, 0.17, 0.07, { yc: 0.0, h: 0.03 });
      k.wound(-0.22, 0.064, -0.17, 0.07, { yc: 0.0, h: 0.03 });
      k.wound(0.18, N.top(0.18, 0.02), 0.02, 0.055);
      k.wound(-0.22, 0.064, 0.2, 0.065, { yc: 0.0, h: 0.03 });
      k.wound(0.06, 0.064, -0.19, 0.07, { yc: 0.0, h: 0.03 });
      k.ornate(() => {
        SYM((s) => { k.horn(0.16, 0.0, 0.1, -0.12, 0.012, s * 0.07, 40, 0.03); k.crest(0.1, -0.3, 0.07, 5, 0.034, s * (BZ1 + 0.008)); });
      });
    },
    rig(P, ix, S) {
      P.r[ix.turret * 3 + 1] = -S.aim;
      P.a[ix.tguns] = 0.08 - 0.4 * S.wreck;
      const o = 0.1 + 1.3 * smooth(S.charge / 0.6);
      P.a[ix.doorR] = Math.max(o, 0.7 * S.wreck); P.a[ix.doorL] = o * (1 - 0.6 * S.wreck);
    },
    liv(L) {
      detail(L, {
        xs: [0.1, -0.04, -0.18, -0.32], zs: [0.09, 0.255], seed: 23, soot: [[-0.42, 0], [-0.42, 0.15]], wear: 0.8,
        extra(l) {
          for (const s of [1, -1]) {
            // landing strip: dark lane with dashed centre markings
            l.fill(l.rect(0.19, s * (BC - 0.04), -0.33, s * (BC + 0.04)), 0x5a5a5a, { rough: 0.7, metal: 0.1 });
            for (let i = 0; i < 6; i++) l.fill(l.rect(0.15 - i * 0.08, s * (BC - 0.03), 0.12 - i * 0.08, s * (BC - 0.022)), 0xffffff);
            for (let i = 0; i < 6; i++) l.fill(l.rect(0.15 - i * 0.08, s * (BC + 0.022), 0.12 - i * 0.08, s * (BC + 0.03)), 0xffffff);
            chevrons(l, 0.15, s * 0.3, 0.02, 3, 0.05);
          }
        },
      });
    },
  };
}

/* ----------------------------- SHIELDBEARER ------------------------------ */
// Projector ship: a compact core carrying a hexagonal emitter frame. The frame is dark steel; only
// the six projector lenses on its corners burn, facing out toward the bubble they hold up. Two
// focusing rings counter-rotate round the crystal on its spine.
// Breaks: starboard projector, port projector, dorsal fin.
function defShieldbearer() {
  const P = pal(0x2e8ea6, 0x12485a, [0.9, 6, 8]);
  const R = 0.27, RX = -0.02;
  const beam = (ax, az, bx, bz, w, y0, y1) => { const L = Math.hypot(bx - ax, bz - az), a = Math.atan2(bz - az, bx - ax); return move(rotY(box(-L / 2, L / 2, y0, y1, -w, w, w * 0.45), a, 0, 0), (ax + bx) / 2, 0, (az + bz) / 2); };
  return {
    zr: 0.44, P,
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.44, w: 0.07, t: 0.046, b: 0.044, et: 2, eb: 2 }, { x: -0.2, w: 0.118, t: 0.074, b: 0.06, et: 1.7, eb: 1.7 },
        { x: 0.06, w: 0.118, t: 0.07, b: 0.056, et: 1.6, eb: 1.6 }, { x: 0.3, w: 0.06, t: 0.036, b: 0.03, et: 1.5, eb: 1.5 },
        { x: 0.44, w: 0.02, t: 0.012, b: 0.012, et: 1.5, eb: 1.5 }, { x: 0.5, w: 0.004, t: 0.003, b: 0.003, et: 1.5, eb: 1.5 },
      ], { n: k.seg(12), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C, { crease: 26 });
      k.col(plate([[0.16, -0.05], [0.16, 0.05], [-0.06, 0.085], [-0.3, 0.07], [-0.3, -0.07], [-0.06, -0.085]], 0.04, F.top(-0.1) + 0.012, 0.008), C2, { crease: 24 });
      k.eyes(0.14, 0.34, 0.016, F.top(0.14) + 0.018, F.top(0.34) + 0.008, 0.05, 0.028);
      // hexagonal emitter frame
      const node = (i) => { const a = (30 + i * 60) * DEG; return [RX + Math.cos(a) * R, Math.sin(a) * R, a]; };
      for (let i = 0; i < 6; i++) {
        const [ax, az, a] = node(i), [bx, bz] = node((i + 1) % 6), c = Math.cos(a), s = Math.sin(a);
        k.metal(beam(ax, az, bx, bz, 0.013, -0.012, 0.014), i % 2 ? GUN : DARK, 26);
        const m = (t, o) => { const x = lerp(ax, bx, t), z = lerp(az, bz, t), l = Math.hypot(bx - ax, bz - az); return [x - ((bz - az) / l) * o, 0.0155, z + ((bx - ax) / l) * o]; };
        k.quad(m(0.2, -0.003), m(0.8, -0.003), m(0.8, 0.003), m(0.2, 0.003), mul(G, 0.12));
        // corner projector: a drum (gold on elites), two prongs reaching outward and a lens between them
        const proj = () => {
          k.trim(latheY([[-0.03, 0.024], [-0.022, 0.03], [0.024, 0.03], [0.032, 0.022], [0.032, 0.0005]], 6, ax, az), { crease: 26 });
          for (const dy of [0.014, -0.014]) k.metal(move(rotY(box(0.022, 0.07, dy - 0.005, dy + 0.005, -0.006, 0.006, 0.002), a, 0, 0), ax, 0, az), GUN, 26);
          k.lamp(ax + c * 0.046, 0, az + s * 0.046, 0.0125, mul(G, 0.62), CH.ACCENT);
          k.lamp(ax, 0.036, az, 0.008, mul(G, 0.4), CH.ACCENT);
        };
        if (i === 1 || i === 4) k.on(i === 1 ? 'emR' : 'emL', { pivot: [ax, 0, az], detach: i === 1 ? 1 : 2, stump: { p: [ax, 0.002, az], u: [c, 0, s], v: [-s, 0, c], w: 0.02, len: 0.026, n: 4 } }, proj);
        else proj();
        // spoke back to the hull
        k.trim(move(rotY(box(0.06, R - 0.026, -0.006, 0.01, -0.009, 0.009, 0.003), a, 0, 0), RX, 0, 0));
        const p = (r, o) => [RX + c * r - s * o, 0.0118, s * r + c * o];
        k.quad(p(0.13, -0.004), p(R - 0.04, -0.004), p(R - 0.04, 0.004), p(0.13, 0.004), GOLD_GLOW, CH.GOLD);
      }
      // focusing crystal on the spine and the two rings that turn round it
      const cy = F.top(-0.1) + 0.01;
      k.solid(latheY([[cy, 0.034], [cy + 0.01, 0.03], [cy + 0.014, 0.02]], 6, -0.1, 0), DARK, { crease: 26 });
      k.glowTris(latheY([[cy + 0.01, 0.018], [cy + 0.026, 0.012], [cy + 0.04, 0.0005]], 6, -0.1, 0), mul(G, 0.7), CH.ACCENT);
      [[0.056, cy + 0.012, 1.7, 'ringA'], [0.078, cy + 0.004, -1.1, 'ringB']].forEach(([rr, ry, spin, name], j) => {
        k.on(name, { pivot: [-0.1, ry, 0], axis: [0, 1, 0], spin }, () => {
          k.metal(torusY(-0.1, ry, 0, rr, 0.006, 0.0045, k.seg(12)), j ? DARK : GUN, 30);
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU + j, c = Math.cos(a), s = Math.sin(a);
            k.trim(move(rotY(box(-0.011, 0.011, -0.007, 0.009, -0.009, 0.009, 0.002), a + TAU / 4, 0, 0), -0.1 + c * rr, ry, s * rr));
            k.lamp(-0.1 + c * rr, ry + 0.012, s * rr, 0.006, mul(G, 0.5), CH.ACCENT);
          }
        });
      });
      const fy = F.top(-0.33);
      k.on('fin', { pivot: [-0.32, fy - 0.004, 0], detach: 3, bend: [0.6, 0, 0], stump: { p: [-0.34, fy - 0.002, 0], u: [0, 1, 0], v: [1, 0, 0], w: 0.05, len: 0.028 } },
        () => k.trim(fin(-0.22, -0.42, 0.08, 0.12, 0.014, 0.045)));
      SYM((s) => k.thruster(-0.5, 0, s * 0.045, 0.036, 0.09, { n: k.seg(8) }));
      k.on('gun', { recoil: 0.025 }, () => k.gun(0.3, 0.46, -0.02, 0, 0.0065));
      k.belly(-0.3, 0.14, -0.05, 0.07, C2);
      k.wound(0.04, F.top(0.04, 0.05), 0.05, 0.055);
      k.wound(-0.24, F.top(-0.24, -0.04), -0.04, 0.055);
      k.wound(0.2, F.top(0.2, -0.02), -0.02, 0.045, { h: 0.014 });
      k.wound(-0.02, 0.03, -0.1, 0.05, { yc: 0, h: 0.02 });
      k.wound(-0.3, F.top(-0.3, 0.03), 0.03, 0.05, { h: 0.016 });
      k.ornate(() => {
        SYM((s) => k.horn(0.1, -0.02, 0.09, -0.1, 0.01, s * 0.08, 40, 0.02));
        for (let i = 0; i < 6; i++) { const [ax, az] = node(i); k.trim(latheY([[0.032, 0.012], [0.07, 0.006], [0.1, 0.0005]], 4, ax, az), { crease: 30 }); k.lamp(ax, 0.104, az, 0.007, GOLD_GLOW, CH.GOLD); }
      });
    },
    liv(L) {
      detail(L, { xs: [0.2, 0.0, -0.2], zs: [0.07], hw: 0.13, seed: 29, soot: [[-0.44, 0.045]], wear: 0.45, tone: [[[[0.1, -0.02], [-0.28, -0.03], [-0.28, 0.03], [0.1, 0.02]], 0.55]] });
    },
  };
}

/* -------------------------------- STRAFER -------------------------------- */
// Gunship: a three-barrel fan battery on a short gunmetal hull. Hot pink only where it warns you —
// the outer wing panels, the barrel sleeves, and three muzzle lights that never go out. The battery
// traverses on its mount and the fluted barrels spool up before a burst.
// Breaks: starboard outer wing, port outer wing, starboard fin.
function defStrafer() {
  const P = pal(0xff2c8c, 0x7c0e44, [9, 0.9, 3.2]);
  const HC = lin(0x30343e), HC2 = lin(0x1c1e25);
  const WING = [
    { z: 0.08, xl: 0.0, xt: -0.36, y: -0.002, th: 0.04 },
    { z: 0.19, xl: -0.04, xt: -0.26, y: -0.002, th: 0.03 },
    { z: 0.285, xl: 0.1, xt: -0.1, y: -0.002, th: 0.014 },
  ];
  return {
    zr: 0.42, P, aim: { max: 0.3, rate: 1.4 },
    geo(k) {
      const C = mul(lin(P.base), 0.82), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.44, w: 0.06, t: 0.04, b: 0.04, et: 2, eb: 2 }, { x: -0.22, w: 0.1, t: 0.062, b: 0.05, et: 1.8, eb: 1.8 },
        { x: 0.0, w: 0.104, t: 0.062, b: 0.05, et: 1.8, eb: 1.8 }, { x: 0.13, w: 0.08, t: 0.046, b: 0.042, et: 2.2, eb: 2.2 },
      ], { n: k.seg(12), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, HC, { crease: 26 });
      // battery housing
      k.solid(loft([ringRect(0.0, -0.046, 0.03, -0.09, 0.09, 0.014), ringRect(0.17, -0.04, 0.026, -0.098, 0.098, 0.012), ringRect(0.215, -0.03, 0.016, -0.08, 0.08, 0.01)]), DARK, { crease: 26 });
      k.trim(box(0.02, 0.17, 0.024, 0.036, -0.1, -0.085, 0.004)); k.trim(box(0.02, 0.17, 0.024, 0.036, 0.085, 0.1, 0.004));
      k.eyes(-0.14, 0.06, 0.03, F.top(-0.14) + 0.02, F.top(0.06) + 0.012, 0.05, 0.034);
      // pink spine flash
      k.col(plate([[-0.16, -0.016], [-0.16, 0.016], [-0.4, 0.01], [-0.4, -0.01]], 0.03, F.top(-0.26) + 0.008, 0.004), C, { crease: 24 });
      // three heavy barrels fanned ±7° on a traversing cradle
      const nb = k.seg(8), MZ = [9, 1.2, 3.4];
      k.on('battery', { pivot: [0.13, -0.008, 0] }, () => {
        k.metal(loft([ringRect(0.19, -0.03, 0.014, -0.086, 0.086, 0.008), ringRect(0.245, -0.027, 0.011, -0.092, 0.092, 0.007)]), GUN, 26);
        [0, 1, -1].forEach((s, i) => {
          const z = s * 0.058, ang = s * 7 * DEG, R = (t) => rotY(t, ang, 0.16, z), r = 0.0135, y = -0.008;
          k.on('bar' + i, { pivot: [0.16, y, z], axis: [Math.cos(ang), 0, Math.sin(ang)], recoil: 0.035 }, () => {
            k.metal(R(lathe([[0.16, r * 1.7], [0.24, r * 1.7], [0.25, r], [0.42, r], [0.43, r * 1.5], [0.5, r * 1.5], [0.497, r * 0.8], [0.45, r * 0.7]], nb, { y, z, capB: false })), GUN, 26);
            k.col(R(lathe([[0.265, r * 1.42], [0.39, r * 1.42]], nb, { y, z })), C, { crease: 26 }); // cooling sleeve
            for (let j = 0; j < 4; j++) k.metal(R(rotX(box(0.272, 0.383, y + r * 1.3, y + r * 1.95, z - 0.0028, z + 0.0028, 0.001), (j / 4) * TAU + TAU / 8, y, z)), GUN, 26); // flutes
            k.charge(R(disc(0.4985, y, z, r * 0.85, nb)), MZ, i ? 0.62 : 0.28);
            k.charge(R(box(0.275, 0.375, y + r * 1.44, y + r * 1.44 + 0.002, z - 0.003, z + 0.003)), mul(MZ, 0.5), i ? 0.5 : 0.18);
            const m = R([0.5, y, z]);
            k.lamp(m[0] + 0.003, m[1], m[2], 0.0125, mul(MZ, 0.42), CH.ACCENT); // pilot light
            k.muzzles.push({ x: m[0], y: m[1], z: m[2] });
          });
        });
      });
      const WM = wAt(WING, 0.165);
      SYM((s) => {
        k.col(side(blade([WING[0], WM], { tip: false }), s), HC2, { crease: 24 });
        k.bar(WING, s, 0.1, 0.16, 0.32, 0.5, mul(G, 0.3));
        k.on(s > 0 ? 'wingR' : 'wingL', { pivot: [-0.157, -0.002, s * 0.165], detach: s > 0 ? 1 : 2, stump: { p: [-0.157, -0.002, s * 0.165], u: [0, 0, s], v: [1, 0, 0], w: 0.085, len: 0.028 } }, () => {
          k.col(side(blade([WM, WING[1], WING[2]]), s), C, { crease: 24, trim: 1 });
          k.trim(side(lathe([[-0.12, 0.004], [-0.08, 0.018], [0.1, 0.018], [0.2, 0.003]], 6, { y: -0.002, z: 0.285 }), s));
          k.lamp(-0.1, 0.018, s * 0.285, 0.01, AMBER);
          k.flap(WING, s, 0.2, 0.272, 0.036);
        });
        // engine nacelles
        k.col(side(lathe([[-0.42, 0.04], [-0.3, 0.046], [-0.14, 0.04], [-0.04, 0.016]], k.seg(8), { y: 0.004, z: 0.1, phase: TAU / 16 }), s), HC, { crease: 26 });
        k.thruster(-0.5, 0.004, s * 0.1, 0.042, 0.1, { n: k.seg(8) });
        k.on(s > 0 ? 'finR' : 'finL', { pivot: [-0.32, 0.05, s * 0.108], axis: [1, 0, 0], detach: s > 0 ? 3 : 0, bend: s > 0 ? null : [-0.5, 0, 0], stump: { p: [-0.33, 0.056, s * 0.11], u: [0, 0.93, s * 0.37], v: [1, 0, 0], w: 0.055, len: 0.028 } },
          () => k.trim(side(fin(-0.22, -0.42, 0.09, 0.14, 0.014, 0.03, 0.1, 68), s)));
        k.solid(side(fin(-0.24, -0.42, 0.06, 0.1, 0.012, -0.03, 0.1, -64), s), DARK, { crease: 24 });
        k.gold(-0.36, -0.12, 0.052, s * 0.1 - 0.006, s * 0.1 + 0.006);
      });
      k.belly(-0.3, 0.12, -0.046, 0.066, HC2, { glow: mul(MZ, 0.2) });
      k.wound(-0.2, F.top(-0.2, 0.03), 0.03, 0.055);
      k.wound(0.08, 0.03, -0.05, 0.05, { yc: 0, h: 0.02 });
      k.wound(-0.24, 0.05, -0.1, 0.045, { yc: 0.006, h: 0.02, zs: 0.45 });
      k.wound(-0.06, F.top(-0.06, -0.04), -0.04, 0.05);
      k.wound(-0.12, 0.016, 0.13, 0.045, { yc: -0.002, h: 0.008, zs: 0.4 });
      k.ornate(() => {
        SYM((s) => k.horn(0.0, -0.12, 0.1, -0.14, 0.012, s * 0.09, 44, 0.02));
        k.crest(-0.18, -0.38, F.top(-0.28) + 0.004, 4, 0.04);
      });
    },
    rig(P, ix, S) {
      P.r[ix.battery * 3 + 1] = -S.aim; P.r[ix.battery * 3 + 2] = -0.1 * S.wreck;
      S.acc[0] += S.dt * 0.001 * (0.6 + 26 * S.charge * S.charge) * (1 - S.wreck);
      P.a[ix.bar0] = S.acc[0] % TAU; P.a[ix.bar1] = (-S.acc[0] * 1.13) % TAU; P.a[ix.bar2] = (S.acc[0] * 0.89) % TAU;
    },
    liv(L) {
      detail(L, {
        xs: [-0.04, -0.2, -0.32], zs: [0.08, 0.19], seed: 31, soot: [[-0.42, 0.1]], wear: 0.7,
        tone: [[[[-0.02, -0.03], [-0.42, -0.03], [-0.42, 0.03], [-0.02, 0.03]], 0.5]],
        extra(l) { for (const s of [1, -1]) chevrons(l, -0.02, s * 0.235, 0.024, 2, 0.05, 0x1a1016); },
      });
    },
  };
}

/* --------------------------------- BROOD --------------------------------- */
// Splitter: two larval pods zipped together. Each pod is a stack of overlapping carapace plates with
// light pulsing in the joints; a veined membrane webs the two, and the seam it will tear along burns.
// The pods breathe out of step and the mandibles work.
// Breaks: a starboard carapace plate, a port carapace plate, the starboard outer mandible.
function defBrood() {
  const P = pal(0xb6d41e, 0x5c780c, [4.5, 8, 0.4]);
  const PZ = 0.142, SY = 0.74;
  const PROF = [[-0.43, 0.02], [-0.38, 0.064], [-0.31, 0.084], [-0.2, 0.1], [-0.1, 0.109], [0.03, 0.109], [0.14, 0.104], [0.25, 0.09], [0.33, 0.068], [0.4, 0.034], [0.44, 0.008]];
  const env = (x) => { let i = 0; while (i < PROF.length - 2 && x > PROF[i + 1][0]) i++; const a = PROF[i], b = PROF[i + 1]; return lerp(a[1], b[1], clamp((x - a[0]) / (b[0] - a[0]), 0, 1)); };
  const SEG = [-0.4, -0.3, -0.18, -0.05, 0.08, 0.2, 0.3]; // plate boundaries, tail → head
  const MEMB = lin(0x3c1420), VEIN = [5, 6.5, 0.5];
  return {
    zr: 0.4, P,
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
      const n = k.seg(14), L = { y: 0, z: PZ, sy: SY };
      SYM((s) => {
        k.on(s > 0 ? 'podR' : 'podL', { pivot: [0, 0, s * PZ] }, () => {
          // soft body under the armour
          k.solid(side(lathe(PROF.map(([x, r]) => [x, r * 0.84]), n, L), s), DARK2, { crease: 44 });
          // carapace: each plate flares at its rear edge and tucks under the next one forward
          for (let i = 0; i < SEG.length - 1; i++) {
            const x0 = SEG[i], x1 = SEG[i + 1], xm = lerp(x0, x1, 0.45), loose = (s > 0 && i === 3) || (s < 0 && i === 1);
            const pl = () => {
              k.col(side(lathe([[x0 - 0.012, env(x0) * 0.9], [x0, env(x0) * 1.06 + 0.004], [xm, env(xm) * 1.03], [x1 - 0.004, env(x1) * 0.9]], n, { ...L, capA: false, capB: false }), s), i % 2 ? C : mul(C, 0.78), { crease: 40, trim: i === SEG.length - 2 ? 1 : 0 });
              // dorsal spike on every plate
              if (q >= 1 || i % 2 === 0) k.solid(side(fin(xm + 0.03, xm - 0.03, 0.03 + 0.012 * (i % 3), 0.05, 0.012, env(xm) * SY * 0.98, PZ), s), DARK, { crease: 24 });
            };
            if (loose) k.on(s > 0 ? 'plateR' : 'plateL', { pivot: [xm, 0, s * PZ], detach: s > 0 ? 1 : 2, stump: { p: [xm, env(xm) * SY * 0.87, s * PZ], u: [1, 0, 0], v: [0, 0, 1], w: env(xm) * 0.45, len: (x1 - x0) * 0.4 } }, pl);
            else pl();
            // light in the joint
            k.glowTris(side(lathe([[x0 - 0.02, env(x0 - 0.02) * 0.875], [x0 - 0.011, env(x0) * 0.895]], n, { ...L, capA: false, capB: false }), s), mul(G, 0.34), CH.BIO);
          }
          // head shield + visor + mandibles
          k.col(side(lathe([[0.288, env(0.3) * 0.93], [0.3, env(0.3) * 1.07 + 0.004], [0.36, env(0.36) * 1.04], [0.43, 0.014], [0.445, 0.002]], n, { ...L, capA: false }), s), C2, { crease: 40, trim: 1 });
          k.eyes(0.25, 0.41, 0.01, 0.078, 0.03, 0.05, 0.024, { z: s * PZ, th: 0.3 });
          const SD = s > 0 ? 'R' : 'L';
          k.on('mand' + SD + 'o', { pivot: [0.31, -0.012, s * (PZ + 0.07)], axis: [0, 1, 0], detach: s > 0 ? 3 : 0, stump: { p: [0.315, -0.012, s * (PZ + 0.068)], u: [1, 0, -s * 0.15], v: [0, 0, 1], w: 0.011, len: 0.022, n: 3 } },
            () => k.trim(side(rotY(lathe([[0.3, 0.02], [0.4, 0.013], [0.5, 0.0012]], 6, { y: -0.012, z: PZ + 0.07, sy: 0.7 }), -9 * DEG, 0.3, PZ + 0.07), s), { crease: 30 }));
          k.on('mand' + SD + 'i', { pivot: [0.31, -0.012, s * (PZ - 0.066)], axis: [0, 1, 0] },
            () => k.trim(side(rotY(lathe([[0.3, 0.016], [0.39, 0.01], [0.47, 0.0012]], 6, { y: -0.012, z: PZ - 0.066, sy: 0.7 }), 7 * DEG, 0.3, PZ - 0.066), s), { crease: 30 }));
          // glow sacs along the outer flank, and a row of belly lights
          for (const [x, r] of [[-0.24, 0.016], [-0.115, 0.019], [0.015, 0.019], [0.14, 0.016]]) k.lamp(x, 0.012, s * (PZ + env(x) * 0.97), r, mul(G, 0.36), CH.BIO);
          for (let i = 0; i < 5; i++) { const x = -0.3 + i * 0.12; k.lamp(x, -env(x) * SY * 0.98, s * PZ, 0.011, mul(G, 0.3), CH.BIO); }
          k.gold(-0.2, 0.12, env(0) * SY + 0.006, s * PZ - 0.004, s * PZ + 0.004);
          k.muzzles.push({ x: 0.46, y: 0, z: s * PZ });
        });
        k.thruster(-0.5, 0, s * PZ, 0.05, 0.1, { n: k.seg(10), sy: 0.8 });
        // membrane veins running from the seam out under the plates
        for (let i = 0; i < 6; i++) {
          const x = -0.3 + i * 0.105, z1 = PZ - env(x) * 0.6;
          for (const y of [0.0085, -0.0085]) k.quad([x - 0.004, y, s * 0.008], [x + 0.004, y, s * 0.008], [x + 0.03, y, s * z1], [x + 0.022, y, s * z1], mul(VEIN, 0.3), CH.BIO);
        }
      });
      // membrane: a dark web between the pods, scalloped fore and aft
      k.solid(plate([[0.3, -0.05], [0.24, 0], [0.3, 0.05], [0.2, 0.11], [-0.26, 0.11], [-0.36, 0.06], [-0.31, 0], [-0.36, -0.06], [-0.26, -0.11], [0.2, -0.11]], -0.0075, 0.0075, 0.003), MEMB, { crease: 30 });
      k.solid(plate([[0.3, -0.05], [0.24, 0], [0.3, 0.05], [0.2, 0.11], [-0.26, 0.11], [-0.36, 0.06], [-0.31, 0], [-0.36, -0.06], [-0.26, -0.11], [0.2, -0.11]], 0.0, -0.0075, 0.003), MEMB, { crease: 30 });
      // the split line: a burning seam laced shut with interlocking chitin teeth
      for (const y of [0.0088, -0.0088]) k.strip(-0.3, 0.235, y, -0.0055, 0.0055, mul(VEIN, 0.75), CH.BIO);
      const NT = q >= 1 ? 13 : 7;
      for (let i = 0; i < NT; i++) {
        const x = lerp(-0.28, 0.21, i / (NT - 1)), s = i % 2 ? 1 : -1;
        k.trim(side(loft([ringRect(x - 0.011, -0.013, 0.015, 0.03, 0.034, 0.001), ringRect(x - 0.008, -0.011, 0.013, 0.012, 0.016, 0.001), ringRect(x, -0.006, 0.008, -0.014, -0.012, 0.0005), ringRect(x + 0.008, -0.011, 0.013, 0.012, 0.016, 0.001), ringRect(x + 0.011, -0.013, 0.015, 0.03, 0.034, 0.001)]), s), { crease: 30 });
      }
      for (const x of [-0.14, 0.05]) k.lamp(x, 0.016, 0, 0.012, mul(VEIN, 0.5), CH.BIO);
      k.muzzles.unshift({ x: 0.44, y: 0, z: 0 });
      const wy = (x) => env(x) * SY * 1.02;
      k.wound(-0.1, wy(-0.1), PZ + 0.01, 0.06, { yc: 0.02, h: 0.03 });
      k.wound(0.12, wy(0.12), -PZ + 0.02, 0.055, { yc: 0.02, h: 0.03 });
      k.wound(-0.26, wy(-0.26) * 0.8, -PZ - 0.04, 0.055, { yc: 0.01, h: 0.025 });
      k.wound(0.26, wy(0.26), PZ, 0.05, { yc: 0.02, h: 0.022 });
      k.wound(-0.02, 0.01, 0.0, 0.05, { yc: 0, h: 0.004, zs: 0.5 });
      k.ornate(() => {
        SYM((s) => { k.crest(0.2, -0.3, wy(-0.05) * 0.96, 5, 0.05, s * PZ); k.horn(0.36, 0.26, 0.09, -0.1, 0.01, s * (PZ + 0.03), 35, 0.02); });
      });
    },
    rig(P, ix, S) {
      const t = S.t, live = 1 - S.wreck * 0.7;
      const a = 0.035 * live * Math.sin(t * 0.0026), b = 0.035 * live * Math.sin(t * 0.0026 + 2.2);
      P.scl(ix.podR, 1, 1 + a, 1 + a); P.scl(ix.podL, 1, 1 + b, 1 + b);
      const m = 0.16 * live * Math.sin(t * 0.0047) + 0.3 * S.recoil, m2 = 0.12 * live * Math.sin(t * 0.0047 + 1.4);
      P.a[ix.mandRo] = -m - 0.5 * S.wreck; P.a[ix.mandRi] = m2; P.a[ix.mandLo] = m; P.a[ix.mandLi] = -m2 - 0.4 * S.wreck;
    },
    liv(L) {
      detail(L, {
        xs: [], zs: [], seed: 37, soot: [[-0.42, PZ]], wear: 0.4,
        extra(l) {
          // mottled carapace: darker flanks, pale growth rings on every plate, freckles
          for (const s of [1, -1]) {
            l.shade([[0.36, s * (PZ + 0.09)], [-0.38, s * (PZ + 0.09)]], 0.06, 0.45);
            l.shade([[0.36, s * (PZ - 0.09)], [-0.38, s * (PZ - 0.09)]], 0.06, 0.45);
            l.shade([[0.3, s * PZ], [-0.36, s * PZ]], 0.03, 0.22, '255,255,220');
            for (let i = 0; i < SEG.length - 1; i++) for (let j = 1; j <= 2; j++) {
              const x = lerp(SEG[i], SEG[i + 1], j / 3.2);
              l.line([[x + 0.012, s * (PZ - 0.1)], [x, s * PZ], [x + 0.012, s * (PZ + 0.1)]], { a: 0.28, w: 1.1 });
            }
            let r = 11; const R = () => ((r = (r * 16807) % 2147483647) / 2147483647);
            for (let i = 0; i < 46; i++) { const x = -0.38 + R() * 0.72, z = s * (PZ + (R() - 0.5) * 0.18), d = 0.004 + R() * 0.008; l.fill([[x - d, z], [x, z - d * 0.7], [x + d, z], [x, z + d * 0.7]], 0x1c2408, { alpha: 0.3 + R() * 0.3 }); }
          }
        },
      });
    },
  };
}

const DEFS = {
  basic: defBasic, weaver: defWeaver, hunter: defHunter, tank: defTank, sniper: defSniper,
  carrier: defCarrier, shieldbearer: defShieldbearer, strafer: defStrafer, brood: defBrood, drone: defDrone,
};

/* ========================================================================== */
/*  Materials                                                                 */
/* ========================================================================== */

const GLSL_NOISE = `
float e3h(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float e3n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(e3h(i), e3h(i + vec2(1.0, 0.0)), f.x), mix(e3h(i + vec2(0.0, 1.0)), e3h(i + vec2(1.0, 1.0)), f.x), f.y); }
float e3f(vec2 p){ return 0.5 * e3n(p) + 0.3 * e3n(p * 2.13 + 7.1) + 0.2 * e3n(p * 4.7 + 3.3); }
`;
// the print front: everything ahead of it (toward the nose) exists
const GLSL_WARP = `
float e3front(float w){ return mix(-0.78, 0.66, w); }
`;
const GLSL_PARTS = `
attribute float aPart;
uniform mat4 uE3P[${NP}];
`;
const HULL_VERT_HEAD = `
attribute float aTrim;
${GLSL_PARTS}
varying vec3 vE3Pos; varying float vE3Trim; varying vec3 vE3N; varying float vE3Sw;
`;
const HULL_FRAG_HEAD = `
uniform vec4 uE3A;   // flash, damage, dim, warp
uniform vec4 uE3B;   // time, fade, elite, seed
uniform vec4 uE3C;   // plates lost, fire, internals exposed, _
uniform vec3 uE3Warp;
uniform vec4 uE3W[${NW}];   // wound centre (model space), scorch radius
uniform float uE3Hr[${NW}]; // radius of the hole burnt through it
varying vec3 vE3Pos; varying float vE3Trim; varying vec3 vE3N; varying float vE3Sw;
${GLSL_NOISE}
${GLSL_WARP}
${GLSL_FACES}
`;
// plan-projected detail only where a face looks up; sides and bellies get their own panelling (see ships3d)
const HULL_FRAG_MAP = `
float e3up = 1.0, e3dn = 0.0, e3sd = 0.0;
{
  vec3 e3n = normalize(vE3N);
  e3up = smoothstep(0.2, 0.5, e3n.y); e3dn = smoothstep(0.2, 0.5, -e3n.y); e3sd = 1.0 - e3up - e3dn;
}
#ifdef USE_MAP
{
  vec4 e3t = texture2D(map, vMapUv);
  if (vE3Sw < 0.5 && e3up < 0.999) e3t = mix(texture2D(map, vMapUv, 3.0), e3t, e3up);
  diffuseColor *= e3t;
}
#endif
`;
// Damage, in the order it reads: soot blotches and scorched dents round each wound; then the wound burns a
// ragged hole (internals and the inside of the skin show through it); then whole plates drop out of the hull.
const HULL_FRAG_COLOR = `
float e3soot = 0.0; float e3hot = 0.0; float e3spark = 0.0; float e3edge = 0.0; float e3dent = 0.0;
float e3gut = step(1.5, vE3Trim);
float e3gold = (1.0 - e3gut) * step(0.5, vE3Trim) * uE3B.z;
float e3fine = 1.0;
diffuseColor.rgb *= s3faces(vE3Pos, e3sd, e3dn);
{
  if (uE3A.w > 0.001) {
    float wn = e3n(vE3Pos.yz * 30.0 + uE3B.w) - 0.5;
    float wd = vE3Pos.x - e3front(uE3A.w) + wn * 0.1;
    if (wd < 0.0) discard;
    e3edge = 1.0 - smoothstep(0.0, 0.09, wd);
  }
  if (uE3B.z > 0.001 && e3gut < 0.5) {
    // elite: the paint goes to deep lacquer and the trim to engraved gold
    vec2 fq = vE3Pos.xz + vE3Pos.y * vec2(0.4, 0.7);
    float fil = abs(sin(fq.x * 150.0 + 2.4 * sin(fq.y * 95.0)) * sin(fq.y * 120.0 + 2.0 * sin(fq.x * 70.0)));
    e3fine = smoothstep(0.1, 0.3, fil);
    float lum = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    vec3 lacq = diffuseColor.rgb * vec3(0.34, 0.3, 0.38) + vec3(0.012, 0.004, 0.02) * step(0.02, lum);
    diffuseColor.rgb = mix(diffuseColor.rgb, lacq, 0.8 * uE3B.z * (1.0 - e3gold));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.52, 0.1) * clamp(0.5 + lum * 2.4, 0.0, 1.0) * (0.42 + 0.58 * e3fine), e3gold);
  }
  float dmg = uE3A.y;
  if (dmg > 0.001 || uE3C.x > 0.001) {
    vec3 q = vE3Pos;
    vec2 qp = q.xz + q.y * vec2(0.37, 0.61);
    float n = e3f(qp * 9.0 + uE3B.w * 3.7);
    float nf = e3n(qp * 34.0 + 5.0) - 0.5;
    float crack = pow(1.0 - abs(2.0 * e3n(qp * 42.0 + 3.0) - 1.0), 6.0);
    float a = mix(0.9, 0.34, dmg);
    e3soot = smoothstep(a, a + 0.12, n) * 0.9;
    for (int i = 0; i < ${NW}; i++) {
      float r = uE3W[i].w;
      if (r > 0.0005) {
        vec3 dv = q - uE3W[i].xyz;
        float d = length(dv) + nf * r * 0.9;
        float hr = uE3Hr[i];
        if (e3gut < 0.5 && d < hr) discard;
        // scorch: black round the wound, smeared aft by the slipstream
        float ds = length(vec3(dv.x * (dv.x < 0.0 ? 0.4 : 1.0), dv.yz)) + nf * r * 1.4;
        e3soot = max(e3soot, 1.0 - smoothstep(r * 1.0, r * 2.9, ds));
        float core = 1.0 - smoothstep(r * 0.45, r, d);
        float rim = hr > 0.0005 ? 1.0 - smoothstep(hr, hr + 0.008, d) : 0.0;
        e3hot += core * (0.012 + crack * crack * 0.8) * (1.0 - step(0.0005, hr) * 0.5) + rim * (0.1 + 0.55 * smoothstep(0.1, 0.6, crack + nf));
        e3dent += 1.0 - smoothstep(r * 0.3, r * 1.6, d);
      }
    }
    if (uE3C.x > 0.001 && e3gut < 0.5) {
      vec2 pc = floor((q.xz + nf * 0.012) * vec2(7.0, 9.0) + uE3B.w);
      float ph = e3h(pc + floor(q.y * 5.0 + 0.5) * 3.1);
      if (ph < uE3C.x) discard;
      e3soot = max(e3soot, 0.9 * (1.0 - smoothstep(uE3C.x, uE3C.x + 0.25, ph)));
    }
    e3dent = (e3dent + e3soot * 0.5) * (0.4 + n);
    e3hot *= (0.72 + 0.28 * sin(uE3B.x * 0.011 + n * 40.0)) * (1.0 + 1.4 * uE3C.y);
    // paint burns off the whole ship as it takes punishment
    float e3lum = dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(e3lum) * 0.55, 0.55 * smoothstep(0.25, 1.0, dmg) * (0.4 + 0.6 * n));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.011, 0.01), e3soot * 0.92);
  }
  float e3fl = 0.5 + 0.5 * sin(uE3B.x * 0.013 + vE3Pos.x * 31.0 + uE3B.w) * sin(uE3B.x * 0.0071 + vE3Pos.z * 23.0);
  if (e3gut > 0.5) {
    // internals: ribs stay dark, the reactor lump smoulders, cables throw the odd blue spark
    e3soot = 0.7;
    e3hot = uE3C.z * (vE3Trim > 2.5 && vE3Trim < 3.5 ? 0.16 + 0.34 * e3fl : 0.035) * (0.55 + 1.3 * uE3C.y);
    if (vE3Trim > 3.5) e3spark = uE3C.z * step(0.88, e3h(vec2(floor(uE3B.x * 0.028), floor(vE3Pos.x * 55.0) + uE3B.w)));
  } else if (!gl_FrontFacing) {
    // the inside of the skin: charred, lit by whatever burns in there
    diffuseColor.rgb = vec3(0.02, 0.017, 0.015);
    e3soot = 1.0; e3gold = 0.0;
    float e3em = e3f(vE3Pos.xz * 17.0 + vE3Pos.y * 23.0 + uE3B.w);
    e3hot = uE3C.z * smoothstep(0.38, 0.75, e3em) * (0.025 + 0.075 * e3fl) * (0.5 + 3.0 * uE3C.y);
  }
}
`;
const HULL_FRAG_NORMAL = `
#ifdef USE_NORMALMAP_TANGENTSPACE
normal = normalize(mix(nonPerturbedNormal, normal, e3up));
#endif
if (e3dent > 0.001) { // scorched plates are buckled
  vec3 e3px = dFdx(vViewPosition), e3py = dFdy(vViewPosition);
  float e3hx = dFdx(e3dent), e3hy = dFdy(e3dent);
  vec3 e3r1 = cross(e3py, normal), e3r2 = cross(normal, e3px);
  float e3det = dot(e3px, e3r1);
  if (abs(e3det) > 1e-12 && abs(e3hx) + abs(e3hy) < 0.5) normal = normalize(abs(e3det) * normal - 0.0045 * sign(e3det) * (e3hx * e3r1 + e3hy * e3r2));
}
`;
const HULL_FRAG_OUT = `
{
  // the dim knob darkens the hull, but fire inside a dying ship does not go out with the lights
  float e3k = max(smoothstep(0.3, 0.9, uE3A.z), uE3C.y);
  outgoingLight = (outgoingLight - totalEmissiveRadiance) * uE3A.z + totalEmissiveRadiance * e3k;
}
if (uE3A.w > 0.001) {
  float scan = 0.5 + 0.5 * sin(vE3Pos.x * 230.0 - uE3B.x * 0.03);
  outgoingLight = mix(outgoingLight, uE3Warp * (0.1 + 0.3 * scan), uE3A.w * 0.8);
  outgoingLight += uE3Warp * e3edge * e3edge * 2.6;
}
outgoingLight = mix(outgoingLight, vec3(1.7, 1.64, 1.55), uE3A.x * (0.5 + 0.5 * uE3A.x));
`;

function patchHull(mat, U) {
  mat.onBeforeCompile = (sh) => {
    for (const k in U) sh.uniforms[k] = U[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + HULL_VERT_HEAD)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nmat4 e3pm = uE3P[int(aPart + 0.5)];\nobjectNormal = mat3(e3pm) * objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvE3Pos = position; vE3Trim = aTrim; vE3N = normal; vE3Sw = step(0.8, uv.x) * step(0.4, abs(uv.y - 0.5));\ntransformed = (e3pm * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HULL_FRAG_HEAD)
      .replace('#include <map_fragment>', HULL_FRAG_MAP)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + HULL_FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + HULL_FRAG_NORMAL)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n#ifdef USE_ROUGHNESSMAP\nvec4 e3orm = texture2D(roughnessMap, vRoughnessMapUv, 3.0);\nif (vE3Sw < 0.5) roughnessFactor = mix(e3orm.g * roughness, roughnessFactor, e3up);\n#endif\nroughnessFactor = mix(mix(mix(roughnessFactor, 0.3, 0.6 * uE3B.z * (1.0 - e3gut)), mix(0.62, 0.3, e3fine), e3gold), 0.95, e3soot);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n#ifdef USE_ROUGHNESSMAP\nif (vE3Sw < 0.5) metalnessFactor = mix(e3orm.b * metalness, metalnessFactor, e3up);\n#endif\nmetalnessFactor = mix(metalnessFactor, 1.0, e3gold) * (1.0 - 0.8 * e3soot);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(5.0, 1.1, 0.14) * e3hot + vec3(1.6, 2.8, 5.0) * e3spark;')
      .replace('#include <opaque_fragment>', HULL_FRAG_OUT + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'e3d-hull3';
  return mat;
}

const EMIS_VERT = `
attribute vec3 aCol; attribute vec2 aCh;
${GLSL_PARTS}
uniform float uLv[10]; uniform vec4 uE3E;   // flame, time, charge, _
varying vec3 vCol; varying vec3 vE3Pos;
void main() {
  int ch = int(aCh.x + 0.5);
  float lv = uLv[ch];
  bool eng = ch == 1 || ch == 9;
  vec3 p = position;
  if (ch == 6) {
    float c = uE3E.z;
    float k = smoothstep(aCh.y - 0.22, aCh.y, c * 1.22);
    float fl = 0.82 + 0.18 * sin(uE3E.y * 0.07 + position.x * 55.0);
    lv *= 0.07 * step(aCh.y, 0.9) + k * (0.55 + 2.3 * c * c) * mix(1.0, fl, c);
  } else {
    p.x -= aCh.y * uE3E.x * (ch == 9 ? uE3E.w : 1.0) * (1.0 + 0.16 * sin(uE3E.y * 0.045 + position.z * 380.0 + position.y * 517.0));
    if (ch == 8) lv *= 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uE3E.y * 0.0042 + position.x * 13.0 + abs(position.z) * 6.0), 2.0); // bioluminescence: a slow wave from tail to head
  }
  p = (uE3P[int(aPart + 0.5)] * vec4(p, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (eng && aCh.y > 0.0) { // plume: thin it when seen end-on, and do not let boost white it out
    vec3 ax = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    lv = min(lv, 1.0 + 0.3 * (lv - 1.0)) * mix(1.0, 0.25, smoothstep(0.5, 0.95, abs(dot(ax, normalize(mv.xyz)))));
  }
  vCol = aCol * lv;
  vE3Pos = position;
  gl_Position = projectionMatrix * mv;
}`;
const EMIS_FRAG = `
uniform vec4 uE3F;   // fade, flash, warp, seed
uniform vec3 uE3Warp;
varying vec3 vCol; varying vec3 vE3Pos;
${GLSL_NOISE}
${GLSL_WARP}
void main() {
  vec3 c = vCol;
  if (uE3F.z > 0.001) {
    float wd = vE3Pos.x - e3front(uE3F.z) + (e3n(vE3Pos.yz * 30.0 + uE3F.w) - 0.5) * 0.1;
    if (wd < 0.0) discard;
    c = mix(c, uE3Warp * 0.5, uE3F.z * 0.6);
  }
  gl_FragColor = vec4(c * uE3F.x * (1.0 + uE3F.y), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ========================================================================== */
/*  Rig                                                                       */
/* ========================================================================== */

const W_AT = [0.04, 0.18, 0.33, 0.48, 0.62]; // damage at which each wound starts to scorch; it burns through 0.17 later
const smooth = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const IDENT = new Float32Array(NP * 16);
for (let i = 0; i < NP; i++) IDENT[i * 16] = IDENT[i * 16 + 5] = IDENT[i * 16 + 10] = IDENT[i * 16 + 15] = 1;

// Per-instance pose: Euler angles (applied yaw·pitch·roll = Y·Z·X), a turn about the part's own hinge axis,
// an offset and a scale for every part. solve() turns it into the matrix palette; a hidden part collapses
// onto its pivot.
class Pose {
  constructor(parts) {
    this.parts = parts; this.n = parts.length;
    this.r = new Float32Array(NP * 3); this.p = new Float32Array(NP * 3); this.s = new Float32Array(NP * 3);
    this.a = new Float32Array(NP); this.hide = new Uint8Array(NP);
    this.m = new Float32Array(IDENT);
  }
  reset() { this.r.fill(0); this.p.fill(0); this.s.fill(1); this.a.fill(0); }
  rot(i, x, y, z) { i *= 3; this.r[i] = x; this.r[i + 1] = y; this.r[i + 2] = z; }
  pos(i, x, y, z) { i *= 3; this.p[i] = x; this.p[i + 1] = y; this.p[i + 2] = z; }
  scl(i, x, y, z) { i *= 3; this.s[i] = x; this.s[i + 1] = y; this.s[i + 2] = z; }
  solve() {
    const { parts, r, p, s, a, hide, m } = this;
    for (let i = 1; i < this.n; i++) {
      const P = parts[i], pv = P.pivot, o = i * 16, j = i * 3;
      let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0, tx = pv[0], ty = pv[1], tz = pv[2];
      if (!hide[i]) {
        const cx = Math.cos(r[j]), sx = Math.sin(r[j]), cy = Math.cos(r[j + 1]), sy = Math.sin(r[j + 1]), cz = Math.cos(r[j + 2]), sz = Math.sin(r[j + 2]);
        a00 = cy * cz; a01 = -cy * sz * cx + sy * sx; a02 = cy * sz * sx + sy * cx;
        a10 = sz; a11 = cz * cx; a12 = -cz * sx;
        a20 = -sy * cz; a21 = sy * sz * cx + cy * sx; a22 = -sy * sz * sx + cy * cx;
        if (a[i] !== 0) { // turn about the hinge axis first
          const ax = P.axis, x = ax[0], y = ax[1], z = ax[2], c = Math.cos(a[i]), sn = Math.sin(a[i]), k = 1 - c;
          const b00 = c + x * x * k, b01 = x * y * k - z * sn, b02 = x * z * k + y * sn;
          const b10 = y * x * k + z * sn, b11 = c + y * y * k, b12 = y * z * k - x * sn;
          const b20 = z * x * k - y * sn, b21 = z * y * k + x * sn, b22 = c + z * z * k;
          const c00 = a00 * b00 + a01 * b10 + a02 * b20, c01 = a00 * b01 + a01 * b11 + a02 * b21, c02 = a00 * b02 + a01 * b12 + a02 * b22;
          const c10 = a10 * b00 + a11 * b10 + a12 * b20, c11 = a10 * b01 + a11 * b11 + a12 * b21, c12 = a10 * b02 + a11 * b12 + a12 * b22;
          const c20 = a20 * b00 + a21 * b10 + a22 * b20, c21 = a20 * b01 + a21 * b11 + a22 * b21, c22 = a20 * b02 + a21 * b12 + a22 * b22;
          a00 = c00; a01 = c01; a02 = c02; a10 = c10; a11 = c11; a12 = c12; a20 = c20; a21 = c21; a22 = c22;
        }
        const s0 = s[j], s1 = s[j + 1], s2 = s[j + 2];
        a00 *= s0; a10 *= s0; a20 *= s0; a01 *= s1; a11 *= s1; a21 *= s1; a02 *= s2; a12 *= s2; a22 *= s2;
        tx += p[j] - (a00 * pv[0] + a01 * pv[1] + a02 * pv[2]);
        ty += p[j + 1] - (a10 * pv[0] + a11 * pv[1] + a12 * pv[2]);
        tz += p[j + 2] - (a20 * pv[0] + a21 * pv[1] + a22 * pv[2]);
      }
      const q = P.parent * 16;
      if (q) { // ride on the parent
        const p00 = m[q], p10 = m[q + 1], p20 = m[q + 2], p01 = m[q + 4], p11 = m[q + 5], p21 = m[q + 6], p02 = m[q + 8], p12 = m[q + 9], p22 = m[q + 10];
        const c00 = p00 * a00 + p01 * a10 + p02 * a20, c01 = p00 * a01 + p01 * a11 + p02 * a21, c02 = p00 * a02 + p01 * a12 + p02 * a22;
        const c10 = p10 * a00 + p11 * a10 + p12 * a20, c11 = p10 * a01 + p11 * a11 + p12 * a21, c12 = p10 * a02 + p11 * a12 + p12 * a22;
        const c20 = p20 * a00 + p21 * a10 + p22 * a20, c21 = p20 * a01 + p21 * a11 + p22 * a21, c22 = p20 * a02 + p21 * a12 + p22 * a22;
        const ux = p00 * tx + p01 * ty + p02 * tz + m[q + 12], uy = p10 * tx + p11 * ty + p12 * tz + m[q + 13], uz = p20 * tx + p21 * ty + p22 * tz + m[q + 14];
        a00 = c00; a01 = c01; a02 = c02; a10 = c10; a11 = c11; a12 = c12; a20 = c20; a21 = c21; a22 = c22; tx = ux; ty = uy; tz = uz;
      }
      m[o] = a00; m[o + 1] = a10; m[o + 2] = a20; m[o + 4] = a01; m[o + 5] = a11; m[o + 6] = a21; m[o + 8] = a02; m[o + 9] = a12; m[o + 10] = a22;
      m[o + 12] = tx; m[o + 13] = ty; m[o + 14] = tz;
    }
  }
}

/* ========================================================================== */
/*  Public class                                                              */
/* ========================================================================== */

export class Enemies3D {
  constructor(THREE, opts = {}) {
    this.T = THREE;
    this.quality = opts.quality === 0.5 || opts.quality < 1 ? 0.5 : 1;
    this.anisotropy = opts.anisotropy ?? 8;
    this.textures = opts.textures !== false && typeof document !== 'undefined';
    this.geo = new Map();   // id → { hull, emis, nozzles, muzzles, parts, wounds, size, tris }
    this.tex = new Map();   // id → { map, orm, normal }
    this.defs = new Map();
    this.live = new Set();  // instance materials, for dispose()
    this.buildMs = {};
    this._n = 0;
  }

  _def(id) {
    let d = this.defs.get(id);
    if (!d) { d = DEFS[id](); this.defs.set(id, d); }
    return d;
  }

  _geometry(id) {
    let g = this.geo.get(id);
    if (g) return g;
    const T = this.T, def = this._def(id);
    const k = new EKit(this.quality, def.zr, def.P);
    def.geo(k);
    k._sync();
    if (k.parts.length > NP) throw new Error(`enemies3d: ${id} has ${k.parts.length} parts (max ${NP})`);
    const hp = k.hull.pos, pa = k.hull.pa, orn = k.parts.findIndex((p) => p.elite);
    // normalise: length exactly 1 on X, centred in x/z (emissive flames and elite regalia excluded)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < hp.length; i += 3) {
      if (pa[i / 3] === orn) continue;
      const x = hp[i], y = hp[i + 1], z = hp[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    { // contact shading; the regalia must not shade the hulls that do not wear it
      const A = { pos: [], nrm: [], col: [] }, at = [], hn = k.hull.nrm, hc = k.hull.col;
      for (let v = 0; v < pa.length; v++) {
        if (pa[v] === orn) continue;
        at.push(v);
        for (let c = 0; c < 3; c++) { A.pos.push(hp[v * 3 + c]); A.nrm.push(hn[v * 3 + c]); A.col.push(hc[v * 3 + c]); }
      }
      bakeAO([A], { vox: this.quality >= 1 ? 0.009 : 0.013, floor: 0.34 });
      for (let j = 0; j < at.length; j++) for (let c = 0; c < 3; c++) hc[at[j] * 3 + c] = A.col[j * 3 + c];
    }
    const sc = 1 / (x1 - x0), ox = (x0 + x1) / 2, oz = (z0 + z1) / 2;
    const fix = (p) => { for (let i = 0; i < p.length; i += 3) { p[i] = (p[i] - ox) * sc; p[i + 1] *= sc; p[i + 2] = (p[i + 2] - oz) * sc; } };
    fix(k.hull.pos); fix(k.emis.pos);
    const ch = k.emis.ch;
    for (let i = 1; i < ch.length; i += 2) if (ch[i - 1] !== CH.CHARGE) ch[i] *= sc;
    const pt = (p) => ({ ...p, x: (p.x - ox) * sc, y: p.y * sc, z: (p.z - oz) * sc, ...(p.r != null ? { r: p.r * sc } : {}) });
    const hull = new T.BufferGeometry();
    hull.setAttribute('position', new T.Float32BufferAttribute(k.hull.pos, 3));
    hull.setAttribute('normal', new T.Float32BufferAttribute(k.hull.nrm, 3));
    hull.setAttribute('color', new T.Float32BufferAttribute(k.hull.col, 3));
    hull.setAttribute('uv', new T.Float32BufferAttribute(k.hull.uv, 2));
    hull.setAttribute('aTrim', new T.Float32BufferAttribute(k.hull.tr, 1));
    hull.setAttribute('aPart', new T.Float32BufferAttribute(k.hull.pa, 1));
    const emis = new T.BufferGeometry();
    emis.setAttribute('position', new T.Float32BufferAttribute(k.emis.pos, 3));
    emis.setAttribute('aCol', new T.Float32BufferAttribute(k.emis.col, 3));
    emis.setAttribute('aCh', new T.Float32BufferAttribute(k.emis.ch, 2));
    emis.setAttribute('aPart', new T.Float32BufferAttribute(k.emis.pa, 1));
    for (const geo of [hull, emis]) { geo.computeBoundingSphere(); geo.computeBoundingBox(); }
    // flames stretch behind the hull and parts swing: pad the bounds so nothing is culled early
    emis.boundingSphere.radius += 0.35; hull.boundingSphere.radius += 0.12;
    const parts = k.parts.map((p, i) => ({
      ...p, index: i, pivot: [(p.pivot[0] - (i ? ox : 0)) * sc, p.pivot[1] * sc, (p.pivot[2] - (i ? oz : 0)) * sc],
      recoil: (p.recoil || 0) * sc, stump: null,
    }));
    parts[0].pivot = [0, 0, 0];
    const ix = {};
    for (const p of parts) ix[p.name] = p.index;
    const wounds = [];
    for (let i = 0; i < NW; i++) { const w = k.wounds[i]; wounds.push(w ? [(w[0] - ox) * sc, w[1] * sc, (w[2] - oz) * sc, w[3] * sc] : [0, 0, 0, 0]); }
    const detach = parts.filter((p) => p.detach).sort((a, b) => a.detach - b.detach).map((p) => p.index);
    g = {
      hull, emis, parts, ix, wounds, detach, debris: new Map(),
      stumps: (k.stumps || []).map((s) => ({ part: s.part, x: (s.x - ox) * sc, y: s.y * sc, z: (s.z - oz) * sc })),
      rig: {
        eng: parts.filter((p) => p.eng != null).map((p) => p.index), flap: parts.filter((p) => p.flap).map((p) => p.index),
        recoil: parts.filter((p) => p.recoil).map((p) => p.index), bend: parts.filter((p) => p.bend).map((p) => p.index),
        spin: parts.filter((p) => p.spin).map((p) => p.index), ornate: orn,
      },
      nozzles: k.nozzles.map(pt), muzzles: k.muzzles.map(pt),
      size: [1, (y1 - y0) * sc, (z1 - z0) * sc],
      tris: { hull: k.hull.pos.length / 9, emis: k.emis.pos.length / 9 },
    };
    g.tris.total = g.tris.hull + g.tris.emis;
    this.geo.set(id, g);
    return g;
  }

  // geometry of one break-away part (with everything riding on it), recentred on its own middle
  _debris(id, part) {
    const g = this._geometry(id);
    let d = g.debris.get(part);
    if (d) return d;
    const T = this.T, parts = g.parts, inSet = new Uint8Array(parts.length);
    for (let i = 1; i < parts.length; i++) { let j = i; while (j && j !== part) j = parts[j].parent; inSet[i] = j === part ? 1 : 0; }
    const A = g.hull.attributes, pa = A.aPart.array, src = { position: A.position.array, normal: A.normal.array, color: A.color.array, uv: A.uv.array, aTrim: A.aTrim.array };
    const out = { position: [], normal: [], color: [], uv: [], aTrim: [] }, size = { position: 3, normal: 3, color: 3, uv: 2, aTrim: 1 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let v = 0; v < pa.length; v++) {
      if (!inSet[pa[v] | 0]) continue;
      for (const key in out) for (let c = 0, n = size[key]; c < n; c++) out[key].push(src[key][v * n + c]);
      const x = src.position[v * 3], y = src.position[v * 3 + 1], z = src.position[v * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], p = out.position;
    for (let i = 0; i < p.length; i += 3) { p[i] -= c[0]; p[i + 1] -= c[1]; p[i + 2] -= c[2]; }
    const geo = new T.BufferGeometry();
    for (const key in out) geo.setAttribute(key, new T.Float32BufferAttribute(out[key], size[key]));
    geo.setAttribute('aPart', new T.Float32BufferAttribute(new Float32Array(p.length / 3), 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    d = { geo, center: c, radius: geo.boundingSphere.radius, tris: p.length / 9 };
    g.debris.set(part, d);
    return d;
  }

  _textures(id) {
    if (!this.textures) return null;
    let t = this.tex.get(id);
    if (t) return t;
    const def = this._def(id);
    const L = new Livery(document, def.zr, this.quality >= 1 ? 768 : 384);
    def.liv(L);
    t = L.finish(this.T, this.anisotropy);
    this.tex.set(id, t);
    return t;
  }

  _hullMat(tex, U) {
    const T = this.T;
    return patchHull(new T.MeshStandardMaterial({
      vertexColors: true, map: tex ? tex.map : null, normalMap: tex ? tex.normal : null,
      roughnessMap: tex ? tex.orm : null, metalnessMap: tex ? tex.orm : null,
      roughness: tex ? 1 : 0.45, metalness: tex ? 1 : 0.3, envMapIntensity: 1.0, side: T.DoubleSide,
    }), U);
  }

  /** { tris (total), trisBy: {hull, emis}, drawCalls, size: [1, h, span], buildMs, glow, parts: break-away part names, aim: bool } */
  info(id) {
    if (!DEFS[id]) id = 'basic';
    const g = this._geometry(id), def = this._def(id);
    return {
      tris: g.tris.total, trisBy: { hull: g.tris.hull, emis: g.tris.emis }, drawCalls: 2, size: g.size.slice(), buildMs: this.buildMs[id], glow: def.P.glow.slice(),
      parts: g.detach.map((i) => g.parts[i].name), rigParts: g.parts.length, aim: !!def.aim,
    };
  }

  build(id, opts = {}) {
    if (!DEFS[id]) id = 'basic';
    const T = this.T, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), t0 = now();
    const g = this._geometry(id), tex = this._textures(id), def = this._def(id);
    if (this.buildMs[id] == null) this.buildMs[id] = now() - t0;

    const seed = ((++this._n * 0.61803398875) % 1) * 97;
    const lv = [1, 1, 1, 1, 1, 1, 1, 0, 1, 1];
    const wc = def.P.glow, wm = 1.7 / Math.max(wc[0], wc[1], wc[2]);
    const A = new T.Vector4(0, 0, 1, 0);            // flash, damage, dim, warp
    const B = new T.Vector4(0, 1, opts.elite ? 1 : 0, seed); // time, fade, elite, seed
    const C = new T.Vector4(0, 0, 0, 0);            // plates lost, fire, internals exposed
    const E = new T.Vector4(0.3, 0, 0, 1);          // flame, time, charge, port flame
    const Fv = new T.Vector4(1, 0, 0, seed);        // fade, flash, warp, seed
    const warpCol = { value: new T.Vector3(wc[0] * wm, wc[1] * wm, wc[2] * wm) };
    if (opts.elite) warpCol.value.set(1.7, 1.15, 0.35);
    const pose = new Pose(g.parts), WU = new Float32Array(NW * 4), HR = new Float32Array(NW);
    for (let i = 0; i < NW; i++) { WU[i * 4] = g.wounds[i][0]; WU[i * 4 + 1] = g.wounds[i][1]; WU[i * 4 + 2] = g.wounds[i][2]; }
    const uP = { value: pose.m };
    const U = { uE3A: { value: A }, uE3B: { value: B }, uE3C: { value: C }, uE3Warp: warpCol, uE3W: { value: WU }, uE3Hr: { value: HR }, uE3P: uP };
    const hull = this._hullMat(tex, U);
    const emis = new T.ShaderMaterial({
      uniforms: { uLv: { value: lv }, uE3E: { value: E }, uE3F: { value: Fv }, uE3Warp: warpCol, uE3P: uP },
      vertexShader: EMIS_VERT, fragmentShader: EMIS_FRAG,
      blending: T.AdditiveBlending, transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    const mats = [hull, emis];
    for (const m of mats) this.live.add(m);

    const group = new T.Group();
    group.name = 'enemy:' + id;
    const mh = new T.Mesh(g.hull, hull), me = new T.Mesh(g.emis, emis);
    me.renderOrder = 2;
    group.add(mh, me);

    // st: what the game asked for. S: what the rig sees (slewed, so a quantised charge or a snapped aim still moves like machinery)
    const st = { thrust: 1, damage: 0, dim: 1, opacity: 1, charge: 0, time: 0, flick: 1, elite: !!opts.elite, ph: seed * 61, aim: 0, death: 0, eng1: 1, eng2: 1, broken: 0 };
    const S = { aim: 0, charge: 0, thrust: 1, roll: 0, recoil: 0, damage: 0, death: 0, wreck: 0, t: 0, dt: 0, elite: st.elite, acc: new Float32Array(4) };
    const aimMax = def.aim ? def.aim.max : 0, aimRate = def.aim ? def.aim.rate : 0;
    const lights = () => clamp((st.dim - 0.5) / 0.4, 0, 1);
    const applyEngine = () => {
      const t = st.thrust, on = st.death > 0 || lights() > 0 ? 1 : 0;
      const lvl = (0.2 + 0.8 * t + (t > 1 ? (t - 1) * 1.1 : 0)) * st.flick * (st.death > 0 ? 1 : lights());
      lv[CH.ENGINE] = lvl * st.eng1; lv[CH.ENGINE2] = lvl * st.eng2;
      E.x = Math.max(0, t - 0.1) * (t > 1 ? 0.6 + (t - 1) * 0.9 : 0.6) * st.flick * on * st.eng1;
      E.w = st.eng1 > 0.01 ? st.eng2 / st.eng1 : 0;
    };
    const ud = group.userData;
    ud.enemyId = id;
    ud.elite = st.elite;
    ud.nozzles = g.nozzles.map((n) => ({ ...n }));
    ud.muzzles = g.muzzles.map((m) => ({ ...m }));
    const muzzleRest = g.muzzles;
    ud.size = g.size.slice();
    ud.glow = def.P.glow.slice();
    ud.canAim = !!def.aim;

    /* ---- wounds: where to hang smoke, fire and sparks ---- */
    ud.wounds = [];
    for (let i = 0; i < NW + g.detach.length; i++) ud.wounds.push({ x: 0, y: 0, z: 0, heat: 0 });
    ud.woundCount = 0;
    ud.partsLeft = g.detach.length;
    const dEff = () => Math.max(st.damage, st.death > 0 ? 0.82 + 0.18 * st.death : 0);
    const refresh = () => {
      const d = dEff();
      let n = 0;
      for (let i = 0; i < NW; i++) {
        const w = g.wounds[i], open = w[3] > 0 ? smooth((d - W_AT[i]) / 0.2) : 0, hole = w[3] > 0 ? smooth((d - W_AT[i] - 0.17) / 0.22) : 0;
        WU[i * 4 + 3] = w[3] * open * (0.8 + 0.4 * d); HR[i] = w[3] * 0.8 * hole;
        if (open > 0) { const o = ud.wounds[n++]; o.x = w[0]; o.y = w[1]; o.z = w[2]; o.heat = 0.25 + 0.75 * hole; }
      }
      for (let j = 0; j < g.stumps.length; j++) {
        const s = g.stumps[j];
        if (pose.hide[s.part]) { const o = ud.wounds[n++]; o.x = s.x; o.y = s.y; o.z = s.z; o.heat = 0.8; }
      }
      ud.woundCount = n;
      S.damage = d; S.wreck = smooth((d - 0.72) / 0.16);
      A.y = d;
      C.x = 0.18 * smooth((d - 0.74) / 0.26) + 0.3 * st.death; // plates shed through the death fall
      C.z = d > 0.12 || st.broken > 0 ? 1 : 0;
    };

    ud.setThrust = (t) => { st.thrust = clamp(+t || 0, 0, 2); applyEngine(); };
    ud.setFlash = (v) => { A.x = Fv.y = clamp(+v || 0, 0, 1); };
    ud.setDim = (k) => { k = clamp(k == null ? 1 : +k, 0, 2); if (k === st.dim) return; st.dim = A.z = k; ud.update(0); };
    ud.setDamage = (d) => { d = clamp(+d || 0, 0, 1); if (d === st.damage) return; st.damage = d; refresh(); };
    ud.setDeath = (q) => { q = clamp(+q || 0, 0, 1); if (q === st.death) return; st.death = S.death = q; refresh(); };
    ud.setWarp = (w) => { A.w = Fv.z = clamp(+w || 0, 0, 1); };
    ud.setCharge = (c) => { st.charge = E.z = clamp(+c || 0, 0, 1); };
    ud.setElite = (on) => { st.elite = ud.elite = S.elite = !!on; B.z = on ? 1 : 0; ud.update(0); };
    // yaw in model-local radians, 0 = dead ahead, positive toward +Z (starboard); clamped to what the mount can do
    ud.setAim = (yaw, snap) => { st.aim = clamp(+yaw || 0, -aimMax, aimMax); if (snap) S.aim = st.aim; };
    ud.setRoll = (r) => { S.roll = clamp(+r || 0, -1, 1); };
    ud.setFire = () => { S.recoil = 1; };
    ud.setOpacity = (a) => {
      a = clamp(a == null ? 1 : +a, 0, 1);
      if (a === st.opacity) return;
      const was = st.opacity < 1, isNow = a < 1;
      st.opacity = a;
      hull.opacity = a; B.y = Fv.x = a;
      if (was !== isNow) { hull.transparent = isNow; hull.needsUpdate = true; }
    };
    // Break the next pre-cut part off the hull. Returns it as a standalone mesh in the hull's local frame
    // (model units; add it under the same transform or copy the hull's matrix), or null when none are left.
    ud.breakOff = () => {
      for (let n = 0; n < g.detach.length; n++) {
        const i = g.detach[n];
        if (pose.hide[i]) continue;
        pose.hide[i] = 1; st.broken++; ud.partsLeft--;
        refresh(); ud.update(0);
        const d = this._debris(id, i);
        const dU = {
          uE3A: { value: new T.Vector4(0, Math.max(0.55, st.damage), 1, 0) }, uE3B: { value: new T.Vector4(B.x, 1, B.z, seed + n * 7.3) },
          uE3C: { value: new T.Vector4(0.06, 0.3, 1, 0) }, uE3Warp: warpCol, uE3W: { value: new Float32Array(NW * 4) }, uE3Hr: { value: new Float32Array(NW) }, uE3P: { value: IDENT },
        };
        const dm = this._hullMat(tex, dU);
        this.live.add(dm);
        const part = new T.Mesh(d.geo, dm);
        part.name = 'debris:' + id + ':' + g.parts[i].name;
        part.position.set(d.center[0], d.center[1], d.center[2]);
        const pu = part.userData;
        pu.part = g.parts[i].name; pu.radius = d.radius; pu.glow = ud.glow;
        pu.setDim = (k) => { dU.uE3A.value.z = clamp(+k || 0, 0, 2); };
        pu.setOpacity = (a) => { a = clamp(a == null ? 1 : +a, 0, 1); dm.opacity = dU.uE3B.value.y = a; if (dm.transparent !== a < 1) { dm.transparent = a < 1; dm.needsUpdate = true; } };
        pu.update = (dtMs, timeMs) => { dU.uE3B.value.x = (timeMs == null ? dU.uE3B.value.x + (dtMs || 0) : timeMs + st.ph) % 1e6; };
        pu.dispose = () => { dm.dispose(); this.live.delete(dm); };
        return part;
      }
      return null;
    };
    // jump every slewed value to its target (after spawning, or for a still frame)
    ud.settle = () => { S.aim = st.aim; S.charge = st.charge; S.thrust = st.thrust; S.recoil = 0; ud.update(0); };

    const R = g.rig, rigFn = def.rig, ixs = g.ix;
    ud.update = (dtMs, timeMs) => {
      const dt = dtMs || 0, k = dt * 0.001;
      const t = (timeMs == null ? (st.time += dt) : (st.time = timeMs)) + st.ph;
      B.x = E.y = t % 1e6;
      const d = S.damage, q = st.death;
      let L = lights();
      // engine: fine shimmer, plus sputter when badly hurt; in a wreck the port burners are dead, and a dying
      // ship coughs on what is left until that goes too
      let f = 1 + 0.05 * Math.sin(t * 0.045) + 0.03 * Math.sin(t * 0.113 + 1.7);
      const n1 = Math.sin(t * 0.031) * Math.sin(t * 0.0173 + 2.0), n2 = Math.sin(t * 0.05) * Math.sin(t * 0.023 + 1.1);
      if (d > 0.45 && n1 > 1.25 - d) f *= 0.35;
      st.flick = f;
      st.eng2 = S.wreck > 0.5 ? (n2 > 0.72 ? 0.5 : 0) : 1;
      st.eng1 = 1;
      if (q > 0) {
        const cough = n1 > q * 2.4 - 0.75 ? 1 : 0;
        st.eng1 = cough * (1 - 0.5 * q); st.eng2 = 0;
        L = (1 - q * q) * (n2 > q * 1.5 - 0.9 ? 1 : 0.12); // the lamps gutter out on their own
        st.flick = f * (0.8 + 0.4 * cough);
      }
      if (q > 0 && st.thrust < 0.9) { const keep = st.thrust; st.thrust = 0.9; applyEngine(); st.thrust = keep; } else applyEngine();
      for (let i = 0; i < ud.nozzles.length; i++) { const n = ud.nozzles[i]; n.on = pose.hide[n.part | 0] ? 0 : n.port ? (st.eng2 > 0 ? 1 : 0) : (st.eng1 > 0 ? 1 : 0); }
      // fire inside: banked while the ship fights on, roaring through the death fall, guttering at the end
      C.y = q > 0 ? smooth(q / 0.22) * (1 - 0.8 * smooth((q - 0.8) / 0.2)) * (0.8 + 0.2 * Math.sin(t * 0.021)) : 0.3 * smooth((d - 0.4) / 0.5);
      // eyes smoulder; warning strobes blink; damage makes the lot stutter
      let eye = 0.86 + 0.14 * Math.sin(t * 0.005), strobe = (t % 1100) < 90 ? 1.5 : 0.05;
      if (d > 0.6 && n2 > 0.2) { eye *= 0.15; strobe *= 0.2; }
      lv[CH.STATIC] = L; lv[CH.EYE] = eye * L * (st.elite ? 1.5 : 1); lv[CH.STROBE] = strobe * L; lv[CH.BIO] = (d > 0.75 ? 0.5 : 1) * L;
      lv[CH.ACCENT] = ((0.82 + 0.18 * Math.sin(t * 0.003)) * (d > 0.75 ? 0.5 + 0.5 * Math.sin(t * 0.04) : 1) + S.recoil * 0.45) * L;
      lv[CH.COCKPIT] = (1 - d * 0.4) * L;
      lv[CH.CHARGE] = L;
      lv[CH.GOLD] = st.elite ? (0.85 + 0.15 * Math.sin(t * 0.004 + 1.0)) * L : 0;

      /* ---- machinery ---- */
      S.t = t; S.dt = dt;
      if (aimRate) S.aim += clamp(st.aim - S.aim, -aimRate * k, aimRate * k);
      S.charge += clamp(st.charge - S.charge, -6 * k, 4 * k);
      S.thrust += clamp((q > 0 ? st.eng1 * 0.6 : st.thrust) - S.thrust, -5 * k, 5 * k);
      if (S.recoil > 0) { S.recoil *= Math.exp(-dt / 110); if (S.recoil < 0.004) S.recoil = 0; }
      pose.reset();
      const th = S.thrust, rl = S.roll, wr = S.wreck;
      for (let j = 0; j < R.eng.length; j++) { // petals open with thrust and vector against the roll
        const i = R.eng[j], z = g.parts[i].eng, o = (th <= 1 ? 0.84 + 0.16 * th : 1 + 0.14 * (th - 1)) + 0.012 * Math.sin(t * 0.021 + j * 2.1) - 0.08 * wr * (j & 1);
        pose.scl(i, 1, o, o);
        pose.rot(i, 0, Math.abs(z) < 1e-4 ? rl * 0.16 : 0, Math.abs(z) < 1e-4 ? 0 : rl * 0.2 * Math.sign(z) + wr * 0.12 * (j & 1));
      }
      for (let j = 0; j < R.flap.length; j++) { const i = R.flap[j]; pose.a[i] = rl * 0.6 + 0.03 * Math.sin(t * 0.004 + j) + wr * 0.5 * g.parts[i].flap * (j & 1 ? 1 : 0.3); }
      for (let j = 0; j < R.recoil.length; j++) { const i = R.recoil[j]; pose.p[i * 3] = -S.recoil * g.parts[i].recoil; }
      for (let j = 0; j < R.spin.length; j++) { const i = R.spin[j]; pose.a[i] = (t * 0.001 * g.parts[i].spin * (1 - 0.85 * wr)) % TAU; }
      for (let j = 0; j < R.bend.length; j++) { const i = R.bend[j], b = g.parts[i].bend; pose.rot(i, b[0] * wr, b[1] * wr, b[2] * wr); }
      if (rigFn) rigFn(pose, ixs, S);
      if (R.ornate > 0 && !st.elite) pose.scl(R.ornate, 0, 0, 0);
      pose.solve();
      const pm = pose.m;
      for (let i = 0; i < muzzleRest.length; i++) { // muzzles ride on their parts
        const r = muzzleRest[i], o = (r.part | 0) * 16;
        if (!o) continue;
        const m = ud.muzzles[i];
        m.x = pm[o] * r.x + pm[o + 4] * r.y + pm[o + 8] * r.z + pm[o + 12];
        m.y = pm[o + 1] * r.x + pm[o + 5] * r.y + pm[o + 9] * r.z + pm[o + 13];
        m.z = pm[o + 2] * r.x + pm[o + 6] * r.y + pm[o + 10] * r.z + pm[o + 14];
      }
    };
    ud.dispose = () => { for (const m of mats) { m.dispose(); this.live.delete(m); } };
    refresh();
    ud.setThrust(opts.thrust ?? 1);
    ud.update(0, 0);
    return group;
  }

  dispose() {
    for (const m of this.live) m.dispose();
    this.live.clear();
    for (const g of this.geo.values()) { g.hull.dispose(); g.emis.dispose(); for (const d of g.debris.values()) d.geo.dispose(); }
    for (const t of this.tex.values()) { t.map.dispose(); t.orm.dispose(); t.normal.dispose(); }
    this.geo.clear(); this.tex.clear(); this.defs.clear();
  }
}
