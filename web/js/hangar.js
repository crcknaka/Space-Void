// HANGAR — two tabs: SHIPS (browse/buy/equip) and UPGRADES (permanent
// meta-upgrades). Preview + stats only; stats are applied in game.js.
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button } from './ui.js';
import * as ui from './ui.js';
import { Star } from './entities.js';
import { SHIPS } from './ships.js';
import { WEAPONS } from './weapons.js';
import {
  progress, saveProgress, UPGRADES, upgradeLevel, upgradeCost, buyUpgrade,
  exportCode, importCode,
} from './progress.js';

const { C, rgba } = ui;

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
    this.wIdx = Math.max(0, WEAPONS.findIndex((w) => w.id === progress.secondary));
    this.anim = new ui.Anim();
  }
  enter() { this.layout(); }
  onResize() { this.layout(); }
  owned(id) { return progress.unlockedShips.includes(id); }

  ownedWeapon(id) { return progress.unlockedWeapons.includes(id); }

  // the primary (Enter) action for the current tab
  primaryAction() {
    if (this.tab === 'ships') {
      const ship = SHIPS[this.idx];
      if (progress.selectedShip === ship.id) return { label: 'SELECTED', action: 'none', color: 'rgb(90,90,90)' };
      if (this.owned(ship.id)) return { label: 'SELECT', action: 'select', color: 'rgb(0,220,130)' };
      if (progress.credits >= ship.cost) return { label: `BUY · ${ship.cost} CR`, action: 'buy', color: 'rgb(255,205,70)' };
      return { label: `${ship.cost} CR — NOT ENOUGH`, action: 'none', color: 'rgb(120,90,60)' };
    }
    if (this.tab === 'weapons') {
      const wp = WEAPONS[this.wIdx];
      if (progress.secondary === wp.id) return { label: 'EQUIPPED', action: 'none', color: 'rgb(90,90,90)' };
      if (this.ownedWeapon(wp.id)) return { label: 'EQUIP', action: 'equip', color: 'rgb(0,220,130)' };
      if (progress.credits >= wp.cost) return { label: `BUY · ${wp.cost} CR`, action: 'buyw', color: 'rgb(255,205,70)' };
      return { label: `${wp.cost} CR — NOT ENOUGH`, action: 'none', color: 'rgb(120,90,60)' };
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
    // Geometry shared by update() (hit tests) and draw(). Wide screens: the
    // hull sits on a stage at the left, a detail panel carries the copy and
    // the primary action on the right. Narrow / portrait: one centred column.
    const wide = ui.isWide(), mx = ui.gutter();
    const L = this.L = { wide, mx, listY: 190, rowH: 52 };
    const pa = this.primaryAction();
    if (wide) {
      const tw = 150, ty = 134;
      this.tabShips = new Button('SHIPS', mx + tw / 2, ty, tw, 46, 'rgb(120,220,255)', 'tab_ships');
      this.tabWeap = new Button('WEAPONS', mx + tw * 1.5 + 6, ty, tw, 46, 'rgb(255,120,90)', 'tab_weapons');
      this.tabUpg = new Button('UPGRADES', mx + tw * 2.5 + 12, ty, tw, 46, 'rgb(255,205,70)', 'tab_upgrades');
      const pw = Math.max(400, Math.min(460, Math.round(W * 0.3))), px = W - mx - pw, py = 110, ph = H - py - 116;
      L.panel = { x: px, y: py, w: pw, h: ph };
      this.actionBtn = new Button(pa.label, px + pw / 2, py + ph - 54, pw - 52, 56, pa.color, pa.action);
      this.backBtn = new Button('BACK', mx + 90, H - 62, 180, 50, 'rgb(255,0,0)', 'back');
      const ew = (pw - 12) / 2;
      this.exportBtn = new Button('EXPORT', px + ew / 2, H - 62, ew, 46, 'rgb(0,200,255)', 'export');
      this.importBtn = new Button('IMPORT', px + pw - ew / 2, H - 62, ew, 46, 'rgb(0,200,255)', 'import');
      const sw = px - 28 - mx; // stage width
      L.sx = mx + sw / 2; L.sy = H * 0.5 + 4;
      L.size = Math.min(440, sw * 0.58);
      L.ax = Math.min(L.size * 0.5 + 96, sw / 2 - 30);
      L.lx = mx; L.lw = sw;
    } else {
      const tw = Math.min(160, (W - 2 * mx - 12) / 3), ts = tw + 6;
      const grow = Math.min(14, Math.max(0, H - 786) * 0.05); // tall phones: taller touch targets
      const th = 46 + grow, ty = 128 + grow / 2;
      L.listY += grow; L.rowH += Math.round(grow * 0.6);
      this.tabShips = new Button('SHIPS', W / 2 - ts, ty, tw, th, 'rgb(120,220,255)', 'tab_ships');
      this.tabWeap = new Button('WEAPONS', W / 2, ty, tw, th, 'rgb(255,120,90)', 'tab_weapons');
      this.tabUpg = new Button('UPGRADES', W / 2 + ts, ty, tw, th, 'rgb(255,205,70)', 'tab_upgrades');
      this.actionBtn = new Button(pa.label, W / 2, H - 166, Math.min(340, W - 2 * mx), 56, pa.color, pa.action);
      this.backBtn = new Button('BACK', W / 2, H - 92, Math.min(200, W * 0.34), 54, 'rgb(255,0,0)', 'back');
      // profile transfer, flanking BACK — offset/width shrink to stay on-screen
      // on narrow (portrait) layouts instead of clipping at the edges
      const ew = Math.min(150, W * 0.27);
      const eoff = Math.min(210, W / 2 - ew / 2 - 8);
      this.exportBtn = new Button('EXPORT', W / 2 - eoff, H - 92, ew, 46, 'rgb(0,200,255)', 'export');
      this.importBtn = new Button('IMPORT', W / 2 + eoff, H - 92, ew, 46, 'rgb(0,200,255)', 'import');
      // keep the stat block clear of the action button (top ~H-194)
      L.sx = W / 2; L.sy = Math.min(H * 0.4, H - 524);
      L.size = Math.min(250, W * 0.46);
      L.ax = Math.min(250, W / 2 - 44);
      L.lx = mx; L.lw = W - 2 * mx;
    }
    this.actionBtn.selected = true; // primary CTA always shows its state colour
  }

  cycle(d) {
    this.idx = (this.idx + d + SHIPS.length) % SHIPS.length;
    this.anim.mark('item');
    audio.play('hover', 0.4);
    this.layout();
  }
  moveList(d) {
    if (this.tab === 'weapons') this.wIdx = (this.wIdx + d + WEAPONS.length) % WEAPONS.length;
    else this.upIdx = (this.upIdx + d + UPGRADES.length) % UPGRADES.length;
    this.anim.mark('item');
    audio.play('hover', 0.4);
    this.layout();
  }
  setTab(t) {
    if (this.tab === t) return;
    this.tab = t;
    this.anim.mark('tab');
    this.anim.mark('item');
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
    } else if (action === 'equip') {
      progress.secondary = WEAPONS[this.wIdx].id;
      saveProgress();
      audio.play('click', 0.5);
      this.layout();
    } else if (action === 'buyw') {
      const wp = WEAPONS[this.wIdx];
      if (progress.credits >= wp.cost && !this.ownedWeapon(wp.id)) {
        progress.credits -= wp.cost;
        progress.unlockedWeapons.push(wp.id);
        progress.secondary = wp.id;
        saveProgress();
        audio.playSynth('fanfare');
        this.layout();
      }
    } else if (action === 'back') {
      this.app.goMenu();
    } else if (action === 'export') {
      const code = exportCode();
      try {
        navigator.clipboard?.writeText(code);
        this.setToast('PROFILE CODE COPIED TO CLIPBOARD');
      } catch { /* fall through to the prompt */ }
      if (!navigator.clipboard) window.prompt('Your profile code (copy it):', code);
    } else if (action === 'import') {
      const code = window.prompt('Paste a profile code to restore progress:');
      if (code) {
        if (importCode(code)) { this.idx = Math.max(0, SHIPS.findIndex((s) => s.id === progress.selectedShip)); this.layout(); this.setToast('PROFILE IMPORTED'); }
        else this.setToast('INVALID CODE');
      }
    }
  }

  setToast(msg) { this.toast = msg; this.toastAt = this._t || 0; }

  update(dt) {
    const k = dt / STEP;
    this._t = (this._t || 0) + dt;
    this.time = this._t;
    this.anim.tick(dt);
    const L = this.L;
    for (const s of this.stars) s.update(k);
    const p = input.pointer;

    // tab switch: keys + clicks (cycles SHIPS → WEAPONS → UPGRADES)
    if (input.pressed.has('Tab') || input.pressed.has('KeyQ')) {
      const order = ['ships', 'weapons', 'upgrades'];
      this.setTab(order[(order.indexOf(this.tab) + 1) % order.length]);
    }

    if (this.tab === 'ships') {
      if (input.pressed.has('ArrowLeft') || input.pressed.has('KeyA')) this.cycle(-1);
      if (input.pressed.has('ArrowRight') || input.pressed.has('KeyD')) this.cycle(1);
      if (p.justDown) {
        if (Math.hypot(p.x - (L.sx - L.ax), p.y - L.sy) < 44) return this.cycle(-1);
        if (Math.hypot(p.x - (L.sx + L.ax), p.y - L.sy) < 44) return this.cycle(1);
      }
    } else {
      const list = this.tab === 'weapons' ? WEAPONS : UPGRADES;
      if (input.pressed.has('ArrowDown') || input.pressed.has('KeyS')) this.moveList(1);
      if (input.pressed.has('ArrowUp') || input.pressed.has('KeyW')) this.moveList(-1);
      // (rows are tested inside the list column, so a tap on the action button
      // beside it can never re-target the purchase)
      if (p.justDown && p.x >= L.lx && p.x <= L.lx + L.lw && p.y > L.listY && p.y < L.listY + list.length * L.rowH) {
        const row = Math.floor((p.y - L.listY) / L.rowH);
        const key = this.tab === 'weapons' ? 'wIdx' : 'upIdx';
        if (row >= 0 && row < list.length && row !== this[key]) { this[key] = row; this.anim.mark('item'); this.layout(); }
      }
    }

    // hover + clicks on the fixed buttons
    for (const b of [this.tabShips, this.tabWeap, this.tabUpg, this.actionBtn, this.backBtn, this.exportBtn, this.importBtn]) {
      b.hovered = b.contains(p.x, p.y);
    }
    this.tabShips.selected = this.tab === 'ships';
    this.tabWeap.selected = this.tab === 'weapons';
    this.tabUpg.selected = this.tab === 'upgrades';

    if (input.pressed.has('Enter') || input.pressed.has('NumpadEnter')) { audio.play('click', 0.55); return this.doAction(this.actionBtn.action); }
    if (input.pressed.has('Escape')) return this.app.goMenu();
    if (p.justDown) {
      if (this.tabShips.contains(p.x, p.y)) return this.setTab('ships');
      if (this.tabWeap.contains(p.x, p.y)) return this.setTab('weapons');
      if (this.tabUpg.contains(p.x, p.y)) return this.setTab('upgrades');
      if (this.actionBtn.contains(p.x, p.y)) { audio.play('click', 0.55); return this.doAction(this.actionBtn.action); }
      if (this.exportBtn.contains(p.x, p.y)) { audio.play('click', 0.5); return this.doAction('export'); }
      if (this.importBtn.contains(p.x, p.y)) { audio.play('click', 0.5); return this.doAction('import'); }
      if (this.backBtn.contains(p.x, p.y)) return this.app.goMenu();
    }
  }

  // label left, value right, hairline under — used in the detail panel
  kv(g, x, y, w, label, value, color = rgba(C.hi)) {
    ui.text(g, label, x, y, { size: 11, weight: 600, track: 0.16, color: rgba(C.low) });
    if (typeof value === 'string') ui.text(g, value, x + w, y, { size: 13, weight: 600, track: 0.08, align: 'right', color });
    else value(x + w, y);
    g.fillStyle = rgba(C.mid, 0.1); g.fillRect(x, y + 15, w, ui.hair());
  }

  // round ‹ › stage buttons (hit radius 44 around the same centre, see update)
  arrow(g, cx, cy, glyph, key) {
    const p = input.pointer;
    const a = this.anim.to(key, Math.hypot(p.x - cx, p.y - cy) < 44 ? 1 : 0, 90);
    if (a > 0.01) ui.glow(g, C.cyan, cx, cy, 44, 44, 0.3 * a);
    g.beginPath(); g.arc(cx, cy, 24, 0, Math.PI * 2);
    g.fillStyle = rgba(C.ink, 0.55); g.fill();
    g.strokeStyle = rgba(a > 0.5 ? C.cyan : C.mid, 0.4 + 0.5 * a); g.lineWidth = ui.hair(); g.stroke();
    ui.text(g, glyph, cx + (glyph === '‹' ? -1 : 1) * (1 + 2 * a), cy - 2, { size: 28, weight: 300, align: 'center', color: rgba(a > 0.5 ? C.hi : C.mid) });
  }

  drawShips(g) {
    const L = this.L, a = this.anim;
    const ship = SHIPS[this.idx];
    const st = { ...BASE, ...ship.stats };
    const owned = this.owned(ship.id);
    const isSel = progress.selectedShip === ship.id;
    const spr = this.app.images.ships?.[ship.id];
    const { sx, sy } = L;
    const k = ui.ease.out(a.since('item') / 260); // copy slides in on every change

    if (L.wide) { // turntable ring under the hull
      const ry = sy + L.size * 0.36;
      ui.glow(g, C.cyan, sx, ry, L.size * 0.62, L.size * 0.14, 0.16);
      g.strokeStyle = rgba(C.cyan, 0.35); g.lineWidth = ui.hair();
      g.beginPath(); g.ellipse(sx, ry, L.size * 0.56, L.size * 0.085, 0, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = rgba(C.mid, 0.14);
      g.beginPath(); g.ellipse(sx, ry, L.size * 0.42, L.size * 0.062, 0, 0, Math.PI * 2); g.stroke();
    }
    if (spr && !this.in3D) { // 3D graphics show the real hull on a turntable instead (see draw)
      const sw = Math.min(300, L.size * 0.96), sh = sw * (spr.height / spr.width);
      g.drawImage(spr, sx - sw / 2, sy - sh / 2 + Math.sin(this._t / 900) * 4, sw, sh);
    }
    this.arrow(g, sx - L.ax, sy, '‹', 'arL');
    this.arrow(g, sx + L.ax, sy, '›', 'arR');

    // roster position: one dash per hull
    const py = L.wide ? sy + L.size * 0.36 + L.size * 0.085 + 30 : sy + 92;
    const dw = 22, dg = 6, total = SHIPS.length * dw + (SHIPS.length - 1) * dg;
    SHIPS.forEach((s, i) => {
      const on = a.to(`dot${i}`, i === this.idx ? 1 : 0, 90);
      g.fillStyle = on > 0.5 ? rgba(C.cyan, 0.4 + 0.6 * on) : rgba(this.owned(s.id) ? C.mid : C.low, 0.35);
      g.fillRect(sx - total / 2 + i * (dw + dg), py - 1.5, dw, 3);
    });

    const badge = isSel ? 'EQUIPPED' : owned ? 'OWNED' : `LOCKED · ${ship.cost} CR`;
    const badgeCol = isSel ? C.ok : owned ? C.cyan : C.gold;
    const num = `${String(this.idx + 1).padStart(2, '0')} / ${String(SHIPS.length).padStart(2, '0')}`;
    const tr = traits(st);

    if (L.wide) {
      const P = L.panel, x = P.x + 26, w = P.w - 52;
      ui.panel(g, P.x, P.y, P.w, P.h, { accent: owned ? C.cyan : C.gold });
      let y = P.y + 34;
      g.globalAlpha = k;
      const ox = (1 - k) * 14;
      ui.text(g, `HULL ${num}`, x + ox, y, { size: 11, weight: 600, track: 0.24, color: rgba(C.cyan) });
      ui.chip(g, x + w, y, badge, { color: badgeCol, align: 'right' });
      y += 40;
      ui.text(g, ship.name, x + ox, y, { size: 32, weight: 300, track: 0.2, maxW: w });
      y += 36;
      for (const ln of ui.wrap(g, ship.desc, w, { size: 14, weight: 400 })) {
        ui.text(g, ln, x + ox, y, { size: 14, weight: 400, color: rgba(C.mid, 0.9) });
        y += 20;
      }
      g.globalAlpha = 1;
      y += 12;
      // loadout readout: three figures
      g.fillStyle = rgba(C.mid, 0.12); g.fillRect(x, y, w, ui.hair());
      y += 34;
      [['LIVES', st.lives], ['ROCKETS', st.rockets], ['BEAMS', st.lasers]].forEach(([label, v], i) => {
        const cx = x + (w / 3) * i;
        if (i) { g.fillStyle = rgba(C.mid, 0.12); g.fillRect(cx - 14, y - 20, ui.hair(), 52); }
        ui.text(g, String(v), cx, y, { size: 30, weight: 300, color: rgba(C.hi), alpha: k });
        ui.text(g, label, cx, y + 26, { size: 10, weight: 600, track: 0.22, color: rgba(C.low) });
      });
      y += 50;
      g.fillStyle = rgba(C.mid, 0.12); g.fillRect(x, y, w, ui.hair());
      y += 30;
      bars(st).forEach(([name, raw], i) => {
        const v = a.to(`bar${i}`, Math.max(0.04, Math.min(1, raw)), 130, 0);
        ui.statBar(g, x, y, w, name, v, { labelW: 104 });
        y += 27;
      });
      y += 8;
      let cx = x;
      for (const t of tr) { // trait chips, wrapping
        const cw = ui.measure(g, t, { size: 10.5, weight: 700, track: 0.14 }) + 16;
        if (cx + cw > x + w + 1) { cx = x; y += 26; }
        cx += ui.chip(g, cx, y, t, { color: C.gold, a: k }) + 6;
      }
    } else {
      const w = Math.min(W - 2 * L.mx - 16, 440);
      g.globalAlpha = k;
      ui.text(g, ship.name, sx, sy + 124, { size: 28, weight: 300, track: 0.2, align: 'center', maxW: w });
      ui.chip(g, sx, sy + 153, badge, { color: badgeCol, align: 'center' });
      let y = sy + 181;
      for (const ln of ui.wrap(g, ship.desc, w, { size: 13, weight: 400 })) {
        ui.text(g, ln, sx, y, { size: 13, weight: 400, align: 'center', color: rgba(C.mid, 0.9) });
        y += 18;
      }
      g.globalAlpha = 1;
      const limit = this.actionBtn.cy - this.actionBtn.h / 2 - 12;
      const bw = Math.min(320, w), step = Math.max(17, Math.min(24, (limit - y - (tr.length ? 34 : 6)) / 4));
      y += 8;
      bars(st).forEach(([name, raw], i) => {
        const v = a.to(`bar${i}`, Math.max(0.04, Math.min(1, raw)), 130, 0);
        ui.statBar(g, sx - bw / 2, y, bw, name, v, { labelW: 96 });
        y += step;
      });
      if (tr.length && y + 12 <= limit) {
        const ws = tr.map((t) => ui.measure(g, t, { size: 10.5, weight: 700, track: 0.14 }) + 16);
        let cx = sx - (ws.reduce((p, c) => p + c, 0) + (tr.length - 1) * 6) / 2;
        tr.forEach((t, i) => { ui.chip(g, cx, y + 2, t, { color: C.gold, a: k }); cx += ws[i] + 6; });
      }
    }
  }

  // shared list for the WEAPONS and UPGRADES tabs. rows: [{ name, desc, sel,
  // nameColor, right(xr, cy) }]
  drawList(g, rows, color, note) {
    const L = this.L, a = this.anim;
    const { lx, lw, listY, rowH } = L;
    ui.panel(g, lx, listY - 10, lw, rows.length * rowH + 20, { accent: color, fill: 0.58 });
    rows.forEach((r, i) => {
      const top = listY + i * rowH;
      const k = a.reveal(i, 'tab', 40, 360);
      g.globalAlpha = k;
      ui.listRow(g, lx + 1, top + 2, lw - 2, rowH - 4, { a: a.to(`li${this.tab}${i}`, r.sel ? 1 : 0, 80), color, divider: i < rows.length - 1 });
      const tx = lx + 20 - (1 - k) * 12;
      ui.text(g, r.name, tx, top + rowH / 2 - 7, { size: 16, weight: 600, track: 0.16, color: r.nameColor || rgba(r.sel ? C.hi : C.mid), maxW: lw - 210 });
      ui.text(g, r.desc, tx, top + rowH / 2 + 12, { size: 12, weight: 400, color: rgba(C.low), maxW: lw - (L.wide ? 210 : 150) });
      r.right(lx + lw - 18, top + rowH / 2);
    });
    g.globalAlpha = 1;
    ui.text(g, note, L.wide ? lx + 20 : W / 2, listY + rows.length * rowH + 32, {
      size: 11, weight: 600, track: 0.16, align: L.wide ? 'left' : 'center', color: rgba(C.low), maxW: lw - 20,
    });
  }

  // wide layout only: copy for the highlighted list entry beside the list
  drawDetail(g, o) {
    const L = this.L, P = L.panel, x = P.x + 26, w = P.w - 52;
    const k = ui.ease.out(this.anim.since('item') / 260), ox = (1 - k) * 14;
    ui.panel(g, P.x, P.y, P.w, P.h, { accent: o.color });
    let y = P.y + 34;
    g.globalAlpha = k;
    ui.text(g, o.over, x + ox, y, { size: 11, weight: 600, track: 0.24, color: rgba(o.color), maxW: w - 110 });
    ui.chip(g, x + w, y, o.badge, { color: o.badgeColor, align: 'right' });
    y += 40;
    ui.text(g, o.name, x + ox, y, { size: 32, weight: 300, track: 0.2, maxW: w });
    y += 36;
    for (const ln of ui.wrap(g, o.desc, w, { size: 14, weight: 400 })) {
      ui.text(g, ln, x + ox, y, { size: 14, weight: 400, color: rgba(C.mid, 0.9) });
      y += 20;
    }
    y += 12;
    g.fillStyle = rgba(C.mid, 0.12); g.fillRect(x, y, w, ui.hair());
    y += 26;
    for (const [label, value, col] of o.rows) { this.kv(g, x, y, w, label, value, col); y += 34; }
    g.globalAlpha = 1;
  }

  drawUpgrades(g) {
    const u0 = UPGRADES[this.upIdx];
    this.drawList(g, UPGRADES.map((u, i) => {
      const lvl = upgradeLevel(u.id), max = lvl >= u.max;
      return {
        name: u.name, desc: u.desc, sel: i === this.upIdx,
        right: (xr, cy) => {
          ui.text(g, max ? 'MAX' : `${u.cost * (lvl + 1)} CR`, xr, cy, { size: 13, weight: 700, track: 0.1, align: 'right', color: rgba(max ? C.ok : C.gold) });
          ui.pips(g, xr - 84, cy, lvl, u.max, { color: max ? C.ok : C.cyan, align: 'right', w: this.L.wide ? 14 : 10 });
        },
      };
    }), C.gold, 'PERMANENT UPGRADES — STACK ON TOP OF YOUR SHIP');
    if (!this.L.wide) return;
    const lvl = upgradeLevel(u0.id), max = lvl >= u0.max;
    this.drawDetail(g, {
      color: C.gold, over: 'PERMANENT UPGRADE', name: u0.name, desc: `${u0.desc}. Applies to every hull you fly.`,
      badge: max ? 'MAXED' : `LEVEL ${lvl} / ${u0.max}`, badgeColor: max ? C.ok : C.cyan,
      rows: [
        ['PROGRESS', (xr, y) => ui.pips(g, xr, y, lvl, u0.max, { color: max ? C.ok : C.cyan, align: 'right', w: 22, h: 6 })],
        ['NEXT LEVEL', max ? '—' : `${upgradeCost(u0.id)} CR`, rgba(max ? C.low : C.gold)],
        ['BALANCE', `${ui.fmt(progress.credits)} CR`],
      ],
    });
  }

  drawWeapons(g) {
    const w0 = WEAPONS[this.wIdx];
    const state = (wp) => (progress.secondary === wp.id ? ['EQUIPPED', C.ok] : this.ownedWeapon(wp.id) ? ['OWNED', C.cyan] : [`${wp.cost} CR`, C.gold]);
    this.drawList(g, WEAPONS.map((wp, i) => {
      const [label, col] = state(wp);
      return {
        name: wp.name, desc: wp.desc, sel: i === this.wIdx,
        nameColor: progress.secondary === wp.id ? rgba(C.ok) : null,
        right: (xr, cy) => {
          if (col === C.gold) ui.text(g, label, xr, cy, { size: 13, weight: 700, track: 0.1, align: 'right', color: rgba(C.gold) });
          else ui.chip(g, xr, cy, label, { color: col, align: 'right' });
        },
      };
    }), C.cyan, 'SECONDARY WEAPON — AUTO-FIRES BESIDE YOUR CANNON');
    if (!this.L.wide) return;
    const [label, col] = state(w0);
    const owned = this.ownedWeapon(w0.id);
    this.drawDetail(g, {
      color: C.cyan, over: 'SECONDARY WEAPON', name: w0.name, desc: w0.desc,
      badge: owned ? label : 'LOCKED', badgeColor: col,
      rows: [
        ['CADENCE', w0.cadence ? `EVERY ${(w0.cadence / 1000).toFixed(1)} S` : '—'],
        ['PRICE', w0.cost ? `${w0.cost} CR` : 'FREE', rgba(w0.cost && !owned ? C.gold : C.mid)],
        ['BALANCE', `${ui.fmt(progress.credits)} CR`],
      ],
    });
  }

  draw(g) {
    const L = this.L, a = this.anim;
    this.in3D = !!this.app.view3d?.backdrop(g, this.tab === 'ships'
      ? { ship: SHIPS[this.idx].id, x: L.sx, y: L.sy, size: L.size, spin: 0.0007 }
      : { ship: null });
    ui.begin(g);
    if (this.in3D) {
      ui.scrim(g, 'all', 0, this.tab === 'ships' ? 0.14 : 0.34);
    } else {
      ui.spaceBackdrop(g);
      for (const s of this.stars) s.draw(g);
    }
    if (L.wide) ui.scrim(g, 'left', W * 0.4, 0.4);
    ui.scrim(g, 'top', 170, 0.72);
    ui.scrim(g, 'bottom', 170, 0.66);

    ui.title(g, L.mx, L.wide ? 62 : 56, 'HANGAR', { size: L.wide ? 34 : 28, width: L.wide ? 462 : 0 });
    ui.wallet(g, W - L.mx, L.wide ? 60 : 54, a.to('cr', progress.credits, 220));

    const tabs = [[this.tabShips, 'ships', C.cyan], [this.tabWeap, 'weapons', C.cyan], [this.tabUpg, 'upgrades', C.gold]];
    for (const [b, id, col] of tabs) {
      ui.tab(g, b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h, b.text, {
        on: a.to(`tab_${id}`, this.tab === id ? 1 : 0, 110), a: a.to(`tabh_${id}`, b.hovered ? 1 : 0, 90), color: col,
      });
    }

    if (this.tab === 'ships') this.drawShips(g);
    else if (this.tab === 'weapons') this.drawWeapons(g);
    else this.drawUpgrades(g);

    // primary action: gold = spend credits, cyan = equip, muted = nothing to do
    const ab = this.actionBtn, act = ab.action;
    ui.button(g, ab.cx - ab.w / 2, ab.cy - ab.h / 2, ab.w, ab.h, ab.text, {
      style: 'solid', disabled: act === 'none', size: 16,
      color: act === 'select' || act === 'equip' ? C.cyan : C.gold,
      a: a.to('act', ab.hovered ? 1 : 0, 90),
    });
    for (const [b, key, style] of [[this.backBtn, 'back', 'ghost'], [this.exportBtn, 'exp', 'quiet'], [this.importBtn, 'imp', 'quiet']]) {
      ui.button(g, b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h, b.text, {
        style, size: style === 'quiet' ? 12 : 14, a: a.to(`b_${key}`, b.hovered ? 1 : 0, 90),
      });
    }
    if (L.wide && !input.isTouch) {
      ui.keyHints(g, this.backBtn.cx + this.backBtn.w / 2 + 28, this.backBtn.cy, [
        this.tab === 'ships' ? ['A D', 'BROWSE'] : ['W S', 'BROWSE'], ['TAB', 'SECTION'], ['ENTER', 'CONFIRM'], ['ESC', 'BACK'],
      ]);
    }

    // transient confirmation toast
    if (this.toast && (this._t || 0) - (this.toastAt || 0) < 2600) {
      const age = (this._t || 0) - (this.toastAt || 0);
      const al = Math.min(1, age / 160) * (age > 2100 ? 1 - (age - 2100) / 500 : 1);
      ui.chip(g, L.wide ? L.sx : W / 2, L.wide ? H - 112 : H - 34, this.toast, {
        color: this.toast === 'INVALID CODE' ? C.danger : C.ok, align: 'center', a: al, h: 26, size: 11.5,
      });
    }
  }
}
