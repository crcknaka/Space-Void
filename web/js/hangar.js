// HANGAR — browse the ship roster, buy with credits, pick your loadout.
// Cosmetic + stat preview; the actual stats are applied in game.js (applyShip).
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { SHIPS } from './ships.js';
import { progress, saveProgress } from './progress.js';

const BASE = { defaultSpeed: 5, fastSpeed: 8, shootDelay: 500, rockets: 3, lasers: 2, lives: 3, w: 50, h: 30 };

// 0..1 stat bars for the preview
function bars(st) {
  return [
    ['SPEED', (st.fastSpeed - 6) / (10 - 6)],
    ['FIRE RATE', (560 - st.shootDelay) / (560 - 340)],
    ['HULL', (st.lives - 1) / (4 - 1)],
    ['AGILITY', (58 - st.w) / (58 - 42)], // smaller hitbox = more agile/survivable
  ];
}

function traits(st) {
  const t = [];
  if (st.startShield) t.push('STARTS SHIELDED');
  if (st.rockets > BASE.rockets) t.push(`+${st.rockets - BASE.rockets} ROCKETS`);
  if (st.lasers > BASE.lasers) t.push(`+${st.lasers - BASE.lasers} BEAM`);
  if (st.w < BASE.w) t.push('SMALL HITBOX');
  if (st.w > BASE.w) t.push('LARGE HITBOX');
  return t;
}

export class HangarState {
  constructor(app) {
    this.app = app;
    this.idx = Math.max(0, SHIPS.findIndex((s) => s.id === progress.selectedShip));
  }

  enter() { this.layout(); }
  onResize() { this.layout(); }

  owned(id) { return progress.unlockedShips.includes(id); }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    const ship = SHIPS[this.idx];
    const owned = this.owned(ship.id);
    const isSel = progress.selectedShip === ship.id;
    const afford = progress.credits >= ship.cost;
    // context action reflects the current ship's state
    let label, action, color;
    if (isSel) { label = 'SELECTED'; action = 'none'; color = 'rgb(90,90,90)'; }
    else if (owned) { label = 'SELECT'; action = 'select'; color = 'rgb(0,220,130)'; }
    else if (afford) { label = `BUY · ${ship.cost} CR`; action = 'buy'; color = 'rgb(255,205,70)'; }
    else { label = `${ship.cost} CR — NOT ENOUGH`; action = 'none'; color = 'rgb(120,90,60)'; }
    this.actionBtn = new Button(label, W / 2, H - 168, 320, 56, color, action);
    this.menu = new ButtonGroup([
      this.actionBtn,
      new Button('BACK', W / 2, H - 92, 200, 54, 'rgb(255,0,0)', 'back'),
    ]);
  }

  cycle(d) {
    this.idx = (this.idx + d + SHIPS.length) % SHIPS.length;
    audio.play('hover', 0.4);
    this.layout();
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);

    if (input.pressed.has('ArrowLeft') || input.pressed.has('KeyA')) this.cycle(-1);
    if (input.pressed.has('ArrowRight') || input.pressed.has('KeyD')) this.cycle(1);
    // click the side arrows to cycle
    if (input.pointer.justDown) {
      if (Math.hypot(input.pointer.x - (W / 2 - 250), input.pointer.y - H * 0.36) < 40) return this.cycle(-1);
      if (Math.hypot(input.pointer.x - (W / 2 + 250), input.pointer.y - H * 0.36) < 40) return this.cycle(1);
    }

    const a = this.menu.update();
    const ship = SHIPS[this.idx];
    if (a === 'buy') {
      if (progress.credits >= ship.cost && !this.owned(ship.id)) {
        progress.credits -= ship.cost;
        progress.unlockedShips.push(ship.id);
        progress.selectedShip = ship.id;
        saveProgress();
        audio.playSynth('fanfare');
        this.layout();
      }
    } else if (a === 'select') {
      progress.selectedShip = ship.id;
      saveProgress();
      audio.play('click', 0.5);
      this.layout();
    } else if (a === 'back' || input.pressed.has('Escape')) {
      this.app.goMenu();
    }
  }

  draw(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'HANGAR', W / 2, 78, 40);
    drawText(g, `◆ ${progress.credits} CR`, W - 14, 26, 17, 'rgb(120,220,255)', 'right');

    const ship = SHIPS[this.idx];
    const st = { ...BASE, ...ship.stats };
    const owned = this.owned(ship.id);
    const isSel = progress.selectedShip === ship.id;

    // ship preview (bank frame 0 or base sprite)
    const spr = this.app.images.ships?.[ship.id];
    const cy = H * 0.36;
    if (spr) {
      const sw = 260, sh = sw * (spr.height / spr.width);
      g.drawImage(spr, W / 2 - sw / 2, cy - sh / 2, sw, sh);
    }
    // side arrows
    drawText(g, '‹', W / 2 - 250, cy, 54, 'rgb(150,180,220)');
    drawText(g, '›', W / 2 + 250, cy, 54, 'rgb(150,180,220)');
    drawText(g, `${this.idx + 1}/${SHIPS.length}`, W / 2, cy + 96, 14, 'rgb(120,130,150)');

    // name + status badge
    drawText(g, ship.name, W / 2, cy + 132, 30, isSel ? 'rgb(0,255,140)' : '#fff');
    const badge = isSel ? 'EQUIPPED' : owned ? 'OWNED' : `LOCKED · ${ship.cost} CR`;
    drawText(g, badge, W / 2, cy + 160, 15, isSel ? 'rgb(0,255,140)' : owned ? 'rgb(160,200,255)' : 'rgb(255,205,70)');
    drawText(g, ship.desc, W / 2, cy + 186, 15, 'rgb(190,200,215)');

    // stat bars
    const bx = W / 2 - 150, bw = 300;
    let by = cy + 214;
    for (const [name, raw] of bars(st)) {
      const v = Math.max(0.04, Math.min(1, raw));
      drawText(g, name, bx, by, 13, 'rgb(150,160,180)', 'left');
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(bx + 96, by - 6, bw - 96, 8);
      g.fillStyle = 'rgb(90,200,255)';
      g.fillRect(bx + 96, by - 6, (bw - 96) * v, 8);
      by += 24;
    }
    const tr = traits(st);
    if (tr.length) drawText(g, tr.join('  ·  '), W / 2, by + 8, 14, 'rgb(255,205,120)');

    this.menu.draw(g);
  }
}
