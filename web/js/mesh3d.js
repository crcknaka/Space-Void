// mesh3d.js — tiny software 3D renderer for the canvas-2D pipeline.
// Low-poly meshes defined in code are flat-shaded and drawn as sorted polygon
// fills (painter's algorithm, weak perspective). Meshes are either baked into
// sprite canvases at load (drop-in for the old PNGs — drawImage accepts a
// canvas) or rendered live for hero objects (player ship, bosses).
//
// Model space: +x = nose/forward, +y = up, +z = starboard.
// VIEW tilts the model so the camera sits above and a little behind the port
// flank — the classic 3/4 shmup sprite view. Screen y is flipped (canvas).

/* --------------------------------- RNG ---------------------------------- */
// Own seeded stream (mulberry32) — must never touch the game-logic RNG in
// const.js (daily-challenge determinism) nor Math.random draw jitter.
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ mesh builder ----------------------------- */

export function newMesh() {
  return { verts: [], faces: [] };
}

export function addVert(m, x, y, z) {
  m.verts.push([x, y, z]);
  return m.verts.length - 1;
}

// c = [r,g,b] 0..255; e = emissive 0..1 (1 = full color regardless of light).
// layer biases the depth sort (model units): attachments sitting ON a surface
// (canopy, stripes, lights) get a small positive layer so their draw order
// never flip-flops with the hull during rotation (painter's-algorithm popping).
export function addFace(m, v, c, e = 0, layer = 0) {
  m.faces.push({ v, c, e, l: layer });
}

// Solid of revolution around the x-axis. Sections run nose→tail:
// { x, r, sy (vertical squash), cy, cz (center offsets) }.
export function addLathe(m, sections, sides, c, o = {}) {
  const L = o.layer || 0;
  const rings = sections.map((s) => {
    const ring = [];
    const sy = s.sy ?? o.sy ?? 1;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      ring.push(addVert(m, s.x, (s.cy || 0) + Math.cos(a) * s.r * sy, (s.cz || 0) + Math.sin(a) * s.r));
    }
    return ring;
  });
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      addFace(m, [rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]], c, o.e || 0, L);
    }
  }
  if (o.capFront) addFace(m, rings[0].slice(), o.capColor || c, o.capE ?? o.e ?? 0, L);
  if (o.capBack) addFace(m, rings[rings.length - 1].slice().reverse(), o.capColor || c, o.capE ?? o.e ?? 0, L);
}

// Ensures an outline traverses counterclockwise so mirrored parts keep a
// consistent winding (mirroring z reverses orientation → breaks culling).
function ccw(pts, ax, bx) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p[ax] * q[bx] - q[ax] * p[bx];
  }
  return s >= 0 ? pts : pts.slice().reverse();
}

// Horizontal plate (wings): outline pts [[x, z, yOff?]] in top view, extruded
// th thick around height y0. Optional per-point yOff gives dihedral/cant.
export function addPlateY(m, pts, y0, th, c, e = 0, layer = 0) {
  pts = ccw(pts, 1, 0); // consistent winding in the x-z plane (y up)
  const top = pts.map(([x, z, dy]) => addVert(m, x, y0 + (dy || 0) + th / 2, z));
  const bot = pts.map(([x, z, dy]) => addVert(m, x, y0 + (dy || 0) - th / 2, z));
  addFace(m, top.slice(), c, e, layer);
  addFace(m, bot.slice().reverse(), c, e, layer);
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    addFace(m, [top[j], top[i], bot[i], bot[j]], c, e, layer); // outward rim
  }
}

// Vertical plate (fins): outline pts [[x, y]] in side view, th thick around z0.
export function addPlateZ(m, pts, z0, th, c, e = 0, layer = 0) {
  pts = ccw(pts, 0, 1); // consistent winding in the x-y plane (z toward viewer)
  const a = pts.map(([x, y]) => addVert(m, x, y, z0 + th / 2));
  const b = pts.map(([x, y]) => addVert(m, x, y, z0 - th / 2));
  addFace(m, a.slice(), c, e, layer);
  addFace(m, b.slice().reverse(), c, e, layer);
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    addFace(m, [a[j], a[i], b[i], b[j]], c, e, layer); // outward rim
  }
}

export function addBox(m, cx, cy, cz, sx, sy, sz, c, e = 0, layer = 0) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const v = [
    addVert(m, x0, y0, z0), addVert(m, x1, y0, z0), addVert(m, x1, y1, z0), addVert(m, x0, y1, z0),
    addVert(m, x0, y0, z1), addVert(m, x1, y0, z1), addVert(m, x1, y1, z1), addVert(m, x0, y1, z1),
  ];
  addFace(m, [v[3], v[2], v[1], v[0]], c, e, layer); // -z
  addFace(m, [v[5], v[4], v[7], v[6]], c, e, layer); // +z
  addFace(m, [v[7], v[3], v[0], v[4]], c, e, layer); // -x
  addFace(m, [v[2], v[6], v[5], v[1]], c, e, layer); // +x
  addFace(m, [v[7], v[6], v[2], v[3]], c, e, layer); // +y
  addFace(m, [v[0], v[1], v[5], v[4]], c, e, layer); // -y
}

/* -------------------------------- renderer ------------------------------- */

// Default sprite view: camera above, nose → screen right, a sliver of the
// port flank visible. Banking (vertical movement tilt) is just rx += bank —
// the view tilt and a roll around the fuselage share the same axis.
export const VIEW = { rx: 1.12, ry: 0, rz: 0 };

const LIGHT = normalize3(-0.35, 0.8, 0.55); // upper-left, toward the viewer

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function rotMatrix(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // M = Rx * Ry * Rz
  return [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
  ];
}

// Projects a single model-space point with a view + fit transform into the
// same pixel space renderMesh/bake use (e.g. engine nozzles → sprite px).
export function projectPoint(view, fit, p) {
  const M = rotMatrix(view.rx ?? 0, view.ry ?? 0, view.rz ?? 0);
  const d = view.persp ?? 420;
  const X = M[0] * p[0] + M[1] * p[1] + M[2] * p[2];
  const Y = M[3] * p[0] + M[4] * p[1] + M[5] * p[2];
  const Z = M[6] * p[0] + M[7] * p[1] + M[8] * p[2];
  const f = d / (d - Z);
  return { x: fit.x + X * f * fit.scale, y: fit.y - Y * f * fit.scale, s: f * fit.scale };
}

// Renders a mesh into a 2D context. Opts: x, y (screen center), scale,
// rx/ry/rz (radians, applied Rz→Ry→Rx), persp (camera distance in model
// units), ambient, panel (panel-line darkening 0..1), light ([x,y,z]),
// flat ([r,g,b]: fill every face that color — hit-flash overlay pass).
// Reused scratch buffers — live renders (boss, turrets, debris) run every
// frame and per-call typed-array allocation is measurable GC churn.
let SC_N = 0;
let SCvx, SCvy, SCvz, SCpx, SCpy;
function scratch(n) {
  if (n > SC_N) {
    SC_N = Math.ceil(n * 1.5);
    SCvx = new Float64Array(SC_N); SCvy = new Float64Array(SC_N); SCvz = new Float64Array(SC_N);
    SCpx = new Float64Array(SC_N); SCpy = new Float64Array(SC_N);
  }
}

export function renderMesh(g, mesh, o = {}) {
  const { x = 0, y = 0, scale = 1, rx = 0, ry = 0, rz = 0 } = o;
  const d = o.persp ?? 420;
  const M = rotMatrix(rx, ry, rz);
  const L = o.light ? normalize3(...o.light) : LIGHT;
  const amb = o.ambient ?? 0.44, dif = 1 - amb;
  const panel = o.panel ?? 0.12;

  const n = mesh.verts.length;
  scratch(n);
  const vx = SCvx, vy = SCvy, vz = SCvz;
  const px = SCpx, py = SCpy;
  for (let i = 0; i < n; i++) {
    const [a, b, c] = mesh.verts[i];
    const X = M[0] * a + M[1] * b + M[2] * c;
    const Y = M[3] * a + M[4] * b + M[5] * c;
    const Z = M[6] * a + M[7] * b + M[8] * c;
    vx[i] = X; vy[i] = Y; vz[i] = Z;
    const f = d / (d - Z);
    px[i] = x + X * f * scale;
    py[i] = y - Y * f * scale;
  }

  // painter's algorithm: farthest (smallest z) first; f.l biases attachments
  // (canopy, stripes, lights) above the surface they sit on so their order
  // never flip-flops with the hull mid-rotation
  const order = [];
  for (let i = 0; i < mesh.faces.length; i++) {
    const f = mesh.faces[i];
    let s = 0;
    for (const vi of f.v) s += vz[vi];
    order.push([s / f.v.length + (f.l || 0), i]);
  }
  order.sort((a, b) => a[0] - b[0]);

  g.lineJoin = 'round';
  g.lineWidth = o.lw ?? 1;
  const cull = o.cull !== false;
  for (const [, fi] of order) {
    const f = mesh.faces[fi];
    const ids = f.v;
    if (cull) {
      // back-face culling via projected signed area (meshes are wound outward);
      // kills the whole class of "far face pops over near face" flicker
      let area = 0;
      for (let i = 0; i < ids.length; i++) {
        const p = ids[i], q = ids[(i + 1) % ids.length];
        area += px[p] * py[q] - px[q] * py[p];
      }
      if (area <= 0) continue;
    }
    // Newell normal in view space (robust for degenerate/concave polys)
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < ids.length; i++) {
      const p = ids[i], q = ids[(i + 1) % ids.length];
      nx += (vy[p] - vy[q]) * (vz[p] + vz[q]);
      ny += (vz[p] - vz[q]) * (vx[p] + vx[q]);
      nz += (vx[p] - vx[q]) * (vy[p] + vy[q]);
    }
    const nl = Math.hypot(nx, ny, nz);
    // unlit faces (degenerate) fall back to ambient; |n·L| shades both sides
    let r, gg, b;
    if (o.flat) {
      [r, gg, b] = o.flat;
    } else {
      const nd = nl > 1e-6 ? Math.abs(nx * L[0] + ny * L[1] + nz * L[2]) / nl : 0;
      let q = (amb + dif * nd) * (o.gain ?? 1.16); // slight overbright — sprites sit on a near-black sky
      q = q + (1 - q) * f.e; // emissive pulls toward full brightness
      r = Math.min(255, f.c[0] * q) | 0;
      gg = Math.min(255, f.c[1] * q) | 0;
      b = Math.min(255, f.c[2] * q) | 0;
    }
    g.beginPath();
    g.moveTo(px[ids[0]], py[ids[0]]);
    for (let i = 1; i < ids.length; i++) g.lineTo(px[ids[i]], py[ids[i]]);
    g.closePath();
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.fill();
    // stroke seals antialiasing seams between faces; slightly darker = panel lines
    const pd = 1 - panel * (1 - f.e);
    g.strokeStyle = `rgb(${(r * pd) | 0},${(gg * pd) | 0},${(b * pd) | 0})`;
    g.stroke();
  }
}

/* ------------------------------- fit + bake ------------------------------ */

// Projected bounds scale linearly with `scale` (persp applies before scale),
// so one measuring pass yields the transform that centers/fits any box.
export function fitTransform(mesh, w, h, view = VIEW, margin = 0.86) {
  const d = view.persp ?? 420;
  const M = rotMatrix(view.rx ?? 0, view.ry ?? 0, view.rz ?? 0);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [a, b, c] of mesh.verts) {
    const X = M[0] * a + M[1] * b + M[2] * c;
    const Y = M[3] * a + M[4] * b + M[5] * c;
    const Z = M[6] * a + M[7] * b + M[8] * c;
    const f = d / (d - Z);
    const sx = X * f, sy = -Y * f;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  }
  const bw = Math.max(1e-6, maxX - minX), bh = Math.max(1e-6, maxY - minY);
  const scale = margin * Math.min(w / bw, h / bh);
  return {
    scale,
    x: w / 2 - ((minX + maxX) / 2) * scale,
    y: h / 2 - ((minY + maxY) / 2) * scale,
  };
}

// Bakes a mesh into a sprite canvas at fixed scale (px per model unit).
export function bake(mesh, w, h, o = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  renderMesh(g, mesh, { x: w / 2, y: h / 2, ...o });
  return c;
}

// Bakes auto-fitted to the canvas — for galleries/icons.
export function bakeAuto(mesh, w, h, view = VIEW, o = {}) {
  const fit = fitTransform(mesh, w, h, view, o.margin ?? 0.86);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  renderMesh(c.getContext('2d'), mesh, { ...view, ...o, ...fit });
  return c;
}
