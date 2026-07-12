// Global leaderboard screen (menu → SCORES) with mode tabs
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { fetchTop, savedName } from './lb.js';

const TABS = [
  { id: 'all', label: 'ALL' },
  { id: 'single', label: 'SINGLE' },
  { id: 'coop', label: 'CO-OP' },
  { id: 'daily', label: 'DAILY' },
];

export class ScoresState {
  constructor(app) {
    this.app = app;
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
    this.tabButtons = TABS.map((t, i) => {
      const bw = Math.min(118, (W - 36) / TABS.length - 8); // shrink to fit narrow widths
      const x = W / 2 + (i - (TABS.length - 1) / 2) * (bw + 8);
      const b = new Button(t.label, x, 170, bw, 44, 'rgb(255,210,0)', `tab_${t.id}`);
      b.selected = t.id === this.mode;
      return b;
    });
    this.menu = new ButtonGroup([
      new Button('BACK', W / 2, H - 90, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
  }

  onResize() {
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
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
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);

    drawText(g, this.mode === 'daily' ? 'DAILY TOP 10' : 'GLOBAL TOP 10', W / 2, 100, 38, 'rgb(255,210,80)');
    for (const b of this.tabButtons) b.draw(g);

    const me = savedName();
    if (this.data === undefined) {
      drawText(g, 'Loading…', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else if (this.data === null) {
      drawText(g, 'Leaderboard unavailable', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else if (!this.data.top.length) {
      drawText(g, 'No scores yet — be the first!', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else {
      const y0 = 250;
      this.data.top.forEach((e, i) => {
        const mine = me && e.name === me;
        const col = mine ? 'rgb(0,255,140)'
          : i === 0 ? 'rgb(255,215,0)'
          : i === 1 ? 'rgb(200,200,210)'
          : i === 2 ? 'rgb(205,130,60)'
          : 'rgb(190,190,190)';
        const y = y0 + i * 42;
        drawText(g, `${i + 1}`, W / 2 - 190, y, 21, col, 'left');
        drawText(g, e.name, W / 2 - 140, y, 21, col, 'left');
        drawText(g, String(e.score), W / 2 + 150, y, 21, col, 'right');
        drawText(g, e.mode === 'coop' ? 'CO' : '', W / 2 + 190, y, 13, 'rgb(120,120,120)', 'right');
      });
      // your own position, even outside the top-10 (kept clear of BACK)
      const sy = Math.min(y0 + 10 * 42 + 24, this.menu.buttons[0].cy - 40);
      if (this.data.you) {
        drawText(g, `YOU: #${this.data.you.rank} · ${this.data.you.score}`, W / 2, sy, 20, 'rgb(0,255,140)');
      } else if (me) {
        drawText(g, `${me}: no score in this board yet`, W / 2, sy, 16, 'rgb(130,130,130)');
      }
    }

    this.menu.draw(g);
  }
}
