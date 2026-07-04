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
import { OnlineState } from './online.js';
import { todayMod, dailyAttemptsLeft, timeToNextDaily } from './daily.js';

export class MenuState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    audio.playMusic('background_music');
    setRngSeed(null); // leave daily-seeded RNG
    this.page = 'main'; // main | local
    this.dailyBlock = 0;
    this.starfield();
    this.layout();
  }

  starfield() {
    this.stars = [];
    this.staticStars = [];
    for (let i = 0; i < 50; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.3), randInt(1, 3), randInt(50, 200)));
    }
    for (let i = 0; i < 100; i++) {
      this.staticStars.push(new StaticStar(randInt(0, W), randInt(0, H), randInt(1, 4), randInt(50, 200)));
    }
  }

  layout() {
    const dy = 74;
    if (this.page === 'local') {
      const cy = H / 2 - dy / 2;
      this.menu = new ButtonGroup([
        new Button('CO-OP', W / 2, cy - dy, 220, 58, 'rgb(0,120,255)', 'coop'),
        new Button('VERSUS', W / 2, cy, 220, 58, 'rgb(255,140,0)', 'versus'),
        new Button('BACK', W / 2, cy + dy + 20, 200, 54, 'rgb(255,0,0)', 'back'),
      ]);
    } else {
      let y = H / 2 - dy * 2.5;
      this.menu = new ButtonGroup([
        new Button('SINGLE', W / 2, y, 220, 58, 'rgb(0,255,0)', 'single'),
        new Button('LOCAL 2P', W / 2, y += dy, 220, 58, 'rgb(0,120,255)', 'local'),
        new Button('ONLINE 2P', W / 2, y += dy, 220, 58, 'rgb(0,220,255)', 'online'),
        new Button('DAILY', W / 2, y += dy, 220, 58, 'rgb(255,210,0)', 'daily'),
        new Button('SCORES', W / 2, y += dy, 220, 58, 'rgb(200,120,255)', 'scores'),
        new Button('SETTINGS', W / 2, y += dy, 220, 58, 'rgb(255,0,0)', 'settings'),
      ]);
    }
  }

  goPage(p) {
    this.page = p;
    audio.play('click', 0.5);
    this.layout();
  }

  onResize() {
    this.starfield();
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);
    for (const s of this.staticStars) s.update(k);
    if (this.dailyBlock > 0) this.dailyBlock -= k;

    const action = this.menu.update();
    if (this.page === 'local') {
      if (action === 'coop') this.app.setState(new GameState(this.app, true));
      else if (action === 'versus') this.app.setState(new VersusState(this.app));
      else if (action === 'back' || input.pressed.has('Escape')) this.goPage('main');
      return;
    }
    if (action === 'single') this.app.setState(new GameState(this.app, false));
    else if (action === 'local') this.goPage('local');
    else if (action === 'online') this.app.setState(new OnlineState(this.app));
    else if (action === 'daily') {
      if (dailyAttemptsLeft() > 0) this.app.setState(new GameState(this.app, false, { daily: true }));
      else this.dailyBlock = 240; // ~4s "no attempts" note
    }
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
    drawText(g, 'v1.2 web', W / 2, H / 2 - 275, 19, 'rgb(150,150,150)');
    if (this.app.highScore > 0) {
      drawText(g, `BEST: ${this.app.highScore}`, W / 2, H / 2 - 243, 22, 'rgb(255,210,80)');
    }

    if (this.page === 'local') {
      drawText(g, '2 PLAYERS · ONE DEVICE', W / 2, H / 2 - 150, 18, 'rgb(160,160,160)');
    }

    this.menu.draw(g);

    if (this.page === 'main') {
      // daily challenge info: today's modifier, attempts, reset countdown
      const tries = dailyAttemptsLeft();
      const dailyLine = `DAILY · ${todayMod().name} · ${tries > 0 ? `${tries} ${tries === 1 ? 'try' : 'tries'} left` : 'no tries left'} · resets in ${timeToNextDaily()}`;
      drawText(g, dailyLine, W / 2, H - 78, 13, tries > 0 ? 'rgb(255,210,80)' : 'rgb(150,120,60)');
    }
    if (this.dailyBlock > 0) {
      g.globalAlpha = Math.min(1, this.dailyBlock / 60);
      drawText(g, 'No daily attempts left — come back after the reset!', W / 2, H / 2 + 250, 16, 'rgb(255,110,110)');
      g.globalAlpha = 1;
    }

    // controls hint
    if (this.page === 'local') {
      drawText(g, input.isTouch
        ? 'Two players share this screen · gamepads recommended (P1=pad1, P2=pad2)'
        : 'P1: WASD + Shift · Space   ·   P2: Arrows + RShift · Enter', W / 2, H - 48, 13, 'rgb(150,150,150)');
    } else {
      drawText(g, 'ONLINE 2P = play with a friend over the internet (room code)', W / 2, H - 48, 13, 'rgb(150,150,150)');
    }
    drawText(g, 'Made by cRc^', W - 10, H - 14, 14, 'rgb(200,200,200)', 'right');
  }
}
