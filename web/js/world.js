// BaseWorld — shared machinery for GameState and VersusState:
// clock, pause menu, scrolling background with zoom, star layers, nebulae.
import { W, H, STEP } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { makeStarLayers } from './entities.js';
import { makeNebulaField, updateNebulae, drawNebulae } from './fx.js';

export class BaseWorld {
  constructor(app, bgKey) {
    this.app = app;
    this.bgKey = bgKey;
    this.nebulaHue = null;
  }

  initBackdrop() {
    this.time = 0;
    this.k = 1;
    this.speedMul = 1;
    this.paused = false;
    this.pauseMenu = null;
    this.effects = [];
    this.starLayers = makeStarLayers();
    this.nebulae = makeNebulaField(3, this.nebulaHue);
    this.bgX = 0;
    this.bgW = 0;
    this.bgZoom = 1;
    this.bgZoomTarget = 1;
  }

  players() { return []; }

  buildPauseMenu() {
    return new ButtonGroup([
      new Button('RESUME', W / 2, H / 2 - 40, 200, 60, 'rgb(0,255,0)', 'resume'),
      new Button('MAIN MENU', W / 2, H / 2 + 50, 200, 60, 'rgb(255,0,0)', 'main_menu'),
    ]);
  }

  // Esc/P toggling + pause menu interaction. Returns true while paused.
  handlePause() {
    if (input.pressed.has('Escape') || input.pressed.has('KeyP')) {
      this.paused = !this.paused;
      audio.play('click', 0.5);
      if (this.paused) this.pauseMenu = this.buildPauseMenu();
    }
    if (!this.paused) return false;
    const action = this.pauseMenu.update();
    if (action === 'resume') this.paused = false;
    else if (action === 'main_menu') this.app.goMenu();
    return true;
  }

  updateBackdrop(dt) {
    this.bgZoom += (this.bgZoomTarget - this.bgZoom) * Math.min(1, 0.01 * this.k);
    const bg = this.app.images[this.bgKey];
    this.bgW = bg.width * ((H * this.bgZoom) / bg.height); // cover height, keep aspect
    this.bgX -= 0.1 * this.speedMul * this.k;
    if (this.bgX <= -this.bgW) this.bgX = 0;
    updateNebulae(this.nebulae, this.k, this.speedMul);
    for (const layer of this.starLayers) for (const s of layer) s.update(this.k);
  }

  drawBackdrop(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const bg = this.app.images[this.bgKey];
    const bgH = H * (this.bgZoom || 1);
    const bgW = this.bgW || bg.width * (bgH / bg.height);
    const bgY = -(bgH - H) / 2;
    g.drawImage(bg, this.bgX, bgY, bgW, bgH);
    g.drawImage(bg, this.bgX + bgW, bgY, bgW, bgH);
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
    if (this.pauseMenu) this.pauseMenu = this.buildPauseMenu();
  }
}
