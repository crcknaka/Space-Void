// Main menu — port of menu.py
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star, StaticStar } from './entities.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';

export class MenuState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    audio.playMusic('background_music');
    this.fsHint = 0;
    this.layout();
  }

  layout() {
    this.stars = [];
    this.staticStars = [];
    for (let i = 0; i < 50; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.3), randInt(1, 3), randInt(50, 200)));
    }
    for (let i = 0; i < 100; i++) {
      this.staticStars.push(new StaticStar(randInt(0, W), randInt(0, H), randInt(1, 4), randInt(50, 200)));
    }
    this.menu = new ButtonGroup([
      new Button('SINGLE', W / 2, H / 2 - 110, 200, 60, 'rgb(0,255,0)', 'single'),
      new Button('COOP', W / 2, H / 2 - 30, 200, 60, 'rgb(0,120,255)', 'coop'),
      new Button('VERSUS', W / 2, H / 2 + 50, 200, 60, 'rgb(255,140,0)', 'versus'),
      new Button('FULLSCREEN', W / 2, H / 2 + 130, 200, 60, 'rgb(255,0,0)', 'fullscreen'),
    ]);
  }

  onResize() {
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);
    for (const s of this.staticStars) s.update(k);

    const action = this.menu.update();
    if (action === 'single') this.app.setState(new GameState(this.app, false));
    else if (action === 'coop') this.app.setState(new GameState(this.app, true));
    else if (action === 'versus') this.app.setState(new VersusState(this.app));
    else if (action === 'fullscreen') {
      if (document.fullscreenEnabled) {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      } else {
        // iOS Safari has no Fullscreen API — PWA install is the way
        this.fsHint = 420; // ~7 seconds
      }
    }
    if (this.fsHint > 0) this.fsHint -= k;
  }

  draw(g) {
    const { images } = this.app;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    // background image near the bottom with slight mouse parallax, like menu.py
    const img = images.menu_background;
    const bgW = Math.min(W, 720);
    const bgH = Math.round((bgW / img.width) * img.height);
    const offX = -(input.pointer.x - W / 2) * 0.02;
    const offY = -(input.pointer.y - H / 2) * 0.02;
    g.drawImage(img, (W - bgW) / 2 + offX, H - bgH + offY, bgW, bgH);

    for (const s of this.staticStars) s.draw(g);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'SPACE VOID', W / 2, H / 2 - 250, 60);
    drawText(g, 'v0.9 web', W / 2, H / 2 - 208, 20, 'rgb(150,150,150)');
    if (this.app.highScore > 0) {
      drawText(g, `BEST: ${this.app.highScore}`, W / 2, H / 2 - 175, 24, 'rgb(255,210,80)');
    }

    this.menu.draw(g);

    // iOS fullscreen hint
    if (this.fsHint > 0) {
      g.globalAlpha = Math.min(1, this.fsHint / 60);
      drawText(g, 'iPhone/iPad: Share → Add to Home Screen', W / 2, H / 2 + 190, 16, 'rgb(255,210,80)');
      drawText(g, 'then launch from the icon for fullscreen', W / 2, H / 2 + 212, 16, 'rgb(255,210,80)');
      g.globalAlpha = 1;
    }

    // controls hint
    if (input.isTouch) {
      drawText(g, 'Drag to move · rocket button bottom-right', W / 2, H - 40, 13, 'rgb(150,150,150)');
    } else {
      drawText(g, 'P1: WASD + Shift · Space = rocket', W / 2, H - 56, 13, 'rgb(150,150,150)');
      drawText(g, 'P2: Arrows + RShift · Enter = rocket · Esc = pause', W / 2, H - 36, 13, 'rgb(150,150,150)');
    }
    drawText(g, 'Made by cRc^', W - 10, H - 14, 14, 'rgb(200,200,200)', 'right');
  }
}
