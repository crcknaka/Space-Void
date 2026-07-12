// Main menu — port of menu.py
import { W, H, STEP, randInt, rand, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star, StaticStar, DistantConvoy, Freighter, Comet } from './entities.js';
import { makeSpaceBackdrop, makePlanetSprite, drawLiveStation } from './bggen.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';
import { ScoresState } from './scores.js';
import { OptionsState } from './options.js';
import { OnlineState } from './online.js';
import { todayMod, dailyAttemptsLeft, timeToNextDaily } from './daily.js';
import { progress } from './progress.js';

export class MenuState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    audio.playMusic('background_music');
    setRngSeed(null); // leave daily-seeded RNG
    this.page = 'main'; // main | local
    this.dailyBlock = 0;
    this.time = 0;
    this.k = 1;
    // procedural vista: deep-space tile + a big dim world low in the frame +
    // slow ambient traffic. Replaces the last PNG the game shipped with.
    this.bg = makeSpaceBackdrop((Math.random() * 1e9) | 0);
    this.bgX = 0;
    this.planet = makePlanetSprite((Math.random() * 1e9) | 0);
    this.ambient = [];
    this.nextAmbientAt = 2000 + Math.random() * 5000;
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
      const online = new Button('ONLINE', W / 2, 0, 220, 58, 'rgb(0,220,255)', 'online');
      online.accent = true; // permanently highlighted
      this.menu = new ButtonGroup([
        new Button('SINGLE', W / 2, y, 220, 58, 'rgb(0,255,0)', 'single'),
        new Button('LOCAL 2P', W / 2, y += dy, 220, 58, 'rgb(0,120,255)', 'local'),
        Object.assign(online, { cy: (y += dy) }),
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
    this.k = k;
    this.time += dt;
    this.bgX -= 0.05 * k; // slow drift
    for (const s of this.stars) s.update(k);
    for (const s of this.staticStars) s.update(k);
    // lazy ambient traffic crossing behind the buttons
    if (this.time > this.nextAmbientAt) {
      this.nextAmbientAt = this.time + 9000 + Math.random() * 14000;
      const roll = Math.random();
      this.ambient.push(roll < 0.35 ? new Comet(this.time)
        : roll < 0.6 ? new DistantConvoy(this.app.images, this.time)
        : new Freighter(this.time));
    }
    for (const a of this.ambient) a.update(this);
    this.ambient = this.ambient.filter((a) => !a.dead);
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
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    // drifting deep-space tile + a large world rising from the bottom edge,
    // both with slight mouse parallax like the old painting had
    const offX = -(input.pointer.x - W / 2) * 0.02;
    const offY = -(input.pointer.y - H / 2) * 0.02;
    const q = g.imageSmoothingQuality;
    g.imageSmoothingQuality = 'low';
    const bgH = H, bgW = this.bg.width * (bgH / this.bg.height);
    let bx = this.bgX % bgW;
    if (bx > 0) bx -= bgW;
    g.drawImage(this.bg, bx + offX * 0.4, offY * 0.4, bgW, bgH);
    g.drawImage(this.bg, bx + bgW + offX * 0.4, offY * 0.4, bgW, bgH);
    for (const a of this.ambient) a.draw(g, this);
    const pw = Math.min(W * 0.9, 900);
    const ph = pw * (this.planet.height / this.planet.width);
    const px0 = (W - pw) / 2 + offX, py0 = H - ph * 0.55 + offY;
    g.drawImage(this.planet, px0, py0, pw, ph);
    const st = this.planet.station;
    if (st) {
      const k2 = pw / this.planet.width;
      const oa = st.a0 + this.time * 0.00005;
      drawLiveStation(g,
        px0 + this.planet.width / 2 * k2 + Math.cos(oa) * st.d * k2,
        py0 + this.planet.height / 2 * k2 + Math.sin(oa) * st.d * 0.7 * k2,
        st.s * k2, this.time * 0.0005 * st.spin, this.time);
    }
    g.imageSmoothingQuality = q;

    for (const s of this.staticStars) s.draw(g);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'SPACE VOID', W / 2, H / 2 - 315, 58);
    drawText(g, 'v1.2 web', W / 2, H / 2 - 275, 19, 'rgb(150,150,150)');
    if (this.app.highScore > 0) {
      drawText(g, `BEST: ${this.app.highScore}`, W / 2, H / 2 - 243, 22, 'rgb(255,210,80)');
    }
    // credits wallet, top-right corner
    if (progress.credits > 0) {
      drawText(g, `◆ ${progress.credits} CR`, W - 14, 26, 17, 'rgb(120,220,255)', 'right');
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
      drawText(g, 'Space = rocket · E = laser · Shift = boost · Esc = pause', W / 2, H - 64, 13, 'rgb(150,150,150)');
      drawText(g, 'ONLINE = play with friends over the internet · up to 4 in co-op', W / 2, H - 44, 13, 'rgb(120,220,255)');
    }
    drawText(g, 'Made by cRc^', W - 10, H - 14, 14, 'rgb(200,200,200)', 'right');
  }
}
