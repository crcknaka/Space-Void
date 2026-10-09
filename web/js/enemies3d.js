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
// Model space: +X nose, +Y up, +Z starboard. A built group is exactly 1 long on
// X, centred on the origin. The module receives THREE; it imports only the
// modelling helpers from ships3d.js.
//
//   const fleet = new Enemies3D(THREE, { quality: 1 });
//   const g = fleet.build('sniper', { elite: false });
//   g.userData.{nozzles,muzzles,setThrust,setFlash,setDim,setDamage,setWarp,setOpacity,setCharge,update,dispose}

import {
  mirrorZ, move, rotX, rotY, rotZ, loft, fuselage, wing, wAt, lathe, latheY, ringRect, box, plate, Livery, Kit, bakeAO, GLSL_FACES,
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
const CH = { STATIC: 0, ENGINE: 1, EYE: 2, STROBE: 3, ACCENT: 4, COCKPIT: 5, CHARGE: 6, GOLD: 7, BIO: 8 };
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
/*  Build kit: ships3d's Kit, re-bucketed into hull + emissive only           */
/* ========================================================================== */

class EKit extends Kit {
  constructor(q, zr, P) {
    super(q, zr, P);
    this.hull.tr = [];
    this._trim = 0;
    this.swP = this.sw;                                                        // flat paint
    this.swM = [(0.495 + UV_X0) / UV_XW, 1 - (2 * zr - 0.03) / (2 * zr)];      // bare metal
    this.swG = [(0.385 + UV_X0) / UV_XW, 1 - 0.03 / (2 * zr)];                 // visor glass
  }
  _emit(b, t, col, crease, mode, hinge) {
    super._emit(b, t, col, crease, mode, hinge);
    if (b === this.hull) { const n = b.pos.length / 3, tr = b.tr; while (tr.length < n) tr.push(this._trim); }
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
  thruster(x, y, z, r, len, o = {}) {
    const n = o.n || this.seg(10), sy = o.sy || 1, sz = o.sz || 1, L = { y, z, sy, sz, phase: o.phase ?? TAU / (2 * n) }, E = ENG, g = o.glow ?? 1;
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
    this.nozzles.push({ x, y, z, r: r * 0.9 * Math.max(sy, sz) });
  }
  // light gun: breech x0 → muzzle x1, hexagonal
  gun(x0, x1, y, z, r, o = {}) {
    const n = o.n || 6;
    this.metal(lathe([[x0, r * 1.5], [x0 + r * 2.2, r * 1.5], [x0 + r * 2.8, r], [x1 - r * 4, r], [x1 - r * 3.6, r * 1.4], [x1, r * 1.4], [x1 - r * 0.4, r * 0.7]], n, { y, z, capB: false }), o.col || GUN, 30);
    this.glowTris(disc(x1 - r * 0.3, y, z, r * 0.72, n), mul(this.P.glow, 0.4), CH.ACCENT);
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
function defBasic() {
  const P = pal(0x789a42, 0x425c24, [2.6, 5.5, 0.5]);
  const WING = [
    { z: 0.06, xl: 0.15, xt: -0.37, y: -0.004, th: 0.036 },
    { z: 0.2, xl: 0.04, xt: -0.2, y: -0.004, th: 0.026 },
    { z: 0.3, xl: 0.15, xt: -0.02, y: -0.004, th: 0.014 },
  ];
  return {
    zr: 0.42, P, breach: [[-0.1, 0.13, 0.08], [0.14, -0.04, 0.055]],
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow;
      const F = fuselage([
        { x: -0.41, w: 0.07, t: 0.046, b: 0.04, et: 1.7, eb: 1.7 }, { x: -0.16, w: 0.1, t: 0.062, b: 0.046, et: 1.5, eb: 1.6 },
        { x: 0.12, w: 0.08, t: 0.05, b: 0.04, et: 1.4, eb: 1.5 }, { x: 0.36, w: 0.044, t: 0.026, b: 0.024, et: 1.3, eb: 1.4 },
        { x: 0.5, w: 0.006, t: 0.004, b: 0.004, et: 1.5, eb: 1.5 },
      ], { n: k.seg(12), sub: k.q >= 1 ? 3 : 2 });
      k.col(F.tris, C, { crease: 26 });
      k.eyes(0.08, 0.3, 0.02, F.top(0.08) + 0.02, F.top(0.3) + 0.006, 0.05, 0.026);
      k.trim(fin(-0.1, -0.4, 0.11, 0.18, 0.018, 0.04));
      k.gold(-0.36, -0.06, F.top(-0.2) + 0.004, 0.02, 0.03); k.gold(-0.36, -0.06, F.top(-0.2) + 0.004, -0.03, -0.02);
      SYM((s) => {
        k.col(side(blade(WING), s), C2, { crease: 24, trim: 1 });
        // tip claw pod + gun
        k.trim(side(lathe([[-0.07, 0.004], [-0.03, 0.019], [0.13, 0.019], [0.17, 0.011]], 6, { y: -0.004, z: 0.3 }), s));
        k.gun(0.14, 0.26, -0.004, s * 0.3, 0.0065);
        k.bar(WING, s, 0.09, 0.27, 0.3, 0.44, mul(G, 0.34));
        k.lamp(-0.06, 0.016, s * 0.3, 0.011, AMBER);
        // cheek intakes
        k.col(side(loft([ringRect(-0.32, -0.04, 0.014, 0.05, 0.115, 0.01), ringRect(0.15, -0.038, 0.012, 0.06, 0.122, 0.008)], { capB: false }), s), C, { crease: 26 });
        k.duct(ringRect(0.15, -0.038, 0.012, 0.06, 0.122, 0.008).map((p) => [p[0], p[1], p[2] * s]), 0.07, 0.007, { glow: [1.6, 0.5, 0.1] });
        k.trim(side(box(-0.3, 0.1, 0.012, 0.02, 0.108, 0.12, 0.003), s));
        // ventral strake
        k.solid(side(fin(-0.16, -0.38, 0.06, 0.1, 0.012, -0.03, 0.05, -62), s), DARK, { crease: 24 });
      });
      k.gun(0.3, 0.47, -0.026, 0, 0.0075);
      k.muzzles.unshift(k.muzzles.pop());
      k.belly(-0.3, 0.2, -0.046, 0.046, C2, { scoop: false });
      k.thruster(-0.5, 0.002, 0, 0.06, 0.13);
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
function defDrone() {
  const P = pal(0xe0d8ba, 0x34382f, [8.5, 2.6, 0.3]);
  const WING = [{ z: 0.09, xl: -0.02, xt: -0.4, y: -0.006, th: 0.034 }, { z: 0.2, xl: -0.12, xt: -0.4, y: -0.02, th: 0.022 }, { z: 0.275, xl: -0.05, xt: -0.3, y: -0.034, th: 0.01 }];
  const EYE1 = [9.5, 2.6, 0.22];
  return {
    zr: 0.4, P, breach: [[-0.08, 0.1, 0.09], [0.12, -0.04, 0.06]],
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
        k.col(side(blade(WING), s), C2, { crease: 24, trim: 1 });
        k.bar(WING, s, 0.11, 0.26, 0.5, 0.64, mul(AMBER, 0.3));
        k.solid(side(fin(-0.2, -0.38, 0.05, 0.08, 0.012, -0.02, 0.07, -64), s), DARK, { crease: 24 });
      });
      k.trim(fin(-0.12, -0.4, 0.1, 0.16, 0.02, 0.04));
      k.gold(-0.34, -0.1, F.top(-0.2) + 0.003, 0.03, 0.05); k.gold(-0.34, -0.1, F.top(-0.2) + 0.003, -0.05, -0.03);
      // engine: a collar as wide as the tail, one big burner
      k.solid(lathe([[-0.3, 0.07], [-0.4, 0.098], [-0.46, 0.094]], 8, { y: 0.004, sy: 0.72, capA: false, capB: false, phase: TAU / 16 }), DARK, { crease: 24 });
      k.thruster(-0.5, 0.004, 0, 0.082, 0.15, { n: 8, glow: 1.2 });
      k.solid(box(-0.26, 0.16, -0.05, -0.034, -0.03, 0.03, 0.006), DARK, { crease: 28 });
      k.muzzles.push({ x: 0.5, y: 0, z: 0 });
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
// Light fighter that carves S-turns: slim spine, long scimitar wings.
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
    zr: 0.46, P, breach: [[-0.12, 0.16, 0.07], [0.1, -0.03, 0.05]],
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
        k.col(side(blade([WM, WING[2], WING[3]]), s), C, { crease: 24, trim: 1 });
        k.bar(WING, s, 0.07, 0.36, 0.06, 0.2, mul(G, 0.34));
        k.trim(side(blade(CAN), s), { crease: 24 });
        // engine pods hugging the spine
        k.col(side(lathe([[-0.42, 0.03], [-0.3, 0.036], [-0.12, 0.03], [-0.02, 0.012]], k.seg(8), { y: 0.002, z: 0.062, phase: TAU / 16 }), s), C2, { crease: 26 });
        k.thruster(-0.5, 0.002, s * 0.062, 0.032, 0.09, { n: k.seg(8) });
        k.gun(0.04, 0.2, -0.012, s * 0.088, 0.0055);
        k.trim(side(fin(-0.24, -0.43, 0.085, 0.13, 0.012, 0.022, 0.062, 62), s));
        k.solid(side(fin(-0.26, -0.42, 0.06, 0.1, 0.01, -0.018, 0.062, -62), s), DARK, { crease: 24 });
        k.lamp(-0.42, 0.006, s * 0.375, 0.009, mul(G, 1.1), CH.ACCENT);
        k.gold(-0.3, -0.08, 0.04, s * 0.062 - 0.006, s * 0.062 + 0.006);
        // pod intake lips, seen head-on
        k.duct(ringRect(-0.03, -0.022, 0.024, 0.04, 0.086, 0.006).map((p) => [p[0], p[1], p[2] * s]), 0.05, 0.005, { glow: mul(G, 0.25), lipCol: DARK });
      });
      k.belly(-0.26, 0.16, -0.03, 0.034, C, { scoop: false, d: 0.008 });
      k.muzzles.unshift({ x: 0.5, y: 0, z: 0 });
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
function defHunter() {
  const P = pal(0xe01208, 0x70080a, [8, 1.3, 0.25]);
  const BLK = lin(0x0c0c0e);
  const WING = [
    { z: 0.055, xl: -0.06, xt: -0.4, y: 0, th: 0.036 },
    { z: 0.15, xl: 0.0, xt: -0.25, y: 0, th: 0.026 },
    { z: 0.235, xl: 0.19, xt: 0.06, y: 0, th: 0.01 },
  ];
  return {
    zr: 0.36, P, breach: [[-0.16, 0.08, 0.07], [0.02, -0.03, 0.05]],
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
        k.col(side(blade(WING), s), C, { crease: 24, trim: 1 });
        k.bar(WING, s, 0.08, 0.225, 0.3, 0.5, mul(G, 0.3));
        // shoulder intakes feeding the burner
        const r0 = ringRect(-0.06, -0.012, 0.05, 0.05, 0.1, 0.008);
        k.col(side(loft([ringRect(-0.34, 0.0, 0.05, 0.06, 0.1, 0.01), r0], { capB: false }), s), C2, { crease: 26 });
        k.duct(r0.map((p) => [p[0], p[1], p[2] * s]), 0.06, 0.006, { glow: [1.8, 0.4, 0.08], lipCol: BLK });
        k.gold(-0.3, 0.0, F.top(-0.15) + 0.002, s * 0.02, s * 0.032);
        k.solid(side(fin(-0.2, -0.4, 0.07, 0.11, 0.012, -0.03, 0.05, -58), s), BLK, { crease: 24 });
      });
      k.trim(fin(-0.1, -0.4, 0.13, 0.2, 0.018, 0.06), { crease: 24 });
      k.solid(fin(-0.16, -0.4, 0.09, 0.14, 0.014, -0.05, 0, -90), BLK, { crease: 24 });
      // the engine: an oversized cowl and a burner half the width of the ship
      k.col(lathe([[-0.22, 0.09], [-0.32, 0.112], [-0.4, 0.116]], k.seg(12), { capA: false, capB: false, phase: TAU / 24 }), C2, { crease: 26 });
      k.solid(lathe([[-0.4, 0.116], [-0.43, 0.118], [-0.47, 0.106]], k.seg(12), { capA: false, capB: false, phase: TAU / 24 }), BLK, { crease: 26 });
      k.thruster(-0.5, 0, 0, 0.102, 0.17, { n: k.seg(12), glow: 1.25 });
      k.muzzles.push({ x: 0.5, y: 0, z: 0 });
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
// Armoured gunship: a slab hull under layered plates, rocket pods on pylons.
function defTank() {
  const P = pal(0x9a5cf0, 0x4d2a8c, [4.2, 1.1, 9]);
  const PZ0 = 0.2, PZ1 = 0.335;
  return {
    zr: 0.44, P, breach: [[-0.1, 0.1, 0.1], [0.14, -0.2, 0.075]],
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
      const F = fuselage([
        { x: -0.42, w: 0.125, t: 0.058, b: 0.056, et: 4, eb: 4 }, { x: -0.1, w: 0.16, t: 0.072, b: 0.062, et: 4, eb: 4 },
        { x: 0.2, w: 0.15, t: 0.068, b: 0.06, et: 3.6, eb: 3.6 }, { x: 0.39, w: 0.1, t: 0.046, b: 0.05, et: 3, eb: 3 },
        { x: 0.47, w: 0.062, t: 0.026, b: 0.036, et: 3, eb: 3 },
      ], { n: k.seg(16), sub: 2 });
      k.col(F.tris, C2, { crease: 26 });
      // layered armour: glacis, deck, crest
      k.col(plate([[0.37, -0.085], [0.37, 0.085], [0.12, 0.14], [-0.3, 0.14], [-0.37, 0.105], [-0.37, -0.105], [-0.3, -0.14], [0.12, -0.14]], 0.04, 0.086, 0.008), C, { crease: 24 });
      k.col(plate([[0.1, -0.075], [0.1, 0.075], [-0.02, 0.1], [-0.28, 0.1], [-0.28, -0.1], [-0.02, -0.1]], 0.08, 0.108, 0.007), C2, { crease: 24, trim: 1 });
      k.trim(plate([[0.04, -0.022], [0.04, 0.022], [-0.26, 0.03], [-0.26, -0.03]], 0.1, 0.122, 0.005));
      k.eyes(0.24, 0.42, 0.04, 0.104, 0.058, 0.07, 0.048, { th: 0.22 });
      SYM((s) => {
        // rocket pod on a pylon
        k.solid(side(box(-0.16, 0.1, -0.022, 0.022, 0.13, PZ0 + 0.01, 0.006), s), DARK, { crease: 28 });
        k.col(side(box(-0.27, 0.2, -0.052, 0.052, PZ0, PZ1, 0.012), s), C2, { crease: 26 });
        k.col(side(plate([[0.17, PZ0 + 0.012], [0.17, PZ1 - 0.012], [-0.24, PZ1 - 0.012], [-0.24, PZ0 + 0.012]], 0.045, 0.066, 0.006), s), C, { crease: 24, trim: 1 });
        k.col(side(plate([[0.15, PZ0 + 0.016], [0.15, PZ1 - 0.016], [-0.2, PZ1 - 0.016], [-0.2, PZ0 + 0.016]], -0.045, -0.062, 0.006), s), C2, { crease: 24 });
        k.trim(side(box(-0.26, 0.19, 0.03, 0.06, PZ1 - 0.006, PZ1 + 0.008, 0.004), s));
        k.solid(side(box(0.192, 0.204, -0.04, 0.04, PZ0 + 0.012, PZ1 - 0.012), s), PITCH);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
          const y = (r - 0.5) * 0.038, z = lerp(PZ0 + 0.03, PZ1 - 0.03, c / 2);
          k.solid(side(lathe([[0.19, 0.0135], [0.218, 0.0135], [0.228, 0.009]], 6, { y, z, capB: false }), s), lin(0xc9c4bc), { crease: 30 });
          k.solid(side(lathe([[0.228, 0.009], [0.246, 0.002]], 6, { y, z, capA: false }), s), lin(0xe8421c), { crease: 30 });
          if (q >= 1 || (r === 0 && c === 1)) k.charge(side(disc(0.2055, y, z, 0.017, 6), s), mul(AMBER, 0.5), 0.3 + 0.1 * (r * 3 + c));
        }
        k.muzzles.push({ x: 0.245, y: 0, z: s * (PZ0 + PZ1) / 2 });
        k.thruster(-0.36, 0, s * (PZ0 + PZ1) / 2, 0.04, 0.1, { n: k.seg(8) });
        k.bar([{ z: PZ0 + 0.03, xl: 0.14, xt: -0.2, y: 0.066, th: 0 }, { z: PZ1 - 0.03, xl: 0.14, xt: -0.2, y: 0.066, th: 0 }], s, PZ0 + 0.058, PZ1 - 0.058, 0, 1, mul(G, 0.3));
        k.lamp(-0.25, 0.062, s * (PZ1 - 0.02), 0.012, AMBER, CH.STROBE);
        // chin cannons, side skirt, main engines
        k.gun(0.3, 0.5, -0.034, s * 0.042, 0.0085, { n: 8 });
        k.col(side(box(-0.32, 0.26, -0.072, -0.01, 0.15, 0.166, 0.006), s), C, { crease: 26 });
        k.thruster(-0.5, 0, s * 0.062, 0.05, 0.1, { n: k.seg(10) });
        k.gold(-0.26, 0.08, 0.1095, s * 0.082, s * 0.094);
      });
      k.solid(box(-0.44, -0.37, -0.03, 0.04, -0.03, 0.03, 0.006), DARK, { crease: 28 }); // mine chute
      k.belly(-0.34, 0.3, -0.064, 0.11, C, { bay: 0.6 });
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
// four radiator blades in an X and a deep keel under them.
function defSniper() {
  const P = pal(0x3a52e8, 0x1c2a8c, [1.1, 2.2, 10]);
  const RAIL = [1.3, 4.2, 10];
  const HOOP = [[-0.03, 0.084], [0.1, 0.072], [0.22, 0.061], [0.335, 0.051]]; // x, radius
  const FN = { xl: -0.19, xt: -0.43, h: 0.215, rake: -0.17, th: 0.022, y0: 0.026, z0: 0.04 };
  // a point on a radiator blade: chord fraction f, distance zl out along it, height off its surface
  const fp = (f, zl, cant, s, up) => {
    const u = zl / FN.h, x = lerp(FN.xl - FN.rake * u, FN.xt - FN.rake * 0.35 * u, f), th = lerp(FN.th, FN.th * 0.45, u);
    const off = up > 0 ? th * 0.5 + 0.0015 : -(th * 0.36 + 0.0015), ca = Math.cos(cant * DEG), sa = Math.sin(cant * DEG);
    return [x, (cant > 0 ? FN.y0 : -FN.y0) + off * ca + zl * sa, s * (FN.z0 - off * sa + zl * ca)];
  };
  return {
    zr: 0.34, P, breach: [[-0.22, 0.05, 0.07], [0.1, -0.02, 0.045]],
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
        // rails
        k.metal(side(loft([ringRect(-0.08, -0.022, 0.022, 0.01, 0.034, 0.004), ringRect(0.4, -0.017, 0.017, 0.01, 0.03, 0.004), ringRect(0.5, -0.009, 0.009, 0.01, 0.02, 0.002)]), s), GUN, 26);
        // capacitor banks
        k.col(side(lathe([[-0.4, 0.016], [-0.37, 0.027], [-0.16, 0.027], [-0.12, 0.014]], n8, { y: 0.004, z: 0.09, phase: TAU / 16 }), s), C2, { crease: 26 });
        for (let i = 0; i < 3; i++) {
          const x = -0.34 + i * 0.07;
          k.metal(side(lathe([[x - 0.008, 0.031], [x + 0.008, 0.031]], n8, { y: 0.004, z: 0.09, phase: TAU / 16 }), s), GUN, 26);
          k.charge(side(lathe([[x + 0.009, 0.0295], [x + 0.022, 0.0295]], n8, { y: 0.004, z: 0.09, capA: false, capB: false, phase: TAU / 16 }), s), mul(RAIL, 0.55), 0.04 + i * 0.05);
        }
        // radiator blades: an X seen from ahead, forward-raked claws from above
        for (const cant of [50, -50]) {
          k.col(side(fin(FN.xl, FN.xt, FN.h, FN.rake, FN.th, cant > 0 ? FN.y0 : -FN.y0, FN.z0, cant), s), cant > 0 ? C : C2, { crease: 24, trim: cant > 0 ? 1 : 0 });
          for (const up of [1, -1]) k.quad(fp(0.27, 0.03, cant, s, up), fp(0.27, FN.h * 0.94, cant, s, up), fp(0.42, FN.h * 0.94, cant, s, up), fp(0.42, 0.03, cant, s, up), mul(G, 0.3));
          // heat-sink pod on the tip, its lamp pointing at you
          const tp = fp(0.3, FN.h, cant, 1, 0);
          k.trim(side(lathe([[tp[0] - 0.09, 0.004], [tp[0] - 0.05, 0.015], [tp[0] + 0.05, 0.015], [tp[0] + 0.075, 0.009]], 6, { y: tp[1], z: tp[2] }), s));
          k.lamp(tp[0] + 0.074, tp[1], s * tp[2], 0.011, mul(G, 0.95), CH.ACCENT);
        }
        k.gold(-0.36, -0.14, 0.032, s * 0.09 - 0.005, s * 0.09 + 0.005);
      });
      // capacitor hoops: closed rings on four spokes; their forward faces light breech → muzzle as the shot charges
      HOOP.forEach(([x, R], i) => {
        const t = 0.013, ph = 0.16 + 0.2 * i;
        k.metal(lathe([[x - 0.014, R - t], [x - 0.008, R], [x + 0.008, R], [x + 0.014, R - t], [x + 0.008, R - 2 * t], [x - 0.008, R - 2 * t], [x - 0.014, R - t]], n8, { capA: false, capB: false, phase: TAU / 16 }), i % 2 ? GUN : DARK, 26);
        for (let j = 0; j < 4; j++) k.solid(rotX(box(x - 0.006, x + 0.006, 0.016, R - t, -0.005, 0.005, 0.002), (j / 4) * TAU + TAU / 8), i % 2 ? DARK : C2, { crease: 26 });
        k.halo(x + 0.0148, 0, 0, R - 2 * t + 0.003, R - 0.003, mul(RAIL, 0.5), n8, CH.CHARGE, ph);
        k.glowTris(lathe([[x - 0.004, R + 0.0012], [x + 0.004, R + 0.0012]], n8, { capA: false, capB: false, phase: TAU / 16 }), mul(G, 0.22), CH.ACCENT);
        k.charge(lathe([[x - 0.007, R + 0.0016], [x + 0.007, R + 0.0016]], n8, { capA: false, capB: false, phase: TAU / 16 }), mul(RAIL, 0.4), ph);
      });
      // rail bed
      const NB = q >= 1 ? 5 : 3;
      for (let i = 0; i < NB; i++) {
        const x = lerp(0.03, 0.43, i / (NB - 1));
        k.solid(box(x - 0.014, x + 0.014, -0.032, -0.016, -0.032, 0.032, 0.004), DARK, { crease: 26 });
        SYM((s) => k.charge(box(x - 0.008, x + 0.008, 0.0222, 0.0245, s * 0.012, s * 0.032), mul(RAIL, 0.6), 0.2 + 0.62 * (i / (NB - 1))));
      }
      // the bore: a ribbon of plasma that fills breech → muzzle as the shot charges
      const NS = q >= 1 ? 12 : 6;
      for (let i = 0; i < NS; i++) {
        const x0 = lerp(-0.06, 0.49, i / NS), x1 = lerp(-0.06, 0.49, (i + 1) / NS), ph = 0.14 + 0.7 * (i / (NS - 1));
        k.strip(x0, x1, 0.0, -0.0095, 0.0095, RAIL, CH.CHARGE, ph);
        k.charge([x0, -0.017, 0, x1, -0.017, 0, x1, 0.017, 0, x0, -0.017, 0, x1, 0.017, 0, x0, 0.017, 0], mul(RAIL, 0.7), ph);
      }
      // muzzle brake, the glare in the bore and the star that burns at full charge
      k.trim(box(0.44, 0.492, -0.024, 0.024, -0.04, -0.03, 0.004)); k.trim(box(0.44, 0.492, -0.024, 0.024, 0.03, 0.04, 0.004));
      k.charge(disc(0.501, 0, 0, 0.03, 8), mul(RAIL, 0.9), 0.5);
      const MS = [2.2, 6, 12], mx = 0.5;
      for (const [dy, dz] of [[0.11, 0], [0, 0.11], [0.06, 0.06], [0.06, -0.06]]) {
        k.charge([mx, -dy, -dz, mx + 0.012, 0, 0, mx, dy, dz, mx, -dy, -dz, mx - 0.012, 0, 0, mx, dy, dz], MS, 0.97);
        k.charge([mx - 0.05, 0, 0, mx, dy * 0.16, dz * 0.16, mx + 0.04, 0, 0, mx - 0.05, 0, 0, mx, -dy * 0.16, -dz * 0.16, mx + 0.04, 0, 0], MS, 0.97);
      }
      // keel: a long blade under the breech carrying the coolant line
      k.solid(fin(0.0, -0.4, 0.15, 0.03, 0.022, -0.04, 0, -90), DARK, { crease: 24 });
      k.trim(lathe([[-0.34, 0.005], [-0.3, 0.017], [-0.06, 0.017], [-0.01, 0.008]], 6, { y: -0.19 }));
      k.lamp(-0.012, -0.19, 0, 0.011, mul(G, 0.9), CH.ACCENT);
      k.strip(-0.3, -0.06, -0.19 - 0.018, -0.005, 0.005, mul(G, 0.3));
      k.trim(fin(-0.26, -0.44, 0.07, 0.1, 0.012, 0.05, 0, 90));
      k.thruster(-0.5, 0, 0, 0.05, 0.1, { n: n8 });
      k.muzzles.push({ x: 0.5, y: 0, z: 0 });
    },
    liv(L) {
      detail(L, { xs: [-0.1, -0.2, -0.3], zs: [0.05, 0.13], seed: 19, soot: [[-0.42, 0]], wear: 0.5, tone: [[[[-0.06, -0.03], [-0.44, -0.03], [-0.44, 0.03], [-0.06, 0.03]], 0.55]] });
    },
  };
}

/* -------------------------------- CARRIER -------------------------------- */
// Drone tender: a broad flight deck over two hangar bays, lit launch ramps.
function defCarrier() {
  const P = pal(0xf08a14, 0x94500c, [8, 3.4, 0.35]);
  const BZ0 = 0.095, BZ1 = 0.25, BC = (BZ0 + BZ1) / 2;
  const CLAW = [{ z: 0.262, xl: 0.02, xt: -0.34, y: -0.004, th: 0.04 }, { z: 0.31, xl: 0.06, xt: -0.2, y: -0.004, th: 0.028 }, { z: 0.345, xl: 0.2, xt: 0.04, y: -0.004, th: 0.012 }];
  return {
    zr: 0.46, P, breach: [[-0.12, 0.17, 0.1], [0.06, -0.14, 0.08]],
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
      // island + mast
      k.solid(box(-0.34, -0.1, 0.04, 0.1, -0.06, 0.06, 0.012), DARK, { crease: 26 });
      k.trim(box(-0.3, -0.14, 0.098, 0.116, -0.036, 0.036, 0.006));
      k.glowBox(-0.1005, -0.097, 0.066, 0.084, -0.046, 0.046, mul(G, 0.5), CH.ACCENT);
      k.solid(box(-0.27, -0.262, 0.11, 0.2, -0.004, 0.004), GUN, { crease: 30 });
      k.trim(box(-0.285, -0.25, 0.158, 0.166, -0.03, 0.03, 0.002));
      k.lamp(-0.266, 0.205, 0, 0.008, AMBER, CH.STROBE);
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
        // deck plate over the bay with a guide light line
        k.col(side(plate([[0.19, BZ0 - 0.004], [0.19, BZ1 + 0.004], [-0.3, BZ1 + 0.004], [-0.36, BZ1 - 0.04], [-0.36, BZ0 - 0.004]], 0.03, 0.062, 0.007), s), C, { crease: 24 });
        k.strip(-0.3, 0.17, 0.0645, s * BC - 0.0045, s * BC + 0.0045, mul(G, 0.5));
        k.trim(side(box(-0.34, 0.19, 0.04, 0.07, BZ1 + 0.002, BZ1 + 0.014, 0.004), s));
        k.gold(-0.3, 0.17, 0.0645, s * (BZ1 - 0.012), s * (BZ1 - 0.004));
        // claw sponsons
        k.col(side(blade(CLAW), s), C2, { crease: 24, trim: 1 });
        k.lamp(0.19, 0.004, s * 0.345, 0.011, AMBER, CH.STROBE);
        k.thruster(-0.5, 0, s * 0.15, 0.046, 0.1, { n: k.seg(8) });
        k.muzzles.push({ x: 0.33, y: -0.02, z: s * BC });
        // belly: bay floor plate with a drop hatch
        k.col(side(plate([[0.14, BZ0 + 0.004], [0.14, BZ1 - 0.004], [-0.32, BZ1 - 0.004], [-0.32, BZ0 + 0.004]], -0.045, -0.064, 0.006), s), C2, { crease: 24 });
        k.solid(side(box(-0.2, 0.04, -0.068, -0.062, BZ0 + 0.03, BZ1 - 0.03, 0.002), s), PITCH, { crease: 30 });
        k.strip(-0.19, 0.03, -0.0685, s * BC - 0.004, s * BC + 0.004, mul(G, 0.25));
      });
      k.thruster(-0.5, 0, 0, 0.055, 0.11, { n: k.seg(10) });
      k.belly(-0.32, 0.2, -0.05, 0.075, C2, { bay: 0.45 });
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
// the six projector lenses on its corners burn, facing out toward the bubble they hold up.
function defShieldbearer() {
  const P = pal(0x2e8ea6, 0x12485a, [0.9, 6, 8]);
  const R = 0.27, RX = -0.02;
  const beam = (ax, az, bx, bz, w, y0, y1) => { const L = Math.hypot(bx - ax, bz - az), a = Math.atan2(bz - az, bx - ax); return move(rotY(box(-L / 2, L / 2, y0, y1, -w, w, w * 0.45), a, 0, 0), (ax + bx) / 2, 0, (az + bz) / 2); };
  return {
    zr: 0.44, P, breach: [[-0.1, 0.06, 0.08], [0.1, -0.05, 0.055]],
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
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
        k.trim(latheY([[-0.03, 0.024], [-0.022, 0.03], [0.024, 0.03], [0.032, 0.022], [0.032, 0.0005]], 6, ax, az), { crease: 26 });
        for (const dy of [0.014, -0.014]) k.metal(move(rotY(box(0.022, 0.07, dy - 0.005, dy + 0.005, -0.006, 0.006, 0.002), a, 0, 0), ax, 0, az), GUN, 26);
        k.lamp(ax + c * 0.046, 0, az + s * 0.046, 0.0125, mul(G, 0.62), CH.ACCENT);
        k.lamp(ax, 0.036, az, 0.008, mul(G, 0.4), CH.ACCENT);
        // spoke back to the hull
        k.trim(move(rotY(box(0.06, R - 0.026, -0.006, 0.01, -0.009, 0.009, 0.003), a, 0, 0), RX, 0, 0));
        const p = (r, o) => [RX + c * r - s * o, 0.0118, s * r + c * o];
        k.quad(p(0.13, -0.004), p(R - 0.04, -0.004), p(R - 0.04, 0.004), p(0.13, 0.004), GOLD_GLOW, CH.GOLD);
      }
      // focusing crystal on the spine
      k.solid(latheY([[F.top(-0.1) + 0.01, 0.034], [F.top(-0.1) + 0.02, 0.03], [F.top(-0.1) + 0.024, 0.02]], 6, -0.1, 0), DARK, { crease: 26 });
      k.glowTris(latheY([[F.top(-0.1) + 0.02, 0.018], [F.top(-0.1) + 0.036, 0.012], [F.top(-0.1) + 0.05, 0.0005]], 6, -0.1, 0), mul(G, 0.7), CH.ACCENT);
      k.trim(fin(-0.22, -0.42, 0.08, 0.12, 0.014, 0.045));
      SYM((s) => k.thruster(-0.5, 0, s * 0.045, 0.036, 0.09, { n: k.seg(8) }));
      k.gun(0.3, 0.46, -0.02, 0, 0.0065);
      k.belly(-0.3, 0.14, -0.05, 0.07, C2);
      void q;
    },
    liv(L) {
      detail(L, { xs: [0.2, 0.0, -0.2], zs: [0.07], hw: 0.13, seed: 29, soot: [[-0.44, 0.045]], wear: 0.45, tone: [[[[0.1, -0.02], [-0.28, -0.03], [-0.28, 0.03], [0.1, 0.02]], 0.55]] });
    },
  };
}

/* -------------------------------- STRAFER -------------------------------- */
// Gunship: a three-barrel fan battery on a short gunmetal hull. Hot pink only where it warns you —
// the outer wing panels, the barrel sleeves, and three muzzle lights that never go out.
function defStrafer() {
  const P = pal(0xff2c8c, 0x7c0e44, [9, 0.9, 3.2]);
  const HC = lin(0x30343e), HC2 = lin(0x1c1e25);
  const WING = [
    { z: 0.08, xl: 0.0, xt: -0.36, y: -0.002, th: 0.04 },
    { z: 0.19, xl: -0.04, xt: -0.26, y: -0.002, th: 0.03 },
    { z: 0.285, xl: 0.1, xt: -0.1, y: -0.002, th: 0.014 },
  ];
  return {
    zr: 0.42, P, breach: [[-0.14, 0.12, 0.08], [0.0, -0.05, 0.06]],
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
      // three heavy barrels fanned ±7°
      const nb = k.seg(8), MZ = [9, 1.2, 3.4];
      [0, 1, -1].forEach((s, i) => {
        const z = s * 0.058, ang = s * 7 * DEG, R = (t) => rotY(t, ang, 0.16, z), r = 0.0135;
        k.metal(R(lathe([[0.16, r * 1.7], [0.24, r * 1.7], [0.25, r], [0.42, r], [0.43, r * 1.5], [0.5, r * 1.5], [0.497, r * 0.8]], nb, { y: -0.008, z, capB: false })), GUN, 26);
        k.col(R(lathe([[0.265, r * 1.42], [0.39, r * 1.42]], nb, { y: -0.008, z })), C, { crease: 26 }); // cooling sleeve
        k.charge(R(disc(0.4985, -0.008, z, r * 0.85, nb)), MZ, i ? 0.62 : 0.28);
        k.charge(R(box(0.275, 0.375, -0.008 + r * 1.44, -0.008 + r * 1.44 + 0.002, z - 0.003, z + 0.003)), mul(MZ, 0.5), i ? 0.5 : 0.18);
        const m = R([0.5, -0.008, z]);
        k.lamp(m[0] + 0.003, m[1], m[2], 0.0125, mul(MZ, 0.42), CH.ACCENT); // pilot light
        k.muzzles.push({ x: m[0], y: m[1], z: m[2] });
      });
      const WM = wAt(WING, 0.165);
      SYM((s) => {
        k.col(side(blade([WING[0], WM], { tip: false }), s), HC2, { crease: 24 });
        k.col(side(blade([WM, WING[1], WING[2]]), s), C, { crease: 24, trim: 1 });
        k.bar(WING, s, 0.1, 0.16, 0.32, 0.5, mul(G, 0.3));
        k.trim(side(lathe([[-0.12, 0.004], [-0.08, 0.018], [0.1, 0.018], [0.2, 0.003]], 6, { y: -0.002, z: 0.285 }), s));
        k.lamp(-0.1, 0.018, s * 0.285, 0.01, AMBER);
        // engine nacelles
        k.col(side(lathe([[-0.42, 0.04], [-0.3, 0.046], [-0.14, 0.04], [-0.04, 0.016]], k.seg(8), { y: 0.004, z: 0.1, phase: TAU / 16 }), s), HC, { crease: 26 });
        k.thruster(-0.5, 0.004, s * 0.1, 0.042, 0.1, { n: k.seg(8) });
        k.trim(side(fin(-0.22, -0.42, 0.09, 0.14, 0.014, 0.03, 0.1, 68), s));
        k.solid(side(fin(-0.24, -0.42, 0.06, 0.1, 0.012, -0.03, 0.1, -64), s), DARK, { crease: 24 });
        k.gold(-0.36, -0.12, 0.052, s * 0.1 - 0.006, s * 0.1 + 0.006);
      });
      k.belly(-0.3, 0.12, -0.046, 0.066, HC2, { glow: mul(MZ, 0.2) });
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
function defBrood() {
  const P = pal(0xb6d41e, 0x5c780c, [4.5, 8, 0.4]);
  const PZ = 0.142, SY = 0.74;
  const PROF = [[-0.43, 0.02], [-0.38, 0.064], [-0.31, 0.084], [-0.2, 0.1], [-0.1, 0.109], [0.03, 0.109], [0.14, 0.104], [0.25, 0.09], [0.33, 0.068], [0.4, 0.034], [0.44, 0.008]];
  const env = (x) => { let i = 0; while (i < PROF.length - 2 && x > PROF[i + 1][0]) i++; const a = PROF[i], b = PROF[i + 1]; return lerp(a[1], b[1], clamp((x - a[0]) / (b[0] - a[0]), 0, 1)); };
  const SEG = [-0.4, -0.3, -0.18, -0.05, 0.08, 0.2, 0.3]; // plate boundaries, tail → head
  const MEMB = lin(0x3c1420), VEIN = [5, 6.5, 0.5];
  return {
    zr: 0.4, P, breach: [[-0.1, 0.14, 0.09], [0.1, -0.14, 0.07]],
    geo(k) {
      const C = paint(P.base), C2 = paint(P.base2), G = P.glow, q = k.q;
      const n = k.seg(14), L = { y: 0, z: PZ, sy: SY };
      SYM((s) => {
        // soft body under the armour
        k.solid(side(lathe(PROF.map(([x, r]) => [x, r * 0.84]), n, L), s), DARK2, { crease: 44 });
        // carapace: each plate flares at its rear edge and tucks under the next one forward
        for (let i = 0; i < SEG.length - 1; i++) {
          const x0 = SEG[i], x1 = SEG[i + 1], xm = lerp(x0, x1, 0.45);
          k.col(side(lathe([[x0 - 0.012, env(x0) * 0.9], [x0, env(x0) * 1.06 + 0.004], [xm, env(xm) * 1.03], [x1 - 0.004, env(x1) * 0.9]], n, { ...L, capA: false, capB: false }), s), i % 2 ? C : mul(C, 0.78), { crease: 40, trim: i === SEG.length - 2 ? 1 : 0 });
          // light in the joint
          k.glowTris(side(lathe([[x0 - 0.02, env(x0 - 0.02) * 0.875], [x0 - 0.011, env(x0) * 0.895]], n, { ...L, capA: false, capB: false }), s), mul(G, 0.34), CH.BIO);
          // dorsal spike on every plate
          if (q >= 1 || i % 2 === 0) k.solid(side(fin(xm + 0.03, xm - 0.03, 0.03 + 0.012 * (i % 3), 0.05, 0.012, env(xm) * SY * 0.98, PZ), s), DARK, { crease: 24 });
        }
        // head shield + visor + mandibles
        k.col(side(lathe([[0.288, env(0.3) * 0.93], [0.3, env(0.3) * 1.07 + 0.004], [0.36, env(0.36) * 1.04], [0.43, 0.014], [0.445, 0.002]], n, { ...L, capA: false }), s), C2, { crease: 40, trim: 1 });
        k.eyes(0.25, 0.41, 0.01, 0.078, 0.03, 0.05, 0.024, { z: s * PZ, th: 0.3 });
        k.trim(side(rotY(lathe([[0.3, 0.02], [0.4, 0.013], [0.5, 0.0012]], 6, { y: -0.012, z: PZ + 0.07, sy: 0.7 }), -9 * DEG, 0.3, PZ + 0.07), s), { crease: 30 });
        k.trim(side(rotY(lathe([[0.3, 0.016], [0.39, 0.01], [0.47, 0.0012]], 6, { y: -0.012, z: PZ - 0.066, sy: 0.7 }), 7 * DEG, 0.3, PZ - 0.066), s), { crease: 30 });
        // glow sacs along the outer flank, and a row of belly lights
        for (const [x, r] of [[-0.24, 0.016], [-0.115, 0.019], [0.015, 0.019], [0.14, 0.016]]) k.lamp(x, 0.012, s * (PZ + env(x) * 0.97), r, mul(G, 0.36), CH.BIO);
        for (let i = 0; i < 5; i++) { const x = -0.3 + i * 0.12; k.lamp(x, -env(x) * SY * 0.98, s * PZ, 0.011, mul(G, 0.3), CH.BIO); }
        k.thruster(-0.5, 0, s * PZ, 0.05, 0.1, { n: k.seg(10), sy: 0.8 });
        k.gold(-0.2, 0.12, env(0) * SY + 0.006, s * PZ - 0.004, s * PZ + 0.004);
        k.muzzles.push({ x: 0.46, y: 0, z: s * PZ });
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
const HULL_VERT_HEAD = `
attribute float aTrim;
varying vec3 vE3Pos; varying float vE3Trim; varying vec3 vE3N; varying float vE3Sw;
`;
const HULL_FRAG_HEAD = `
uniform vec4 uE3A;   // flash, damage, dim, warp
uniform vec4 uE3B;   // time, fade, elite, seed
uniform vec3 uE3Warp;
uniform vec4 uE3Br[2];
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
const HULL_FRAG_COLOR = `
float e3soot = 0.0; float e3hot = 0.0; float e3edge = 0.0; float e3gold = vE3Trim * uE3B.z;
diffuseColor.rgb *= s3faces(vE3Pos, e3sd, e3dn);
{
  if (uE3A.w > 0.001) {
    float wn = e3n(vE3Pos.yz * 30.0 + uE3B.w) - 0.5;
    float wd = vE3Pos.x - e3front(uE3A.w) + wn * 0.1;
    if (wd < 0.0) discard;
    e3edge = 1.0 - smoothstep(0.0, 0.09, wd);
  }
  if (e3gold > 0.001) {
    float lum = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.5, 0.1) * clamp(0.5 + lum * 2.4, 0.0, 1.0), e3gold);
  }
  float dmg = uE3A.y;
  if (dmg > 0.001) {
    vec2 q = vE3Pos.xz;
    float n = e3f(q * 9.0 + uE3B.w * 3.7);
    float a = mix(0.86, 0.4, dmg);
    e3soot = smoothstep(a, a + 0.1, n) * 0.8;
    for (int i = 0; i < 2; i++) {
      float r = uE3Br[i].z * smoothstep(0.12 + 0.3 * float(i), 0.6 + 0.35 * float(i), dmg);
      if (r > 0.0005) {
        float d = length(q - uE3Br[i].xy) + (e3n(q * 34.0 + float(i) * 9.0) - 0.5) * r * 0.9;
        float core = 1.0 - smoothstep(r * 0.45, r, d);
        e3soot = max(e3soot, 1.0 - smoothstep(r * 0.8, r * 2.1, d));
        float crack = pow(1.0 - abs(2.0 * e3n(q * 42.0 + 3.0) - 1.0), 6.0);
        float rim = smoothstep(r * 0.72, r * 0.92, d) * (1.0 - smoothstep(r * 0.92, r * 1.08, d));
        e3hot += core * (0.02 + crack * crack * 1.1) + rim * (0.25 + 0.5 * crack);
      }
    }
    e3hot *= 0.72 + 0.28 * sin(uE3B.x * 0.011 + n * 40.0);
    e3hot *= smoothstep(0.3, 0.9, uE3A.z);   // a dead wreck cools
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.011, 0.01), e3soot * 0.9);
  }
}
`;
const HULL_FRAG_OUT = `
outgoingLight *= uE3A.z;
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
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvE3Pos = position; vE3Trim = aTrim; vE3N = normal; vE3Sw = step(0.8, uv.x) * step(0.4, abs(uv.y - 0.5));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HULL_FRAG_HEAD)
      .replace('#include <map_fragment>', HULL_FRAG_MAP)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + HULL_FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n#ifdef USE_NORMALMAP_TANGENTSPACE\nnormal = normalize(mix(nonPerturbedNormal, normal, e3up));\n#endif')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n#ifdef USE_ROUGHNESSMAP\nvec4 e3orm = texture2D(roughnessMap, vRoughnessMapUv, 3.0);\nif (vE3Sw < 0.5) roughnessFactor = mix(e3orm.g * roughness, roughnessFactor, e3up);\n#endif\nroughnessFactor = mix(mix(roughnessFactor, 0.44, e3gold), 0.95, e3soot);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n#ifdef USE_ROUGHNESSMAP\nif (vE3Sw < 0.5) metalnessFactor = mix(e3orm.b * metalness, metalnessFactor, e3up);\n#endif\nmetalnessFactor = mix(metalnessFactor, 1.0, e3gold) * (1.0 - 0.8 * e3soot);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(5.0, 1.1, 0.14) * e3hot;')
      .replace('#include <opaque_fragment>', HULL_FRAG_OUT + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'e3d-hull2';
  return mat;
}

const EMIS_VERT = `
attribute vec3 aCol; attribute vec2 aCh;
uniform float uLv[9]; uniform vec4 uE3E;   // flame, time, charge, _
varying vec3 vCol; varying vec3 vE3Pos;
void main() {
  int ch = int(aCh.x + 0.5);
  float lv = uLv[ch];
  vec3 p = position;
  if (ch == 6) {
    float c = uE3E.z;
    float k = smoothstep(aCh.y - 0.22, aCh.y, c * 1.22);
    float fl = 0.82 + 0.18 * sin(uE3E.y * 0.07 + position.x * 55.0);
    lv *= 0.07 * step(aCh.y, 0.9) + k * (0.55 + 2.3 * c * c) * mix(1.0, fl, c);
  } else {
    p.x -= aCh.y * uE3E.x * (1.0 + 0.16 * sin(uE3E.y * 0.045 + position.z * 380.0 + position.y * 517.0));
    if (ch == 8) lv *= 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uE3E.y * 0.0042 + position.x * 13.0 + abs(position.z) * 6.0), 2.0); // bioluminescence: a slow wave from tail to head
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  if (ch == 1 && aCh.y > 0.0) { // plume: thin it when seen end-on, and do not let boost white it out
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
/*  Public class                                                              */
/* ========================================================================== */

export class Enemies3D {
  constructor(THREE, opts = {}) {
    this.T = THREE;
    this.quality = opts.quality === 0.5 || opts.quality < 1 ? 0.5 : 1;
    this.anisotropy = opts.anisotropy ?? 8;
    this.textures = opts.textures !== false && typeof document !== 'undefined';
    this.geo = new Map();   // id → { hull, emis, nozzles, muzzles, breach, size, tris }
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
    // normalise: length exactly 1 on X, centred in x/z (emissive flames excluded)
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const hp = k.hull.pos;
    for (let i = 0; i < hp.length; i += 3) {
      const x = hp[i], y = hp[i + 1], z = hp[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    bakeAO([k.hull], { vox: this.quality >= 1 ? 0.009 : 0.013, floor: 0.34 });
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
    const emis = new T.BufferGeometry();
    emis.setAttribute('position', new T.Float32BufferAttribute(k.emis.pos, 3));
    emis.setAttribute('aCol', new T.Float32BufferAttribute(k.emis.col, 3));
    emis.setAttribute('aCh', new T.Float32BufferAttribute(k.emis.ch, 2));
    for (const geo of [hull, emis]) { geo.computeBoundingSphere(); geo.computeBoundingBox(); }
    // flames stretch behind the hull: pad the emissive bounds so it is never culled early
    emis.boundingSphere.radius += 0.35;
    g = {
      hull, emis,
      nozzles: k.nozzles.map(pt), muzzles: k.muzzles.map(pt),
      breach: (def.breach || [[0, 0.1, 0.08], [0.1, -0.05, 0.06]]).map(([x, z, r]) => [(x - ox) * sc, (z - oz) * sc, r * sc]),
      size: [1, (y1 - y0) * sc, (z1 - z0) * sc],
      tris: { hull: k.hull.pos.length / 9, emis: k.emis.pos.length / 9 },
    };
    g.tris.total = g.tris.hull + g.tris.emis;
    this.geo.set(id, g);
    return g;
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

  /** { tris (total), trisBy: {hull, emis}, drawCalls, size: [1, h, span], buildMs, glow: family accent (linear HDR rgb) } */
  info(id) {
    if (!DEFS[id]) id = 'basic';
    const g = this._geometry(id);
    return { tris: g.tris.total, trisBy: { hull: g.tris.hull, emis: g.tris.emis }, drawCalls: 2, size: g.size.slice(), buildMs: this.buildMs[id], glow: this._def(id).P.glow.slice() };
  }

  build(id, opts = {}) {
    if (!DEFS[id]) id = 'basic';
    const T = this.T, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), t0 = now();
    const g = this._geometry(id), tex = this._textures(id), def = this._def(id);
    if (this.buildMs[id] == null) this.buildMs[id] = now() - t0;

    const seed = ((++this._n * 0.61803398875) % 1) * 97;
    const lv = [1, 1, 1, 1, 1, 1, 1, 0, 1];
    const wc = def.P.glow, wm = 1.7 / Math.max(wc[0], wc[1], wc[2]);
    const A = new T.Vector4(0, 0, 1, 0);            // flash, damage, dim, warp
    const B = new T.Vector4(0, 1, opts.elite ? 1 : 0, seed); // time, fade, elite, seed
    const E = new T.Vector4(0.3, 0, 0, 0);          // flame, time, charge
    const Fv = new T.Vector4(1, 0, 0, seed);        // fade, flash, warp, seed
    const warpCol = { value: new T.Vector3(wc[0] * wm, wc[1] * wm, wc[2] * wm) };
    if (opts.elite) warpCol.value.set(1.7, 1.15, 0.35);
    const U = { uE3A: { value: A }, uE3B: { value: B }, uE3Warp: warpCol, uE3Br: { value: g.breach.map((b, i) => new T.Vector4(b[0], b[1], b[2], i)) } };
    const hull = patchHull(new T.MeshStandardMaterial({
      vertexColors: true, map: tex ? tex.map : null, normalMap: tex ? tex.normal : null,
      roughnessMap: tex ? tex.orm : null, metalnessMap: tex ? tex.orm : null,
      roughness: tex ? 1 : 0.45, metalness: tex ? 1 : 0.3, envMapIntensity: 1.0,
    }), U);
    const emis = new T.ShaderMaterial({
      uniforms: { uLv: { value: lv }, uE3E: { value: E }, uE3F: { value: Fv }, uE3Warp: warpCol },
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

    const st = { thrust: 1, damage: 0, dim: 1, opacity: 1, charge: 0, time: 0, flick: 1, elite: !!opts.elite, ph: seed * 61 };
    const lights = () => clamp((st.dim - 0.5) / 0.4, 0, 1);
    const applyEngine = () => {
      const t = st.thrust;
      lv[CH.ENGINE] = (0.2 + 0.8 * t + (t > 1 ? (t - 1) * 1.1 : 0)) * st.flick * lights();
      E.x = Math.max(0, t - 0.1) * (t > 1 ? 0.6 + (t - 1) * 0.9 : 0.6) * st.flick * (lights() > 0 ? 1 : 0);
    };
    const ud = group.userData;
    ud.enemyId = id;
    ud.elite = st.elite;
    ud.nozzles = g.nozzles.map((n) => ({ ...n }));
    ud.muzzles = g.muzzles.map((m) => ({ ...m }));
    ud.size = g.size.slice();
    ud.glow = def.P.glow.slice();
    ud.setThrust = (t) => { st.thrust = clamp(+t || 0, 0, 2); applyEngine(); };
    ud.setFlash = (v) => { A.x = Fv.y = clamp(+v || 0, 0, 1); };
    ud.setDim = (k) => { st.dim = A.z = clamp(k == null ? 1 : +k, 0, 2); ud.update(0); };
    ud.setDamage = (d) => { st.damage = A.y = clamp(+d || 0, 0, 1); };
    ud.setWarp = (w) => { A.w = Fv.z = clamp(+w || 0, 0, 1); };
    ud.setCharge = (c) => { st.charge = E.z = clamp(+c || 0, 0, 1); };
    ud.setElite = (on) => { st.elite = ud.elite = !!on; B.z = on ? 1 : 0; ud.update(0); };
    ud.setOpacity = (a) => {
      a = clamp(a == null ? 1 : +a, 0, 1);
      if (a === st.opacity) return;
      const was = st.opacity < 1, isNow = a < 1;
      st.opacity = a;
      hull.opacity = a; B.y = Fv.x = a;
      if (was !== isNow) { hull.transparent = isNow; hull.needsUpdate = true; }
    };
    ud.update = (dtMs, timeMs) => {
      const t = (timeMs == null ? (st.time += dtMs || 0) : (st.time = timeMs)) + st.ph;
      B.x = E.y = t % 1e6;
      const d = st.damage, L = lights();
      // engine: fine shimmer, plus sputter when badly hurt
      let f = 1 + 0.05 * Math.sin(t * 0.045) + 0.03 * Math.sin(t * 0.113 + 1.7);
      if (d > 0.45) { const n = Math.sin(t * 0.031) * Math.sin(t * 0.0173 + 2.0); if (n > 1.25 - d) f *= 0.35; }
      st.flick = f; applyEngine();
      // eyes smoulder; warning strobes blink; damage makes the lot stutter
      let eye = 0.86 + 0.14 * Math.sin(t * 0.005), strobe = (t % 1100) < 90 ? 1.5 : 0.05;
      if (d > 0.6 && Math.sin(t * 0.05) * Math.sin(t * 0.023) > 0.2) { eye *= 0.15; strobe *= 0.2; }
      lv[CH.STATIC] = L; lv[CH.EYE] = eye * L * (st.elite ? 1.5 : 1); lv[CH.STROBE] = strobe * L; lv[CH.BIO] = (d > 0.75 ? 0.5 : 1) * L;
      lv[CH.ACCENT] = (0.82 + 0.18 * Math.sin(t * 0.003)) * (d > 0.75 ? 0.5 + 0.5 * Math.sin(t * 0.04) : 1) * L;
      lv[CH.COCKPIT] = (1 - d * 0.4) * L;
      lv[CH.CHARGE] = L;
      lv[CH.GOLD] = st.elite ? (0.85 + 0.15 * Math.sin(t * 0.004 + 1.0)) * L : 0;
    };
    ud.dispose = () => { for (const m of mats) { m.dispose(); this.live.delete(m); } };
    ud.setThrust(opts.thrust ?? 1);
    ud.update(0, 0);
    return group;
  }

  dispose() {
    for (const m of this.live) m.dispose();
    this.live.clear();
    for (const g of this.geo.values()) { g.hull.dispose(); g.emis.dispose(); }
    for (const t of this.tex.values()) { t.map.dispose(); t.orm.dispose(); t.normal.dispose(); }
    this.geo.clear(); this.tex.clear(); this.defs.clear();
  }
}
