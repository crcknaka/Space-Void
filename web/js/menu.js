// Main menu — port of menu.py
import { W, H, STEP, randInt, rand, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star, StaticStar } from './entities.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';
import { ScoresState } from './scores.js';
import { OptionsState } from './options.js';

export class MenuState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    audio.playMusic('background_music');
    setRngSeed(null); // leave daily-seeded RNG
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
      new Button('SINGLE', W / 2, H / 2 - 185, 200, 58, 'rgb(0,255,0)', 'single'),
      new Button('COOP', W / 2, H / 2 - 111, 200, 58, 'rgb(0,120,255)', 'coop'),
      new Button('VERSUS', W / 2, H / 2 - 37, 200, 58, 'rgb(255,140,0)', 'versus'),
      new Button('DAILY', W / 2, H / 2 + 37, 200, 58, 'rgb(255,210,0)', 'daily'),
      new Button('SCORES', W / 2, H / 2 + 111, 200, 58, 'rgb(200,120,255)', 'scores'),
      new Button('SETTINGS', W / 2, H / 2 + 185, 200, 58, 'rgb(255,0,0)', 'settings'),
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
    else if (action === 'daily') this.app.setState(new GameState(this.app, false, { daily: true }));
    else if (action === 'scores') this.app.setState(new ScoresState(this.app));
    else if (action === 'settings') this.app.setState(new OptionsState(this.app));
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

    drawText(g, 'SPACE VOID', W / 2, H / 2 - 315, 58);
    drawText(g, 'v1.1 web', W / 2, H / 2 - 275, 19, 'rgb(150,150,150)');
    if (this.app.highScore > 0) {
      drawText(g, `BEST: ${this.app.highScore}`, W / 2, H / 2 - 243, 22, 'rgb(255,210,80)');
    }

    this.menu.draw(g);

    // controls hint
    if (input.isTouch) {
      drawText(g, 'Drag to move · rocket button bottom-right', W / 2, H - 56, 13, 'rgb(150,150,150)');
      drawText(g, 'Coop / Versus: connect Bluetooth gamepads (P1 = pad 1, P2 = pad 2)', W / 2, H - 36, 13, 'rgb(150,150,150)');
    } else {
      drawText(g, 'P1: WASD + Shift · Space = rocket    P2: Arrows + RShift · Enter = rocket', W / 2, H - 56, 13, 'rgb(150,150,150)');
      drawText(g, 'Gamepads: stick = move · A = fire · B = boost · Start = pause', W / 2, H - 36, 13, 'rgb(150,150,150)');
    }
    drawText(g, 'Made by cRc^', W - 10, H - 14, 14, 'rgb(200,200,200)', 'right');
  }
}
