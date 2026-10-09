// Boot: canvas scaling (HiDPI), adaptive world size, asset loading, state machine, main loop
import { W, H, BASE_W, BASE_H, MAX_W, MAX_H, setSize, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { loadImages, IMG_COUNT } from './assets.js';
import { generateSprites } from './procassets.js';
import { makeVignette } from './fx.js';
import { drawText } from './ui.js';
import * as ui from './ui.js';
import { MenuState } from './menu.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';
import { View3D } from './view3d.js';

const canvas = document.getElementById('game');
const g = canvas.getContext('2d');
let scale = 1;
let vignette = null;

// Camera zoom: a smaller world with the same-size sprites reads as a pulled-in
// camera (bigger ships/pickups, a touch less playfield shown). Online modes keep
// the untouched fixed field so both peers stay identical.
const ZOOM = 1.12;

function fit() {
  // Adapt the world to the screen aspect: widescreen extends the playfield
  // horizontally, tall phones extend it vertically — no black bars.
  // (a tab opened in the background can report a 0×0 window: sizing from that gave
  // NaN world dimensions and killed the boot — fall back to the base size until the real resize)
  const vw = window.innerWidth || BASE_W, vh = window.innerHeight || BASE_H;
  const aspect = vw / vh;
  let w, h;
  if (app.lockWorld) {
    // online modes: identical fixed field for both peers, letterboxed
    w = BASE_W; h = BASE_H;
  } else {
    const bw = BASE_W / ZOOM, bh = BASE_H / ZOOM;
    if (aspect >= BASE_W / BASE_H) {
      h = bh;
      w = clamp(Math.round(bh * aspect), bw, MAX_W);
    } else {
      w = bw;
      h = clamp(Math.round(bw / aspect), bh, MAX_H);
    }
  }
  setSize(w, h);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const view = Math.min(vw / W, vh / H);
  canvas.style.width = `${Math.round(W * view)}px`;
  canvas.style.height = `${Math.round(H * view)}px`;
  canvas.width = Math.round(W * view * dpr);
  canvas.height = Math.round(H * view * dpr);
  scale = view * dpr;
  g.imageSmoothingEnabled = true;
  // 'high' resampling is costly on mobile GPUs at HiDPI; 'low' is imperceptible
  // for these sprites and noticeably cheaper per frame.
  g.imageSmoothingQuality = input.isTouch ? 'low' : 'high';
  vignette = makeVignette();
  if (app.state?.onResize) app.state.onResize();
}
addEventListener('resize', fit);
document.addEventListener('fullscreenchange', fit);
// auto-pause offline runs when the window/tab loses focus (no dead ships on alt-tab)
addEventListener('blur', () => app.state?.autoPause?.());
document.addEventListener('visibilitychange', () => { if (document.hidden) app.state?.autoPause?.(); });
input.init(canvas);
audio.installAutoUnlock();
// offline play + instant repeat loads
addEventListener('load', () => {
  navigator.serviceWorker?.register('sw.js').catch(() => {});
});

const app = {
  canvas,
  images: null,
  state: null,
  highScore: 0,
  lockWorld: false,
  setState(s) {
    this.state = s;
    if (s.enter) s.enter();
  },
  setLockWorld(on) {
    if (this.lockWorld === on) return;
    this.lockWorld = on;
    fit();
  },
  goMenu() {
    this.setLockWorld(false);
    this.setState(new MenuState(this));
  },
  saveHigh(score) {
    if (score > this.highScore) {
      this.highScore = score;
      try { localStorage.setItem('spacevoid_high', String(score)); } catch {}
    }
  },
};
app.view3d = new View3D(app); // WebGL renderer for offline runs (V camera, G classic); loads lazily
try { app.highScore = Number(localStorage.getItem('spacevoid_high')) || 0; } catch {}

fit(); // initial world + canvas sizing (after app exists for onResize dispatch)

/* ------------------------------ start screen ------------------------------- */

class StartState {
  update() {
    this.t = (this.t || 0) + 1;
    if (input.anyPress()) {
      audio.unlock();
      app.goMenu();
    }
  }
  draw(g) {
    drawLockup(g);
    const pulse = 0.5 + 0.5 * Math.sin((this.t || 0) / 20);
    ui.text(g, input.isTouch ? 'TAP TO START' : 'CLICK OR PRESS ANY KEY', W / 2, H / 2 + 64, {
      size: 13, weight: 600, track: 0.36, align: 'center', color: ui.rgba(ui.C.hi), alpha: 0.4 + 0.6 * pulse, maxW: W - 40,
    });
  }
}

/* --------------------------------- loading --------------------------------- */

// splash / loading backdrop + the SPACE (heavy) VOID (light) lockup, as in the menu
function drawLockup(g) {
  const { C, rgba } = ui;
  ui.begin(g);
  ui.spaceBackdrop(g);
  const size = Math.min(60, (W - 48) / 9.6);
  const o1 = { size, weight: 700, track: 0.2 }, o2 = { size, weight: 200, track: 0.2 };
  const w1 = ui.measure(g, 'SPACE', o1), w2 = ui.measure(g, 'VOID', o2), gap = size * 0.52;
  const tw = w1 + gap + w2, x = W / 2 - tw / 2, y = H / 2 - 40;
  ui.text(g, 'SPACE', x, y, o1);
  ui.text(g, 'VOID', x + w1 + gap, y, { ...o2, color: rgba(C.cyan) });
  const ry = Math.round(y + size * 0.74);
  g.fillStyle = rgba(C.mid, 0.22); g.fillRect(x, ry, tw, ui.hair());
  g.fillStyle = rgba(C.cyan); g.fillRect(W / 2 - 18, ry - 1, 36, 2);
  return { x, w: tw, y: ry };
}

let progress = 0;
function drawLoading() {
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const l = drawLockup(g);
  const bw = Math.min(300, l.w);
  ui.hudBar(g, W / 2 - bw / 2, l.y + 42, bw, 4, progress, { color: ui.C.cyan, segs: 24, back: 0.16 });
  ui.text(g, 'LOADING', W / 2, l.y + 66, { size: 10, weight: 700, track: 0.4, align: 'center', color: ui.rgba(ui.C.low) });
}

async function boot() {
  let imgDone = 0, sndDone = 0;
  const IMG_TOTAL = IMG_COUNT, SND_TOTAL = 8;
  const tick = () => {
    progress = (imgDone + sndDone) / (IMG_TOTAL + SND_TOTAL);
    drawLoading();
  };
  drawLoading();

  const [images] = await Promise.all([
    loadImages((d) => { imgDone = d; tick(); }),
    audio.loadSounds((d) => { sndDone = d; tick(); }),
  ]);
  app.images = generateSprites(images); // procedural sprites replace the old PNG set
  { const baked = import('./bake3d.js').then((m) => m.bakeSprites(app)).catch(() => {}); if (/[?&]bakefirst\b/.test(location.search)) await baked; } // classic sprites re-baked from the WebGL hero models, behind the menu (debug ?bakefirst waits for it)

  const params = new URLSearchParams(location.search);
  app.debugGod = params.has('god'); // debug: invincible player for testing
  app.debugBoss = Number(params.get('boss')) || 0; // debug: instant boss of level N
  app.debugNoBg = params.has('nobg'); // debug: keep the old static-canvas backdrop off
  app.debugBg = Number(params.get('bg')) || 0; // debug: force a backdrop seed (?bg=N)
  app.debugIon = params.has('ion'); // debug: ion storm hits at ~5s
  app.debugMod = params.get('mod'); // debug: force a daily modifier by id (?mod=convoy)
  app.debugShip = params.get('ship'); // debug: fly a roster hull without owning it (?ship=ace)
  app.debugBossDie = Number(params.get('bossdie')) || 0; // debug: the boss drops to 1 hp at this world time (ms)
  app.debugEnvEvent = params.get('envevent'); // debug: fire a background event at 1 s (?envevent=capital|battle|cometImpact|…)
  app.debugBench = Number(params.get('bench')) || 0; // debug: time N stepped frames (GPU-synced), log every hitch to ?log
  app.debugAutoFire = params.has('autofire'); // debug: the ship fires its laser and rockets on a timer
  app.debugFreezeAt = Number(params.get('shotat')) || 0; // debug: freeze the sim at this world time — deterministic screenshots
  if (params.has('prof')) window.__prof = { u: 0, d: 0, n: 0 }; // debug: frame-time probe
  const mode = params.get('mode');
  if (params.has('shipgen')) {
    // dev gallery for the procedural ship generator (loaded on demand)
    const { ShipGenState } = await import('./shipgen_page.js');
    app.setState(new ShipGenState(app));
  } else if (params.get('screen') === 'hangar') { // debug: open the hangar directly
    const { HangarState } = await import('./hangar.js');
    app.setState(new HangarState(app));
  } else if (params.get('screen') === 'weapons' || params.get('screen') === 'upgrades') { // debug: a hangar tab
    const { HangarState } = await import('./hangar.js');
    const st = new HangarState(app);
    st.tab = params.get('screen');
    app.setState(st);
  } else if (params.get('screen') === 'options') { // debug: settings
    const { OptionsState } = await import('./options.js');
    app.setState(new OptionsState(app));
  } else if (params.get('screen') === 'scores' || params.get('screen') === 'scoresdemo') { // debug: leaderboard (demo = sample rows, no API)
    const { ScoresState } = await import('./scores.js');
    const st = new ScoresState(app);
    if (params.get('screen') === 'scoresdemo') {
      st.load = () => {
        st.data = {
          top: ['NOVA', 'KESTREL', 'VOIDWALKER', 'ILJA', 'ORION-7', 'MAVERICK', 'PIXEL', 'DRIFTER', 'ECHO', 'ZENITH']
            .map((name, i) => ({ name, score: Math.round(48200 / (1 + i * 0.37)), mode: i % 4 === 1 ? 'coop' : 'single' })),
          you: { rank: 27, score: 6120 },
        };
      };
    }
    app.setState(st);
  } else if (params.get('screen') === 'online') { // debug: the online lobby (&phase=lobby|hosting|joining|lobby-guest|error, no network)
    const { OnlineState } = await import('./online.js');
    app.setState(new OnlineState(app));
    if (params.get('phase')) { app.state.phase = params.get('phase'); app.state.errorText = 'Room not found'; }
  } else if (params.get('screen') === 'local') { // debug: the LOCAL 2P menu page
    app.goMenu();
    app.state.goPage('local');
  } else if (mode === 'single') app.setState(new GameState(app, false));
  else if (mode === 'coop') app.setState(new GameState(app, true));
  else if (mode === 'daily') app.setState(new GameState(app, false, { daily: true }));
  else if (mode === 'versus') app.setState(new VersusState(app));
  else if (params.has('skipstart')) app.goMenu();
  else app.setState(new StartState());

  // debug: start straight in a 3D camera (?view=tilt|chase) — headless screenshots, tuning
  const view = params.get('view');
  if (view === 'classic') app.view3d.enabled = false;
  else if (['top', 'tilt', 'chase', 'cockpit'].includes(view)) { app.view3d.enabled = true; app.view3d.mode = view; app.view3d.snapCam = true; }
  if (app.view3d.enabled) app.view3d.load(); // warm up behind the menu

  // debug: fast-forward game time deterministically (?mode=single&ff=30000)
  if (params.has('log')) { window.__svlog = []; window.__app = app; } // (debug handle for profiling from the console)
  const ff = Number(params.get('ff') || 0);
  for (let t = 0; t < ff; t += 16.67) {
    app.state.update(16.67);
    input.endStep();
  }
  // debug: open a run straight on an overlay (?mode=single&hud=pause | &hud=over) — HUD screenshots
  if (params.get('hud') === 'pause') app.state.togglePause?.();
  else if (params.get('hud') === 'over' && app.state.buildWinMenu) { // versus result
    app.state.score1 = 5; app.state.score2 = 3; app.state.winner = 'PLAYER 1'; app.state.winMenu = app.state.buildWinMenu();
  }
  else if (params.get('hud') === 'over' && app.state.buildOverMenu) {
    const st = app.state;
    st.over = true; st.overAlpha = 0.5; st.overMenu = st.buildOverMenu();
    st.reward = { total: 240 };
    st.lb = { status: 'done', rank: 3, name: 'ILJA', top: ['NOVA', 'KESTREL', 'ILJA', 'ORION-7', 'MAVERICK'].map((name, i) => ({ name, score: Math.round(48200 / (1 + i * 0.37)) })) };
  }
  if (params.has('log')) {
    const pre = document.createElement('pre');
    pre.id = 'svlog';
    pre.style.display = 'none';
    pre.textContent = (window.__svlog || []).join('\n');
    document.body.appendChild(pre);
    const arr = window.__svlog; // keep mirroring events that happen after the fast-forward
    arr.push = (...a) => { pre.textContent += `\n${a.join('\n')}`; return Array.prototype.push.apply(arr, a); };
    // live error capture: runtime errors after the ff loop land in the pre too
    const pushErr = (msg) => { pre.textContent += `\nERR: ${msg}`; };
    addEventListener('error', (e) => pushErr(`${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
    addEventListener('unhandledrejection', (e) => pushErr(`rejection: ${e.reason?.message || e.reason}`));
  }

  let last = performance.now();
  let errCount = 0;
  // The game is tuned for 60fps; on 120Hz+ displays (ProMotion Macs) rAF
  // fires per refresh and doubles the update+draw work for no visual gain —
  // the machine just runs hot. Skip ticks until ~1/60s has accumulated.
  const MIN_FRAME = 1000 / 70;
  function frame(now) {
    if (now - last < MIN_FRAME) { requestAnimationFrame(frame); return; }
    const dt = Math.min(Math.max(now - last, 0.1), 40); // clamp tab-switch spikes
    last = now;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    input.pollGamepads();
    // A thrown update/draw must NEVER kill the loop or blank the screen —
    // skip the bad frame and keep going (this used to leave only the backdrop).
    try {
      // debug (?shotat=T): once the renderer is up, step sim+render synchronously
      // to world time T so a headless screenshot lands on an exact, fully
      // "lived-in" frame (particles only exist in frames that were drawn)
      const v3d = app.view3d;
      if (app.debugFreezeAt && !app._stepped && (v3d.active || !v3d.enabled || v3d.failed)) {
        app._stepped = true;
        for (let i = 0; i < 6000 && (app.state.time || 0) < app.debugFreezeAt; i++) {
          app.state.update(16.67); input.endStep(); app.state.draw(g); v3d.endFrame();
        }
      }
      // debug (?bench=N&log): frame-time histogram + every frame over 12 ms, with the
      // shader-program count before/after (a jump there = a link stall)
      if (app.debugBench && !app._benched && v3d.active && !v3d.warming) {
        app._benched = true;
        const glc = v3d.gl.getContext(), info = v3d.gl.info, ts = [];
        let lastP = info.programs.length;
        for (let i = 0; i < app.debugBench; i++) {
          const b0 = performance.now();
          app.state.update(16.67); input.endStep(); app.state.draw(g); v3d.endFrame(); glc.finish();
          const d = performance.now() - b0;
          ts.push(d);
          if (d > 12) window.__svlog?.push(`HITCH ${(app.state.time / 1000).toFixed(1)}s L${app.state.level} ${d.toFixed(0)}ms programs ${lastP}>${info.programs.length}`);
          if (info.programs.length > lastP) { // (headless clocks don't tick inside a frame, so links are also reported by name)
            window.__svlog?.push(`LINK ${(app.state.time / 1000).toFixed(1)}s L${app.state.level} +${info.programs.length - lastP}: ${info.programs.slice(lastP).map((x) => x.name || x.cacheKey.split(',')[0] || '?').join(' | ')}`);
          }
          lastP = info.programs.length;
        }
        ts.sort((a, b) => a - b);
        const q = (f) => ts[Math.floor(ts.length * f)].toFixed(1);
        window.__svlog?.push(`BENCH frames=${ts.length} median=${q(0.5)}ms p95=${q(0.95)} p99=${q(0.99)} max=${ts[ts.length - 1].toFixed(0)} over12=${ts.filter((x) => x > 12).length} programs=${info.programs.length}`);
      }
      const p = window.__prof;
      const t0 = p && performance.now();
      app.state.update(dt);
      input.endStep();
      const t1 = p && performance.now();
      app.state.draw(g);
      app.view3d.endFrame();
      if (p) {
        p.u += t1 - t0;
        p.d += performance.now() - t1;
        if (++p.n === 120) {
          p.last = `upd ${(p.u / 120).toFixed(2)}ms  draw ${(p.d / 120).toFixed(2)}ms`;
          console.info(`PROF ${p.last}`);
          p.u = p.d = p.n = 0;
        }
        if (p.last) drawText(g, p.last, W / 2, H - 14, 14, 'rgb(0,255,120)');
      }
    } catch (e) {
      input.endStep();
      if (errCount++ < 5) {
        console.error('frame error:', e);
        document.getElementById('svlog')?.append(`\nERR frame: ${e.message} | ${(e.stack || '').split('\n')[1] || ''}`);
      }
      window.__svlog?.push?.(`ERR ${e.message}`);
    }
    if (!app.state?.anim) g.drawImage(vignette, 0, 0, W, H); // (the menu screens light themselves)
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
