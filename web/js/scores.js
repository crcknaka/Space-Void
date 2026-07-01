// Global leaderboard screen (menu → SCORES)
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { fetchTop } from './lb.js';

export class ScoresState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    this.top = undefined; // undefined = loading, null = offline, [] = empty
    this.layout();
    fetchTop().then((top) => {
      if (this.app.state === this) this.top = top;
    });
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    this.menu = new ButtonGroup([
      new Button('BACK', W / 2, H - 110, 200, 60, 'rgb(255,0,0)', 'back'),
    ]);
  }

  onResize() {
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);
    const action = this.menu.update();
    if (action === 'back' || input.pressed.has('Escape')) this.app.goMenu();
  }

  draw(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'GLOBAL TOP 10', W / 2, 120, 40, 'rgb(255,210,80)');

    if (this.top === undefined) {
      drawText(g, 'Loading…', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else if (this.top === null) {
      drawText(g, 'Leaderboard unavailable', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else if (!this.top.length) {
      drawText(g, 'No scores yet — be the first!', W / 2, H / 2, 22, 'rgb(150,150,150)');
    } else {
      const y0 = 200;
      this.top.forEach((e, i) => {
        const col = i === 0 ? 'rgb(255,215,0)' : i === 1 ? 'rgb(200,200,210)' : i === 2 ? 'rgb(205,130,60)' : 'rgb(190,190,190)';
        const y = y0 + i * 44;
        drawText(g, `${i + 1}`, W / 2 - 190, y, 22, col, 'left');
        drawText(g, e.name, W / 2 - 140, y, 22, col, 'left');
        drawText(g, String(e.score), W / 2 + 150, y, 22, col, 'right');
        drawText(g, e.mode === 'coop' ? 'CO' : '', W / 2 + 190, y, 14, 'rgb(120,120,120)', 'right');
      });
    }

    this.menu.draw(g);
  }
}
