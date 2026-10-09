// view3d.js — WebGL (three.js) renderer that draws the SAME 2D simulation in
// real 3D. The play plane becomes the horizontal XZ plane (sim x → +X forward,
// sim y → +Z starboard, +Y up), so nothing about the game logic, hitboxes or
// netcode changes — only the camera does.
//
// Ships/bosses/debris reuse the procedural meshes from mesh3d/shipgen/bossgen
// (sprites carry them as img.mesh), re-tessellated smooth via mesh.hi3d().
// Particles live in fx3d.js, asteroids in rocks3d.js; this file owns the
// scene, the cameras, post-processing and the sim → 3D translation.
// three.js and friends load lazily on first use.
//
// Cameras (cycled with V): 'top' (the classic framing, straight down) → 'tilt'
// (2.5D over-the-field) → 'chase' (third person, behind the ship). The old
// canvas renderer stays available as "classic" graphics (settings / G).
import { W, H } from './const.js';
import * as input from './input.js';
import { settings, saveSettings } from './settings.js';
import {
  Explosion, Shockwave, Spark, MeshDebris, LaserBeam, SmokeParticle, RockDust,
  MuzzleFlash, Freighter, Comet, DistantConvoy, Skirmish, SpaceBattle, DistantRocks,
} from './entities.js';
import { VIEW, withDetail } from './mesh3d.js';
import { genBoss, genBossCore } from './bossgen.js';
import { SECTOR_THEMES } from './bggen.js';

export const MODES = ['top', 'tilt', 'chase'];
const MODE_LABEL = { top: 'TOP', tilt: 'TILT', chase: 'CHASE' };
const FOV = 50;
const CHASE_FOV = 40; // telephoto: compresses depth so the far end of the field stays readable
const HI = 3;         // tessellation multiplier for models shown in 3D
const STEP = 16.67;   // sim velocities are "px per 60Hz step"
const GOLD = [1, 0.75, 0.3], CYAN = [0.35, 0.85, 1];
const RK_PLAYER = { color: 'player' }, RK_ENEMY = { color: 'enemy' };
// family paint (linear) — the chips and plates a dying fighter throws off
const PAINT = {
  basic: [0.2, 0.26, 0.12], weaver: [0.06, 0.34, 0.3], hunter: [0.6, 0.02, 0.01], tank: [0.26, 0.12, 0.42],
  sniper: [0.1, 0.14, 0.5], carrier: [0.5, 0.26, 0.06], shieldbearer: [0.03, 0.26, 0.38], strafer: [0.4, 0.05, 0.2], brood: [0.36, 0.44, 0.06],
  drone: [0.6, 0.55, 0.4],
};
const PU_COLOR = {
  shooting: 'rgb(110,255,120)', slow_motion: 'rgb(255,180,60)', kill_all: 'rgb(255,80,200)',
  rocket: 'rgb(255,95,80)', spread: 'rgb(255,220,80)', shield: 'rgb(0,210,255)', laser: 'rgb(90,160,255)',
};
let THREE = null;
let ADD = null; // lazily imported classes: three addons + the fx / rocks / hull / env / ships / enemies modules

export class View3D {
  constructor(app) {
    this.app = app;
    this.mode = MODES.includes(settings.cam3d) ? settings.cam3d : 'top';
    this.enabled = !!settings.gfx3d; // false = classic canvas graphics
    this.ready = false;
    this.loading = false;
    this.failed = false;
    this.objs = new Map();   // sim entity → Object3D
    this.seen = new WeakSet(); // one-shot sim effects already turned into particles
    this.stamp = 0;
    this._rendered = false;
    this.world = null;
  }

  get active() { return this.enabled && this.ready && !this.failed && !this.lost; }
  get label() { return this.loading ? 'LOADING 3D…' : this.failed ? '3D UNAVAILABLE' : `CAMERA: ${MODE_LABEL[this.mode] || ''}`; }

  // V: next camera (or back into 3D from classic graphics)
  cycle() {
    if (!this.enabled) this.setEnabled(true);
    else this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]);
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = settings.cam3d = mode;
    saveSettings();
  }

  setEnabled(on) {
    this.enabled = settings.gfx3d = !!on;
    saveSettings();
    if (on) { this.load(); this.fresh = true; }
    else this.flush(); // or everything that dies while classic is shown would "die again" on return
  }

  // three.js + modules load once, in the background; classic keeps drawing meanwhile
  load() {
    if (this.ready || this.loading || this.failed) return;
    this.loading = true;
    const A = '../vendor/three-addons/';
    Promise.all([
      import('three'),
      import(`${A}postprocessing/EffectComposer.js`),
      import(`${A}postprocessing/RenderPass.js`),
      import(`${A}postprocessing/UnrealBloomPass.js`),
      import(`${A}postprocessing/OutputPass.js`),
      import(`${A}postprocessing/ShaderPass.js`),
      import(`${A}environments/RoomEnvironment.js`),
      import(`${A}utils/BufferGeometryUtils.js`),
      import('./fx3d.js'),
      import('./rocks3d.js'),
      import('./hullmat3d.js'),
      import('./env3d.js'),
      import('./ships3d.js'),
      import('./enemies3d.js'),
    ]).then(([three, ec, rp, bp, op, sp, re, bgu, fx, rocks, hull, env, ships, enemies]) => {
      THREE = three;
      ADD = {
        EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass, UnrealBloomPass: bp.UnrealBloomPass,
        OutputPass: op.OutputPass, ShaderPass: sp.ShaderPass, RoomEnvironment: re.RoomEnvironment,
        toCreasedNormals: bgu.toCreasedNormals, Fx3D: fx.Fx3D, Rocks3D: rocks.Rocks3D, HullMaterials: hull.HullMaterials, Env3D: env.Env3D, Ships3D: ships.Ships3D, Enemies3D: enemies.Enemies3D,
      };
      this.init();
      this.ready = true;
    }).catch((e) => {
      console.error('3D view failed to load:', e);
      window.__svlog?.push(`ERR 3D load: ${e.message} | ${(e.stack || '').split('\n')[1] || ''}`);
      this.failed = true; // classic graphics take over
    }).finally(() => { this.loading = false; });
  }

  /* --------------------------------- setup --------------------------------- */

  init() {
    const cv = document.createElement('canvas');
    cv.id = 'game3d';
    cv.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:0;background:#000';
    const game = this.app.canvas;
    game.style.position = 'relative';
    game.style.zIndex = '1';
    game.parentNode.insertBefore(cv, game);
    this.cv = cv;

    const lite = input.isTouch; // phones: fewer particles, cheaper bloom
    this.gl = new THREE.WebGLRenderer({ canvas: cv, antialias: !lite, powerPreference: 'high-performance' });
    // GPU reset / driver crash: the classic canvas takes over until the context
    // comes back (three re-creates its GL state itself; baked planets are redone)
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL context lost — classic graphics until it is restored');
      window.__svlog?.push('ERR 3D: WebGL context lost');
      this.lost = true;
      cv.style.display = 'none';
      this.app.canvas.style.background = '#000';
    });
    cv.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.flush();
      this._lay = '';
      this.env.rebake?.();
    });
    this.pr = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2);
    this.gl.setPixelRatio(this.pr);
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(FOV, W / H, 5, 30000);
    this.camPos = new THREE.Vector3(0, 900, 0);
    this.camTgt = new THREE.Vector3();
    this.camUp = new THREE.Vector3(0, 0, -1);

    // image-based light for the metal hulls + a warm key and a cool fill
    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pmrem.fromScene(new ADD.RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.sun = new THREE.DirectionalLight(0xfff0dc, 2.7);
    this.sun.position.set(-0.45, 1, 0.55);
    this.hemi = new THREE.HemisphereLight(0x8fb8ff, 0x1a1420, 0.9);
    this.scene.add(this.sun, this.hemi);
    // sky, sun, planets, lit fog, dust, the lane, weather — everything that is not gameplay
    this.env = new ADD.Env3D(THREE, this.scene, { quality: lite ? 0.5 : 1, fogLayers: lite ? 1 : undefined, fieldDim: 0.32, renderer: this.gl });
    this.envState = { time: 0, W, H, mode: 'top', speedMul: 1, warpMul: 1, paused: false, ion: 0, eclipse: 0, lights: new Float32Array(16 * 8), lightCount: 0, playerX: 0, playerZ: 0, viewH: 720 };

    // post: bloom on a half-float target (HDR colours > 1 glow), then ACES + sRGB
    const rt = new THREE.WebGLRenderTarget(256, 256, { type: THREE.HalfFloatType, samples: lite ? 0 : 4 });
    this.composer = new ADD.EffectComposer(this.gl, rt);
    this.composer.setPixelRatio(this.pr);
    this.composer.addPass(new ADD.RenderPass(this.scene, this.cam));
    this.bloom = new ADD.UnrealBloomPass(new THREE.Vector2(256, 256), lite ? 0.4 : 0.5, 0.8, 0.9);
    this.composer.addPass(this.bloom);
    // grade (linear, pre-tonemap): edge chromatic split that kicks on big hits,
    // a touch of contrast/saturation, fine grain to kill banding in the dark sky
    this.grade = new ADD.ShaderPass({
      uniforms: { tDiffuse: { value: null }, uPunch: { value: 0 }, uTime: { value: 0 }, uSat: { value: 1.08 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uPunch; uniform float uTime; uniform float uSat;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
        void main() {
          vec2 d = vUv - 0.5;
          float r2 = dot(d, d);
          vec2 off = d * r2 * (0.006 + uPunch * 0.05);
          vec3 c = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSat);
          c *= 1.0 + 0.06 * smoothstep(0.0, 0.5, l);       // gentle shoulder lift
          c += (hash(gl_FragCoord.xy) - 0.5) * 0.012 * (0.3 + l); // grain
          gl_FragColor = vec4(max(c, 0.0), 1.0);
        }`,
    });
    this.composer.addPass(this.grade);
    this.composer.addPass(new ADD.OutputPass());

    this.ships = new ADD.Ships3D(THREE, { quality: lite ? 0.5 : 1 }); // hand-built hero hulls for the player roster
    this.fleet = new ADD.Enemies3D(THREE, { quality: lite ? 0.5 : 1 }); // the hostile roster, one designed hull per type
    // plated, worn, seam-lit hull surface for every procedural mesh (hullmat3d.js)
    this.hull = new ADD.HullMaterials(THREE, { quality: lite ? 0.5 : 1 });
    this.geoCache = new WeakMap();
    this.texCache = new WeakMap();

    this.glowTex = this.dotTexture();
    this.ballGeo = new THREE.IcosahedronGeometry(1, 3);
    this.gemGeo = new THREE.OctahedronGeometry(1, 0).scale(1, 1.25, 1);
    this.gemEdges = new THREE.EdgesGeometry(this.gemGeo);
    // naval-mine silhouette: armoured ball bristling with contact horns
    this.mineGeo = new THREE.IcosahedronGeometry(1, 1);
    this.hornGeo = new THREE.ConeGeometry(0.2, 0.62, 6).translate(0, 1.2, 0);
    this.hornDirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.58, 0.58, 0.58], [-0.58, 0.58, -0.58], [0.58, -0.58, -0.58], [-0.58, -0.58, 0.58]];
    this.shieldMats = new Map();

    this.fx = new ADD.Fx3D(THREE, this.scene, { quality: lite ? 0.5 : 1 });
    this.rocks = new ADD.Rocks3D(THREE, this.scene, { fx: this.fx });
    this.prMax = this.pr; this.prMin = Math.min(this.pr, 0.8);
    this.frameMs = 16; this.slowFrames = 0; this.fastFrames = 0;

    this.boltKinds = { // reused opts objects (fx.bolt allocates nothing)
      player: { kind: 'player', scale: 1 }, playerHot: { kind: 'playerHot', scale: 1 }, playerPlasma: { kind: 'playerPlasma', scale: 1 },
      enemy: { kind: 'enemy', scale: 1 }, enemyHeavy: { kind: 'enemyHeavy', scale: 1 },
    };
    this.col = new THREE.Color();
    this.beamOpts = { kind: 'laser', width: 4, color: undefined, alpha: 1, hot: false, flare: undefined };
    this.warm();

  }

  // Shader programs are the stutter risk in WebGL: linking one costs 100–300 ms
  // on first use, and three frees a program as soon as its last material is
  // disposed — so a game where enemies, pickups and debris come and go would
  // re-link the same shaders all run long. Two measures:
  //  1. materials are never "disposed" (they own no GPU memory themselves —
  //     geometries and textures are still freed normally), so every program
  //     is linked once per session;
  //  2. one of everything is built up front and compiled in the background
  //     (KHR_parallel_shader_compile) while the menu is showing.
  warm() {
    THREE.Material.prototype.dispose = function () {}; // (1)
    const tmp = new THREE.Group(), std = (o) => new THREE.MeshStandardMaterial(o);
    const add = (o) => { tmp.add(o); return o; };
    try {
      for (const id of ['basic', 'weaver', 'hunter', 'tank', 'sniper', 'carrier', 'shieldbearer', 'strafer', 'brood', 'drone']) add(this.fleet.build(id));
      for (const id of ['vanguard', 'interceptor', 'juggernaut', 'ghost', 'ace', 'player2']) add(this.ships.build(id));
      add(this.ships.build('vanguard')).userData.setOpacity(0.6); // the respawn-blink variant
      const tri = { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [{ v: [0, 1, 2], c: [200, 200, 200], e: 0 }, { v: [0, 2, 1], c: [255, 255, 255], e: 1 }] };
      for (const kind of ['boss', 'debris', 'rocket', 'freighter']) add(this.model(tri, { own: true, kind }));
      // pickups, mines, shields, the gravity well, billboards
      add(new THREE.Mesh(this.gemGeo, std({ color: 0xffffff, emissive: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, flatShading: true })));
      add(new THREE.LineSegments(this.gemEdges, new THREE.LineBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      add(new THREE.Mesh(this.mineGeo, std({ color: 0x2a2f38, metalness: 0.85, roughness: 0.32, flatShading: true })));
      add(new THREE.Mesh(this.ballGeo, this.shieldMat(0x50dcff)));
      add(new THREE.Mesh(this.ballGeo, new THREE.MeshBasicMaterial({ color: 0 })));
      add(new THREE.Sprite(this.spriteMat('rgb(255,255,255)', 0.5)));
      add(new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, depthTest: false })));
    } catch (e) { console.warn('3D warm-up: could not build a sample', e); }

    // programs are keyed by the render target's colour handling: compile against
    // the composer's linear half-float target, exactly as the game renders
    const gl = this.gl, rt = this.composer.renderTarget1;
    const hidden = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } }); // idle particle pools etc.
    gl.setRenderTarget(rt);
    try {
      this.rocks.warmup?.(gl, this.cam);
      const jobs = [gl.compileAsync(this.scene, this.cam), gl.compileAsync(tmp, this.cam, this.scene)];
      this.warming = Promise.all(jobs).catch(() => {}).then(() => { this.warming = null; });
    } catch (e) { console.warn('3D warm-up skipped:', e); }
    gl.setRenderTarget(null);
    for (const o of hidden) o.visible = false;
  }

  dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // additive glow sprite; color is a css string or a linear [r,g,b] (HDR ok)
  spriteMat(color, opacity = 1) {
    const m = new THREE.SpriteMaterial({
      map: this.glowTex, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    if (Array.isArray(color)) m.color.setRGB(color[0], color[1], color[2]);
    else m.color.set(color);
    return m;
  }

  // energy shield: fresnel rim + drifting lattice, additive HDR
  shieldMat(color) {
    let m = this.shieldMats.get(color);
    if (m) return m;
    m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          vP = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uTime;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          vec3 p = vP * 7.0;
          float cell = abs(sin(p.x + uTime) * sin(p.y * 1.15 - uTime * 0.7) * sin(p.z + uTime * 0.4));
          float lattice = smoothstep(0.08, 0.0, cell);
          float a = rim * 0.42 + lattice * 0.035;
          gl_FragColor = vec4(uColor * (0.35 + rim * 1.5 + lattice * 0.45), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.shieldMats.set(color, m);
    return m;
  }

  /* ------------------------------- geometry -------------------------------- */

  // mesh3d mesh ({verts, faces:[{v,c,e}]}) → { lit, unlit } BufferGeometries.
  // Normals are crease-aware: the resampled hull curves shade smooth, while
  // wings, fins, boxes and panel breaks keep their hard edges.
  buildGeo(mesh, crease = true) {
    const col = new THREE.Color();
    const bins = { lit: { p: [], c: [] }, unlit: { p: [], c: [] } };
    for (const f of mesh.faces) {
      const b = f.e >= 0.5 ? bins.unlit : bins.lit;
      col.setRGB(f.c[0] / 255, f.c[1] / 255, f.c[2] / 255, THREE.SRGBColorSpace);
      for (let i = 1; i < f.v.length - 1; i++) {
        for (const vi of [f.v[0], f.v[i], f.v[i + 1]]) {
          const v = mesh.verts[vi];
          b.p.push(v[0], v[1], v[2]);
          b.c.push(col.r, col.g, col.b);
        }
      }
    }
    const mk = (b, lit) => {
      if (!b.p.length) return null;
      let g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.p), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.c), 3));
      if (lit) {
        g.computeVertexNormals();
        if (crease) g = ADD.toCreasedNormals(g, 0.62); // (skipped for small wreckage chunks: flat facets are fine there)
      }
      return g;
    };
    return { lit: mk(bins.lit, true), unlit: mk(bins.unlit, false) };
  }

  geoFor(mesh) {
    let g = this.geoCache.get(mesh);
    if (!g) {
      g = this.buildGeo(mesh.hi3d ? mesh.hi3d() : mesh);
      this.geoCache.set(mesh, g);
    }
    return g;
  }

  // group holding a mesh3d model with its own hull-material instance (shared
  // shader program), so each entity can flash / dim / burn / warp on its own
  model(mesh, { own = false, flame = null, kind = 'fighter', scale = 0.62, seed = (Math.random() * 1e6) | 0, geo: pre = null } = {}) {
    const geo = pre || (own ? this.buildGeo(mesh, kind !== 'debris') : this.geoFor(mesh));
    const grp = new THREE.Group();
    const mat = this.hull.create({ kind, scale, seed });
    const glow = this.hull.emissive({ kind, seed });
    if (geo.lit) {
      grp.add(new THREE.Mesh(geo.lit, mat));
      if (!geo.lit.boundingBox) geo.lit.computeBoundingBox();
      glow.userData.setBounds?.(geo.lit.boundingBox.min.x, geo.lit.boundingBox.max.x);
    }
    if (geo.unlit) grp.add(new THREE.Mesh(geo.unlit, glow));
    grp.userData.mat = mat;
    grp.userData.glow = glow;
    if (own) grp.userData.ownGeo = geo;
    if (flame && mesh.nozzles) {
      grp.userData.nozzles = mesh.nozzles;
    }
    return grp;
  }

  exhOpt(boost, intensity) { // reused opts object for the player plumes
    const o = this._exh || (this._exh = { color: 'player', boost: false, intensity: 1 });
    o.boost = boost; o.intensity = intensity;
    return o;
  }

  // cached uniform-setter call on a model's userData control API
  setU(ud, fn, v) {
    const key = `_${fn}`;
    if (ud[key] === v) return;
    ud[key] = v;
    ud[fn]?.(v);
  }

  // drive a hull state (setFlash / setDim / setDamage / setHeat / setOpacity / setWarp) on both materials
  hullSet(o, fn, v) {
    if (o.userData[fn] === v) return;
    o.userData[fn] = v;
    o.userData.mat.userData[fn]?.(v);
    o.userData.glow?.userData[fn]?.(v);
  }

  texFor(img) {
    let t = this.texCache.get(img);
    if (!t) {
      t = new THREE.CanvasTexture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(img, t);
    }
    return t;
  }

  /* ------------------------------ entity sync ------------------------------ */

  obj(ent, make) {
    let o = this.objs.get(ent);
    if (!o) {
      o = make();
      this.scene.add(o);
      this.objs.set(ent, o);
    }
    o.userData.stamp = this.stamp;
    o.visible = true;
    return o;
  }

  drop(o, quiet = false) {
    if (!quiet) o.userData.onDrop?.(o);
    this.scene.remove(o);
    o.userData.mat?.dispose?.();
    o.userData.glow?.dispose?.(); // (fleet models keep a colour in .glow, hull models a material)
    const og = o.userData.ownGeo;
    if (og) { og.lit?.dispose(); og.unlit?.dispose(); }
    o.userData.ownMats?.forEach((m) => m.dispose());
    o.userData.release?.(o);
  }

  sweep() {
    for (const [ent, o] of this.objs) {
      if (o.userData.stamp !== this.stamp) { this.drop(o); this.objs.delete(ent); }
    }
  }

  // forget every mirrored object and live particle without firing their
  // death effects (the sector/sky state is kept)
  flush() {
    if (!this.ready) return;
    for (const o of this.objs.values()) this.drop(o, true);
    this.objs.clear();
    this.fx.clear();
    this.rocks.clear();
    this.quiet = true;
    this._simT = null;
  }

  reset() {
    for (const o of this.objs.values()) this.drop(o, true);
    this.objs.clear();
    this.fx?.clear();
    this.rocks?.clear();
    this.env?.clear();
    this._bg = undefined;
    this.quiet = true; // objects re-created on the next frame are not "arriving": no spawn effects
    this._simT = null;
  }

  // Menu / hangar backdrop: the same sky, sun and planets as in flight, plus an
  // optional hero hull on a slow turntable at a given spot of the 2D layout.
  // Returns false when 3D is off or not ready (the caller paints its classic
  // backdrop instead); on true the 2D canvas has been cleared to transparent.
  // opts: { ship: roster id | null, x, y (canvas px), size (px hull length), spin }
  backdrop(g, opts = {}) {
    if (!this.active) return false;
    const now = performance.now();
    const real = Math.min(50, now - (this._last || now));
    this._last = now;
    this.governor(real);
    if (this.world) { this.reset(); this.world = null; }
    this._rendered = true;
    this.stamp++;
    this.layout();
    const T = (this._menuT = (this._menuT || 0) + real);
    if (this._bg !== 'menu') { // one sector per visit, a different one every day
      this._bg = 'menu';
      const day = Math.floor(Date.now() / 864e5);
      this.env.setSector(1 + (day % 9), SECTOR_THEMES[day % SECTOR_THEMES.length]);
    }
    const fx = this.fx, cam = this.cam;
    fx.update(real, cam, this.cv.height);
    // a calm horizon shot with a slow breathing drift and a hint of mouse parallax
    const cl = (v) => Math.max(-0.5, Math.min(0.5, v || 0)); // (the pointer starts far off-screen)
    const mx = cl(input.pointer.x / W - 0.5), my = cl(input.pointer.y / H - 0.5);
    cam.fov = 42; cam.aspect = W / H;
    cam.position.set(-560 + Math.sin(T / 9000) * 30, 300 + Math.sin(T / 7000) * 14, mx * -40);
    cam.up.set(0, 1, 0);
    cam.lookAt(460, -10 + my * 30, mx * 60);
    cam.updateProjectionMatrix();

    if (opts.ship) {
      if (this.showShip?.id !== opts.ship) {
        if (this.showShip) { this.scene.remove(this.showShip.obj); this.showShip.obj.userData.dispose?.(); }
        this.showShip = { id: opts.ship, obj: this.ships.build(opts.ship), born: T };
        this.scene.add(this.showShip.obj);
      }
      const o = this.showShip.obj, ud = o.userData;
      // park it on the view ray through (x, y), sized in screen pixels
      const D = 330, v = this._v || (this._v = new THREE.Vector3());
      v.set((opts.x / W) * 2 - 1, 1 - (opts.y / H) * 2, 0.5).unproject(cam).sub(cam.position).normalize();
      o.position.copy(cam.position).addScaledVector(v, D);
      const pxPerUnit = (H / 2) / Math.tan((cam.fov * Math.PI) / 360) / D;
      const pop = Math.min(1, (T - this.showShip.born) / 260);
      o.scale.setScalar((opts.size / pxPerUnit) * (0.86 + 0.14 * pop * (2 - pop)));
      o.rotation.order = 'YXZ';
      o.rotation.set(0.28 + Math.sin(T / 2300) * 0.1, T * (opts.spin ?? 0.00045) + 0.6, Math.sin(T / 3100) * 0.06);
      o.visible = true;
      ud.setThrust(1); ud.update(real, T);
    } else if (this.showShip) this.showShip.obj.visible = false;

    fx.commit();
    const es = this.envState;
    es.time = T; es.W = W; es.H = H; es.mode = 'top'; es.viewH = this.cv.height;
    es.speedMul = 0.6; es.warpMul = 1; es.paused = false; es.ion = 0; es.eclipse = 0; es.intense = false;
    es.lights = fx.lightData; es.lightCount = fx.lightCount; es.playerX = 0; es.playerZ = 0;
    this.env.update(real, cam, es);
    this.sun.position.copy(this.env.sunDirection);
    this.sun.color.copy(this.env.sunColor);
    this.hemi.color.copy(this.env.ambientColor);
    this.grade.uniforms.uPunch.value = 0;
    this.grade.uniforms.uTime.value = (T % 1000) / 1000;
    this.composer.render();
    g.clearRect(0, 0, W, H);
    return true;
  }

  // Adaptive resolution: nobody tuned this for your GPU, so watch the real
  // frame time and trade pixels for smoothness (and take them back when idle).
  // It reads the raw requestAnimationFrame cadence (the browser slows that down
  // when the GPU can't keep up) — not the interval between frames the 60 fps
  // game loop chooses to run, which is deliberately longer on fast displays.
  governor() {
    if (!this._rafTap) {
      this._rafTap = true;
      let last = 0;
      const tap = (now) => {
        const d = now - last; last = now;
        if (d > 0 && d < 250) this.rafMs = (this.rafMs ?? d) + (d - (this.rafMs ?? d)) * 0.05;
        requestAnimationFrame(tap);
      };
      requestAnimationFrame(tap);
    }
    if (this.rafMs == null) return;
    this.frameMs = this.rafMs;
    if (this.frameMs > 21) { this.slowFrames++; this.fastFrames = 0; }
    else if (this.frameMs < 17.3) { this.fastFrames++; this.slowFrames = 0; }
    else { this.slowFrames = Math.max(0, this.slowFrames - 1); this.fastFrames = 0; }
    let pr = this.pr;
    if (this.slowFrames > 75 && pr > this.prMin) pr = Math.max(this.prMin, pr - 0.25);
    else if (this.fastFrames > 900 && pr < this.prMax) pr = Math.min(this.prMax, pr + 0.25);
    if (pr !== this.pr) {
      this.pr = pr; this.slowFrames = this.fastFrames = 0; this.frameMs = 17;
      this.gl.setPixelRatio(pr);
      this.composer.setPixelRatio(pr);
      this._lay = ''; // layout() re-applies the buffer sizes
    }
  }

  // lasers, telegraphs, aim lines, markers — all shader ribbons in fx3d
  beam(kind, x0, z0, x1, z1, width, alpha = 1, hot = false) {
    const o = this.beamOpts;
    o.kind = kind; o.width = width; o.alpha = alpha; o.hot = hot;
    this.fx.beam(x0, z0, x1, z1, o);
  }

  /* --------------------------------- frame --------------------------------- */

  render(world) {
    if (!this.ready) return;
    if (world !== this.world) { this.reset(); this.world = world; this.fresh = true; if (this.showShip) this.showShip.obj.visible = false; }
    this._rendered = true;
    this.stamp++;
    const t = world.time, images = world.app.images;
    const ox = W / 2, oz = H / 2;
    const now = performance.now();
    const real = now - (this._last || now);
    const k = Math.min(3, real / STEP) || 1;
    this._last = now;
    this.governor(real);
    // particles run on SIM time: they freeze on pause and crawl in slow-mo
    const dt = this._simT == null ? 0 : Math.max(0, Math.min(50, t - this._simT));
    this._simT = t;
    const fx = this.fx;

    this.layout();
    if (world.bossWarnStart) this.bossParts(world.level); // spend the klaxon building the boss
    // new sector (the sim swaps its backdrop at the peak of the hyperspace jump)
    if (world.bgOverride !== this._bg || world.level < (this._lvl || 0)) {
      this._bg = world.bgOverride;
      this._lvl = world.level;
      this.env.setSector(world.level, world.sectorTheme());
    }

    fx.update(dt, this.cam, this.cv.height);
    this.rocks.update(dt);
    for (const m of this.shieldMats.values()) m.uniforms.uTime.value = t / 500;
    this.hull.update(t);

    // --- players: hero hulls from ships3d.js (roster id recovered from the sprite) ---
    for (const p of world.players()) {
      if (!p.alive) continue;
      const o = this.obj(p, () => {
        let id = p.slot === 1 ? 'player2' : 'player1';
        for (const k2 in images.ships || {}) if (images.ships[k2] === p.img) id = k2;
        const g = this.ships.build(id);
        g.userData.release = (x) => x.userData.dispose?.();
        if (t > 500 && !this.quiet) fx.warpIn(p.x - ox, 0, p.y - oz, p.w * 1.6, { color: CYAN }); // respawn
        return g;
      });
      const ud = o.userData;
      const L = p.w * 1.34; // hull length in world units (the model is 1 long)
      const px = p.x - ox, pz = p.y - oz;
      o.scale.setScalar(L);
      o.position.set(px, Math.sin(t / 480 + (p.slot || 0) * 2) * 1.5, pz);
      // bank into the strafe, nose into the turn, and pitch with fore/aft thrust
      const pvx = (p.x - (ud.lx ?? p.x)) / Math.max(1, dt || 16.7);
      ud.lx = p.x;
      ud.pitch = (ud.pitch || 0) + (Math.max(-1, Math.min(1, pvx * 2.2)) * -0.14 - (ud.pitch || 0)) * 0.12;
      o.rotation.order = 'YXZ';
      o.rotation.set(p.tilt * 3.2, -p.tilt * 0.9, ud.pitch);
      const invuln = p.invulnUntil && t < p.invulnUntil;
      const warpBoost = (world.warpMul || 1) > 4;
      const thrust = p.boosting || warpBoost ? 2 : 1 + Math.max(0, pvx) * 1.2;
      ud.setThrust(thrust);
      ud.setBank(Math.max(-1, Math.min(1, p.tilt / 0.14)));
      const op = invuln ? 0.5 + 0.3 * Math.sin(t / 55) : 1;
      if (op !== ud._op) { ud._op = op; ud.setOpacity(op); }
      const dmg = p.maxLives ? Math.max(0, Math.min(1, 1 - p.lives / p.maxLives)) : 0;
      if (dmg !== ud._dmg) { ud._dmg = dmg; ud.setDamage(dmg); }
      ud.update(dt, t);
      for (const n of ud.nozzles || []) {
        fx.exhaust(px + (n.x - n.r) * L, n.y * L, pz + n.z * L, -1, 0, n.r * L * 0.95, this.exhOpt(thrust >= 2, 0.55));
      }
      if (p.shield) this.bubble(p, px, pz, 36, 0x50dcff, t);
      this.ripple(p, px, pz, 36, CYAN);
      if (world.overUntil && t < world.overUntil) fx.aura(px, 0, pz, 52, GOLD, 0.65); // OVERDRIVE
    }

    // --- enemies + boss ---
    for (const e of world.enemies) {
      if (e.dead) continue;
      if (e.isBoss) { this.boss(e, world, ox, oz, t); continue; }
      const ex = e.x - ox, ez = e.y - oz;
      const warping = e.warpUntil && t < e.warpUntil;
      const drone = e.type === 'basic' && e.w < 40; // carrier drones, brood fragments
      const o = this.obj(e, () => {
        const g = this.fleet.build(drone ? 'drone' : e.type, { elite: !!e.elite });
        g.userData.release = (x) => x.userData.dispose?.();
        g.userData.onDrop = (x) => { // destroyed on the field: plates and chips in its own colours
          if (!e.dead || e.x < 0 || e.x > W || e.y < -20 || e.y > H + 20) return;
          const n = drone ? 5 : e.type === 'tank' || e.type === 'carrier' ? 16 : 10;
          fx.shrapnel(x.position.x, 0, x.position.z, n, { color: e.elite ? GOLD : drone ? PAINT.drone : PAINT[e.type] || PAINT.basic, size: e.w * 0.1, speed: 240, trail: drone ? 0 : 2 });
        };
        if (warping && !this.quiet) fx.warpIn(ex, 0, ez, e.w * 1.3, { color: e.elite ? GOLD : g.userData.glow });
        return g;
      });
      const ud = o.userData;
      const L = e.w * (e.type === 'sniper' ? 1.5 : e.type === 'hunter' ? 1.3 : 1.2); // hull length (model is 1 long)
      o.scale.setScalar(L);
      this.setU(ud, 'setWarp', warping ? Math.min(1, (e.warpUntil - t) / 550) : 0); // printed in nose-first
      if (e.dying) {
        ud.sink = Math.min(46, (ud.sink || 0) + 0.5 * k);
        o.rotation.order = 'XYZ';
        o.rotation.set(((e.spinAngle || 0) * Math.PI) / 180, Math.PI, 0.3);
        this.setU(ud, 'setDim', 0.45);
        this.setU(ud, 'setDamage', 1);
        if (e.burning) fx.fireTrail(ex, -ud.sink, ez);
      } else {
        // fighters roll into their lateral motion (weavers carve S-turns) and
        // jolt back when struck
        const evz = (e.y - (ud.lz ?? e.y)) / Math.max(1, dt || 16.7);
        ud.lz = e.y;
        ud.roll = (ud.roll || 0) + (Math.max(-0.75, Math.min(0.75, evz * 3.2)) - (ud.roll || 0)) * 0.15;
        o.rotation.order = 'YXZ';
        o.rotation.set(-ud.roll, Math.PI + ud.roll * 0.35, 0);
        // weapons telegraph on the hull itself: rail charging, battery winding up, bays opening
        let charge = 0;
        if (e.type === 'sniper') charge = e.aim ? 1 - Math.max(0, e.aim.until - t) / 800 : 0;
        else if (e.type === 'strafer') charge = e.x <= e.holdX + 4 ? Math.min(1, (t - e.lastShot) / e.strafeDelay) : 0;
        else if (e.type === 'carrier') charge = 1 - Math.min(1, Math.max(0, e.nextDroneAt - t) / 1500);
        else if (e.type === 'tank' && e.rocketLauncher) charge = Math.min(1, Math.max(0, (t - e.lastRocketAt) / e.rocketDelay));
        this.setU(ud, 'setCharge', Math.round(charge * 25) / 25);
      }
      o.position.set(ex + (e.dying ? 0 : (e.flash || 0) * 4), -(ud.sink || 0) + (e.elite ? Math.sin(t / 300 + ex) * 2 : 0), ez);
      this.setU(ud, 'setFlash', (e.flash || 0) > 0.04 ? Math.round(e.flash * 10) / 20 : 0);
      this.setU(ud, 'setThrust', e.dying ? 0 : e.boosting ? 2 : 1);
      ud.update(dt, t);
      if (!e.dying && !warping) {
        for (const n of ud.nozzles || []) {
          fx.exhaust(ex - n.x * L, n.y * L, ez - n.z * L, 1, 0, n.r * L * 1.5, { color: 'enemy', boost: !!e.boosting });
        }
      }
      if (e.elite && !e.dying) fx.aura(ex, 0, ez, e.w * 0.85, GOLD, 0.55);
      if (e.shieldHp > 0) this.bubble(e, ex, ez, e.w * 0.62, 0x5ae6ff, t);
      this.ripple(e, ex, ez, e.w * 0.62, CYAN);
      if (e.aim) this.beam('aim', ex - e.w / 2, e.aim.y - oz, -ox, e.aim.y - oz, 2.5, 0.6 + 0.4 * Math.sin(t / 60));
    }

    // --- asteroids: detailed rocks that burst into fragments when they die ---
    const rocks = this.rocks;
    for (const a of world.asteroids) {
      if (a.dead) continue;
      const o = this.obj(a, () => {
        const variant = (a._v3 ??= (Math.random() * 1e6) | 0); // stable per rock; wraps per family; debris reuses its palette
        const r = rocks.create(variant, !!a.volcanic, a.w);
        r.userData.axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        r.userData.variant = variant;
        r.userData.hp = a.hp;
        r.userData.release = (x) => rocks.release(x);
        r.userData.onDrop = (x) => {
          // cracked (not merely drifted off the field) → shatter where it stood
          if (!a.dead || a.x < -a.w * 0.4 || a.x > W + a.w * 0.4 || a.y < -a.w * 0.4 || a.y > H + a.w * 0.4) return;
          rocks.shatter({
            x: x.position.x, y: 0, z: x.position.z, size: a.w, variant, volcanic: !!a.volcanic,
            quaternion: x.quaternion, vx: -a.vx / STEP, vz: a.vy / STEP, byImpact: { dirX: 1, dirZ: 0 },
          });
        };
        return r;
      });
      const ax = a.x - ox, az = a.y - oz;
      o.scale.setScalar(a.w * 1.2);
      o.position.set(ax, 0, az);
      o.quaternion.setFromAxisAngle(o.userData.axis, (a.angle * Math.PI) / 180);
      if (a.hp < o.userData.hp) { // a giant soaked a hit: chips fly off the struck face
        rocks.chip({ x: ax - a.w * 0.45, y: 0, z: az, size: a.w, dirX: 1, dirZ: 0, volcanic: !!a.volcanic, variant: o.userData.variant, object: o, nx: -1, ny: 0, nz: 0 }); // shots come from −X: the scar lands on that face
      }
      o.userData.hp = a.hp;
    }

    // --- rockets ---
    for (const list of [world.rockets, world.enemyRockets]) {
      for (const r of list) {
        if (r.dead) continue;
        const src = r.img.mesh ? r.img : images.rocket;
        const o = this.obj(r, () => this.model(src.mesh, { flame: r.enemyFire ? 'enemy' : 'player', kind: 'rocket', scale: src.fitScale * (r.w / src.width) * 1.7 }));
        const rad = (r.angle * Math.PI) / 180, cx = Math.cos(rad), cz = Math.sin(rad);
        const rx = r.x - ox, rz = r.y - oz;
        o.scale.setScalar(src.fitScale * (r.w / src.width) * 1.7);
        o.position.set(rx, 0, rz);
        o.rotation.order = 'YXZ';
        o.rotation.set(t / 110, -rad, 0); // spins around its own axis as it flies
        fx.rocketTrail(rx - cx * r.w * 0.8, 0, rz - cz * r.w * 0.8, -cx, -cz, r.enemyFire ? RK_ENEMY : RK_PLAYER);
      }
    }

    // --- mines ---
    for (const mn of world.mines) {
      if (mn.dead) continue;
      const o = this.obj(mn, () => {
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.85, roughness: 0.32, flatShading: true });
        g.add(new THREE.Mesh(this.mineGeo, mat));
        const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
        for (const h of this.hornDirs) {
          const horn = new THREE.Mesh(this.hornGeo, mat);
          horn.quaternion.setFromUnitVectors(up, d.set(h[0], h[1], h[2]).normalize());
          g.add(horn);
        }
        const led = new THREE.Sprite(this.spriteMat([6, 0.5, 0.3]));
        g.add(led);
        g.userData.led = led;
        g.userData.ownMats = [mat, led.material];
        return g;
      });
      o.scale.setScalar(11);
      o.position.set(mn.x - ox, 0, mn.y - oz);
      o.rotation.set(t / 1300, t / 900, 0);
      o.userData.led.scale.setScalar(2.2 + 1.6 * Math.max(0, Math.sin(t / 180 + mn.phase)));
    }

    // --- power-ups: a glassy energy crystal turning around the pod's glyph ---
    for (const pu of world.powerups) {
      if (pu.dead) continue;
      const o = this.obj(pu, () => {
        const g = new THREE.Group();
        const col = PU_COLOR[pu.type] || 'rgb(120,255,180)';
        const shell = new THREE.Mesh(this.gemGeo, new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 0.9, metalness: 0.1, roughness: 0.12,
          transparent: true, opacity: 0.42, depthWrite: false, flatShading: true,
        }));
        const cage = new THREE.LineSegments(this.gemEdges, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
        cage.material.color.multiplyScalar(2.4);
        const glow = new THREE.Sprite(this.spriteMat(col, 0.3));
        glow.scale.set(70, 70, 1);
        const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texFor(pu.img), transparent: true, depthWrite: false, depthTest: false }));
        icon.scale.set(pu.w * 0.9, pu.h * 0.9, 1);
        icon.renderOrder = 30;
        g.add(glow, shell, cage, icon);
        g.userData.spin = [shell, cage];
        g.userData.onDrop = (x) => { // grabbed (not drifted off the left edge)
          if (pu.dead && pu.x > 0) fx.pickup(x.position.x, 6, x.position.z, col);
        };
        g.userData.ownMats = [shell.material, cage.material, glow.material, icon.material];
        return g;
      });
      o.position.set(pu.x - ox, 6 + Math.sin(t / 300 + pu.phase) * 4, pu.y - oz);
      for (const m of o.userData.spin) { m.rotation.y = t / 700 + pu.phase; m.rotation.x = 0.35; m.scale.setScalar(22 * (1 + 0.05 * Math.sin(t / 200 + pu.phase))); }
    }

    // --- bullets ---
    const chase = this.mode === 'chase';
    this.bolts(world.bullets, ox, oz, false, 1);
    this.bolts(world.enemyBullets, ox, oz, true, 1.3); // slim, but never hard to spot

    const seenAmb = this.seen;
    // --- freighters (ambient, but shootable: convoy raids + the golden hauler) ---
    for (const a of world.ambient || []) {
      if (!(a instanceof Freighter) || a.dead || !a.img.mesh) continue;
      const o = this.obj(a, () => this.model(a.img.mesh.hi3d ? a.img.mesh.hi3d() : a.img.mesh, { own: true, kind: 'freighter', scale: a.img.fitScale })); // one-off hull: disposed with it
      o.scale.setScalar(a.img.fitScale);
      const fxx = a.x + a.img.width / 2 - ox, fz = a.y + a.img.height / 2 - oz;
      // only the golden hauler and convoy-raid targets are in the fight; ordinary
      // traffic passes well below the lane so it never reads as an obstacle
      const target = a.golden || !!world.mod?.convoy;
      o.position.set(fxx, target ? -6 : -190, fz);
      o.rotation.set(0, Math.PI, 0);
      if (a.golden) fx.aura(fxx, 0, fz, a.img.width * 0.45, GOLD, 0.6);
      else this.hullSet(o, 'setDim', target ? 0.8 : 0.42);
    }

    // the sim's own background flourishes play out in the 3D sky
    for (const a of world.ambient || []) {
      if (seenAmb.has(a)) continue;
      seenAmb.add(a);
      const name = a instanceof Comet ? (a.target ? 'cometImpact' : 'comet') : a instanceof DistantConvoy ? 'convoy'
        : a instanceof Skirmish ? 'skirmish' : a instanceof SpaceBattle ? 'battle' : a instanceof DistantRocks ? 'rocks' : null;
      if (name) this.env.event?.(name);
    }

    if (world.app.debugEnvEvent && !this._dbgEv && t > 1000) { this._dbgEv = true; this.env.event?.(world.app.debugEnvEvent, { force: true }); }

    if (chase) this.chaseAids(world, ox, oz);

    // --- sim effects → particles. One-shot effects fire once, the first frame
    // they are seen; the sim keeps simulating its own 2D copies regardless ---
    const seen = this.seen;
    for (const e of world.effects) {
      if (e.dead) continue;
      if (e instanceof MeshDebris) {
        const age = t - e.spawn, p = age / e.life;
        const o = this.obj(e, () => {
          const d = this.model(e.sub, { own: true, kind: 'debris', scale: e.scale });
          d.userData.vy = (Math.random() - 0.5) * 0.16; // tumble out of the plane too
          d.userData.srz = (Math.random() - 0.5) * 0.14;
          return d;
        });
        const dy = o.userData.vy * age;
        o.scale.setScalar(e.scale * (p < 0.7 ? 1 : Math.max(0.05, 1 - (p - 0.7) / 0.3)));
        o.position.set(e.x - ox, dy, e.y - oz);
        o.rotation.set(e.srx * age / 16, e.ry0 + e.sry * age / 16, o.userData.srz * age / 16);
        this.hullSet(o, 'setHeat', Math.round(Math.max(0, 1 - p * 2.4) * 20) / 20); // glowing-hot, cooling off
        if (e.burning) fx.fireTrail(e.x - ox, dy, e.y - oz);
        continue;
      }
      if (e instanceof LaserBeam) {
        const p = Math.min(1, (t - e.spawn) / e.life);
        // the beam really ends at the field edge, but drawing it to there made it look
        // chopped off in the angled views — let it run on into the distance
        const x1 = e.dir > 0 ? W + 2600 : -2600, z = e.y - oz;
        this.beam('laser', e.x0 - ox, z, x1 - ox, z, 16 * (1 - p * 0.5), 1 - p * p);
        if (!seen.has(e)) { seen.add(e); fx.muzzle(e.x0 - ox, 0, z, e.dir, 0, { color: [1.5, 3.5, 6], scale: 2.6 }); }
        continue;
      }
      if (seen.has(e)) continue;
      seen.add(e);
      const x = e.x - ox, z = e.y - oz;
      if (e instanceof Explosion) fx.explosion(x, 0, z, e.scale);
      else if (e instanceof Shockwave) {
        this.col.set(e.color);
        fx.shockwave(x, -2, z, e.maxR, { color: [this.col.r * 0.55, this.col.g * 0.55, this.col.b * 0.55], life: e.life });
      } else if (e instanceof Spark) fx.sparks(x, 0, z, 2, e.vx, e.vy, { speed: Math.hypot(e.vx, e.vy) * 60, spread: 0.5 });
      else if (e instanceof SmokeParticle) fx.smokePuff(x, 0, z, e.size * 5, { dark: 0.7 });
      else if (e instanceof RockDust) { if (e.soft) fx.dust(x, 0, z, e.size * 4, { count: 2 }); }
      else if (e instanceof MuzzleFlash) fx.muzzle(x, 0, z, 1, 0, { color: 'player' });
    }

    // --- gravity well ---
    if (world.singularity) {
      const s = world.singularity;
      const o = this.obj(s, () => {
        const g = new THREE.Group();
        const core = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        const glow = new THREE.Sprite(this.spriteMat([1.1, 0.45, 2.2], 0.6));
        glow.scale.setScalar(5.5);
        g.add(glow, core);
        g.userData.ownMats = [core.material, glow.material];
        g.userData.ownGeo = { lit: core.geometry };
        return g;
      });
      o.position.set(s.x - ox, 0, s.y - oz);
      o.scale.setScalar(Math.max(1, s.coreR));
    }

    this.sweep();

    // environment: gets the frame's light list so the mist glows around fire and gunfire
    const es = this.envState, ion = world.ionStorm, ec = world.eclipse;
    es.time = t; es.W = W; es.H = H; es.mode = this.mode; es.viewH = this.cv.height;
    es.speedMul = world.speedMul || 1; es.warpMul = world.warpMul || 1;
    es.paused = !!(world.paused || world.over);
    es.intense = world.bossSpawned || !!world.bossWarnStart; // background keeps quiet during boss fights
    es.ion = ion ? (ion.phase === 'active' ? 1 : 0.25) : 0;
    if (ec) { const q = (t - ec.start) / ec.dur; es.eclipse = q < 0.2 ? q / 0.2 : q > 0.7 ? Math.max(0, (1 - q) / 0.3) : 1; } else es.eclipse = 0;
    fx.commit(); // rank this frame's lights → real PointLights + the list the fog glows from
    es.lights = fx.lightData; es.lightCount = fx.lightCount;
    es.playerX = world.player1.x - ox; es.playerZ = world.player1.y - oz;
    this.env.update(dt, this.cam, es);
    this.sun.position.copy(this.env.sunDirection);
    this.sun.color.copy(this.env.sunColor);
    this.hemi.color.copy(this.env.ambientColor);

    this.camera(world, k);
    this.quiet = false;
    this.grade.uniforms.uPunch.value = settings.motionFx ? Math.min(1, (world.impactFx || 0) + (world.dmgFlash || 0) * 0.6) : 0;
    this.grade.uniforms.uTime.value = (t % 1000) / 1000;
    this.composer.render();
  }

  // Depth aids for the behind-the-ship view, where distance along the lane is
  // hard to judge: a faint gun line ahead of each ship, and "impact markers" —
  // bars on the ship's own lateral line showing where every incoming bullet,
  // rock and fighter will cross it (hot when it is on a collision course).
  chaseAids(world, ox, oz) {
    const HORIZON = 100; // logic steps (~1.7s) of look-ahead
    for (const p of world.players()) {
      if (!p.alive) continue;
      const px = p.x - ox, pz = p.y - oz;
      this.beam('guide', px + p.w / 2, pz, W - ox, pz, 1.6, 1);
      const mark = (x, y, vx, vy, size) => {
        if (vx > -0.4 || x <= p.x) return;
        const steps = (x - p.x) / -vx;
        if (steps > HORIZON) return;
        const zc = y + vy * steps;
        const miss = Math.abs(zc - p.y) - (size + p.h * 0.8) / 2;
        if (miss > 90) return;
        const near = 1 - steps / HORIZON;
        const hot = miss < 4;
        this.beam('marker', px - 6, zc - oz - size / 2, px - 6, zc - oz + size / 2, hot ? 7 : 4, hot ? 0.35 + 0.65 * near : 0.15 + 0.4 * near, hot);
      };
      const sm = world.speedMul || 1;
      for (const b of world.enemyBullets) if (!b.dead) mark(b.x, b.y, b.vx * sm, b.vy * sm, 10);
      for (const a of world.asteroids) if (!a.dead) mark(a.x, a.y, -a.vx * sm, a.vy * sm, a.w * 0.75);
      for (const e of world.enemies) {
        if (e.dead || e.isBoss || e.dying || !(e.vx < 0)) continue;
        if ((e.type === 'sniper' || e.type === 'strafer') && e.x <= e.holdX) continue; // parked
        mark(e.x, e.y, e.vx * sm * (e.boosting ? 1.9 : 1), 0, e.h);
      }
    }
  }

  // sim point → 2D-canvas coordinates (for HUD bits pinned to world positions)
  toScreen(x, y) {
    const v = this._v || (this._v = new THREE.Vector3());
    v.set(x - W / 2, 0, y - H / 2).project(this.cam);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H };
  }

  // every bullet is a shader bolt in fx3d (hot core, halo, wake, its own light)
  bolts(list, ox, oz, enemy, scale) {
    const fx = this.fx, K = this.boltKinds;
    for (const b of list) {
      if (b.dead) continue;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const o = enemy ? (sp > 14 ? K.enemyHeavy : K.enemy) : b.tier === 3 ? K.playerPlasma : b.tier === 2 ? K.playerHot : K.player;
      o.scale = scale;
      fx.bolt(b.x - ox, 0, b.y - oz, b.vx / sp, b.vy / sp, o);
    }
  }

  // energy shield shell; keyed off a per-entity token so it shares the sweep
  bubble(ent, x, z, r, color, t) {
    const key = ent._sh3 || (ent._sh3 = {});
    const o = this.obj(key, () => new THREE.Mesh(this.ballGeo, this.shieldMat(color)));
    o.position.set(x, 0, z);
    o.scale.setScalar(r * (1 + 0.04 * Math.sin(t / 140)));
    o.rotation.y = t / 1400;
  }

  // a fresh shield impact (the sim stamps ent.shieldRipple) → sparks + ripple, once
  ripple(ent, x, z, r, color) {
    const sr = ent.shieldRipple;
    if (!sr || sr === ent._sr3) return;
    ent._sr3 = sr;
    this.fx.shieldHit(x, 0, z, Math.cos(sr.a), Math.sin(sr.a), r, color);
  }

  // hi-detail dreadnought geometry for a level: same seed → same boss as the sim's
  bossParts(level) {
    if (this._bossPre?.level === level) return this._bossPre;
    const gen = withDetail(HI, () => genBoss(level));
    return (this._bossPre = { level, gen, core: this.buildGeo(gen.core), turrets: gen.turrets.map((tr) => this.buildGeo(tr.mesh)) });
  }

  boss(b, world, ox, oz, t) {
    const bx = b.x - ox, bz = b.y - oz, fx = this.fx;
    const o = this.obj(b, () => {
      if (!this.quiet && t - b.spawnTime < 1500) fx.warpIn(bx - b.w * 0.3, 0, bz, b.w * 1.6, { color: [1, 0.35, 0.25] }); // it tears its way in
      // same seed → same dreadnought, re-tessellated smooth for the 3D view
      const pre = this.bossParts(b.level); // usually built during the WARNING, so no hitch on arrival
      this._bossPre = null;
      const gen = pre.gen;
      const g = new THREE.Group();
      const bs = b.fit.scale * 1.08;
      const core = this.model(gen.core, { own: true, flame: 'enemy', kind: 'boss', scale: bs, seed: b.level, geo: pre.core });
      g.add(core);
      g.userData.core = core;
      g.userData.turrets = gen.turrets.map((tr, i) => {
        const tm = this.model(tr.mesh, { own: true, kind: 'boss', scale: bs, seed: b.level * 10 + i + 1, geo: pre.turrets[i] });
        tm.visible = !tr.dead; // (a re-created boss must not re-blow modules it already lost)
        tm.position.set(tr.pivot[0], tr.pivot[1], tr.pivot[2]);
        g.add(tm);
        return tm;
      });
      g.userData.parts = [core, ...g.userData.turrets];
      g.userData.release = (x) => {
        for (const part of x.userData.parts) {
          part.userData.mat.dispose();
          part.userData.glow?.dispose();
          part.userData.ownGeo?.lit?.dispose();
          part.userData.ownGeo?.unlit?.dispose();
        }
      };
      return g;
    });
    const ud = o.userData;
    if (b.phase2 && !ud.phase2) { // hull blown away → swap in the core
      ud.phase2 = true;
      o.remove(ud.core);
      for (const tm of ud.turrets) tm.visible = false;
      ud.core = this.model(withDetail(HI, () => genBossCore(b.level)), { own: true, kind: 'boss', scale: b.fit.scale, seed: b.level + 100 });
      ud.parts.push(ud.core);
      o.add(ud.core);
    }
    const pulse = b.phase2 ? 1 + 0.045 * Math.sin(t / 160) : 1;
    const S = b.fit.scale * pulse * 1.08;
    o.scale.setScalar(S);
    const dying = !!b.deathSeq;
    const shudder = dying ? (Math.random() - 0.5) * 5 : 0;
    const sinkY = dying ? -(t - b.deathSeq.start) * 0.012 : 0;
    o.position.set(bx + shudder, sinkY, bz + shudder);
    // the dreadnought leans into its drift, shudders under fire, lists as it dies
    const bvz = (b.y - (ud.lz ?? b.y)) / 16.7;
    ud.lz = b.y;
    ud.roll = (ud.roll || 0) + (Math.max(-0.3, Math.min(0.3, bvz * 1.6)) - (ud.roll || 0)) * 0.06;
    o.rotation.order = 'YXZ';
    o.rotation.set(
      dying ? (t - b.deathSeq.start) * 0.00022 : -ud.roll + (b.ram?.phase === 'windup' ? Math.sin(t / 22) * 0.03 : 0),
      Math.PI + (b.phase2 ? t / 900 : 0),
      dying ? (t - b.deathSeq.start) * 0.00009 : (b.flash || 0) * 0.025 + (b.ram?.phase === 'charge' ? -0.1 : 0));
    const flash = Math.max(0, b.flash || 0) > 0.04 ? Math.round(b.flash * 16) / 20 : 0;
    this.hullSet(ud.core, 'setFlash', flash);
    this.hullSet(ud.core, 'setDamage', Math.round(Math.max(0, 1 - b.health / b.maxHealth) * 20) / 20);
    if (!b.phase2) {
      b.gen.turrets.forEach((tr, i) => {
        const tm = ud.turrets[i];
        if (!tm) return;
        if (tm.visible && tr.dead) { // module blown off: fireball + shrapnel at its mount
          const wx = bx - tr.pivot[0] * S, wz = bz - tr.pivot[2] * S;
          fx.explosion(wx, tr.pivot[1] * S, wz, 0.9);
          fx.shrapnel(wx, tr.pivot[1] * S, wz, 10, { speed: 260 });
        }
        tm.visible = !tr.dead;
        // tr.yaw is tuned for the tilted 2D sprite view — recover the true
        // in-plane heading and express it in the hull's (flipped) frame
        const yaw = Math.atan2(Math.sin(tr.yaw) * Math.sin(VIEW.rx), Math.cos(tr.yaw));
        tm.rotation.y = yaw - Math.PI;
        this.hullSet(tm, 'setFlash', flash);
      });
      if (!dying) {
        for (const n of ud.core.userData.nozzles || []) {
          fx.exhaust(bx - n.x * S, n.y * S, bz - n.z * S, 1, 0, n.r * S * 2.2, { color: 'enemy', boost: !!b.ram });
        }
      } else {
        if (Math.random() < 0.5) fx.fireTrail(bx + (Math.random() - 0.5) * b.w * 0.6, sinkY, bz + (Math.random() - 0.5) * b.h * 0.5);
        fx.arcs?.(bx, sinkY, bz, b.w * 0.42, { rate: 16 }); // the reactor is going
      }
    }
    if (b.shieldUntil > t) this.bubble(b, bx, bz, b.w / 2 + 16, 0x5adcff, t);
    this.ripple(b, bx, bz, b.w / 2 + 16, CYAN);

    // beams
    if (b.laser) {
      const z = b.laser.y - oz, x0 = bx - b.w / 2 + 10;
      if (b.laser.phase === 'telegraph') this.beam('telegraph', x0, z, -ox, z, 4, 1);
      else this.beam('boss', x0, z, -ox, z, 30, 1);
    }
    if (b.laser2) {
      const L = b.laser2, far = W + H;
      const x1 = bx - Math.cos(L.ang) * far, z1 = bz + Math.sin(L.ang) * far;
      if (L.phase === 'telegraph') this.beam('telegraph', bx, bz, x1, z1, 4, 1);
      else this.beam('boss', bx, bz, x1, z1, 27, 1);
    }
    if (b.phase2 && b.coreBeams) {
      const live = t >= b.coreBeams.activeAt, far = W + H;
      for (const a of [b.coreBeams.ang, b.coreBeams.ang + Math.PI / 2]) {
        const cx = Math.cos(a) * far, cz = Math.sin(a) * far;
        for (const sgn of [1, -1]) this.beam(live ? 'boss' : 'telegraph', bx, bz, bx + cx * sgn, bz + cz * sgn, live ? 19 : 4, 1);
      }
    }
  }

  /* --------------------------------- camera -------------------------------- */

  // Distance for the 45° tilt camera at which all four field corners (and so
  // every ship and bullet) stay inside the frame — recomputed when the field resizes.
  tiltDist(hTop) {
    const key = `${W}x${H}`;
    if (this._tiltKey === key) return this._tiltD;
    const c = this._fitCam || (this._fitCam = new THREE.PerspectiveCamera(FOV, 1, 5, 30000));
    const v = new THREE.Vector3(), tz = H * 0.04;
    c.fov = FOV; c.aspect = W / H; c.updateProjectionMatrix();
    let d = hTop * 0.85;
    for (let i = 0; i < 60; i++, d *= 1.03) {
      c.position.set(0, d * 0.7071, tz + d * 0.7071);
      c.up.set(0, 1, 0);
      c.lookAt(0, 0, tz);
      c.updateMatrixWorld();
      let ok = true;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        v.set((sx * W) / 2, 0, (sz * H) / 2).project(c);
        if (Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.93) ok = false;
      }
      if (ok) break;
    }
    this._tiltKey = key;
    return (this._tiltD = d);
  }

  // Camera rig. A base pose per mode, then cinematic modifiers layered on top
  // (run intro, boss arrival, boss death, the final death, hyperspace), eased
  // together, and finally a trauma-driven rotational shake. With MOTION off in
  // settings it stays a calm, fixed framing.
  camera(world, k) {
    const p = world.player1, t = world.time;
    const px = p.x - W / 2, pz = p.y - H / 2;
    const hTop = (H / 2) / Math.tan((FOV * Math.PI) / 360);
    const motion = settings.motionFx && !this.snapCam;
    const mode = this.mode;
    if (this.fresh) { // (re)entering 3D: start from the classic top-down framing
      this.fresh = false;
      this.camPos.set(0, hTop, 0.01);
      this.camTgt.set(0, 0, 0);
      this.camUp.set(0, 0, -1);
      this.trauma = 0;
    }
    let pos, tgt, roll = 0, fov = FOV, upY = 1, upZ = 0;
    const boss = world.enemies.find((b) => b.isBoss && !b.dead);
    if (mode === 'chase') {
      // long lens from well behind and above: the far end of the lane (where
      // enemies and the boss live) stays big, and the lane reads as a floor
      const follow = W / H < 1 ? 1 : 0.84; // narrow screens can't show the whole width
      const back = 540 + (boss ? 90 : 0), up = 330 + (boss ? 50 : 0);
      pos = [px - back, up, pz * follow];
      tgt = [px + 470, 0, pz * follow * 0.92];
      roll = -(p.tilt || 0) * 0.55; // lean with the ship
      fov = CHASE_FOV + (p.boosting ? 5 : 0);
    } else if (mode === 'tilt') {
      const d = this.tiltDist(hTop);
      pos = [0, d * 0.7071, H * 0.04 + d * 0.7071];
      tgt = [0, 0, H * 0.04];
    } else { // top: the classic framing — the whole field, straight down
      pos = [0, hTop, 0.01];
      tgt = [0, 0, 0];
      upY = 0; upZ = -1;
    }

    let ease = 0.93; // per-step retention; cinematic beats move slower
    if (motion) {
      const allDead = world.players().every((pp) => !pp.alive);
      if (mode !== 'chase') {
        // the field drifts a touch against the deep backdrop as the ship moves
        const f = mode === 'top' ? 0.035 : 0.05;
        pos[0] += px * f; tgt[0] += px * f; pos[2] += pz * f; tgt[2] += pz * f;
        if (mode === 'tilt') { const sway = Math.sin(t / 5200) * W * 0.012; pos[0] += sway; }
      }
      // run intro: start tucked in behind the ship, pull out to the chosen view
      if (t < 2600 && !world.over) {
        const q = t / 2600, e2 = q * q * (3 - 2 * q), m = 1 - e2;
        if (mode === 'chase') { // tucked in behind the ship, pulling out
          const ip = [px - 190, 70, pz + 150], it = [px + 60, 0, pz];
          for (let i = 0; i < 3; i++) { pos[i] += (ip[i] - pos[i]) * m; tgt[i] += (it[i] - tgt[i]) * m; }
          fov += 10 * m;
        } else { // same framing (so the controls already make sense), easing back from a close-up on the ship
          const z = 0.45 * m;
          for (let i = 0; i < 3; i++) pos[i] += (tgt[i] - pos[i]) * z;
          pos[0] += (px - tgt[0]) * z; tgt[0] += (px - tgt[0]) * z;
          pos[2] += (pz - tgt[2]) * z; tgt[2] += (pz - tgt[2]) * z;
        }
        ease = 0.6;
      }
      if (world.bossWarnStart) { // something big is coming: look up the lane
        if (mode === 'chase') { tgt[0] += 320; pos[1] -= 70; pos[0] += 60; fov -= 4; }
        else { pos[0] += W * 0.07; tgt[0] += W * 0.07; pos[1] *= 0.94; pos[2] *= 0.94; }
        ease = 0.965;
      }
      if (boss?.deathSeq) { // the kill: push in on the dying hull and drift around it
        const bx = boss.x - W / 2, bz = boss.y - H / 2, q = Math.min(1, (t - boss.deathSeq.start) / 1700);
        if (mode === 'chase') {
          tgt[0] += (bx - tgt[0]) * 0.75; tgt[2] += (bz - tgt[2]) * 0.75;
          pos[0] += 190 * q; pos[1] -= 90 * q; pos[2] += Math.sin(q * 2.2) * 150;
          fov -= 5 * q;
        } else {
          const z = 0.16 * q;
          pos[0] += (bx - pos[0]) * z * 1.6; tgt[0] += (bx - tgt[0]) * z * 1.6;
          pos[2] += (bz - tgt[2]) * z; tgt[2] += (bz - tgt[2]) * z * 1.6;
          pos[1] *= 1 - z;
        }
        ease = 0.95;
      }
      if (world.slowmo && allDead) { // the final death: slow orbit of the wreck
        const a = t / 1500;
        if (mode === 'top') {
          pos = [px, hTop * 0.72, pz + 0.01]; tgt = [px, 0, pz];
        } else {
          pos = [px - Math.cos(a) * 250, 130, pz + Math.sin(a) * 250]; tgt = [px, 0, pz];
          upY = 1; upZ = 0; roll = 0.12; fov = 44;
        }
        ease = 0.95;
      }
      const warp = Math.min(1, ((world.warpMul || 1) - 1) / 27);
      if (warp > 0) { // hyperspace: the frame leans and breathes with the jump
        roll += Math.sin(t / 420) * 0.07 * warp;
        if (mode === 'chase') { pos[0] -= 110 * warp; pos[1] -= 60 * warp; }
      }
      // trauma: fed by the sim's shake, decays on its own; squared for punch
      this.trauma = Math.min(1, Math.max((this.trauma || 0) - 0.02 * k, (world.shake || 0) / 12));
    } else {
      this.trauma = 0;
    }

    const e = this.snapCam ? 1 : 1 - Math.pow(ease, k); // snapCam: debug (?view=) — no easing, for screenshots
    this.camPos.x += (pos[0] - this.camPos.x) * e;
    this.camPos.y += (pos[1] - this.camPos.y) * e;
    this.camPos.z += (pos[2] - this.camPos.z) * e;
    this.camTgt.x += (tgt[0] - this.camTgt.x) * e;
    this.camTgt.y += (tgt[1] - this.camTgt.y) * e;
    this.camTgt.z += (tgt[2] - this.camTgt.z) * e;
    this.camUp.x += (0 - this.camUp.x) * e;
    this.camUp.y += (upY - this.camUp.y) * e;
    this.camUp.z += (upZ + Math.sin(roll) - this.camUp.z) * e;
    this.camFov = (this.camFov ?? FOV) + (fov - (this.camFov ?? FOV)) * e;

    this.cam.position.copy(this.camPos);
    this.cam.up.copy(this.camUp).normalize();
    this.cam.lookAt(this.camTgt);
    const live = !(world.paused || world.over);
    const tr = live ? this.trauma * this.trauma : 0;
    if (tr > 0.0005) { // smooth pseudo-noise, mostly rotational: reads as impact, not jitter
      const n = performance.now() / 1000;
      const amp = (mode === 'top' ? 0.011 : 0.02) * tr;
      this.cam.rotateX(amp * (Math.sin(n * 47.1) + Math.sin(n * 81.7 + 1.3)) * 0.5);
      this.cam.rotateY(amp * (Math.sin(n * 53.9 + 2.1) + Math.sin(n * 71.3)) * 0.5);
      this.cam.rotateZ(amp * 1.4 * (Math.sin(n * 39.7 + 0.7) + Math.sin(n * 91.1 + 4.2)) * 0.5);
      this.cam.position.y += tr * 5 * Math.sin(n * 63.3);
    }
    const warpF = Math.min(1, ((world.warpMul || 1) - 1) / 27);
    this.cam.fov = this.camFov + warpF * 16 + (motion ? (world.killFlash || 0) * -3 : 0);
    this.cam.aspect = W / H;
    this.cam.updateProjectionMatrix();
  }

  // keep the GL canvas glued under the 2D canvas (which keeps drawing the HUD)
  layout() {
    const game = this.app.canvas;
    const r = game.getBoundingClientRect();
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (key !== this._lay) {
      this._lay = key;
      const s = this.cv.style;
      s.left = `${r.left}px`; s.top = `${r.top}px`;
      s.width = `${r.width}px`; s.height = `${r.height}px`;
      this.gl.setSize(r.width, r.height, false);
      this.composer.setSize(r.width, r.height);
    }
    if (this.cv.style.display !== 'block') {
      this.cv.style.display = 'block';
      game.style.background = 'transparent';
    }
  }

  // called by the main loop after every state draw: hide the GL layer on any
  // frame the 3D view wasn't rendered (2D mode, menus, other states)
  endFrame() {
    if (!this.ready) return;
    if (!this._rendered && this.cv.style.display !== 'none') {
      this.cv.style.display = 'none';
      this.app.canvas.style.background = '#000';
    }
    this._rendered = false;
  }
}
