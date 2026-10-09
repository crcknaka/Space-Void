// Main menu — port of menu.py
import { W, H, STEP, randInt, rand, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup } from './ui.js';
import * as ui from './ui.js';
import { Star, StaticStar, DistantConvoy, Freighter, Comet } from './entities.js';
import { makeSpaceBackdrop, makePlanetSprite, drawLiveStation } from './bggen.js';
import { GameState } from './game.js';
import { VersusState } from './versus.js';
import { ScoresState } from './scores.js';
import { OptionsState } from './options.js';
import { OnlineState } from './online.js';
import { HangarState } from './hangar.js';
import { todayMod, dailyAttemptsLeft, timeToNextDaily } from './daily.js';
import { progress } from './progress.js';
import { SHIP_BY_ID } from './ships.js';

const { C, rgba } = ui;

// per-entry presentation: accent + the one-line blurb shown under the list
const ITEMS = {
  single: { info: 'Solo run — waves, elites and a boss in every sector' },
  hangar: { info: 'Ships, secondary weapons and permanent upgrades' },
  local: { info: 'Co-op or versus — two players on one device' },
  online: { info: 'Play with friends over the internet · up to 4 in co-op', tag: 'MULTIPLAYER' },
  daily: { info: 'One seeded run a day with a global leaderboard', color: C.gold },
  scores: { info: 'Global leaderboards for every mode' },
  settings: { info: 'Audio, graphics, controls feel and achievements' },
  coop: { info: 'Fight the campaign side by side' },
  versus: { info: 'Head-to-head duel in the arena', color: C.gold },
  back: { info: 'Return to the main menu' },
};

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
    this.anim = new ui.Anim();
    // procedural vista: deep-space tile + a big dim world low in the frame +
    // slow ambient traffic. Replaces the last PNG the game shipped with.
    this.bg = makeSpaceBackdrop((Math.random() * 1e9) | 0);
    this.bgX = 0;
    this.planet = makePlanetSprite((Math.random() * 1e9) | 0);
    this.ambient = [];
    this.nextAmbientAt = 2000 + Math.random() * 5000;
    this.starfield();
    this.layout();
    this.anim.mark('enter');
    this.anim.mark('page');
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
    // wide screens: the list is anchored to the left margin and the hull owns
    // the right half; narrow / portrait: one centred column
    const wide = ui.isWide(), mx = ui.gutter();
    const rw = wide ? 380 : Math.min(400, W - 2 * mx - 16);
    const cx = wide ? mx + rw / 2 : W / 2;
    const slack = Math.max(0, H - 786); // tall phones: spread the column out, bigger touch rows
    const rh = wide ? 52 : 56 + Math.min(10, slack * 0.03), step = rh + (wide ? 6 : 4);
    const y0 = (wide ? 236 : 204) + slack * 0.3;
    let last;
    if (this.page === 'local') {
      this.menu = new ButtonGroup([
        new Button('CO-OP', cx, y0, rw, rh, 'rgb(0,120,255)', 'coop'),
        new Button('VERSUS', cx, y0 + step, rw, rh, 'rgb(255,140,0)', 'versus'),
        new Button('BACK', cx, last = y0 + step * 2 + 20, rw, rh, 'rgb(255,0,0)', 'back'),
      ]);
    } else {
      let y = y0;
      const online = new Button('ONLINE', cx, 0, rw, rh, 'rgb(0,220,255)', 'online');
      online.accent = true; // permanently highlighted
      this.menu = new ButtonGroup([
        new Button('SINGLE', cx, y, rw, rh, 'rgb(0,255,0)', 'single'),
        new Button('HANGAR', cx, y += step, rw, rh, 'rgb(120,220,255)', 'hangar'),
        new Button('LOCAL 2P', cx, y += step, rw, rh, 'rgb(0,120,255)', 'local'),
        Object.assign(online, { cy: (y += step) }),
        new Button('DAILY', cx, y += step, rw, rh, 'rgb(255,210,0)', 'daily'),
        new Button('SCORES', cx, y += step, rw, rh, 'rgb(200,120,255)', 'scores'),
        new Button('SETTINGS', cx, last = y += step, rw, rh, 'rgb(255,0,0)', 'settings'),
      ]);
    }
    this.L = { wide, mx, rw, x: cx - rw / 2, slack, bottom: last + rh / 2 };
    // showcase hull (wide only): right of the list, level with its middle
    this.hero = wide ? { x: W * 0.67, y: H * 0.47, size: Math.min(430, W * 0.3) } : null;
  }

  goPage(p) {
    this.page = p;
    audio.play('click', 0.5);
    this.layout();
    this.anim.mark('page');
  }

  onResize() {
    this.starfield();
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    this.k = k;
    this.time += dt;
    this.anim.tick(dt);
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
    if (this.menu.index !== this._selIdx) { this._selIdx = this.menu.index; this.anim.mark('sel'); }
    if (this.page === 'local') {
      if (action === 'coop') this.app.setState(new GameState(this.app, true));
      else if (action === 'versus') this.app.setState(new VersusState(this.app));
      else if (action === 'back' || input.pressed.has('Escape')) this.goPage('main');
      return;
    }
    if (action === 'single') this.app.setState(new GameState(this.app, false));
    else if (action === 'hangar') this.app.setState(new HangarState(this.app));
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
    // 3D graphics: the menu floats over the live sky, with the equipped hull
    // idling beside the buttons when there is room for it
    const hero = this.hero;
    const in3D = !!this.app.view3d?.backdrop(g, hero
      ? { ship: progress.selectedShip, x: hero.x, y: hero.y, size: hero.size }
      : { ship: null });
    if (!in3D) {
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
    }

    this.drawUI(g, in3D);
  }

  // everything above the backdrop: scrims, title lockup, the list, info cards
  drawUI(g, in3D) {
    ui.begin(g);
    const a = this.anim, L = this.L, { wide, mx } = L;
    const hero = this.hero;

    // scrims keep the type readable over a bright planet or the sun
    if (wide) ui.scrim(g, 'left', W * 0.6, in3D ? 0.78 : 0.7);
    else ui.scrim(g, 'all', 0, in3D ? 0.46 : 0.4);
    ui.scrim(g, 'top', 120, 0.5);
    ui.scrim(g, 'bottom', 150, 0.62);

    // classic graphics have no 3D turntable — float the baked hull instead
    const ship = SHIP_BY_ID[progress.selectedShip];
    if (hero && !in3D) {
      const spr = this.app.images.ships?.[progress.selectedShip];
      if (spr) {
        const sw = Math.min(280, hero.size * 0.7), sh = sw * (spr.height / spr.width);
        ui.glow(g, C.cyan, hero.x, hero.y, sw * 0.9, sw * 0.5, 0.1);
        g.drawImage(spr, hero.x - sw / 2, hero.y - sh / 2 + Math.sin(this.time / 900) * 6, sw, sh);
      }
    }
    if (hero && ship) {
      const k = a.reveal(3, 'page'), cy = hero.y + hero.size * (in3D ? 0.4 : 0.3);
      g.globalAlpha = k;
      ui.line(g, hero.x - 70, cy, hero.x + 70, cy, rgba(C.mid, 0.3));
      g.fillStyle = rgba(C.cyan); g.fillRect(hero.x - 12, cy - 1, 24, 2);
      ui.text(g, ship.name, hero.x, cy + 20, { size: 15, weight: 600, track: 0.32, align: 'center' });
      ui.text(g, 'ACTIVE HULL', hero.x, cy + 40, { size: 10, weight: 600, track: 0.26, align: 'center', color: rgba(C.low) });
      g.globalAlpha = 1;
    }

    // ---- title lockup: SPACE (heavy) VOID (light) over a rule ----
    const ts = wide ? 58 : Math.min(46, (W - 2 * mx) / 9.6);
    const ty = wide ? 98 : 84 + L.slack * 0.12;
    const o1 = { size: ts, weight: 700, track: 0.2 }, o2 = { size: ts, weight: 200, track: 0.2 };
    const w1 = ui.measure(g, 'SPACE', o1), w2 = ui.measure(g, 'VOID', o2), gap = ts * 0.52;
    const tw = w1 + gap + w2, tx = wide ? mx : W / 2 - tw / 2;
    const tk = a.reveal(0, 'enter', 0, 700);
    g.globalAlpha = tk;
    ui.text(g, 'SPACE', tx, ty, o1);
    ui.text(g, 'VOID', tx + w1 + gap, ty, { ...o2, color: rgba(C.cyan) });
    const ry = Math.round(ty + ts * 0.74);
    g.fillStyle = rgba(C.mid, 0.22); g.fillRect(tx, ry, tw * tk, ui.hair());
    g.fillStyle = rgba(C.cyan); g.fillRect(tx, ry - 1, 36, 2);
    ui.text(g, this.page === 'local' ? '2 PLAYERS · ONE DEVICE' : 'V2.0', tx, ry + 17,
      { size: 11, weight: 600, track: 0.24, color: rgba(C.mid, 0.9) });
    if (this.app.highScore > 0) {
      const best = ui.fmt(a.to('best', this.app.highScore, 320, 0));
      const bw = ui.text(g, best, tx + tw, ry + 17, { size: 13, weight: 700, track: 0.1, align: 'right', color: rgba(C.gold) });
      ui.text(g, 'BEST', tx + tw - bw - 10, ry + 17, { size: 11, weight: 600, track: 0.24, align: 'right', color: rgba(C.mid) });
    }
    g.globalAlpha = 1;

    // credits wallet, top-right corner
    if (progress.credits > 0) ui.wallet(g, W - mx, 38, a.to('cr', progress.credits, 260, 0));

    // ---- the list ----
    const tries = dailyAttemptsLeft();
    this.menu.buttons.forEach((b, i) => {
      const meta = ITEMS[b.action] || {};
      const sel = a.to(`row_${b.action}`, b.selected || b.hovered ? 1 : 0, 80);
      const k = a.reveal(i, 'page');
      g.globalAlpha = k;
      ui.menuRow(g, b.cx - b.w / 2 - (1 - k) * 22, b.cy - b.h / 2, b.w, b.h, b.text, {
        a: sel,
        color: meta.color || C.cyan,
        index: b.action === 'back' ? '‹' : String(i + 1).padStart(2, '0'),
        tag: b.action === 'daily' ? (tries > 0 ? `${tries} LEFT` : 'DONE') : meta.tag,
        tagColor: b.action === 'daily' && tries === 0 ? C.low : meta.color || C.cyan,
      });
    });
    g.globalAlpha = 1;

    // blurb for the focused entry (or the "no attempts" notice)
    const iy = L.bottom + 24;
    const iw = wide ? Math.max(L.rw, W * 0.4) : L.rw;
    const ix = wide ? L.x + 20 : W / 2;
    const ial = wide ? 'left' : 'center';
    if (this.dailyBlock > 0) {
      ui.text(g, 'No daily attempts left — come back after the reset!', ix, iy,
        { size: 13, weight: 600, align: ial, color: rgba(C.danger), alpha: Math.min(1, this.dailyBlock / 60), maxW: iw });
    } else {
      const meta = ITEMS[this.menu.buttons[this.menu.index].action];
      if (meta) ui.text(g, meta.info, ix, iy, { size: 13, weight: 400, align: ial, color: rgba(C.mid, 0.85), alpha: ui.ease.out(a.since('sel') / 220), maxW: iw });
    }

    // ---- daily challenge card: today's modifier, attempts, reset countdown ----
    if (this.page === 'main') {
      const cw = wide ? 340 : L.rw, ch = 62;
      const cx0 = wide ? W - mx - cw : W / 2 - cw / 2;
      const cy0 = wide ? H - 152 : iy + 22;
      const k = a.reveal(5, 'page');
      g.globalAlpha = k;
      ui.panel(g, cx0, cy0 + (1 - k) * 10, cw, ch, { accent: C.gold, cut: 10, fill: 0.55 });
      ui.text(g, 'DAILY CHALLENGE', cx0 + 18, cy0 + 20, { size: 10, weight: 700, track: 0.24, color: rgba(tries > 0 ? C.gold : C.low) });
      ui.text(g, todayMod().name, cx0 + 18, cy0 + 42, { size: 15, weight: 600, track: 0.12, maxW: cw - 150 });
      ui.pips(g, cx0 + cw - 18, cy0 + 20, tries, 3, { color: C.gold, align: 'right' });
      ui.text(g, `RESETS IN ${timeToNextDaily()}`, cx0 + cw - 18, cy0 + 43, { size: 10.5, weight: 600, track: 0.12, align: 'right', color: rgba(C.low) });
      g.globalAlpha = 1;
    }

    // ---- footer: controls ----
    const fy = H - 38;
    if (this.page === 'local') {
      if (input.isTouch) {
        ui.text(g, 'Two players share this screen · gamepads recommended (P1 = pad 1, P2 = pad 2)', wide ? mx : W / 2, fy,
          { size: 12, align: wide ? 'left' : 'center', color: rgba(C.low), maxW: W - 2 * mx });
      } else {
        const p1 = [['P1', 'WASD'], ['SHIFT', 'BOOST'], ['SPACE', 'ROCKET']];
        const p2 = [['P2', 'ARROWS'], ['RSHIFT', 'BOOST'], ['ENTER', 'ROCKET']];
        if (wide) {
          const w = ui.keyHints(g, mx, fy, p1);
          ui.keyHints(g, mx + w + 44, fy, p2);
        } else {
          ui.keyHints(g, W / 2, fy - 30, p1, { align: 'center', gap: 14 });
          ui.keyHints(g, W / 2, fy, p2, { align: 'center', gap: 14 });
        }
      }
    } else if (!input.isTouch) {
      const keys = [['SPACE', 'ROCKET'], ['E', 'LASER'], ['SHIFT', 'BOOST'], ['ESC', 'PAUSE']];
      if (wide) ui.keyHints(g, mx, fy, keys);
      else ui.keyHints(g, W / 2, fy - 14, keys, { align: 'center', gap: 14 });
    }
    ui.text(g, 'MADE BY cRc^', W - mx, wide ? fy : H - 16, { size: 10, weight: 600, track: 0.22, align: 'right', color: rgba(C.low, 0.7) });
  }
}
