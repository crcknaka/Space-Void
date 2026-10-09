// bake3d.js — classic (canvas-2D) sprites re-baked from the WebGL hero models.
//
// procassets.js bakes the classic sprite set from the old low-poly meshes. When
// WebGL is available this module renders the hand-built hulls of ships3d.js /
// enemies3d.js once, offscreen, from the very same sprite camera (mesh3d.js
// VIEW: tilt, weak perspective, auto-fit), and swaps the pictures into
// app.images. Gameplay never notices: every sprite keeps its canvas object
// (entities hold references to it), its logical framing and its metadata —
// only the pixels get better and denser.
//
//   bakeSprites(app)             boot hook: defers itself behind the menu, never throws
//   bakeImages(images, opts)     the bake itself (dev/bake.html calls it directly)
//
// What a sprite keeps after the swap (all consumers divide by img.width/height,
// so a denser canvas is transparent to them):
//   img (same object)   resized in place to K× its old size and redrawn
//   img.nozzles         same array object (tinted() copies share it), refilled
//                       with the new hull's engine points in the new pixel space
//   img.fitScale        × K, so MeshDebris built from img.mesh stays the same size
//   img.mesh            untouched — wreckage and the 3D view still read the old mesh
//   img.bankFrames      a new array of K× roll frames, same count and meaning
//   tinted() variants   the ones that already exist are redrawn in place (see retint)
//
// Not baked here: bosses (drawn live from bossgen meshes), rockets and asteroids
// (no hero model that can be built without its scene machinery).
//
// Failure is always silent and total: nothing is swapped until every sprite has
// been rendered, so any error, a lost context or a blown time budget leaves the
// old sprite set exactly as it was.

import { VIEW, fitTransform, projectPoint } from './mesh3d.js';
import { genBoss, BOSS_VIEW } from './bossgen.js';
import { tinted } from './fx.js';
import { isTouch } from './input.js';

const PERSP = 420;          // mesh3d.js default camera distance (old model units)
const MARGIN = 0.92;        // procassets.js bakeInto() fit margin
const BANK_N = 7, BANK_MAX = 0.42; // procassets.js bakeBankFrames()
const ROCK_PX = 192;        // procassets.js bakeRock() canvas
const MS = 192;             // measuring viewport (px): silhouette bounds are read back from it
const RTW0 = 640, RTH0 = 400; // render target / GL canvas of the main bake: the largest sprite (a 6× hangar hull) fits
const SLICE_MS = 5;         // work per slice before yielding to the game loop
const MAX_WORK_MS = 9000;   // give up (old sprites stay) when the bake itself burns more than this…
const MAX_WALL_MS = 45000;  // …or drags on this long while the tab is visible

const ROCK_NORMAL = [1, 0, 6, 3];   // rocks3d variants behind the four classic rocks: cratered, rubble, carbon, binary
const ROCK_VOLCANIC = [0, 2];       // …and the two volcanic ones
const ROCK_LOD = 1;                 // 5k triangles: plenty at sprite size
const ROCKET = {
  player: { body: 0xcdd2dc, accent: 0xeb4646, glow: 0xffb45a },
  enemy: { body: 0x7d3e44, accent: 0xff4b3c, glow: 0xff7a3c },
};
const SHIP_KEYS = ['vanguard', 'interceptor', 'juggernaut', 'ghost', 'ace'];
const ENEMY_KEYS = ['basic', 'weaver', 'hunter', 'tank', 'sniper', 'carrier', 'shieldbearer', 'strafer', 'brood'];

export const bakeState = { status: 'idle', stats: null, error: null };

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = () => new Promise((r) => (window.requestIdleCallback
  ? requestIdleCallback(() => r(), { timeout: 150 })
  : setTimeout(r, 16)));

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ------------------------------- boot hook -------------------------------- */

// ?log timeline line (the log array may not exist yet when ?bakefirst finishes during boot)
function say(msg, tries = 30) {
  if (window.__svlog) window.__svlog.push(msg);
  else if (tries > 0 && /[?&]log\b/.test(location.search)) setTimeout(() => say(msg, tries - 1), 100);
}

let started = null;

// Called once from main.js right after generateSprites(). Resolves when the
// bake is over (either way); only ?bakefirst waits for it before the first frame.
export function bakeSprites(app) {
  if (started) return started;
  const params = new URLSearchParams(location.search);
  const sync = params.has('bakefirst'); // debug: finish the bake before the game starts (headless screenshots)
  if (params.has('nobake')) { bakeState.status = 'off'; return (started = Promise.resolve(bakeState)); } // debug: keep the old sprites
  started = (async () => {
    try {
      if (!sync) {
        // let the first frames out, then stay out of the way of the 3D view's own warm-up
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await sleep(350);
        const v = app.view3d;
        for (let i = 0; i < 80 && v && v.enabled && (v.loading || v.warming); i++) await sleep(250);
      }
      bakeState.status = 'running';
      // a run in progress is never disturbed: the bake holds its breath until the action stops
      const busy = () => { const s = app.state; return !!s && Array.isArray(s.effects) && !s.paused && !s.over && !s.winner; };
      bakeState.stats = await bakeImages(app.images, { sync, busy, fail: params.get('bakefail') });
      bakeState.status = 'done';
      app.images.bakedBoss = bakedBoss; // Boss.draw can reach the boss sprites through its images dict
      const bossN = Number(params.get('boss')) || 1; // the first boss of a run is baked ahead, behind the menu (debug ?boss=N: that one)
      bossSync = sync;
      bakedBoss(bossN);
      if (sync && bossJob) await bossJob;
      const s = bakeState.stats;
      say(`BAKE ok: ${s.sprites} sprites, work ${s.work.toFixed(0)}ms in ${s.slices} slices (max ${s.maxSlice.toFixed(0)}ms), wall ${s.wall.toFixed(0)}ms, K=${s.K}/${s.KH}`);
    } catch (e) {
      bakeState.status = 'failed';
      bakeState.error = e;
      console.warn('sprite bake skipped — classic keeps the old sprites:', e);
      say(`BAKE off: ${e?.message || e}`);
    }
    return bakeState;
  })();
  return started;
}

/* -------------------------------- the bake -------------------------------- */

// Renders every sprite, then swaps them all into `images` in one synchronous
// pass. Throws (having changed nothing) on any failure. opts:
//   sync     no yielding between steps (debug / harness)
//   busy     () => true while the game must not be disturbed: the bake waits between steps
//   K, KH    pixel density of game sprites / of the roster hulls shown enlarged in the hangar
//   fail     debug: 'gl' | 'mid' | 'slow' simulate a failure at that stage
export async function bakeImages(images, opts = {}) {
  if (images.baked3d) throw new Error('already baked');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // game sprites: 2× covers a phone and a 1× desktop, 3× a HiDPI desktop (the canvas
  // tops out at ~2.6 device px per world px). The roster hulls are also the hangar /
  // menu preview, drawn up to 300 CSS px wide — those get their own, denser bake.
  const K = opts.K || (isTouch ? 2 : dpr >= 1.5 ? 3 : 2);
  const KH = opts.KH || (isTouch ? 4 : dpr >= 1.5 ? 6 : 3);
  const S = { t0: now(), work: 0, slices: 0, maxSlice: 0, wall: 0, held: 0, sprites: 0, K, KH, steps: [] };

  let sliceT = now(), lost = false, R = null;
  const endSlice = () => {
    const d = now() - sliceT;
    S.work += d; S.slices++;
    if (d > S.maxSlice) S.maxSlice = d;
  };
  const check = () => {
    if (lost) throw new Error('WebGL context lost');
    if (S.work > MAX_WORK_MS) throw new Error(`too slow (${S.work.toFixed(0)}ms of work)`);
    if (!document.hidden && now() - S.t0 - S.held > MAX_WALL_MS) throw new Error('timed out');
  };
  // yield to the game loop once the current slice has used its budget
  const breathe = async () => {
    check();
    if (opts.sync || (now() - sliceT < SLICE_MS && !opts.busy?.())) return;
    endSlice();
    await idle();
    while (opts.busy?.() && !lost) { // a run is on: wait it out (not counted against the time budget)
      const h = now();
      await sleep(300);
      S.held += now() - h;
    }
    sliceT = now();
    check();
  };
  // wait for something that is not our own work (module fetch, shader link)
  const outside = async (p) => {
    endSlice();
    try { return await p; } finally { sliceT = now(); }
  };
  const step = (name, t) => S.steps.push([name, +(now() - t).toFixed(1)]);

  try {
    if (opts.fail === 'gl') throw new Error('simulated: no WebGL');
    // no WebGL2, no bake — found out before three.js and the model modules are fetched
    const probe = cv(1, 1).getContext('webgl2');
    if (!probe) throw new Error('WebGL2 unavailable');
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    const A = '../vendor/three-addons/';
    const [THREE, re, ships3d, enemies3d] = await outside(Promise.all([
      import('three'),
      import(`${A}environments/RoomEnvironment.js`),
      import('./ships3d.js'),
      import('./enemies3d.js'),
    ]));
    let t = now();
    R = makeRig(THREE, re.RoomEnvironment, () => { lost = true; }, RTW0, Math.max(RTH0, ROCK_PX * K));
    step('renderer', t);
    await breathe();

    const q = isTouch ? 0.5 : 1;
    const ships = new ships3d.Ships3D(THREE, { quality: opts.quality || q });
    const fleet = new enemies3d.Enemies3D(THREE, { quality: opts.quality || q });
    R.kits.push(ships, fleet);

    const staged = [];
    const prepare = async (name, build) => {
      t = now();
      const obj = build();
      R.holder.add(obj);
      step(`build ${name}`, t);
      // link the shaders off the main thread where the driver can (KHR_parallel_shader_compile)
      R.gl.setRenderTarget(R.rt);
      if (!opts.sync && R.gl.compileAsync) await outside(R.gl.compileAsync(R.scene, R.cam));
      R.gl.setRenderTarget(null);
      await breathe();
      return obj;
    };
    const drop = (obj) => { R.holder.remove(obj); obj.userData.dispose?.(); };

    // --- player hulls: the sprite itself + the roll frames Player.draw picks from ---
    const players = [
      ...SHIP_KEYS.map((id) => ({ id, img: images.ships?.[id], k: KH })),
      { id: 'player1', img: images.player1_ship, k: K },
      { id: 'player2', img: images.player2_ship, k: K },
    ];
    for (const job of players) {
      const img = job.img;
      if (!img) continue;
      const obj = await prepare(job.id, () => ships.build(job.id, { thrust: 0 }));
      const ud = obj.userData, w = img.width, h = img.height;
      const d = camDist(img);
      const pose = (f) => {
        obj.rotation.order = 'XYZ';
        obj.rotation.set(BANK_MAX * f, 0, 0); // mesh3d: rx = VIEW.rx + bank — a roll about the fuselage
        ud.setBank?.(f);                      // ailerons follow, as in the 3D view
        ud.settle?.();
      };
      ud.setThrust?.(0); ud.setGear?.(0);
      // one fit for every frame (stable anchor, shared nozzle points): centred on the level
      // hull, sized so the fully rolled frames still clear the canvas edge
      t = now();
      pose(0);
      const b0 = R.measure(d);
      pose(-1);
      const bA = R.measure(d);
      pose(1);
      const bB = R.measure(d);
      step(`measure ${job.id}`, t);
      await breathe();
      const cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2;
      let hx = 0, hy = 0;
      for (const b of [b0, bA, bB]) {
        hx = Math.max(hx, cx - b.x0, b.x1 - cx);
        hy = Math.max(hy, cy - b.y0, b.y1 - cy);
      }
      const unit = MARGIN * Math.min(w / (2 * hx), h / (2 * hy)); // logical px per model unit
      const fit = (k) => ({ scale: unit * k, x: (w / 2 - cx * unit) * k, y: (h / 2 - cy * unit) * k });

      t = now();
      pose(0);
      const base = R.shoot(w * job.k, h * job.k, fit(job.k), d);
      const nozzles = (ud.nozzles || []).map((n) => project(n, 0, 0, fit(job.k), d));
      step(`render ${job.id}`, t);
      await breathe();
      const bank = [];
      for (let i = 0; i < BANK_N; i++) {
        t = now();
        pose((i / (BANK_N - 1)) * 2 - 1);
        bank.push(R.shoot(w * K, h * K, fit(K), d));
        step(`bank ${job.id} ${i}`, t);
        await breathe();
      }
      staged.push({ img, canvas: base, nozzles, bank });
      drop(obj);
    }
    if (opts.fail === 'mid') throw new Error('simulated: failure half way');

    // --- the hostile fleet, facing left; elite and drone looks go in as extra keys ---
    const enemies = [
      ...ENEMY_KEYS.map((id) => ({ id, key: `enemy_${id}`, img: images[`enemy_${id}`], elite: `enemy_${id}_elite` })),
      { id: 'drone', key: 'enemy_drone', img: images.enemy_basic, fresh: true },
    ];
    for (const job of enemies) {
      const img = job.img;
      if (!img) continue;
      const obj = await prepare(job.id, () => fleet.build(job.id, { thrust: 0 }));
      const ud = obj.userData, w = img.width, h = img.height;
      const d = camDist(img);
      obj.rotation.order = 'XYZ';
      obj.rotation.set(0, Math.PI, 0); // procassets LEFT view
      ud.setThrust?.(0); ud.setAim?.(0, true); ud.settle?.();
      t = now();
      const b = R.measure(d);
      let be = null;
      if (job.elite && ud.setElite) { ud.setElite(true); ud.settle?.(); be = R.measure(d); }
      step(`measure ${job.id}`, t);
      let unit = MARGIN * Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0));
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      if (be) { // elite regalia must not be cut off: both looks share the (then smaller) fit
        const ex = Math.max(cx - be.x0, be.x1 - cx), ey = Math.max(cy - be.y0, be.y1 - cy);
        unit = Math.min(unit, 0.99 * Math.min(w / (2 * ex), h / (2 * ey)));
      }
      const fit = { scale: unit * K, x: (w / 2 - cx * unit) * K, y: (h / 2 - cy * unit) * K };
      const nozzles = () => (ud.nozzles || []).map((n) => project(n, 0, Math.PI, fit, d));
      t = now();
      if (be) {
        staged.push({ key: job.elite, like: img, canvas: R.shoot(w * K, h * K, fit, d), nozzles: nozzles() });
        ud.setElite(false); ud.settle?.();
        await breathe();
      }
      const s = { canvas: R.shoot(w * K, h * K, fit, d), nozzles: nozzles() };
      if (job.fresh) { s.key = job.key; s.like = img; } else s.img = img;
      staged.push(s);
      step(`render ${job.id}`, t);
      drop(obj);
      await breathe();
    }

    // --- rockets: a small model of our own (there is no hero rocket), nose toward +X ---
    for (const [key, look] of [['rocket', ROCKET.player], ['enemy_rocket', ROCKET.enemy]]) {
      const img = images[key];
      if (!img) continue;
      const obj = await prepare(key, () => rocketModel(THREE, look));
      const w = img.width, h = img.height, d = camDist(img);
      const b = R.measure(d, 0.7);
      const unit = 0.95 * Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0)); // procassets: margin 0.95
      const fit = { scale: unit * K, x: (w / 2 - ((b.x0 + b.x1) / 2) * unit) * K, y: (h / 2 - ((b.y0 + b.y1) / 2) * unit) * K };
      t = now();
      staged.push({ img, canvas: R.shoot(w * K, h * K, fit, d) });
      step(`render ${key}`, t);
      drop(obj);
      await breathe();
    }

    // --- asteroids from rocks3d.js: optional — a failure here costs only the rocks ---
    const rocks3d = images.asteroids?.length ? await outside(import('./rocks3d.js').catch(() => null)) : null;
    if (rocks3d && opts.rocks !== false) {
      const rockStage = [];
      try {
        t = now();
        // its debris pools want a scene: a private one that is never rendered
        const rocks = new rocks3d.Rocks3D(THREE, new THREE.Scene(), { sun: R.sun, maxLod: 2 });
        R.kits.push(rocks);
        rocks.update(0); // reads the key light for the body shadow
        step('rocks kit', t);
        await breathe();
        let nN = 0, nV = 0;
        for (const img of images.asteroids) {
          t = now();
          const vol = !!img.volcanic, pick = vol ? ROCK_VOLCANIC[nV++ % ROCK_VOLCANIC.length] : ROCK_NORMAL[nN++ % ROCK_NORMAL.length];
          const mesh = rocks.create(pick, vol, 60);
          const vr = mesh.userData.rock?.vr;
          if (vr && rocks._buildNow) { rocks._buildNow(vr, ROCK_LOD); if (vr.geo?.[ROCK_LOD]) mesh.geometry = vr.geo[ROCK_LOD]; } // the finer surface, without its fracture mesh
          mesh.rotation.set(0.5 + pick * 0.9, pick * 1.7, 0.3 + pick * 0.6); // a different face up for every variant
          mesh.userData.dispose = () => rocks.release(mesh);
          R.holder.add(mesh);
          step(`build rock ${img.varIdx ?? 0}`, t);
          R.gl.setRenderTarget(R.rt);
          if (!opts.sync && R.gl.compileAsync) await outside(R.gl.compileAsync(R.scene, R.cam));
          R.gl.setRenderTarget(null);
          await breathe();
          t = now();
          const D = img.width, d = 6, b = R.measure(d, 0.75);
          const unit = 0.95 * Math.min(D / (b.x1 - b.x0), D / (b.y1 - b.y0)); // the old rocks reached 0.94 of the canvas
          const fit = { scale: unit * K, x: (D / 2 - ((b.x0 + b.x1) / 2) * unit) * K, y: (D / 2 - ((b.y0 + b.y1) / 2) * unit) * K };
          rockStage.push({ img, canvas: R.shoot(D * K, D * K, fit, d) });
          step(`render rock ${img.varIdx ?? 0}`, t);
          drop(mesh);
          await breathe();
        }
        staged.push(...rockStage);
      } catch (e) {
        check(); // (a lost context or a blown budget is not a rock problem)
        console.warn('asteroid bake skipped:', e);
        S.rocksError = e.message;
      }
    }

    if (opts.fail === 'slow') throw new Error('simulated: too slow');
    check();
    // --- all rendered: swap. One synchronous pass, so no frame ever sees a half-set ---
    t = now();
    commit(images, staged, K);
    step('commit', t);
    S.sprites = staged.length;
    images.baked3d = { K, KH };
  } finally {
    endSlice();
    S.wall = now() - S.t0;
    R?.dispose();
  }
  return S;
}

// The old sprite camera sat PERSP old-model units away; the hero hulls are 1 unit
// long, so the same weak perspective needs the distance in hull lengths.
function camDist(img) {
  let x0 = Infinity, x1 = -Infinity;
  for (const v of img.mesh?.verts || []) { if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0]; }
  const len = x1 - x0;
  return len > 1 ? PERSP / len : 6;
}

// mesh3d.projectPoint() for a hero-model point: model → (roll, yaw) → VIEW tilt →
// weak perspective → sprite px. Returns the { x, y, r } drawFlames() reads.
function project(n, roll, yaw, fit, d) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
  const x1 = cy * n.x + sy * n.z, z1 = -sy * n.x + cy * n.z;
  const y2 = cr * n.y - sr * z1, z2 = sr * n.y + cr * z1;
  const cx = Math.cos(VIEW.rx), sx = Math.sin(VIEW.rx);
  const Y = cx * y2 - sx * z2, Z = sx * y2 + cx * z2;
  const f = d / (d - Z);
  return { x: fit.x + x1 * f * fit.scale, y: fit.y - Y * f * fit.scale, r: (n.r || 0.02) * f * fit.scale };
}

/* -------------------------------- the bosses ------------------------------- */

// Classic draws a boss live: bossgen hull + turret meshes that turn to track the
// players. The baked version keeps that structure — one hull sprite without
// turrets and, per turret, a ring of pre-rendered yaw frames — so Boss.draw can
// swap its three renderMesh() calls for drawImage() and keep everything else.
//
//   const bb = bakedBoss(level);        // also reachable as images.bakedBoss(level): no import needed
//   if (bb.ready) { …sprites… } else { …live meshes, as before… }
//
// The first call for a level starts its bake (call it when the boss warning
// begins); `ready` turns true a moment later. It stays false for good when the
// sprite set itself was not baked or the boss bake fails (`failed`).
// All coordinates are logical px in the boss's own w×h box, whose top-left is
// (boss.x - boss.w / 2, boss.y - boss.h / 2) — the frame Boss.draw calls bx, by:
//   hull, white      canvases (white = flash silhouette); draw at (bx + hullX, by + hullY, hullW, hullH)
//   turrets[i]       { frame(yaw) → canvas, img (rest frame), frames, pivotX, pivotY, w, h }
//                    draw frame(tr.yaw) at (bx + pivotX - w / 2, by + pivotY - h / 2, w, h); skip dead ones
//   flame            { width, height, nozzles } — drop-in for boss.flameImg (the hero hull's engines)
//   size             the box the bake assumed (= Boss.w for that level)
// A MEGA's phase-2 core spins about its own axis and is not baked: keep the live mesh for it.
const BOSS_FRAMES = 24;       // turret yaw steps (15° — below what reads as a jump at turret size)
const BOSS_KEEP = 2;          // boss sets kept (the current one and the one before)
const NOT_READY = Object.freeze({ ready: false, failed: false, turrets: [] });
const bossCache = new Map();
let bossJob = null, bossSync = false; // (?bakefirst bakes bosses without yielding too)

export function bakedBoss(level) {
  level = Math.max(1, level | 0);
  let e = bossCache.get(level);
  if (e) return e;
  if (bakeState.status !== 'done' || bossJob) return NOT_READY; // only on top of a baked sprite set, one at a time
  e = { level, ready: false, failed: false, turrets: [] };
  bossCache.set(level, e);
  for (const k of bossCache.keys()) { if (bossCache.size <= BOSS_KEEP) break; if (k !== level) bossCache.delete(k); }
  bossJob = bakeBoss(level, { sync: bossSync }).then((r) => {
    Object.assign(e, r, { ready: true });
    say(`BAKE boss ${level}: ${r.turrets.length} turrets, work ${r.ms.toFixed(0)}ms (max slice ${r.maxSlice.toFixed(0)}ms)`);
  }).catch((err) => {
    e.failed = true;
    console.warn(`boss ${level} bake skipped — classic keeps the live meshes:`, err);
    say(`BAKE boss ${level} off: ${err?.message || err}`);
  }).finally(() => { bossJob = null; });
  return e;
}

// One boss: its own short-lived renderer (bosses are minutes apart). Runs in
// slices during play — the classic view keeps drawing the live meshes meanwhile.
export async function bakeBoss(level, opts = {}) {
  const probe = cv(1, 1).getContext('webgl2');
  if (!probe) throw new Error('WebGL2 unavailable');
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  const [THREE, re, bm] = await Promise.all([import('three'), import('../vendor/three-addons/environments/RoomEnvironment.js'), import('./bosses3d.js')]);
  let work = 0, maxSlice = 0, sliceT = now(), lost = false, R = null;
  const breathe = async () => {
    if (lost) throw new Error('WebGL context lost');
    const d = now() - sliceT;
    if (opts.sync || d < SLICE_MS) return;
    work += d; if (d > maxSlice) maxSlice = d;
    if (work > MAX_WORK_MS) throw new Error('too slow');
    await idle();
    sliceT = now();
    if (lost) throw new Error('WebGL context lost');
  };
  try {
    const mega = level % 5 === 0;
    const size = Math.min(285, 200 * (1 + (level - 1) * 0.06)); // entities.js Boss: w = h
    const gen = genBoss(level);
    const fit = fitTransform(gen.core, size, size, BOSS_VIEW, 0.9); // …and its fit: the hero hull is built to the same box and pivots
    const S = fit.scale, d = PERSP;
    const RT = isTouch ? 640 : 800;
    R = makeRig(THREE, re.RoomEnvironment, () => { lost = true; }, RT, RT, 260);
    await breathe();
    const kit = new bm.Bosses3D(THREE, { fx: null, quality: isTouch ? 0.5 : 1 });
    R.kits.push(kit);
    while (!kit.prepare(level, gen, { mega })) await breathe();
    const boss = kit.build(level, gen, { mega });
    await breathe();
    const ud = boss.userData;
    boss.rotation.y = Math.PI; // BOSS_VIEW: facing left
    R.holder.add(boss);
    const world = { x: 0, y: 0, z: 0, scale: 1, rotY: Math.PI };
    ud.setArrive?.(1);
    for (let i = 0, tm = 0; i < 40; i++) ud.update?.(100, (tm += 100), world); // let the deploy / arrival tracks run out
    R.gl.setRenderTarget(R.rt);
    if (!opts.sync && R.gl.compileAsync) { work += now() - sliceT; await R.gl.compileAsync(R.scene, R.cam); sliceT = now(); }
    R.gl.setRenderTarget(null);
    await breathe();

    // what is drawn in a pass is chosen with camera layers, not visibility: a turret rides on
    // a hull section (and glow meshes on their hull mesh), so hiding a parent would hide its riders
    const under = (o, root) => { for (let p = o; p; p = p.parent) if (p === root) return true; return false; };
    const turretGroups = ud.turrets || [];
    const parts = [];
    boss.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) parts.push([o, turretGroups.findIndex((tg) => under(o, tg))]); });
    R.sun.layers.enableAll(); R.hemi.layers.enableAll();
    const show = (only) => {
      for (const [o, ti] of parts) o.layers.set(only == null ? (ti < 0 ? 0 : 2) : ti === only ? 1 : 2);
      R.cam.layers.set(only == null ? 0 : 1);
    };

    // --- hull, without turrets: the canvas is the silhouette's own box, wherever it overhangs the w×h one ---
    show(null);
    const b = R.measure(d, 95);
    const x0 = Math.floor(fit.x + b.x0 * S) - 4, y0 = Math.floor(fit.y + b.y0 * S) - 4;
    const hw = Math.ceil(fit.x + b.x1 * S) + 4 - x0, hh = Math.ceil(fit.y + b.y1 * S) + 4 - y0;
    const kb = Math.min(opts.K || (isTouch ? 1.5 : 2), RT / hw, RT / hh); // boss density: it is big, and seldom larger than 2 device px per px
    const hull = R.shoot(hw * kb, hh * kb, { scale: S * kb, x: (fit.x - x0) * kb, y: (fit.y - y0) * kb }, d);
    const white = cv(hull.width, hull.height), wg = white.getContext('2d');
    wg.drawImage(hull, 0, 0);
    wg.globalCompositeOperation = 'source-atop';
    wg.fillStyle = '#fff';
    wg.fillRect(0, 0, white.width, white.height);
    await breathe();

    // --- turrets: BOSS_FRAMES yaw frames each, centred on the projected pivot (the classic anchor) ---
    const turrets = [];
    for (let i = 0; i < turretGroups.length; i++) {
      const tg = turretGroups[i], tr = gen.turrets[i];
      if (!tr) break;
      show(i);
      const P = projectPoint(BOSS_VIEW, fit, tr.pivot);
      const pu = (P.x - fit.x) / S, pv = (P.y - fit.y) / S; // pivot in measure units
      let rad = 0;
      for (const yaw of [Math.PI, Math.PI * 1.5, Math.PI * 1.25, Math.PI * 0.75]) {
        tg.rotation.y = yaw - Math.PI;
        let m = null;
        try { m = R.measure(d, 95); } catch (e) { /* nothing visible at this yaw */ }
        if (m) rad = Math.max(rad, Math.hypot(Math.max(pu - m.x0, m.x1 - pu), Math.max(pv - m.y0, m.y1 - pv)));
        await breathe();
      }
      if (!rad) { turrets.push(null); continue; }
      const half = Math.ceil(rad * S) + 2, fw = half * 2, px = Math.round(fw * kb);
      const frames = [];
      for (let f = 0; f < BOSS_FRAMES; f++) {
        // frame f shows the sim's tr.yaw = f·2π/N (an absolute model yaw; the hull itself sits at π)
        tg.rotation.y = (f / BOSS_FRAMES) * Math.PI * 2 - Math.PI;
        frames.push(R.shoot(px, px, { scale: S * kb, x: (half - (P.x - fit.x)) * kb, y: (half - (P.y - fit.y)) * kb }, d));
        await breathe();
      }
      tg.rotation.y = 0;
      const frame = (yaw) => frames[((Math.round((yaw / (Math.PI * 2)) * BOSS_FRAMES) % BOSS_FRAMES) + BOSS_FRAMES) % BOSS_FRAMES];
      turrets.push({ frames, frame, img: frame(Math.PI), pivotX: P.x, pivotY: P.y, w: fw, h: fw });
    }
    if (turrets.includes(null)) throw new Error('a turret did not render');

    const nozzles = (ud.nozzles?.length ? ud.nozzles : gen.core.nozzles).map((n) => {
      const p = projectPoint(BOSS_VIEW, fit, [n.x, n.y, n.z]);
      return { x: p.x, y: p.y, r: n.r * p.s };
    });
    work += now() - sliceT; maxSlice = Math.max(maxSlice, now() - sliceT);
    return { size, hull, white, hullX: x0, hullY: y0, hullW: hw, hullH: hh, turrets, flame: { width: size, height: size, nozzles }, density: kb, ms: work, maxSlice };
  } finally {
    R?.dispose();
  }
}

/* -------------------------------- the rocket ------------------------------- */

// A small missile, 1 unit long, nose toward +X: ogive nose in the accent colour, banded
// metal body, four swept fins and a dark bell with a hot throat.
function rocketModel(THREE, look) {
  const g = new THREE.Group(), made = [];
  const mat = (o) => { const m = new THREE.MeshStandardMaterial(o); made.push(m); return m; };
  const body = mat({ color: look.body, metalness: 0.75, roughness: 0.34 });
  const paint = mat({ color: look.accent, metalness: 0.25, roughness: 0.42 });
  const dark = mat({ color: 0x23262c, metalness: 0.85, roughness: 0.4 });
  const hot = mat({ color: 0x000000, emissive: look.glow, emissiveIntensity: 5 });
  const add = (geo, m) => { made.push(geo); const o = new THREE.Mesh(geo, m); g.add(o); return o; };
  // lathe profiles are (radius, height along +Y); the mesh is laid over onto +X
  const lathe = (pts, m) => add(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 20), m).rotation.set(0, 0, -Math.PI / 2);
  const R0 = 0.062;
  lathe([[0.0001, 0.5], [0.018, 0.47], [0.04, 0.4], [0.055, 0.32], [R0, 0.24]], paint);                 // nose
  lathe([[R0, 0.24], [R0, -0.3], [R0 * 0.86, -0.38]], body);                                            // body
  lathe([[R0 * 1.06, 0.2], [R0 * 1.06, 0.17]], dark);                                                   // seeker band
  lathe([[R0 * 1.07, -0.06], [R0 * 1.07, -0.1]], paint);                                                // mid stripe
  lathe([[R0 * 0.86, -0.38], [R0 * 0.6, -0.41], [R0 * 0.95, -0.5], [R0 * 0.8, -0.5], [R0 * 0.5, -0.42], [0.0001, -0.42]], dark); // bell
  lathe([[0.0001, -0.425], [R0 * 0.62, -0.47]], hot);                                                   // throat glow
  const fin = new THREE.Shape();
  fin.moveTo(-0.16, R0 * 0.8); fin.lineTo(-0.36, 0.2); fin.lineTo(-0.44, 0.2); fin.lineTo(-0.4, R0 * 0.8); fin.closePath();
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.014, bevelEnabled: false });
  finGeo.translate(0, 0, -0.007);
  made.push(finGeo);
  for (let i = 0; i < 4; i++) { const f = new THREE.Mesh(finGeo, paint); f.rotation.x = (i * Math.PI) / 2; g.add(f); }
  g.userData.size = [1, 0.4, 0.4];
  g.userData.dispose = () => { for (const x of made) x.dispose(); };
  return g;
}

/* --------------------------------- the rig -------------------------------- */

// One small offscreen renderer for the whole bake: the 3D view's light recipe
// (warm key, cool hemisphere fill, RoomEnvironment reflections), an HDR render
// target and a tone-mapping blit that turns it into a premultiplied sprite.
function makeRig(THREE, RoomEnvironment, onLost, RTW = RTW0, RTH = RTH0, span = 4) {
  const canvas = cv(RTW, RTH);
  let disposed = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); if (!disposed) onLost(); });
  const gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true });
  gl.setPixelRatio(1);
  gl.setSize(RTW, RTH, false);
  gl.setClearColor(0x000000, 0);
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.0;
  const glc = gl.getContext();

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(gl);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.7);
  sun.position.set(-0.45, 1, 0.55);
  const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x1a1420, 0.9);
  const holder = new THREE.Group();
  scene.add(sun, hemi, holder);

  // the sprite camera: mesh3d tilts the model by VIEW.rx under a fixed eye — here the eye
  // is tilted instead, so the lights stay where the 3D view has them (above the lane)
  const cam = new THREE.PerspectiveCamera(10, 1, 0.1, 50);
  const sx = Math.sin(VIEW.rx), cx = Math.cos(VIEW.rx);

  const half = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
  const rt = new THREE.WebGLRenderTarget(RTW, RTH, {
    samples: 4, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  rt.scissorTest = true;

  // blit: ACES + sRGB exactly as the 3D view's output pass. The picture is what the hull
  // looks like over black space; alpha is its coverage, raised under anything that glows
  // so lights and hot nozzles survive as (premultiplied) light instead of being cut out.
  const quadMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: rt.texture }, uScale: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'uniform vec2 uScale; varying vec2 vUv; void main() { vUv = uv * uScale; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tMap; varying vec2 vUv;
      void main() {
        vec4 s = texture2D(tMap, vUv);
        gl_FragColor = vec4(max(s.rgb, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0);
        float a = clamp(max(s.a, max(c.r, max(c.g, c.b))), 0.0, 1.0);
        gl_FragColor = vec4(c, a);
      }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeo, quadMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Renders the holder into the bottom-left vw×vh px of the GL canvas. fit = { scale
  // (px per model unit), x, y (where the model origin lands, px from the top-left) }.
  const render = (vw, vh, fit, d) => {
    const ss = Math.max(1, Math.min(2, Math.floor(Math.min(RTW / vw, RTH / vh)))); // supersample when it fits
    cam.aspect = vw / vh;
    cam.fov = (2 * Math.atan(vh / (2 * fit.scale * d)) * 180) / Math.PI;
    cam.near = Math.max(d * 0.01, d - span); cam.far = d + span;
    cam.position.set(0, d * sx, d * cx);
    cam.up.set(0, cx, -sx);
    cam.lookAt(0, 0, 0);
    cam.setViewOffset(vw, vh, vw / 2 - fit.x, vh / 2 - fit.y, vw, vh);
    cam.updateProjectionMatrix();
    rt.viewport.set(0, 0, vw * ss, vh * ss);
    rt.scissor.set(0, 0, vw * ss, vh * ss);
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(scene, cam);
    gl.setRenderTarget(null);
    gl.setViewport(0, 0, vw, vh);
    gl.setScissor(0, 0, vw, vh);
    gl.setScissorTest(true);
    quadMat.uniforms.uScale.value.set((vw * ss) / RTW, (vh * ss) / RTH);
    gl.clear();
    gl.render(quadScene, quadCam);
  };

  const buf = new Uint8Array(MS * MS * 4);
  return {
    gl, scene, cam, rt, holder, sun, hemi, kits: [],
    // silhouette bounds of the current pose in model units around the origin (x right, y down)
    // (rad: a first guess at the model's radius; it is widened when the silhouette touches the edge)
    measure(d, rad = 0) {
      const sizeOf = (o) => o.userData.size || [1, 1, 1];
      if (!rad) {
        rad = 0.7;
        for (const o of holder.children) { const s = sizeOf(o); rad = Math.max(rad, 0.6 * Math.hypot(s[0], 2 * s[1], s[2])); }
      }
      for (let pass = 0; pass < 3; pass++) {
        const scale = MS / 2 / rad;
        render(MS, MS, { scale, x: MS / 2, y: MS / 2 }, d);
        glc.readPixels(0, 0, MS, MS, glc.RGBA, glc.UNSIGNED_BYTE, buf);
        let x0 = MS, x1 = -1, y0 = MS, y1 = -1;
        for (let j = 0; j < MS; j++) {
          const row = j * MS * 4 + 3;
          for (let i = 0; i < MS; i++) {
            if (buf[row + i * 4] > 40) {
              if (i < x0) x0 = i;
              if (i > x1) x1 = i;
              if (j < y0) y0 = j;
              if (j > y1) y1 = j;
            }
          }
        }
        if (x1 < 0) throw new Error('empty render');
        if (x0 > 0 && y0 > 0 && x1 < MS - 1 && y1 < MS - 1) {
          // GL rows run bottom-up: flip to canvas y
          return { x0: (x0 - MS / 2) / scale, x1: (x1 + 1 - MS / 2) / scale, y0: (MS - 1 - y1 - MS / 2) / scale, y1: (MS - y0 - MS / 2) / scale };
        }
        rad *= 1.5; // touched the edge: pull back and look again
      }
      throw new Error('model does not fit the measuring view');
    },
    // one finished sprite canvas
    shoot(vw, vh, fit, d) {
      vw = Math.round(vw); vh = Math.round(vh);
      if (vw > RTW || vh > RTH) throw new Error(`sprite ${vw}x${vh} exceeds the bake target`);
      render(vw, vh, fit, d);
      const c = cv(vw, vh);
      c.getContext('2d').drawImage(canvas, 0, RTH - vh, vw, vh, 0, 0, vw, vh);
      return c;
    },
    dispose() {
      disposed = true;
      try {
        for (const o of [...holder.children]) { holder.remove(o); o.userData.dispose?.(); }
        for (const k of this.kits) k.dispose?.();
        envRT.dispose(); rt.dispose(); quadGeo.dispose(); quadMat.dispose();
        gl.dispose();
        gl.forceContextLoss(); // hand the context back now, not at the next GC
      } catch (e) { /* the context may already be gone */ }
      canvas.width = canvas.height = 0;
    },
  };
}

/* --------------------------------- the swap -------------------------------- */

function commit(images, staged, K) {
  for (const s of staged) {
    if (s.img) {
      const img = s.img, k = s.canvas.width / img.width;
      img.width = s.canvas.width; img.height = s.canvas.height; // (resizing clears: redrawn in the same task)
      img.getContext('2d').drawImage(s.canvas, 0, 0);
      if (img.fitScale) img.fitScale *= k;
      if (s.nozzles) { if (img.nozzles) { img.nozzles.length = 0; img.nozzles.push(...s.nozzles); } else img.nozzles = s.nozzles; }
      if (s.bank) img.bankFrames = s.bank;
    } else {
      // a look the old set did not have (elite hulls, the carrier drone): same framing
      // and wreck mesh as the sprite it stands in for
      const c = s.canvas, k = c.width / s.like.width;
      c.nozzles = s.nozzles;
      c.tintKey = s.key.replace('enemy_', ''); // tinted() cache key for this look (the base hull's key would hand back the wrong silhouette)
      c.mesh = s.like.mesh;
      c.fitScale = s.like.baked3d ? s.like.fitScale : (s.like.fitScale || 0) * k;
      images[s.key] = c;
    }
    if (s.img) s.img.baked3d = K;
  }
  retint(images);
}

// fx.tinted() caches its copies by key and the game holds on to them (hit flashes,
// wreck silhouettes, online hull colours, far-off convoys). The ones made from a
// sprite that has just changed are redrawn in place. The cache is private to fx.js,
// so existing entries are found by probing: a hit returns the cached canvas, a miss
// throws inside tinted() before anything is stored (the probe is not drawable).
const PROBE = { width: 1, height: 1 };
const PLAYER_TINTS = [null, 'rgba(90,255,140,0.45)', 'rgba(255,150,40,0.55)', 'rgba(220,90,255,0.5)']; // game.js
function retint(images) {
  const list = [];
  for (const id of ENEMY_KEYS) {
    const img = images[`enemy_${id}`];
    list.push([`white_enemy_${id}`, 'rgba(255,255,255,1)', img], [`black_enemy_${id}`, 'rgba(0,0,0,1)', img], [`gold_enemy_${id}`, 'rgba(255,205,80,1)', img]);
  }
  list.push(
    ['convoy_silhouette', 'rgba(22,28,40,0.96)', images.enemy_basic], ['pirate_silhouette', 'rgba(42,20,24,0.96)', images.enemy_hunter],
    ['capital_silhouette', 'rgba(30,35,50,0.96)', images.enemy_carrier], ['battle_fighter', 'rgba(26,32,46,0.96)', images.enemy_basic],
    ['battle_raider', 'rgba(48,22,26,0.96)', images.enemy_hunter],
  );
  (images.asteroids || []).forEach((img, vi) => list.push([`belt_rock_${vi}`, 'rgba(26,30,42,0.93)', img]));
  for (let i = 1; i < PLAYER_TINTS.length; i++) {
    for (const id of SHIP_KEYS) list.push([`hull_${i}_${id}`, PLAYER_TINTS[i], images.ships?.[id]]);
    list.push([`hull_${i}_def`, PLAYER_TINTS[i], i === 1 ? images.player2_ship : images.player1_ship]);
  }
  for (const [key, color, img] of list) {
    if (!img) continue;
    let c = null;
    try { c = tinted(PROBE, color, key); } catch (e) { /* not cached yet: tinted() will make it from the new sprite */ }
    if (!c || !c.getContext || c.width === 1) continue;
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
  }
}
