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

import { VIEW } from './mesh3d.js';
import { tinted } from './fx.js';
import { isTouch } from './input.js';

const PERSP = 420;          // mesh3d.js default camera distance (old model units)
const MARGIN = 0.92;        // procassets.js bakeInto() fit margin
const BANK_N = 7, BANK_MAX = 0.42; // procassets.js bakeBankFrames()
const MS = 192;             // measuring viewport (px): silhouette bounds are read back from it
const RTW = 640, RTH = 400; // render target / GL canvas: the largest sprite (a 6× hangar hull) fits
const SLICE_MS = 5;         // work per slice before yielding to the game loop
const MAX_WORK_MS = 9000;   // give up (old sprites stay) when the bake itself burns more than this…
const MAX_WALL_MS = 45000;  // …or drags on this long while the tab is visible

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
    R = makeRig(THREE, re.RoomEnvironment, () => { lost = true; });
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

/* --------------------------------- the rig -------------------------------- */

// One small offscreen renderer for the whole bake: the 3D view's light recipe
// (warm key, cool hemisphere fill, RoomEnvironment reflections), an HDR render
// target and a tone-mapping blit that turns it into a premultiplied sprite.
function makeRig(THREE, RoomEnvironment, onLost) {
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
    cam.near = Math.max(0.05, d - 4); cam.far = d + 4;
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
    gl, scene, cam, rt, holder, kits: [],
    // silhouette bounds of the current pose in model units around the origin (x right, y down)
    measure(d) {
      const sizeOf = (o) => o.userData.size || [1, 1, 1];
      let rad = 0.7;
      for (const o of holder.children) { const s = sizeOf(o); rad = Math.max(rad, 0.6 * Math.hypot(s[0], 2 * s[1], s[2])); }
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
      if (img.nozzles) { img.nozzles.length = 0; img.nozzles.push(...s.nozzles); } else img.nozzles = s.nozzles;
      if (s.bank) img.bankFrames = s.bank;
    } else {
      // a look the old set did not have (elite hulls, the carrier drone): same framing
      // and wreck mesh as the sprite it stands in for
      const c = s.canvas, k = c.width / s.like.width;
      c.nozzles = s.nozzles;
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
