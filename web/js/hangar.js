// HANGAR — two tabs: SHIPS (browse/buy/equip) and UPGRADES (permanent
// meta-upgrades). Preview + stats only; stats are applied in game.js.
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, drawText } from './ui.js';
import { Star } from './entities.js';
import { SHIPS } from './ships.js';
import {
  progress, saveProgress, UPGRADES, upgradeLevel, upgradeCost, buyUpgrade,
} from './progress.js';

const BASE = { defaultSpeed: 5, fastSpeed: 8, shootDelay: 500, rockets: 3, lasers: 2, lives: 3, w: 50, h: 30 };

function bars(st) {
  return [
    ['SPEED', (st.fastSpeed - 6) / (10 - 6)],
    ['FIRE RATE', (560 - st.shootDelay) / (560 - 340)],
    ['HULL', (st.lives - 1) / (4 - 1)],
    ['AGILITY', (58 - st.w) / (58 - 42)],
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
    this.tab = 'ships';
    this.idx = Math.max(0, SHIPS.findIndex((s) => s.id === progress.selectedShip));
    this.upIdx = 0;
  }
  enter() { this.layout(); }
  onResize() { this.layout(); }
  owned(id) { return progress.unlockedShips.includes(id); }

  // the primary (Enter) action for the current tab
  primaryAction() {
    if (this.tab === 'ships') {
      const ship = SHIPS[this.idx];
      if (progress.selectedShip === ship.id) return { label: 'SELECTED', action: 'none', color: 'rgb(90,90,90)' };
      if (this.owned(ship.id)) return { label: 'SELECT', action: 'select', color: 'rgb(0,220,130)' };
      if (progress.credits >= ship.cost) return { label: `BUY · ${ship.cost} CR`, action: 'buy', color: 'rgb(255,205,70)' };
      return { label: `${ship.cost} CR — NOT ENOUGH`, action: 'none', color: 'rgb(120,90,60)' };
    }
    const u = UPGRADES[this.upIdx];
    const lvl = upgradeLevel(u.id);
    if (lvl >= u.max) return { label: 'MAXED OUT', action: 'none', color: 'rgb(90,90,90)' };
    const cost = upgradeCost(u.id);
    if (progress.credits >= cost) return { label: `UPGRADE · ${cost} CR`, action: 'upgrade', color: 'rgb(255,205,70)' };
    return { label: `${cost} CR — NOT ENOUGH`, action: 'none', color: 'rgb(120,90,60)' };
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    this.tabShips = new Button('SHIPS', W / 2 - 92, 128, 168, 46, 'rgb(120,220,255)', 'tab_ships');
    this.tabUpg = new Button('UPGRADES', W / 2 + 92, 128, 168, 46, 'rgb(255,205,70)', 'tab_upgrades');
    const pa = this.primaryAction();
    this.actionBtn = new Button(pa.label, W / 2, H - 166, 340, 56, pa.color, pa.action);
    this.actionBtn.selected = true; // primary CTA always shows its state colour
    this.backBtn = new Button('BACK', W / 2, H - 92, 200, 54, 'rgb(255,0,0)', 'back');
  }

  cycle(d) {
    this.idx = (this.idx + d + SHIPS.length) % SHIPS.length;
    audio.play('hover', 0.4);
    this.layout();
  }
  moveUp(d) {
    this.upIdx = (this.upIdx + d + UPGRADES.length) % UPGRADES.length;
    audio.play('hover', 0.4);
    this.layout();
  }
  setTab(t) {
    if (this.tab === t) return;
    this.tab = t;
    audio.play('click', 0.5);
    this.layout();
  }

  doAction(action) {
    if (action === 'buy') {
      const ship = SHIPS[this.idx];
      if (progress.credits >= ship.cost && !this.owned(ship.id)) {
        progress.credits -= ship.cost;
        progress.unlockedShips.push(ship.id);
        progress.selectedShip = ship.id;
        saveProgress();
        audio.playSynth('fanfare');
        this.layout();
      }
    } else if (action === 'select') {
      progress.selectedShip = SHIPS[this.idx].id;
      saveProgress();
      audio.play('click', 0.5);
      this.layout();
    } else if (action === 'upgrade') {
      if (buyUpgrade(UPGRADES[this.upIdx].id)) { audio.playSynth('fanfare'); this.layout(); }
    } else if (action === 'back') {
      this.app.goMenu();
    }
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);
    const p = input.pointer;

    // tab switch: keys + clicks
    if (input.pressed.has('Tab') || input.pressed.has('KeyQ')) this.setTab(this.tab === 'ships' ? 'upgrades' : 'ships');

    if (this.tab === 'ships') {
      if (input.pressed.has('ArrowLeft') || input.pressed.has('KeyA')) this.cycle(-1);
      if (input.pressed.has('ArrowRight') || input.pressed.has('KeyD')) this.cycle(1);
      if (p.justDown) {
        if (Math.hypot(p.x - (W / 2 - 250), p.y - H * 0.4) < 44) return this.cycle(-1);
        if (Math.hypot(p.x - (W / 2 + 250), p.y - H * 0.4) < 44) return this.cycle(1);
      }
    } else {
      if (input.pressed.has('ArrowDown') || input.pressed.has('KeyS')) this.moveUp(1);
      if (input.pressed.has('ArrowUp') || input.pressed.has('KeyW')) this.moveUp(-1);
      // click a row to select it
      if (p.justDown && p.y > 176 && p.y < 176 + UPGRADES.length * 52) {
        const row = Math.floor((p.y - 176) / 52);
        if (row >= 0 && row < UPGRADES.length && row !== this.upIdx) { this.upIdx = row; this.layout(); }
      }
    }

    // hover + clicks on the fixed buttons
    for (const b of [this.tabShips, this.tabUpg, this.actionBtn, this.backBtn]) {
      b.hovered = b.contains(p.x, p.y);
    }
    this.tabShips.selected = this.tab === 'ships';
    this.tabUpg.selected = this.tab === 'upgrades';

    if (input.pressed.has('Enter') || input.pressed.has('NumpadEnter')) { audio.play('click', 0.55); return this.doAction(this.actionBtn.action); }
    if (input.pressed.has('Escape')) return this.app.goMenu();
    if (p.justDown) {
      if (this.tabShips.contains(p.x, p.y)) return this.setTab('ships');
      if (this.tabUpg.contains(p.x, p.y)) return this.setTab('upgrades');
      if (this.actionBtn.contains(p.x, p.y)) { audio.play('click', 0.55); return this.doAction(this.actionBtn.action); }
      if (this.backBtn.contains(p.x, p.y)) return this.app.goMenu();
    }
  }

  drawShips(g) {
    const ship = SHIPS[this.idx];
    const st = { ...BASE, ...ship.stats };
    const owned = this.owned(ship.id);
    const isSel = progress.selectedShip === ship.id;
    const spr = this.app.images.ships?.[ship.id];
    const cy = H * 0.4;
    if (spr) {
      const sw = 240, sh = sw * (spr.height / spr.width);
      g.drawImage(spr, W / 2 - sw / 2, cy - sh / 2, sw, sh);
    }
    drawText(g, '‹', W / 2 - 250, cy, 52, 'rgb(150,180,220)');
    drawText(g, '›', W / 2 + 250, cy, 52, 'rgb(150,180,220)');
    drawText(g, `${this.idx + 1}/${SHIPS.length}`, W / 2, cy + 92, 14, 'rgb(120,130,150)');
    drawText(g, ship.name, W / 2, cy + 126, 30, isSel ? 'rgb(0,255,140)' : '#fff');
    const badge = isSel ? 'EQUIPPED' : owned ? 'OWNED' : `LOCKED · ${ship.cost} CR`;
    drawText(g, badge, W / 2, cy + 152, 15, isSel ? 'rgb(0,255,140)' : owned ? 'rgb(160,200,255)' : 'rgb(255,205,70)');
    drawText(g, ship.desc, W / 2, cy + 178, 15, 'rgb(190,200,215)');
    const bx = W / 2 - 150, bw = 300;
    let by = cy + 206;
    for (const [name, raw] of bars(st)) {
      const v = Math.max(0.04, Math.min(1, raw));
      drawText(g, name, bx, by, 13, 'rgb(150,160,180)', 'left');
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(bx + 96, by - 6, bw - 96, 8);
      g.fillStyle = 'rgb(90,200,255)'; g.fillRect(bx + 96, by - 6, (bw - 96) * v, 8);
      by += 24;
    }
    const tr = traits(st);
    if (tr.length) drawText(g, tr.join('  ·  '), W / 2, by + 8, 14, 'rgb(255,205,120)');
  }

  drawUpgrades(g) {
    drawText(g, 'PERMANENT UPGRADES — stack on top of your ship', W / 2, 178, 14, 'rgb(150,170,200)');
    let y = 210;
    UPGRADES.forEach((u, i) => {
      const lvl = upgradeLevel(u.id);
      const sel = i === this.upIdx;
      const ry = y + i * 52;
      if (sel) { g.fillStyle = 'rgba(120,200,255,0.12)'; g.fillRect(W / 2 - 320, ry - 20, 640, 46); }
      drawText(g, u.name, W / 2 - 300, ry, 20, sel ? '#fff' : 'rgb(200,210,225)', 'left');
      drawText(g, u.desc, W / 2 - 300, ry + 20, 12, 'rgb(140,155,180)', 'left');
      const pips = '●'.repeat(lvl) + '○'.repeat(u.max - lvl);
      drawText(g, pips, W / 2 + 150, ry, 18, lvl >= u.max ? 'rgb(0,255,140)' : 'rgb(120,220,255)', 'right');
      const right = lvl >= u.max ? 'MAX' : `${u.cost * (lvl + 1)} CR`;
      drawText(g, right, W / 2 + 300, ry, 15, lvl >= u.max ? 'rgb(0,255,140)' : 'rgb(255,205,70)', 'right');
    });
  }

  draw(g) {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);
    drawText(g, 'HANGAR', W / 2, 74, 38);
    drawText(g, `◆ ${progress.credits} CR`, W - 14, 26, 17, 'rgb(120,220,255)', 'right');
    this.tabShips.draw(g);
    this.tabUpg.draw(g);
    if (this.tab === 'ships') this.drawShips(g); else this.drawUpgrades(g);
    this.actionBtn.draw(g);
    this.backBtn.draw(g);
  }
}
