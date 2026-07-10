// BaseWorld — shared machinery for GameState and VersusState:
// clock, pause menu, scrolling background with zoom, star layers, nebulae.
import { W, H, STEP } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { makeStarLayers } from './entities.js';
import { makeNebulaField, updateNebulae, drawNebulae } from './fx.js';
import { makePlanetSprite } from './bggen.js';
import { OptionsState } from './options.js';

export class BaseWorld {
  constructor(app, bgKey) {
    this.app = app;
    this.bgKey = bgKey;
    this.bgOverride = null; // procedural backdrop canvas (bggen.js) if set
    this.nebulaHue = null;
  }

  initBackdrop() {
    this.time = 0;
    this.k = 1;
    this.speedMul = 1;
    this.warpMul = 1;
    this.paused = false;
    this.pauseMenu = null;
    this.effects = [];
    this.starLayers = makeStarLayers();
    this.nebulae = makeNebulaField(3, this.nebulaHue);
    this.planets = [];
    this.spawnPlanet(W * (0.1 + Math.random() * 0.5), true); // one world in view from the start
    this.bgX = 0;
    this.bgW = 0;
    this.bgZoom = 1;
    this.bgZoomTarget = 1;
  }

  players() { return []; }

  // Planet parallax layer: a pipeline of freshly generated worlds. New ones
  // fade in while entering; the visible one is never replaced mid-screen.
  spawnPlanet(x, instant = false) {
    if (this.planets.length >= 3) return;
    const img = makePlanetSprite((Math.random() * 1e9) | 0);
    this.planets.push({
      img, x,
      y: -img.height * 0.2 + Math.random() * (H - img.height * 0.6),
      born: instant ? -1e9 : (this.time || 0),
    });
  }

  buildPauseMenu() {
    return new ButtonGroup([
      new Button('RESUME', W / 2, H / 2 - 70, 200, 60, 'rgb(0,255,0)', 'resume'),
      new Button('SETTINGS', W / 2, H / 2 + 10, 200, 60, 'rgb(0,150,255)', 'settings'),
      new Button('MAIN MENU', W / 2, H / 2 + 90, 200, 60, 'rgb(255,0,0)', 'main_menu'),
    ]);
  }

  togglePause() {
    this.paused = !this.paused;
    audio.play('click', 0.5);
    if (this.paused) this.pauseMenu = this.buildPauseMenu();
  }

  // Esc/P toggling + pause menu interaction. Returns true while paused.
  handlePause() {
    if (this.pauseDisabled) return false;
    if (input.pressed.has('Escape') || input.pressed.has('KeyP')) this.togglePause();
    if (!this.paused) return false;
    const action = this.pauseMenu.update();
    if (action === 'resume') this.paused = false;
    else if (action === 'settings') this.app.setState(new OptionsState(this.app, this)); // returns here, still paused
    else if (action === 'main_menu') this.app.goMenu();
    return true;
  }

  updateBackdrop(dt) {
    this.bgZoom += (this.bgZoomTarget - this.bgZoom) * Math.min(1, 0.01 * this.k);
    const bg = this.bgOverride || this.app.images[this.bgKey];
    this.bgW = bg.width * ((H * this.bgZoom) / bg.height); // cover height, keep aspect
    const wm = this.warpMul || 1; // hyperspace hop: everything streams faster
    this.bgX -= 0.1 * this.speedMul * wm * this.k;
    if (this.bgX <= -this.bgW) this.bgX += this.bgW;
    updateNebulae(this.nebulae, this.k, this.speedMul * wm);
    for (const layer of this.starLayers) for (const s of layer) s.update(this.k * Math.min(wm, 30));
    for (const pl of this.planets) pl.x -= 0.16 * this.speedMul * wm * this.k;
    this.planets = this.planets.filter((pl) => pl.x + pl.img.width > -20);
    // keep the pipeline fed: queue the next world once the newest one is
    // well inside the screen (occasional two-planet vistas, no vanishing)
    const last = this.planets[this.planets.length - 1];
    if (!last || last.x + last.img.width < W * 0.55) {
      this.spawnPlanet(W + 500 + Math.random() * 1600);
    }
  }

  drawBackdrop(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const bg = this.bgOverride || this.app.images[this.bgKey];
    const bgH = H * (this.bgZoom || 1);
    const bgW = this.bgW || bg.width * (bgH / bg.height);
    const bgY = -(bgH - H) / 2;
    // 'high' smoothing on scaled canvas sources falls off the GPU fast path —
    // full-screen twice per frame it costs real milliseconds; 'low' is
    // indistinguishable on a soft space backdrop.
    const q = g.imageSmoothingQuality;
    g.imageSmoothingQuality = 'low';
    g.drawImage(bg, this.bgX, bgY, bgW, bgH);
    g.drawImage(bg, this.bgX + bgW, bgY, bgW, bgH);
    g.imageSmoothingQuality = q;
    for (const pl of this.planets) { // 1:1 draws, soft fade-in on arrival
      const a = Math.min(1, ((this.time || 0) - pl.born) / 1500);
      if (a <= 0) continue;
      g.globalAlpha = a;
      g.drawImage(pl.img, pl.x, pl.y);
    }
    g.globalAlpha = 1;
    drawNebulae(g, this.nebulae);
    for (const layer of this.starLayers) for (const s of layer) s.draw(g);
  }

  drawPauseOverlay(g) {
    if (!this.paused) return;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, W, H);
    drawText(g, 'PAUSED', W / 2, H / 2 - 130, 52, 'rgb(255,60,60)');
    this.pauseMenu.draw(g);
  }

  onResize() {
    this.starLayers = makeStarLayers();
    this.nebulae = makeNebulaField(3, this.nebulaHue);
    this.planets = [];
    this.spawnPlanet(W * (0.1 + Math.random() * 0.5), true);
    if (this.pauseMenu) this.pauseMenu = this.buildPauseMenu();
  }
}
