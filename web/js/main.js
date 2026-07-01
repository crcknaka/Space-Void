// Boot: canvas scaling (HiDPI), adaptive world size, asset loading, state machine, main loop
import { W, H, BASE_W, BASE_H, MAX_W, MAX_H, setSize, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { loadImages } from './assets.js';
import { makeVignette } from './fx.js';
import { drawText } from './ui.js';
import { MenuState } from './menu.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';

const canvas = document.getElementById('game');
const g = canvas.getContext('2d');
let scale = 1;
let vignette = null;

function fit() {
  // Adapt the world to the screen aspect: widescreen extends the playfield
  // horizontally, tall phones extend it vertically — no black bars.
  const vw = window.innerWidth, vh = window.innerHeight;
  const aspect = vw / vh;
  let w, h;
  if (aspect >= BASE_W / BASE_H) {
    h = BASE_H;
    w = clamp(Math.round(BASE_H * aspect), BASE_W, MAX_W);
  } else {
    w = BASE_W;
    h = clamp(Math.round(BASE_W / aspect), BASE_H, MAX_H);
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
  g.imageSmoothingQuality = 'high';
  vignette = makeVignette();
  if (app.state?.onResize) app.state.onResize();
}
addEventListener('resize', fit);
document.addEventListener('fullscreenchange', fit);
input.init(canvas);

const app = {
  canvas,
  images: null,
  state: null,
  highScore: 0,
  setState(s) {
    this.state = s;
    if (s.enter) s.enter();
  },
  goMenu() {
    this.setState(new MenuState(this));
  },
  saveHigh(score) {
    if (score > this.highScore) {
      this.highScore = score;
      try { localStorage.setItem('spacevoid_high', String(score)); } catch {}
    }
  },
};
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
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    drawText(g, 'SPACE VOID', W / 2, H / 2 - 80, 56);
    const pulse = 0.5 + 0.5 * Math.sin((this.t || 0) / 20);
    g.globalAlpha = 0.4 + 0.6 * pulse;
    drawText(g, input.isTouch ? 'TAP TO START' : 'CLICK OR PRESS ANY KEY', W / 2, H / 2 + 30, 26, 'rgb(120,220,120)');
    g.globalAlpha = 1;
  }
}

/* --------------------------------- loading --------------------------------- */

let progress = 0;
function drawLoading() {
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  drawText(g, 'SPACE VOID', W / 2, H / 2 - 80, 56);
  const bw = 300, bh = 10;
  g.fillStyle = 'rgba(255,255,255,0.15)';
  g.fillRect(W / 2 - bw / 2, H / 2 + 20, bw, bh);
  g.fillStyle = 'rgb(0,220,120)';
  g.fillRect(W / 2 - bw / 2, H / 2 + 20, bw * progress, bh);
}

async function boot() {
  let imgDone = 0, sndDone = 0;
  const IMG_TOTAL = 29, SND_TOTAL = 8;
  const tick = () => {
    progress = (imgDone + sndDone) / (IMG_TOTAL + SND_TOTAL);
    drawLoading();
  };
  drawLoading();

  const [images] = await Promise.all([
    loadImages((d) => { imgDone = d; tick(); }),
    audio.loadSounds((d) => { sndDone = d; tick(); }),
    document.fonts?.load('700 30px Orbitron').catch(() => {}),
  ]);
  app.images = images;

  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  if (mode === 'single') app.setState(new GameState(app, false));
  else if (mode === 'coop') app.setState(new GameState(app, true));
  else if (mode === 'versus') app.setState(new VersusState(app));
  else if (params.has('skipstart')) app.goMenu();
  else app.setState(new StartState());

  // debug: fast-forward game time deterministically (?mode=single&ff=30000)
  const ff = Number(params.get('ff') || 0);
  for (let t = 0; t < ff; t += 16.67) {
    app.state.update(16.67);
    input.endStep();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(Math.max(now - last, 0.1), 40); // clamp tab-switch spikes
    last = now;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    app.state.update(dt);
    input.endStep();
    app.state.draw(g);
    g.drawImage(vignette, 0, 0, W, H);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot();
