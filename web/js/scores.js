// Global leaderboard screen (menu → SCORES) with mode tabs
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup } from './ui.js';
import * as ui from './ui.js';
import { Star } from './entities.js';
import { fetchTop, savedName } from './lb.js';
import { progress } from './progress.js';

const { C, rgba } = ui;
const SILVER = '206,214,226', BRONZE = '222,150,92';

const TABS = [
  { id: 'all', label: 'ALL' },
  { id: 'single', label: 'SINGLE' },
  { id: 'coop', label: 'CO-OP' },
  { id: 'daily', label: 'DAILY' },
];

export class ScoresState {
  constructor(app) {
    this.app = app;
    this.anim = new ui.Anim();
    this.time = 0;
  }

  enter() {
    this.mode = 'all';
    this.layout();
    this.load();
  }

  load() {
    this.data = undefined; // undefined = loading, null = offline
    const mode = this.mode;
    fetchTop(mode, savedName()).then((data) => {
      if (this.app.state === this && this.mode === mode) this.data = data;
    });
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    // wide: the board is anchored to the left margin and the equipped hull
    // idles on the right; narrow / portrait: full-width board
    const wide = ui.isWide(), mx = ui.gutter();
    const pw = wide ? Math.min(680, Math.round(W * 0.5)) : W - 2 * mx;
    const grow = wide ? 0 : Math.min(14, Math.max(0, H - 786) * 0.05); // tall phones: taller touch targets
    const px = mx, th = 46 + grow, ty = (wide ? 134 : 128) + grow / 2;
    const gap = 6, bw = Math.min(130, (pw - gap * (TABS.length - 1)) / TABS.length); // shrink to fit narrow widths
    this.tabButtons = TABS.map((t, i) => {
      const b = new Button(t.label, px + bw / 2 + i * (bw + gap), ty, bw, th, 'rgb(255,210,0)', `tab_${t.id}`);
      b.selected = t.id === this.mode;
      return b;
    });
    const back = wide
      ? new Button('BACK', mx + 90, H - 62, 180, 50, 'rgb(255,0,0)', 'back')
      : new Button('BACK', W / 2, H - 90, 200, 56, 'rgb(255,0,0)', 'back');
    this.menu = new ButtonGroup([back]);
    // table: header + 10 rows + "you" strip, squeezed to fit above BACK
    const top = ty + th / 2 + 16, limit = back.cy - back.h / 2 - 16;
    const rowH = Math.max(26, Math.min(40, (limit - top - 34 - 48) / 10));
    this.L = { wide, mx, px, pw, top, rowH, h: 34 + rowH * 10 + 48 };
    this.hero = wide ? { x: px + pw + (W - mx - px - pw) / 2, y: H * 0.47, size: Math.min(400, (W - mx - px - pw) * 0.62) } : null;
  }

  onResize() {
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    this.time += dt;
    this.anim.tick(dt);
    for (const s of this.stars) s.update(k);

    // tab clicks (mouse/touch only — BACK stays keyboard-selectable)
    for (const b of this.tabButtons) {
      const hov = b.contains(input.pointer.x, input.pointer.y);
      if (hov && !b.hovered) audio.play('hover', 0.35);
      b.hovered = hov;
      if (hov && input.pointer.justDown) {
        audio.play('click', 0.5);
        this.mode = b.action.slice(4);
        for (const tb of this.tabButtons) tb.selected = tb === b;
        this.load();
      }
    }

    const action = this.menu.update();
    if (action === 'back' || input.pressed.has('Escape')) this.app.goMenu();
  }

  draw(g) {
    const hero = this.hero, L = this.L, a = this.anim;
    const in3D = !!this.app.view3d?.backdrop(g, hero
      ? { ship: progress.selectedShip, x: hero.x, y: hero.y, size: hero.size }
      : {});
    ui.begin(g);
    if (in3D) ui.scrim(g, 'all', 0, L.wide ? 0.2 : 0.42);
    else {
      ui.spaceBackdrop(g);
      for (const s of this.stars) s.draw(g);
      const spr = hero && this.app.images.ships?.[progress.selectedShip];
      if (spr) {
        const sw = Math.min(280, hero.size * 0.7), sh = sw * (spr.height / spr.width);
        ui.glow(g, C.cyan, hero.x, hero.y, sw * 0.9, sw * 0.5, 0.1);
        g.drawImage(spr, hero.x - sw / 2, hero.y - sh / 2 + Math.sin(this.time / 900) * 6, sw, sh);
      }
    }
    if (L.wide) ui.scrim(g, 'left', W * 0.6, 0.5);
    ui.scrim(g, 'top', 170, 0.7);
    ui.scrim(g, 'bottom', 170, 0.6);

    ui.title(g, L.px, L.wide ? 62 : 56, this.mode === 'daily' ? 'DAILY TOP 10' : 'GLOBAL TOP 10', {
      size: L.wide ? 34 : 28, width: L.wide ? L.pw : 0,
    });
    for (const b of this.tabButtons) {
      ui.tab(g, b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h, b.text, {
        on: a.to(`on_${b.action}`, b.selected ? 1 : 0, 110), a: a.to(`h_${b.action}`, b.hovered ? 1 : 0, 90),
        color: b.action === 'tab_daily' ? C.gold : C.cyan,
      });
    }

    // ---- the board ----
    const { px, pw, top, rowH } = L;
    if (this.data !== this._seen) { this._seen = this.data; a.mark('data'); }
    ui.panel(g, px, top, pw, L.h, { accent: this.mode === 'daily' ? C.gold : C.cyan });
    const xr = px + pw - 24, xRank = px + 24, xName = px + 82;
    const head = { size: 10, weight: 700, track: 0.24, color: rgba(C.low) };
    ui.text(g, 'RANK', xRank, top + 18, head);
    ui.text(g, 'PILOT', xName, top + 18, head);
    ui.text(g, 'SCORE', xr, top + 18, { ...head, align: 'right' });
    g.fillStyle = rgba(C.mid, 0.16); g.fillRect(px + 14, top + 33, pw - 28, ui.hair());

    const me = savedName();
    const midY = top + 34 + rowH * 5;
    const note = (s) => ui.text(g, s, px + pw / 2, midY, { size: 15, weight: 500, track: 0.08, align: 'center', color: rgba(C.mid, 0.8), maxW: pw - 40 });
    if (this.data === undefined) {
      // three pulsing ticks while the request is out
      for (let i = 0; i < 3; i++) {
        g.fillStyle = rgba(C.cyan, 0.25 + 0.75 * Math.max(0, Math.sin(this.time / 220 - i * 0.9)));
        g.fillRect(px + pw / 2 - 23 + i * 18, midY - 22, 10, 3);
      }
      note('Loading…');
    } else if (this.data === null) {
      note('Leaderboard unavailable');
    } else if (!this.data.top.length) {
      note('No scores yet — be the first!');
    } else {
      const fs = Math.min(17, rowH * 0.46);
      this.data.top.slice(0, 10).forEach((e, i) => {
        const mine = me && e.name === me;
        const medal = i === 0 ? C.gold : i === 1 ? SILVER : i === 2 ? BRONZE : null;
        const col = mine ? C.ok : medal || C.mid;
        const y0 = top + 34 + i * rowH, y = y0 + rowH / 2;
        const k = a.reveal(i, 'data', 32, 380);
        g.globalAlpha = k;
        const ox = -(1 - k) * 16;
        if (mine) ui.listRow(g, px + 1, y0 + 1, pw - 2, rowH - 2, { a: 1, color: C.ok, divider: false });
        else if (i === 0) ui.fade(g, C.gold, 'r', px + 1, y0 + 1, pw * 0.7, rowH - 2, 0.1);
        if (i < 9) { g.fillStyle = rgba(C.mid, 0.07); g.fillRect(px + 14, y0 + rowH, pw - 28, ui.hair()); }
        if (medal) {
          g.beginPath();
          g.moveTo(xRank + 4 + ox, y - 5); g.lineTo(xRank + 9 + ox, y); g.lineTo(xRank + 4 + ox, y + 5); g.lineTo(xRank - 1 + ox, y);
          g.closePath(); g.fillStyle = rgba(medal); g.fill();
        }
        ui.text(g, String(i + 1).padStart(2, '0'), xRank + (medal ? 18 : 0) + ox, y + 0.5, { size: fs * 0.82, weight: 700, track: 0.08, color: rgba(col, medal || mine ? 1 : 0.6) });
        const nw = ui.text(g, e.name, xName + ox, y + 0.5, { size: fs, weight: 600, track: 0.1, color: rgba(mine || medal ? col : C.hi, mine || medal ? 1 : 0.9), maxW: pw * 0.44 });
        if (e.mode === 'coop') ui.chip(g, xName + nw + 12 + ox, y, 'CO-OP', { color: C.low, size: 9, h: 17 });
        ui.text(g, ui.fmt(e.score), xr, y + 0.5, { size: fs, weight: 600, track: 0.06, align: 'right', color: rgba(mine || medal ? col : C.hi) });
      });
      g.globalAlpha = 1;
    }
    // your own position, even outside the top-10
    const sy = top + 34 + rowH * 10;
    g.fillStyle = rgba(C.mid, 0.16); g.fillRect(px + 14, sy, pw - 28, ui.hair());
    if (this.data && this.data.top.length) {
      if (this.data.you) {
        ui.text(g, 'YOUR RANK', xRank, sy + 24, { size: 10, weight: 700, track: 0.24, color: rgba(C.ok) });
        const sw = ui.text(g, ui.fmt(this.data.you.score), xr, sy + 24.5, { size: 16, weight: 700, track: 0.06, align: 'right', color: rgba(C.ok) });
        ui.text(g, `#${this.data.you.rank}`, xr - sw - 18, sy + 24.5, { size: 16, weight: 300, track: 0.06, align: 'right', color: rgba(C.hi) });
      } else if (me) {
        ui.text(g, `${me}: no score in this board yet`, px + pw / 2, sy + 24, { size: 13, weight: 500, align: 'center', color: rgba(C.low), maxW: pw - 40 });
      }
    }

    const back = this.menu.buttons[0];
    ui.button(g, back.cx - back.w / 2, back.cy - back.h / 2, back.w, back.h, back.text, {
      a: a.to('back', back.selected || back.hovered ? 1 : 0, 80), size: 14,
    });
    if (L.wide && !input.isTouch) ui.keyHints(g, back.cx + back.w / 2 + 28, back.cy, [['ENTER', 'BACK'], ['ESC', 'BACK']]);
  }
}
