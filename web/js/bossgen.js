// bossgen.js — modular bosses. Unlike regular ships (baked once), a boss is
// rendered LIVE from parts: a generated dreadnought hull plus separate turret
// meshes that rotate to track players and blow off as health drops. Each
// level gets its own seed → its own silhouette and palette.
import {
  newMesh, addLathe, addPlateZ, addBox, makeRng, VIEW,
} from './mesh3d.js';
import { hsl } from './shipgen.js';

// Bosses face left like enemies; turret yaw is an absolute ry for renderMesh.
export const BOSS_VIEW = { ...VIEW, ry: Math.PI };

// Converts a desired screen-space aim angle (atan2(dy,dx)) into the turret's
// model yaw under the tilted view (screen dir of the barrel ≈ (cos ry,
// -sin(view.rx)·sin ry)).
export function aimYaw(phi) {
  return Math.atan2(-Math.sin(phi) / Math.sin(BOSS_VIEW.rx), Math.cos(phi));
}

function makeTurret(base, barrel, R) {
  const t = newMesh();
  addLathe(t, [
    { x: 6, r: 2.2 }, { x: 2.5, r: 5.8 }, { x: -4, r: 6.2 }, { x: -7.5, r: 4 },
  ], 6, base, { sy: 0.72 });
  for (const s of [1, -1]) {
    addBox(t, 10, 1.6, s * 2, 15 + R() * 4, 1.9, 1.9, barrel);
    addBox(t, 18.5, 1.6, s * 2, 2, 2.3, 2.3, [255, 130, 80], 1); // hot muzzles
  }
  return t;
}

// Static single-mesh boss (turrets welded on at rest pose) — for baked
// sprites: the coop guest fallback and the ?shipgen gallery.
export function bossStaticMesh(level) {
  const gen = genBoss(level);
  const m = gen.core;
  for (const tr of gen.turrets) {
    const off = m.verts.length;
    // rest yaw equals the hull's ry — turret verts translate straight in
    for (const [x, y, z] of tr.mesh.verts) {
      m.verts.push([x + tr.pivot[0], y + tr.pivot[1], z + tr.pivot[2]]);
    }
    for (const f of tr.mesh.faces) m.faces.push({ ...f, v: f.v.map((i) => i + off) });
  }
  return m;
}

// Phase-2 core of a mega boss: pulsing sphere, glowing equator ring, spikes.
export function genBossCore(level) {
  const R = makeRng((level * 5077 + 7) >>> 0);
  const hue = (348 + (level - 1) * 63) % 360;
  const c1 = hsl(hue, 26, 46);
  const dark = hsl(hue, 30, 30);
  const acc = hsl((hue + 40) % 360, 92, 62);
  const m = newMesh();
  addLathe(m, [
    { x: 18, r: 3 }, { x: 12, r: 12.5 }, { x: 0, r: 16 }, { x: -12, r: 12.5 }, { x: -18, r: 3 },
  ], 8, c1, { capFront: true, capBack: true, capColor: dark });
  addLathe(m, [{ x: 3.2, r: 17.6 }, { x: -3.2, r: 17.6 }], 8, acc, { e: 0.85, layer: 1 });
  // four armor spikes
  addBox(m, 24, 0, 0, 14, 3.4, 3.4, dark, 0, 1);
  addBox(m, -24, 0, 0, 14, 3.4, 3.4, dark, 0, 1);
  addBox(m, 0, 0, 24, 3.4, 3.4, 14, dark, 0, 1);
  addBox(m, 0, 0, -24, 3.4, 3.4, 14, dark, 0, 1);
  return m;
}

export function genBoss(level) {
  const R = makeRng((level * 2654435761 + 0xB055) >>> 0);
  const rng = (a, b) => a + R() * (b - a);

  /* palette — hue walks 63° per level, so every boss reads differently */
  const hue = (348 + (level - 1) * 63) % 360;
  const sat = rng(14, 24), lit = rng(48, 58);
  const hullC = hsl(hue, sat, lit);
  const hullD = hsl(hue, sat + 8, lit * 0.74);
  const dark = hsl(hue, sat + 6, lit * 0.45);
  const acc = hsl((hue + rng(30, 70)) % 360, 92, 62);
  const glass = [140, 225, 255];
  const nozzle = [255, 175, 80];

  const core = newMesh();
  const hr = rng(17, 21);
  const flat = rng(0.55, 0.68);
  addLathe(core, [
    { x: 66, r: rng(3, 6) },
    { x: rng(38, 50), r: hr * 0.7 },
    { x: rng(10, 20), r: hr },
    { x: rng(-20, -8), r: hr * rng(0.9, 1) },
    { x: -45, r: hr * 0.75 },
    { x: -62, r: hr * 0.45 },
  ], 8, hullC, { sy: flat, capBack: true, capColor: dark });
  const topY = hr * flat;

  /* twin engine pods + pylons */
  const podZ = hr + rng(7, 11);
  const podR = rng(8, 10);
  core.nozzles = [];
  for (const s of [1, -1]) {
    addLathe(core, [
      { x: rng(28, 36), r: 4, cz: s * podZ },
      { x: 15, r: podR, cz: s * podZ },
      { x: -35, r: podR * 0.95, cz: s * podZ },
      { x: -52, r: 6, cz: s * podZ },
    ], 8, hullD, { sy: 0.85, capBack: true, capColor: nozzle, capE: 1 });
    core.nozzles.push({ x: -52, y: 0, z: s * podZ, r: 6 });
    addBox(core, rng(-8, 2), 0, s * (podZ / 2 + hr * 0.3), rng(18, 26), 3.5, podZ - hr * 0.5, dark);
    addBox(core, rng(18, 30), 0, s * (podZ + 1), 6, 4, 2.2, acc, 0.9, 2); // pod nav lights
  }
  core.nozzles.push({ x: -62, y: 0, z: 0, r: hr * 0.42 }); // center engine

  /* command tower, armor slabs, spine stripe, fin */
  addBox(core, rng(8, 18), topY + 4, 0, rng(14, 20), 8, rng(9, 13), hullC);
  addBox(core, rng(10, 16), topY + 9, 0, 8, 3, 8, glass, 0.65, 2);
  for (let i = 0; i < 3; i++) {
    addBox(core, 30 - i * rng(22, 26), topY * rng(0.7, 0.9), 0, rng(12, 18), rng(3, 5), rng(14, 20), hullD, 0, 1);
  }
  addBox(core, rng(-30, -10), topY + 0.5, 0, rng(30, 50), 1, 2.2, acc, 0.85, 2);
  addPlateZ(core, [
    [-30, topY * 0.8], [-40, topY * 0.8 + rng(10, 15)], [-52, topY * 0.8 + rng(8, 12)], [-50, topY * 0.8],
  ], 0, 2, hullD);

  /* turrets — more of them at higher levels, mounted on spine and pods */
  const spots = [
    [38, topY * 0.6, 0],
    [0, topY * 0.95, 0],
    [16, podR * 0.7, podZ],
    [16, podR * 0.7, -podZ],
  ];
  const nT = Math.min(spots.length, 1 + Math.ceil(level / 2));
  const turrets = [];
  for (let i = 0; i < nT; i++) {
    turrets.push({
      mesh: makeTurret(hullD, dark, R),
      pivot: spots[i],
      yaw: Math.PI,
      speed: 0.035 + i * 0.012, // each turret tracks at its own pace
      dead: false,
    });
  }

  return { core, turrets, level };
}
