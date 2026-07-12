// shipgen.js — seeded, parts-based procedural ship generator.
// A ship = fuselage lathe + canopy + wings + fins + engines + greebles,
// each picked/proportioned from family-tuned ranges. Same seed → same ship
// on every client (host and guest bake identical sprites from a type+seed).
//
// Families keep the game's established color language:
// player = blue/cyan, basic = gray/green, weaver = teal, hunter = red,
// tank = purple. Nozzles stay amber to match the in-game engine glow.
import { newMesh, addLathe, addPlateY, addPlateZ, addBox, makeRng } from './mesh3d.js';

export function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Tuned per-family ranges: silhouettes stay recognizable, seeds add variety.
export const FAMILIES = {
  player: {
    hue: [200, 225], accHue: [185, 200], sat: [10, 22], lit: [60, 72],
    hullR: [10, 13], flat: [0.5, 0.62], span: [30, 42], sweep: [10, 22],
    engines: [2, 2], finTwin: 0.55, wings2: 0, twinHull: 0, greeble: 0,
  },
  basic: {
    hue: [90, 150], accHue: [95, 140], sat: [8, 16], lit: [52, 64],
    hullR: [9, 13], flat: [0.55, 0.7], span: [22, 32], sweep: [8, 18],
    engines: [1, 2], finTwin: 0.3, wings2: 0, twinHull: 0, greeble: 0.35,
  },
  weaver: {
    hue: [160, 185], accHue: [160, 175], sat: [14, 26], lit: [55, 68],
    hullR: [8, 11], flat: [0.55, 0.68], span: [36, 50], sweep: [14, 26],
    engines: [2, 2], finTwin: 0.25, wings2: 0.65, twinHull: 0, greeble: 0,
  },
  hunter: {
    hue: [345, 15], accHue: [350, 8], sat: [30, 44], lit: [50, 62],
    hullR: [6.5, 9], flat: [0.6, 0.75], span: [20, 28], sweep: [-18, -8],
    engines: [1, 1], finTwin: 0.5, wings2: 0, twinHull: 0, greeble: 0,
  },
  tank: {
    hue: [265, 290], accHue: [270, 290], sat: [12, 22], lit: [50, 62],
    hullR: [14, 18], flat: [0.55, 0.68], span: [16, 24], sweep: [4, 12],
    engines: [2, 4], finTwin: 0.5, wings2: 0, twinHull: 0.45, greeble: 1,
  },
  sniper: { // long thin indigo dart — parks at the edge and snipes
    hue: [215, 240], accHue: [185, 205], sat: [18, 30], lit: [40, 52],
    hullR: [5.5, 7.5], flat: [0.6, 0.75], span: [14, 20], sweep: [16, 26],
    engines: [1, 1], finTwin: 0.2, wings2: 0, twinHull: 0, greeble: 0,
  },
  carrier: { // wide amber barge that launches drones
    hue: [25, 45], accHue: [35, 55], sat: [14, 24], lit: [46, 58],
    hullR: [13, 16], flat: [0.5, 0.6], span: [26, 34], sweep: [2, 8],
    engines: [2, 3], finTwin: 0.6, wings2: 0, twinHull: 0.7, greeble: 1,
  },
  shieldbearer: { // rounded cyan hull wrapped in its own hex bubble
    hue: [180, 200], accHue: [175, 195], sat: [20, 32], lit: [52, 64],
    hullR: [10, 13], flat: [0.68, 0.8], span: [16, 22], sweep: [4, 10],
    engines: [2, 2], finTwin: 0.3, wings2: 0, twinHull: 0, greeble: 0.5,
  },
  strafer: { // wide crimson gunship — parks in a lane and rakes aimed fire
    hue: [340, 356], accHue: [20, 40], sat: [26, 40], lit: [42, 54],
    hullR: [11, 14], flat: [0.5, 0.6], span: [32, 44], sweep: [-10, 2],
    engines: [2, 3], finTwin: 0.6, wings2: 0.5, twinHull: 0.5, greeble: 0.85,
  },
  brood: { // bulbous olive pod that bursts into fast fragments when killed
    hue: [64, 86], accHue: [50, 70], sat: [22, 36], lit: [44, 56],
    hullR: [13, 16], flat: [0.72, 0.85], span: [16, 24], sweep: [2, 10],
    engines: [1, 2], finTwin: 0.3, wings2: 0, twinHull: 0.5, greeble: 0.6,
  },
  boss: { // hulking dreadnought base — per-level tinting happens in-game
    hue: [340, 20], accHue: [350, 10], sat: [12, 20], lit: [46, 56],
    hullR: [16, 20], flat: [0.6, 0.72], span: [20, 30], sweep: [6, 16],
    engines: [3, 4], finTwin: 0.7, wings2: 0.4, twinHull: 0.55, greeble: 1,
  },
};

const FAM_SALT = { player: 0x50, basic: 0xB0, weaver: 0x77, hunter: 0x44, tank: 0x7A, boss: 0xB055, sniper: 0x51, carrier: 0xCA, shieldbearer: 0x5B, strafer: 0x5F, brood: 0x8D };

// `over` merges over the family ranges (e.g. a different palette for player 2)
export function genShip(seed, family = 'basic', over = null) {
  const P = { ...(FAMILIES[family] || FAMILIES.basic), ...over };
  const R = makeRng((seed * 2654435761 + FAM_SALT[family]) >>> 0);
  const rng = (a, b) => a + R() * (b - a);
  const rInt = (a, b) => Math.floor(rng(a, b + 1));
  const m = newMesh();

  /* palette */
  const hue = rng(P.hue[0], P.hue[1] + (P.hue[1] < P.hue[0] ? 360 : 0)) % 360;
  const accHue = rng(P.accHue[0], P.accHue[1] + (P.accHue[1] < P.accHue[0] ? 360 : 0)) % 360;
  const sat = rng(P.sat[0], P.sat[1]);
  const lit = rng(P.lit[0], P.lit[1]);
  const hullC = hsl(hue, sat, lit);
  const hullD = hsl(hue, sat + 8, lit * 0.74);      // wings/fins/panels
  const acc = hsl(accHue, 92, 62);                  // neon accents
  const glass = [140, 225, 255];
  const nozzle = [255, 175, 80];
  const gunC = hsl(hue, 8, 32);

  /* fuselage */
  const hullR = rng(P.hullR[0], P.hullR[1]);
  const flat = rng(P.flat[0], P.flat[1]);           // vertical squash → wide flat hulls
  const sides = R() < 0.4 ? 6 : 8;
  const noseX = 52, tailX = -50;
  const noseDrop = rng(-2.5, 0);                    // drooped nose reads aggressive
  const twin = R() < P.twinHull;
  const hullOff = twin ? hullR * rng(1.05, 1.35) : 0;
  const hullSections = [
    { x: noseX, r: 0.8, cy: noseDrop, sy: flat },
    { x: rng(22, 34), r: hullR * rng(0.5, 0.7), cy: noseDrop * 0.6, sy: flat },
    { x: rng(-4, 8), r: hullR, sy: flat },
    { x: rng(-30, -20), r: hullR * rng(0.72, 0.88), sy: flat },
    { x: tailX, r: hullR * rng(0.38, 0.55), sy: flat },
  ];
  for (const cz of twin ? [-hullOff, hullOff] : [0]) {
    addLathe(m, hullSections.map((s) => ({ ...s, cz })), sides, hullC,
      { capBack: true, capColor: hsl(hue, sat, lit * 0.4) });
  }
  if (twin) { // bridge deck connecting the two hulls
    addBox(m, rng(-14, 0), hullR * flat * 0.35, 0, rng(26, 40), hullR * flat * 0.9, hullOff * 2, hullC);
  }

  /* canopy */
  const topY = hullR * flat;
  if (!twin || R() < 0.5) {
    const cx = rng(12, 24);
    addLathe(m, [
      { x: cx + rng(7, 10), r: 0.6, cy: topY * 0.55 },
      { x: cx + 3, r: hullR * 0.34, cy: topY * 0.72 },
      { x: cx - rng(5, 8), r: hullR * 0.38, cy: topY * 0.75 },
      { x: cx - rng(9, 12), r: 0.8, cy: topY * 0.6 },
    ], 6, glass, { sy: 0.85, e: 0.65, layer: 2 });
  } else {
    // twin-hull command bridge
    addBox(m, rng(0, 12), topY + 2.5, 0, rng(10, 16), 5, rng(8, 12), hullC);
    addBox(m, rng(2, 10), topY + 5.5, 0, 6, 2.2, 7, glass, 0.65, 2);
  }

  /* wings — cranked outline; shape numbers rolled ONCE, mirrored exactly */
  const wingBaseZ = (twin ? hullOff : 0) + hullR * 0.72;
  const buildWing = (s, sh) => {
    const kinkZ = wingBaseZ + sh.span * sh.kinkFrac;
    const tipZ = wingBaseZ + sh.span;
    const kinkLead = sh.lead - sh.sweep * sh.kinkLeadFrac;
    const tipLead = sh.lead - sh.sweep;
    const pts = [
      [sh.lead, s * wingBaseZ, 0],
      [kinkLead, s * kinkZ, sh.dih * 0.5],
      [tipLead, s * tipZ, sh.dih],
      [tipLead - sh.tipChord, s * tipZ, sh.dih],
      [kinkLead - sh.chord * sh.kinkTrailFrac, s * kinkZ, sh.dih * 0.5],
      [sh.lead - sh.chord, s * wingBaseZ, 0],
    ];
    addPlateY(m, pts, sh.y0, 2.3, hullD);
    // wingtip nav light
    addBox(m, tipLead - sh.tipChord / 2, sh.y0 + sh.dih, s * (tipZ - 0.9), sh.tipChord * 0.8, 3.4, 1.6, acc, 0.9, 2);
    return { tipLead, tipChord: sh.tipChord, tipZ, dih: sh.dih, y0: sh.y0 };
  };
  const chord = rng(20, 32);
  const wing = {
    span: rng(P.span[0], P.span[1]),
    sweep: rng(P.sweep[0], P.sweep[1]),
    chord,
    tipChord: chord * rng(0.32, 0.5),
    lead: rng(6, 16),
    dih: rng(-3, 5),
    y0: rng(-2, 1),
    kinkFrac: rng(0.4, 0.55),
    kinkLeadFrac: rng(0.3, 0.5),
    kinkTrailFrac: rng(0.75, 0.95),
  };
  let tip = null;
  for (const s of [1, -1]) tip = buildWing(s, wing);
  if (R() < P.wings2) { // canard pair ahead of the main wings
    const canard = {
      ...wing,
      span: wing.span * rng(0.4, 0.55),
      sweep: wing.sweep * 0.6,
      chord: wing.chord * 0.5,
      tipChord: wing.chord * 0.2,
      lead: wing.lead + rng(18, 26),
      dih: wing.dih * 0.5,
      y0: wing.y0 + rng(-1, 1),
    };
    for (const s of [1, -1]) buildWing(s, canard);
  }

  /* fins */
  const finTwin = R() < P.finTwin;
  const finF = rng(-16, -6), finH = rng(9, 16);
  const finPts = [
    [finF, topY * 0.7],
    [finF - rng(5, 10), topY * 0.7 + finH],
    [finF - rng(13, 20), topY * 0.7 + finH * rng(0.72, 0.95)],
    [finF - rng(11, 17), topY * 0.7],
  ];
  if (R() < 0.9) {
    for (const z of finTwin ? [-hullR * 0.55 - (twin ? hullOff : 0), hullR * 0.55 + (twin ? hullOff : 0)] : [0]) {
      addPlateZ(m, finPts, z, 1.8, hullD);
      // fin-tip accent
      const t = finPts[1], t2 = finPts[2];
      addBox(m, (t[0] + t2[0]) / 2, (t[1] + t2[1]) / 2, z, Math.abs(t2[0] - t[0]) + 2, 2, 2.4, acc, 0.85, 2);
    }
  }

  /* engines — nacelles with glowing nozzle caps (pairs with in-game glow) */
  const nEng = rInt(P.engines[0], P.engines[1]);
  const er = rng(3.4, 5) * (family === 'tank' ? 1.25 : 1);
  const eSpread = twin ? hullOff : Math.max(hullR * 0.55, er * 1.15);
  const slots = nEng === 1 ? [[0, 0]]
    : nEng === 2 ? [[-eSpread, 0], [eSpread, 0]]
    : nEng === 3 ? [[-eSpread, 0], [eSpread, 0], [0, topY * 0.5 + er * 0.6]]
    : [[-eSpread, -er * 0.55], [eSpread, -er * 0.55], [-eSpread * 0.75, er * 1.05], [eSpread * 0.75, er * 1.05]];
  m.nozzles = []; // model-space exhaust points; bakers project these into
                  // sprite pixels so in-game flames attach to real engines
  for (const [cz, cy] of slots) {
    const back = tailX - rng(2, 5);
    addLathe(m, [
      { x: tailX + rng(10, 16), r: er * 0.72, cz, cy },
      { x: tailX + 4, r: er, cz, cy },
      { x: back, r: er * 0.82, cz, cy },
    ], 8, hullD, { capBack: true, capColor: nozzle, capE: 1 });
    m.nozzles.push({ x: back, y: cy, z: cz, r: er });
  }

  /* spine accent stripe */
  if (R() < 0.85) {
    addBox(m, rng(2, 14), topY + 0.4, twin ? 0 : rng(-1, 1), rng(28, 52), 0.9, 1.6, acc, 0.8, 2);
  }

  /* guns */
  if (R() < 0.75 || family === 'hunter') { // chin cannon
    const gl = rng(10, 18);
    addBox(m, rng(30, 38) + gl / 2, -topY * 0.75 + noseDrop, 0, gl, 1.7, 1.7, gunC, 0, 1);
  }
  if (R() < 0.45) { // wingtip guns — one length, mirrored
    const gl = rng(9, 14);
    for (const s of [1, -1]) {
      addBox(m, tip.tipLead + gl * 0.4, tip.y0 + tip.dih, s * (tip.tipZ - 1), gl, 1.5, 1.5, gunC, 0, 1);
    }
  }

  /* greebles — armor blocks on heavy hulls, mirrored pairs */
  if (R() < P.greeble) {
    const nG = rInt(1, 2);
    for (let i = 0; i < nG; i++) {
      const gx = rng(-26, 8), gy = topY * rng(0.55, 0.8);
      const gz = (twin ? hullOff : 0) + rng(2, hullR * 0.5);
      const gsx = rng(7, 15), gsy = rng(2.5, 5), gsz = rng(5, 10);
      for (const s of [1, -1]) addBox(m, gx, gy, s * gz, gsx, gsy, gsz, hullD, 0, 1);
    }
    if (R() < 0.5) addBox(m, rng(-20, 0), topY * 0.75, 0, rng(10, 18), rng(3, 5), rng(6, 10), hullD, 0, 1);
  }

  return m;
}


/* ------------------------------ cargo freighter ------------------------------ */
// Big slow hauler for background ambience: tug + container train + engines.
// Rendered dim (silhouette against the void), so shapes matter more than color.
export function genFreighter(seed, golden = false) {
  const R = makeRng((seed * 48271 + 331) >>> 0);
  const rng = (a, b) => a + R() * (b - a);
  const m = newMesh();
  const hue = golden ? 45 : rng(200, 250);
  const hull = golden ? hsl(45, 65, 55) : hsl(hue, 10, 34);
  const dark = golden ? hsl(40, 55, 38) : hsl(hue, 12, 24);
  // tug cab up front
  addLathe(m, [
    { x: 78, r: 2 }, { x: 66, r: 9 }, { x: 48, r: 10 }, { x: 40, r: 5 },
  ], 6, hull, { sy: 0.8 });
  addBox(m, 56, 9, 0, 10, 4, 6, hull);
  addBox(m, 55, 12, 0, 4, 2, 4, [150, 220, 255], 0.6, 2); // lit bridge windows
  // spine
  addBox(m, -8, 0, 0, 100, 3, 3, dark);
  // container train
  let cx = 34;
  const n = 3 + ((R() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const len = rng(16, 26);
    const col = golden ? hsl(45 + rng(-8, 8), 70, rng(48, 60)) : hsl((hue + rng(-30, 90) + 360) % 360, rng(18, 40), rng(26, 42));
    addBox(m, cx - len / 2, rng(-1, 1), 0, len - 3, rng(9, 12), rng(10, 14), col, golden ? 0.15 : 0, 1);
    cx -= len;
  }
  // engine block with twin glowing nozzles
  const ex = cx - 6;
  addBox(m, ex, 0, 0, 14, 10, 12, hull);
  m.nozzles = [];
  for (const s of [1, -1]) {
    addLathe(m, [
      { x: ex - 4, r: 3.4, cz: s * 4 }, { x: ex - 12, r: 4.2, cz: s * 4 },
    ], 6, dark, { capBack: true, capColor: [255, 175, 80], capE: 1 });
    m.nozzles.push({ x: ex - 12, y: 0, z: s * 4, r: 4.2 });
  }
  return m;
}
