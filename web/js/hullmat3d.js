// hullmat3d.js — procedural hull surface for the WebGL view.
// Turns the flat-coloured mesh3d models (position / crease normal / vertex
// colour, no UVs) into plated, worn, manufactured-looking spacecraft without
// touching their geometry: an irregular multi-scale plating layout projected
// along the dominant model axis, per-plate paint/roughness variation, bevelled
// panel grooves, rivets/hatches/vents up close, edge wear, airflow streaks,
// tail soot, a micro normal that breaks up the env reflections, a fresnel rim
// and a few HDR accent seams — plus per-instance hit flash, dim, damage, heat,
// warp-in and opacity, all as plain uniform writes.
//
// No imports: THREE is handed in (core r170 API only). Every material made
// here is a real MeshStandardMaterial patched in onBeforeCompile, so .color,
// .emissive, .opacity, .metalness … keep working; all instances of a variant
// share ONE compiled program (customProgramCacheKey), each with its own
// uniform values.
//
//   const hull = new HullMaterials(THREE, { quality: 1 });
//   const mat  = hull.create({ kind: 'fighter', scale: 0.6, seed: 3 });
//   const glow = hull.emissive({ kind: 'fighter', seed: 3 });
//   mat.userData.setFlash(0.8); … hull.update(timeMs) once per frame.

const KINDS = {
  //            plate = plate height in WORLD units (÷ scale → model units)
  fighter:   { plate: 12.5, line: 0.34, glow: 1.0, glowDensity: 0.06, wear: 0.75, grime: 0.8, rim: 0.26, accentPanels: 0.14, metalness: 0.62, roughness: 0.40, emissive: 2.2, pulse: 0.10 },
  boss:      { plate: 21.0, line: 0.24, glow: 1.1, glowDensity: 0.10, wear: 0.9, grime: 1.0, rim: 0.28, accentPanels: 0.12, metalness: 0.68, roughness: 0.38, emissive: 2.3, pulse: 0.16 },
  freighter: { plate: 17.0, line: 0.30, glow: 0.5, glowDensity: 0.05, wear: 1.0, grime: 1.3, rim: 0.20, accentPanels: 0.06, metalness: 0.50, roughness: 0.52, emissive: 2.0, pulse: 0.05 },
  rocket:    { plate: 6.0, line: 0.30, glow: 0.0, glowDensity: 0.0, wear: 0.5, grime: 0.4, rim: 0.35, accentPanels: 0.20, metalness: 0.70, roughness: 0.34, emissive: 2.6, pulse: 0.0 },
  debris:    { plate: 12.5, line: 0.34, glow: 0.0, glowDensity: 0.0, wear: 1.2, grime: 1.5, rim: 0.18, accentPanels: 0.10, metalness: 0.55, roughness: 0.55, emissive: 1.2, pulse: 0.0 },
};

/* ------------------------------ noise texture ------------------------------ */
// One tileable RGBA8 texture, built once:
//   R  blotchy fbm (grime, wear and damage masks)
//   GB gradient of a finer height field (micro normal), 0.5-centred
//   A  an independent fbm (streaks, second damage octave)
function makeNoise(N) {
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000003) / 1000003; };
  const lattice = (p) => { const a = new Float32Array(p * p); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const sm = (t) => t * t * (3 - 2 * t);
  const sample = (lat, p, x, y) => { // periodic value noise, x/y in lattice units
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = sm(x - x0), fy = sm(y - y0);
    const i0 = ((x0 % p) + p) % p, i1 = (i0 + 1) % p, j0 = ((y0 % p) + p) % p, j1 = (j0 + 1) % p;
    const a = lat[j0 * p + i0], b = lat[j0 * p + i1], c = lat[j1 * p + i0], d = lat[j1 * p + i1];
    return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy;
  };
  const fbm = (periods, gains) => {
    const lats = periods.map(lattice), f = new Float32Array(N * N);
    let norm = 0; for (const g of gains) norm += g;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0;
      for (let o = 0; o < periods.length; o++) v += gains[o] * sample(lats[o], periods[o], (x / N) * periods[o], (y / N) * periods[o]);
      f[y * N + x] = v / norm;
    }
    return f;
  };
  const stretch = (f) => { // spread to the full 0..1 range
    let lo = 1, hi = 0; for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / (hi - lo);
    return f;
  };
  const blotch = stretch(fbm([4, 8, 16, 32], [1, 0.55, 0.3, 0.18]));
  const height = stretch(fbm([8, 16, 32, 64], [0.5, 1, 0.8, 0.5]));
  const other = stretch(fbm([3, 6, 12, 24, 48], [1, 0.6, 0.4, 0.25, 0.15]));
  const data = new Uint8Array(N * N * 4);
  const at = (f, x, y) => f[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const gx = (at(height, x + 1, y) - at(height, x - 1, y)) * 3.2;
    const gy = (at(height, x, y + 1) - at(height, x, y - 1)) * 3.2;
    data[i] = Math.round(blotch[y * N + x] * 255);
    data[i + 1] = Math.max(0, Math.min(255, Math.round((0.5 + gx) * 255)));
    data[i + 2] = Math.max(0, Math.min(255, Math.round((0.5 + gy) * 255)));
    data[i + 3] = Math.round(other[y * N + x] * 255);
  }
  return data;
}

/* --------------------------------- shaders --------------------------------- */

const VERT_PARS = /* glsl */`
varying vec3 vHullP;
varying vec3 vHullN;
`;
const VERT_MAIN = /* glsl */`
vHullP = position;
vHullN = normal;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vHullP;
varying vec3 vHullN;
uniform mat3 normalMatrix;
uniform sampler2D uHullNoise;
uniform float uHullTime;
uniform vec4 uHullA;      // flash, dim (albedo multiplier), damage, heat
uniform vec4 uHullB;      // warp, seed, plate size (model units), groove half-width (model units)
uniform vec4 uHullC;      // glow intensity, glow density, wear, grime
uniform vec4 uHullD;      // min x, max x (model), rim strength, accent-panel density
uniform vec3 uHullAccent; // x < 0 → derive from the vertex colour's hue
uniform vec3 uHullWarpCol;

float hullH1(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hullH3(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
vec4 hullTex(vec2 uv, float fw, vec2 f) {
  return textureGrad(uHullNoise, uv * f, vec2(fw * f.x, 0.0), vec2(0.0, fw * f.y));
}
// Irregular plating: a brick-offset grid of big cells, each split once
// (lengthwise or across) at a random ratio and usually once more the other way.
//   d    distance to the nearest plate edge (model units), dir → towards it
//   rnd  three random numbers of the plate, pl/sz position inside it and its size
//   dg   distance to the cell's primary split line (carries the glow seams), cr its random
void hullPlates(vec2 uv, vec2 cs, float seed, out float d, out vec2 dir, out vec3 rnd, out vec2 pl, out vec2 sz, out float dg, out vec3 cr) {
  vec2 q = uv / cs;
  float row = floor(q.y);
  q.x += hullH1(vec2(row, seed)) * 0.9;
  vec2 ci = floor(q);
  vec2 f = q - ci;
  vec3 h = hullH3(ci + seed * 17.0);
  cr = h;
  vec2 lo = vec2(0.0), hi = vec2(1.0);
  float s1 = 0.26 + 0.48 * h.y;
  float sub = 0.0;
  dg = 1e3;
  if (h.x < 0.44) {
    float sd = step(s1, f.x);
    sub = 1.0 + sd;
    lo.x = sd * s1; hi.x = mix(s1, 1.0, sd);
    dg = abs(f.x - s1) * cs.x;
    vec3 h2 = hullH3(ci * 1.7 + sub * 7.3 + seed);
    if (h2.x < 0.6) {
      float s2 = 0.26 + 0.48 * h2.y, se = step(s2, f.y);
      sub += 2.0 + se * 2.0;
      lo.y = se * s2; hi.y = mix(s2, 1.0, se);
    }
  } else if (h.x < 0.84) {
    float sd = step(s1, f.y);
    sub = 7.0 + sd;
    lo.y = sd * s1; hi.y = mix(s1, 1.0, sd);
    dg = abs(f.y - s1) * cs.y;
    vec3 h2 = hullH3(ci * 2.3 + sub * 5.1 + seed);
    if (h2.x < 0.6) {
      float s2 = 0.26 + 0.48 * h2.y, se = step(s2, f.x);
      sub += 2.0 + se * 2.0;
      lo.x = se * s2; hi.x = mix(s2, 1.0, se);
    }
  }
  rnd = hullH3(ci * 3.1 + sub * 13.7 + seed * 5.0);
  vec2 a = (f - lo) * cs, b = (hi - f) * cs;
  pl = a; sz = (hi - lo) * cs;
  vec2 m = min(a, b);
  if (m.x < m.y) { d = m.x; dir = vec2(a.x < b.x ? -1.0 : 1.0, 0.0); }
  else { d = m.y; dir = vec2(0.0, a.y < b.y ? -1.0 : 1.0); }
}
// anti-aliased, energy-conserving line of half-width w at distance d (pixel footprint fw)
float hullLine(float d, float w, float fw) {
  return clamp((w - d) / fw + 0.5, 0.0, 1.0) * min(1.0, 2.0 * w / fw);
}
`;

// runs right after <color_fragment>: everything that feeds albedo / roughness /
// metalness / normal / emissive is computed once here and consumed further down
const FRAG_ALBEDO = /* glsl */`
vec3 hP = vHullP;
float hSz = hP.z < 0.0 ? -1.0 : 1.0;
hP.z = abs(hP.z); // mirror: port and starboard get the same plating
vec3 hAn = abs(vHullN);
vec3 hFwp = fwidth(vHullP);
float hFw = max(max(hFwp.x, hFwp.y), hFwp.z) + 1e-4;
float hSeed = uHullB.y;
float hLen = max(uHullD.y - uHullD.x, 1.0);
float hT = clamp((vHullP.x - uHullD.x) / hLen, 0.0, 1.0); // 0 tail → 1 nose

vec2 hUv; vec3 hAU; vec3 hAV;
if (hAn.y * 1.15 >= max(hAn.x, hAn.z)) { hUv = hP.xz; hAU = vec3(1.0, 0.0, 0.0); hAV = vec3(0.0, 0.0, hSz); }
else if (hAn.z >= hAn.x) { hUv = hP.xy + vec2(31.7, 11.3); hAU = vec3(1.0, 0.0, 0.0); hAV = vec3(0.0, 1.0, 0.0); }
else { hUv = hP.zy + vec2(-17.1, 47.9); hAU = vec3(0.0, 0.0, hSz); hAV = vec3(0.0, 1.0, 0.0); }
hUv += vec2(hSeed * 7.31, hSeed * 3.17);

vec4 hN1 = hullTex(hUv, hFw, vec2(0.0105));               // blotches
vec4 hN3 = hullTex(hUv + 9.0, hFw, vec2(0.0034, 0.043));  // long streaks along the airflow

// --- warp-in: the hull is "printed" nose-first behind a noisy energy front
float hWarp = uHullB.x;
float hWarpEdge = 0.0;
if (hWarp > 0.001) {
  float hFront = (1.0 - hWarp) * 1.3 - 0.15;
  float hWd = (1.0 - hT) + (hN1.a - 0.5) * 0.22 - hFront;
  if (hWd > 0.0) discard;
  hWarpEdge = smoothstep(-0.07, 0.0, hWd);
}

float hPlate = uHullB.z;
vec2 hCs = vec2(hPlate * 1.6, hPlate);
float hD; vec2 hDir; vec3 hRnd; vec2 hPl; vec2 hPsz; float hDg; vec3 hCr;
hullPlates(hUv, hCs, hSeed, hD, hDir, hRnd, hPl, hPsz, hDg, hCr);
float hW = uHullB.w;
float hLod = 1.0 - smoothstep(0.10, 0.36, hFw / hPlate);  // plating fades out before it can shimmer
float hLine = hullLine(hD, hW, hFw) * hLod;
float hBev = hullLine(hD, hW * 2.0, hFw) * hLod;
vec2 hGrad = hDir * hBev * 0.5;

vec3 hBase = diffuseColor.rgb;
float hMx = max(hBase.r, max(hBase.g, hBase.b)), hMn = min(hBase.r, min(hBase.g, hBase.b));
float hLum = dot(hBase, vec3(0.2126, 0.7152, 0.0722));
vec3 hHue = (hBase - hMn) / max(hMx - hMn, 1e-4);          // fully saturated hue of the paint
float hSat = (hMx - hMn) / max(hMx, 1e-4);
vec3 hAcc = uHullAccent.x < 0.0
  ? mix(vec3(0.35, 0.75, 1.0), normalize(hHue * 0.9 + 0.1) * 1.25, smoothstep(0.06, 0.22, hSat))
  : uHullAccent;

// --- per-plate paint variation, accent panels, a painted stripe
vec3 hAlb = hBase * (1.0 + (hRnd.x - 0.5) * 0.30 * hLod);
hAlb = mix(hAlb, vec3(hLum), (hRnd.z - 0.5) * 0.35 * hLod);              // some plates greyer, some richer
float hAccPanel = step(1.0 - uHullD.w, hRnd.y) * hLod;
vec3 hPaint = mix(hBase, hHue * (hLum * 1.9 + 0.03) + hLum * 0.25, 0.75);  // the same hue, pushed
hAlb = mix(hAlb, mix(hPaint, hBase * 0.42, step(0.5, hRnd.x)), hAccPanel * 0.8);
float hStripeX = uHullD.x + hLen * (0.52 + 0.3 * hullH1(vec2(hSeed, 3.0)));
float hStripe = hullLine(abs(vHullP.x - hStripeX), hPlate * 0.11, hFw) * step(hAn.x, 0.6) * step(0.25, hullH1(vec2(hSeed, 9.0)));
hAlb = mix(hAlb, hPaint * 1.15 + 0.02, hStripe * 0.7);

// --- grime: blotches, airflow streaks, soot towards the tail
float hGrime = uHullC.w;
float hStreak = smoothstep(0.42, 0.9, hN3.r);
float hSoot = smoothstep(0.34, 0.0, hT) * (0.45 + 0.75 * hN3.a);
float hDirt = clamp(hGrime * (0.26 * hStreak + 0.16 * smoothstep(0.5, 0.95, hN1.r)) + min(hGrime, 1.2) * 0.5 * hSoot, 0.0, 0.8);
hAlb *= 1.0 - hDirt;
hAlb *= 1.0 + (hN1.a - 0.5) * 0.14;

// --- wear: bare metal chipping in from the plate edges and on tight curvature
float hCurv = length(fwidth(vHullN)) / (length(hFwp) + 1e-4);
float hWearMask = smoothstep(0.58, 0.80, hN1.r * 0.55 + hN3.a * 0.55);
float hWear = clamp(uHullC.z * (hWearMask * (1.0 - smoothstep(hW, hW + hPlate * 0.10, hD)) * hLod
  + smoothstep(0.12, 0.45, hCurv) * hWearMask * 0.6), 0.0, 1.0) * 0.6;
hAlb = mix(hAlb, vec3(0.60, 0.62, 0.66) * (0.55 + 0.6 * hLum), hWear);

float hRoughAdd = (hRnd.y - 0.5) * 0.26 * hLod + (hN1.r - 0.5) * 0.22 + hDirt * 0.45 - hWear * 0.22;
float hMetalAdd = (hRnd.z - 0.5) * 0.22 * hLod - hDirt * 0.5 + hWear * 0.45;

#ifdef HULL_HQ
// --- finest layer: micro normal, rivets along the plate edges, hatches and vents
vec4 hN2 = hullTex(hUv + 3.7, hFw, vec2(0.13));
hGrad += (hN2.gb - 0.5) * 0.065;
float hK = hPlate / 15.0; // fine detail is sized relative to the plating
float hFine = 1.0 - smoothstep(0.10, 0.32, hFw / hK);
if (hFine > 0.0) {
  float hAlong = abs(hDir.x) > 0.5 ? hPl.y : hPl.x;
  float hAlongSz = abs(hDir.x) > 0.5 ? hPsz.y : hPsz.x;
  float hRs = 2.1 * hK;
  float hRn = max(floor((hAlongSz - 1.6 * hK) / hRs), 1.0);
  float hRa = (hAlong - 0.5 * (hAlongSz - hRn * hRs)) / hRs;
  vec2 hRp = vec2(hD - 0.95 * hK, (fract(hRa) - 0.5) * hRs);
  float hRiv = (1.0 - smoothstep(0.13 * hK, 0.24 * hK, length(hRp))) * step(0.0, hRa) * step(hRa, hRn) * hFine * step(hRnd.x, 0.75);
  hAlb *= 1.0 - 0.34 * hRiv;
  hRoughAdd += 0.2 * hRiv;
  // inset hatch outline / vent slats on a few big plates
  vec2 hIn = min(hPl, hPsz - hPl);
  float hMargin = min(hPsz.x, hPsz.y) * 0.24;
  float hBig = step(4.5 * hK, min(hPsz.x, hPsz.y)) * hFine;
  float hHatch = step(0.80, hRnd.z) * hBig;
  float hHd = abs(min(hIn.x, hIn.y) - hMargin);
  float hHl = hullLine(hHd, 0.16 * hK, hFw) * hHatch;
  float hVent = step(hRnd.z, 0.13) * hBig * step(hMargin, min(hIn.x, hIn.y));
  float hVp = 1.3 * hK;
  float hSl = abs(fract(hPl.x / hVp) - 0.5) * hVp;
  float hVl = hullLine(hSl, 0.2 * hVp, hFw) * hVent;
  hAlb *= 1.0 - 0.6 * hHl - 0.72 * hVl;
  hGrad += vec2(1.0, 0.0) * hVent * (fract(hPl.x / hVp) - 0.5) * 1.6;
  hRoughAdd += 0.25 * hVl;
}
#endif

hAlb *= 1.0 - 0.72 * hLine;
hRoughAdd += 0.3 * hLine;

// --- accent seams: the primary split of a few cells is a lit channel
float hGlowOn = step(1.0 - uHullC.y, hCr.z) * step(hAn.x, 0.7);
float hPulse = 0.78 + 0.22 * sin(uHullTime * 2.1 + hCr.y * 40.0 + hSeed);
float hSeam = hullLine(hDg, hW * 0.85, hFw) * hGlowOn * hLod;
float hHalo = (1.0 - smoothstep(0.0, hW * 5.0, hDg)) * hGlowOn * hLod;
vec3 hGlow = hAcc * (hSeam * 3.0 + hHalo * hHalo * 0.22) * uHullC.x * hPulse;
hAlb *= 1.0 - 0.5 * hSeam;

// --- damage: soot patches → stripped plating with exposed dark structure → glowing breaches
float hDmg = uHullA.z;
float hBreach = 0.0;
if (hDmg > 0.001) {
  float hDn = hN1.a * 0.62 + hN1.r * 0.38 + (hRnd.x - 0.5) * 0.30 * hLod + (hN3.r - 0.5) * 0.12;
  float hLvl = mix(0.78, 0.41, hDmg);
  float hScorch = smoothstep(hLvl - 0.19, hLvl + 0.01, hDn);
  float hHole = smoothstep(hLvl + 0.12, hLvl + 0.14, hDn);
  hAlb = mix(hAlb, hAlb * 0.10 + vec3(0.012, 0.010, 0.009), hScorch * 0.93);
  vec2 hRib = abs(fract(hUv / (hPlate * 0.21)) - 0.5);
  float hRibs = smoothstep(0.34, 0.44, max(hRib.x, hRib.y)) * (1.0 - smoothstep(0.2, 0.6, hFw / (hPlate * 0.21)));
  hAlb = mix(hAlb, vec3(0.020, 0.021, 0.024) + 0.05 * hRibs, hHole);
  hRoughAdd = mix(hRoughAdd, 0.42, hScorch);
  hMetalAdd = mix(hMetalAdd, -0.35, hScorch);
  hGrad *= 1.0 - 0.7 * hHole;
  hGlow *= 1.0 - hScorch;
  float hEdge = (1.0 - hHole) * smoothstep(hLvl + 0.07, hLvl + 0.125, hDn);
  float hFlick = 0.6 + 0.4 * sin(uHullTime * 9.0 + hDn * 50.0 + hSeed * 3.0);
  hBreach = (hEdge * 0.85 + hHole * (1.0 - hRibs) * 0.9 * smoothstep(0.80, 0.97, hN3.r + hN1.r * 0.25)) * smoothstep(0.4, 0.9, hDmg) * hFlick;
}

hAlb *= uHullA.y;
hGlow *= uHullA.y;
diffuseColor.rgb = hAlb;
`;

const FRAG_ROUGH = /* glsl */`
roughnessFactor = clamp(roughnessFactor + hRoughAdd, 0.12, 1.0);
metalnessFactor = clamp(metalnessFactor + hMetalAdd, 0.0, 1.0);
`;

const FRAG_NORMAL = /* glsl */`
{
  vec3 hT3 = normalMatrix * (hAU * hGrad.x + hAV * hGrad.y);
  normal = normalize(normal + hT3 / max(length(normalMatrix[0]), 1e-5));
}
`;

const FRAG_EMISSIVE = /* glsl */`
totalEmissiveRadiance += hGlow;
totalEmissiveRadiance += vec3(4.2, 1.15, 0.22) * hBreach;
{
  // heat: fresh wreckage glows from the edges inwards and cools through orange to dull red
  float hHeat = uHullA.w;
  if (hHeat > 0.001) {
    float hFres = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    float hE = hHeat * hHeat * (0.06 + 0.7 * hFres * hFres + 0.35 * hN1.r * hN1.r + 1.1 * hBev + 0.30 * hHeat * hHeat);
    vec3 hCol = mix(vec3(0.95, 0.075, 0.012), vec3(2.4, 0.85, 0.20), hHeat * hHeat);
    totalEmissiveRadiance += hCol * hE * 0.75;
  }
}
`;

const FRAG_FINAL = /* glsl */`
{
  float hNV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float hRim = pow(1.0 - hNV, 4.0);
  vec3 hRimCol = mix(vec3(0.50, 0.72, 1.0), hBase * 2.4 + 0.08, 0.55);
  outgoingLight += hRimCol * hRim * uHullD.z * uHullA.y;
  float hFl = uHullA.x;
  outgoingLight = outgoingLight * (1.0 + 0.7 * hFl) + vec3(1.0, 0.94, 0.84) * hFl * (0.30 + 1.1 * hRim);
  if (hWarp > 0.001) {
    float hScan = 0.5 + 0.5 * sin(vHullP.x * 1.7 - uHullTime * 26.0);
    outgoingLight = mix(outgoingLight, uHullWarpCol * (0.12 + 0.38 * hScan), hWarp * 0.8);
    outgoingLight += uHullWarpCol * (hWarpEdge * hWarpEdge * 1.9 + hRim * 0.5 * hWarp);
  }
}
`;

const EMI_VERT = /* glsl */`
uniform vec4 uEmiB; // min x, max x, phase, _
varying vec3 vEmiC;
varying vec3 vEmiP;
varying vec3 vEmiV;
void main() {
  #ifdef USE_COLOR
    vEmiC = color;
  #else
    vEmiC = vec3(1.0);
  #endif
  vEmiP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vEmiV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
const EMI_FRAG = /* glsl */`
uniform vec4 uEmiA; // intensity, pulse amount, flash, dim
uniform vec4 uEmiB; // min x, max x, phase, pulse speed
uniform vec4 uEmiC; // warp, opacity, heat, _
uniform float uHullTime;
uniform vec3 uHullWarpCol;
varying vec3 vEmiC;
varying vec3 vEmiP;
varying vec3 vEmiV;
float emiHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
void main() {
  float t = clamp((vEmiP.x - uEmiB.x) / max(uEmiB.y - uEmiB.x, 1.0), 0.0, 1.0);
  float warp = uEmiC.x;
  float edge = 0.0;
  if (warp > 0.001) {
    float wd = (1.0 - t) - ((1.0 - warp) * 1.3 - 0.15);
    if (wd > 0.0) discard;
    edge = smoothstep(-0.07, 0.0, wd);
  }
  // each light pulses on its own phase; a rare quick flicker keeps them alive
  float cell = emiHash(floor(vEmiP * 0.2) + uEmiB.z);
  float pulse = 1.0 + uEmiA.y * sin(uHullTime * uEmiB.w + cell * 6.283 + uEmiB.z);
  pulse *= 1.0 - uEmiA.y * 1.5 * step(0.985, fract(sin(floor(uHullTime * 14.0) * 12.9898 + cell * 78.233 + uEmiB.z) * 43758.5453));
  // glass/lenses: hotter facing the eye, a tinted falloff towards the rim
  // (the emissive geometry carries no normals: take the face normal from derivatives)
  vec3 fn = cross(dFdx(vEmiV), dFdy(vEmiV));
  float nv = abs(dot(fn / max(length(fn), 1e-9), normalize(vEmiV)));
  vec3 c = vEmiC * uEmiA.x * pulse * uEmiA.w * (0.62 + 0.38 * nv * nv);
  c += vec3(1.0, 0.94, 0.84) * uEmiA.z * 0.6;
  c += vec3(1.6, 0.55, 0.12) * uEmiC.z * uEmiC.z;
  c = mix(c, uHullWarpCol * 0.9, warp * 0.7) + uHullWarpCol * edge * edge * 1.9;
  gl_FragColor = vec4(c, uEmiC.y);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ---------------------------------- class ---------------------------------- */

export class HullMaterials {
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.quality = opts.quality != null && opts.quality < 0.75 ? 0.5 : 1;
    this.time = { value: 0 };
    this.warpColor = { value: new THREE.Color().setRGB(0.35, 0.9, 1.6) };
    const N = 128;
    const tex = new THREE.DataTexture(makeNoise(N), N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.noiseTex = tex;
    this.noise = { value: tex };
    this.key = `hull3d-q${this.quality}`;
    this.made = new Set();
    // built once; every material's onBeforeCompile applies the same edits
    const hq = this.quality >= 1;
    this._patch = (shader) => {
      if (hq) shader.defines = { ...(shader.defines || {}), HULL_HQ: '' };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_ALBEDO}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_ROUGH}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`)
        .replace('#include <opaque_fragment>', `${FRAG_FINAL}\n#include <opaque_fragment>`);
    };
  }

  // seed → a small well-spread number the shader can hash without losing precision
  _seed(seed) {
    const s = Math.abs(Math.sin((Number(seed) || 0) * 12.9898 + 4.1414) * 43758.5453);
    return (s - Math.floor(s)) * 61 + 1.5;
  }

  _controls(mat, set) {
    const ud = mat.userData;
    ud.setFlash = (v) => set('flash', Math.max(0, Math.min(1, +v || 0)));
    ud.setDim = (k) => set('dim', Math.max(0, k == null ? 1 : +k));
    ud.setDamage = (d) => set('damage', Math.max(0, Math.min(1, +d || 0)));
    ud.setHeat = (h) => set('heat', Math.max(0, Math.min(1, +h || 0)));
    ud.setWarp = (w) => set('warp', Math.max(0, Math.min(1, +w || 0)));
    ud.setOpacity = (a) => {
      a = Math.max(0, Math.min(1, a == null ? 1 : +a));
      const tr = a < 0.999;
      mat.opacity = a;
      set('opacity', a);
      if (mat.transparent !== tr) { // OPAQUE is a compile-time define → hop to the other shared program
        mat.transparent = tr;
        mat.needsUpdate = true;
      }
    };
    ud.setBounds = (minX, maxX) => { set('minX', minX); set('maxX', maxX); ud.hullBounds = true; };
  }

  // Lit hull material. opts: kind, scale (world units per model unit), seed,
  // + optional overrides: accent (hex | [r,g,b] linear, HDR ok), plate, line,
  // glow, glowDensity, wear, grime, rim, accentPanels, metalness, roughness,
  // bounds: [minX, maxX] in model units (otherwise read from the geometry).
  create(opts = {}) {
    const THREE = this.THREE;
    const K = { ...(KINDS[opts.kind] || KINDS.fighter), ...opts };
    const scale = Math.max(0.05, +opts.scale || 1);
    const plate = Math.max(5, Math.min(34, K.plate / scale));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide, metalness: K.metalness, roughness: K.roughness,
    });
    mat.name = 'Hull';
    mat.forceSinglePass = true; // fading hulls stay one draw (and one program) instead of back+front passes
    const acc = new THREE.Vector3(-1, 0, 0);
    if (opts.accent != null) {
      if (Array.isArray(opts.accent)) acc.set(opts.accent[0], opts.accent[1], opts.accent[2]);
      else { const c = new THREE.Color(opts.accent); acc.set(c.r, c.g, c.b); }
    }
    const u = {
      uHullNoise: this.noise,
      uHullTime: this.time,
      uHullWarpCol: this.warpColor,
      uHullA: { value: new THREE.Vector4(0, 1, 0, 0) },
      uHullB: { value: new THREE.Vector4(0, this._seed(opts.seed), plate, K.line * Math.sqrt(plate / 16)) },
      uHullC: { value: new THREE.Vector4(K.glow, K.glowDensity, K.wear, K.grime) },
      uHullD: { value: new THREE.Vector4(-50, 52, K.rim, K.accentPanels) },
      uHullAccent: { value: acc },
    };
    const ud = mat.userData;
    ud.hull = u;
    ud.hullKind = opts.kind || 'fighter';
    const A = u.uHullA.value, B = u.uHullB.value, D = u.uHullD.value;
    this._controls(mat, (k, v) => {
      if (k === 'flash') A.x = v; else if (k === 'dim') A.y = v; else if (k === 'damage') A.z = v;
      else if (k === 'heat') A.w = v; else if (k === 'warp') B.x = v;
      else if (k === 'minX') D.x = v; else if (k === 'maxX') D.y = v;
    });
    if (opts.bounds) ud.setBounds(opts.bounds[0], opts.bounds[1]);
    const patch = this._patch;
    mat.onBeforeCompile = (shader) => { Object.assign(shader.uniforms, u); patch(shader); };
    const key = this.key;
    mat.customProgramCacheKey = () => key;
    // nose/tail extent for the soot and warp gradients: read once from the geometry
    mat.onBeforeRender = (r, s, c, geometry) => {
      if (ud.hullBounds) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      if (bb && Number.isFinite(bb.min.x)) ud.setBounds(bb.min.x, bb.max.x);
      ud.hullBounds = true;
    };
    this._track(mat);
    return mat;
  }

  // Unlit HDR material for the emissive faces (canopies, running lights,
  // nozzles, accent strips). opts: kind, seed, intensity, pulse (0..1 depth),
  // pulseSpeed (rad/s), bounds. Extra control: userData.setIntensity(v).
  // The same setFlash/setDim/setHeat/setWarp/setOpacity as the hull (setDamage
  // dims the lights as the ship is shot up).
  emissive(opts = {}) {
    const THREE = this.THREE;
    const K = { ...(KINDS[opts.kind] || KINDS.fighter), ...opts };
    const intensity = opts.intensity != null ? +opts.intensity : K.emissive;
    const u = {
      uHullTime: this.time,
      uHullWarpCol: this.warpColor,
      uEmiA: { value: new THREE.Vector4(intensity, K.pulse, 0, 1) },
      uEmiB: { value: new THREE.Vector4(-50, 52, this._seed(opts.seed), opts.pulseSpeed != null ? +opts.pulseSpeed : 3.2) },
      uEmiC: { value: new THREE.Vector4(0, 1, 0, 0) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: EMI_VERT, fragmentShader: EMI_FRAG,
      vertexColors: true, side: THREE.DoubleSide,
    });
    mat.name = 'HullEmissive';
    mat.forceSinglePass = true;
    const ud = mat.userData;
    ud.hull = u;
    const A = u.uEmiA.value, B = u.uEmiB.value, Cc = u.uEmiC.value;
    let dim = 1, dmg = 0;
    this._controls(mat, (k, v) => {
      if (k === 'flash') A.z = v;
      else if (k === 'dim') { dim = v; A.w = dim * (1 - 0.7 * dmg); }
      else if (k === 'damage') { dmg = v; A.w = dim * (1 - 0.7 * dmg); }
      else if (k === 'heat') Cc.z = v; else if (k === 'warp') Cc.x = v; else if (k === 'opacity') Cc.y = v;
      else if (k === 'minX') B.x = v; else if (k === 'maxX') B.y = v;
    });
    ud.setIntensity = (v) => { A.x = Math.max(0, +v || 0); };
    if (opts.bounds) ud.setBounds(opts.bounds[0], opts.bounds[1]);
    this._track(mat);
    return mat;
  }

  _track(mat) {
    this.made.add(mat);
    mat.addEventListener('dispose', () => this.made.delete(mat));
  }

  // advance the shared clock (seam pulse, breach flicker, warp scanlines, light pulses)
  update(timeMs) {
    this.time.value = ((timeMs || 0) / 1000) % 3600;
  }

  dispose() {
    for (const m of [...this.made]) m.dispose();
    this.made.clear();
    this.noiseTex.dispose();
  }
}
