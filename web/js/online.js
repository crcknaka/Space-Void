// Online lobby: pick mode, create or join a room by code.
//   Versus = 1:1 (Net).  Co-op = up to 4 players (CoopHub host / CoopLink guest)
//   with a host waiting-room + START button.
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup } from './ui.js';
import * as ui from './ui.js';
import { OV } from './lb.js';
import { Star } from './entities.js';
import { Net, CoopHub, CoopLink } from './net.js';
import { VersusOnline } from './versus_online.js';
import { CoopHost, CoopGuest } from './coop_online.js';
import { PLAYER_COLORS } from './game.js';

let codeOverlay = null;
function askCode() {
  if (!codeOverlay) {
    codeOverlay = document.createElement('div');
    codeOverlay.style.cssText = OV.WRAP;
    codeOverlay.innerHTML = `
      <div style="${OV.BOX}">
        <div style="${OV.TITLE}">ENTER ROOM CODE</div>
        <input id="codeov-input" maxlength="6" placeholder="ABCD" autocomplete="off" spellcheck="false"
          style='${OV.INPUT};font-size:24px;letter-spacing:.3em'>
        <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
          <button id="codeov-ok" style='${OV.OK}'>JOIN</button>
          <button id="codeov-cancel" style='${OV.ALT}'>CANCEL</button>
        </div>
      </div>`;
    document.body.appendChild(codeOverlay);
  }
  const inp = codeOverlay.querySelector('#codeov-input');
  const ok = codeOverlay.querySelector('#codeov-ok');
  const cancel = codeOverlay.querySelector('#codeov-cancel');
  inp.value = '';
  codeOverlay.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);
  return new Promise((resolve) => {
    const done = (v) => { codeOverlay.style.display = 'none'; ok.onclick = cancel.onclick = inp.onkeydown = null; resolve(v); };
    ok.onclick = () => { const c = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); if (c.length >= 4) done(c); else inp.focus(); };
    cancel.onclick = () => done(null);
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') cancel.onclick(); };
  });
}

export class OnlineState {
  constructor(app) { this.app = app; }

  enter() {
    this.phase = 'menu'; // menu | hosting | lobby | joining | error
    this.mode = 'versus';
    this.net = null; this.hub = null; this.link = null;
    this.errorText = '';
    this.layout();
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    const cy = H / 2;
    this.modeVs = new Button('VERSUS', W / 2 - 80, cy - 150, 150, 54, 'rgb(255,140,0)', 'mode_versus');
    this.modeCo = new Button('CO-OP', W / 2 + 80, cy - 150, 150, 54, 'rgb(0,120,255)', 'mode_coop');
    this.menu = new ButtonGroup([
      new Button('CREATE ROOM', W / 2, cy - 50, 260, 60, 'rgb(0,220,130)', 'create'),
      new Button('JOIN ROOM', W / 2, cy + 30, 260, 60, 'rgb(0,150,255)', 'join'),
      new Button('BACK', W / 2, cy + 130, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
    this.cancelBtn = new ButtonGroup([new Button('CANCEL', W / 2, H - 120, 200, 56, 'rgb(255,0,0)', 'cancel')]);
    this.startBtn = new ButtonGroup([
      new Button('START', W / 2, H - 190, 220, 60, 'rgb(0,220,130)', 'start'),
      new Button('CANCEL', W / 2, H - 116, 200, 54, 'rgb(255,0,0)', 'cancel'),
    ]);
    this.errorMenu = new ButtonGroup([
      new Button('TRY AGAIN', W / 2, H / 2 + 40, 220, 56, 'rgb(0,220,130)', 'retry'),
      new Button('BACK', W / 2, H / 2 + 110, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
    this.updateModeButtons();
  }

  updateModeButtons() { this.modeVs.selected = this.mode === 'versus'; this.modeCo.selected = this.mode === 'coop'; }
  onResize() { this.layout(); }

  fail(msg) { this.phase = 'error'; this.errorText = msg; }

  /* -------- create -------- */
  async host() {
    if (this.mode === 'versus') {
      this.phase = 'hosting';
      this.net = new Net(true);
      this.net.onState = (s) => {
        if (s === 'open') { this.app.setLockWorld(true); this.app.setState(new VersusOnline(this.app, this.net)); }
        else if (s === 'failed') this.fail('No one joined, or the connection failed.');
      };
      try { await this.net.createRoom(); } catch { this.fail('Could not create the room.'); }
    } else {
      this.phase = 'lobby';
      this.hub = new CoopHub();
      try { await this.hub.createRoom(); } catch { this.fail('Could not create the room.'); }
    }
  }

  /* -------- join -------- */
  async join() {
    const code = await askCode();
    if (!code) return;
    this.phase = 'joining';
    if (this.mode === 'versus') {
      this.net = new Net(false);
      this.net.onState = (s) => {
        if (s === 'open') { this.app.setLockWorld(true); this.app.setState(new VersusOnline(this.app, this.net)); }
        else if (s === 'failed') this.fail('Could not connect — wrong code, or the host left.');
      };
      try { await this.net.joinRoom(code); } catch { this.fail('Could not connect.'); }
    } else {
      this.link = new CoopLink();
      this.link.onState = (s) => {
        if (s === 'open') this.phase = 'lobby-guest';
        else if (s === 'failed' || s === 'closed') { if (this.phase !== 'lobby-guest') this.fail('Could not connect — wrong code, or the host left.'); }
      };
      this.link.onMessage = (m) => {
        if (m.k === 'go') { this.app.setLockWorld(true); this.app.setState(new CoopGuest(this.app, this.link, m.me, m.n)); }
        else if (m.k === 'bye') this.fail('Host closed the room.');
      };
      try { await this.link.join(code); } catch { this.fail('Could not connect.'); }
    }
  }

  startCoop() {
    this.hub.locked = true;
    this.app.setLockWorld(true);
    this.app.setState(new CoopHost(this.app, this.hub));
  }

  cancelNet() {
    this.net?.cancel(); this.hub?.cancel(); this.link?.cancel();
    this.net = this.hub = this.link = null;
    this.phase = 'menu';
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);

    if (this.phase === 'menu') {
      for (const b of [this.modeVs, this.modeCo]) {
        const hov = b.contains(input.pointer.x, input.pointer.y);
        if (hov && !b.hovered) audio.play('hover', 0.35);
        b.hovered = hov;
        if (hov && input.pointer.justDown) { audio.play('click', 0.5); this.mode = b.action === 'mode_versus' ? 'versus' : 'coop'; this.updateModeButtons(); }
      }
      if (input.pressed.has('Tab')) { this.mode = this.mode === 'versus' ? 'coop' : 'versus'; this.updateModeButtons(); }
      const a = this.menu.update();
      if (a === 'create') this.host();
      else if (a === 'join') this.join();
      else if (a === 'back' || input.pressed.has('Escape')) this.app.goMenu();
    } else if (this.phase === 'lobby') {
      // host waiting room
      const total = 1 + (this.hub?.count || 0);
      const a = this.startBtn.update();
      if (a === 'start' && total >= 2) this.startCoop();
      else if (a === 'cancel' || input.pressed.has('Escape')) this.cancelNet();
    } else if (this.phase === 'hosting' || this.phase === 'joining' || this.phase === 'lobby-guest') {
      const a = this.cancelBtn.update();
      if (a === 'cancel' || input.pressed.has('Escape')) this.cancelNet();
    } else if (this.phase === 'error') {
      const a = this.errorMenu.update();
      if (a === 'retry') this.phase = 'menu';
      else if (a === 'back' || input.pressed.has('Escape')) this.app.goMenu();
    }
  }

  draw(g) {
    const { C, rgba } = ui;
    ui.begin(g);
    ui.spaceBackdrop(g);
    for (const s of this.stars) s.draw(g);
    ui.title(g, W / 2, 96, 'ONLINE', { size: 34, align: 'center', sub: this.mode === 'coop' ? 'CO-OP · UP TO 4 PLAYERS' : 'VERSUS · 1 ON 1' });
    const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
    const status = (str, y, color = C.gold) => ui.text(g, str, W / 2, y, { size: 12, weight: 700, track: 0.22, align: 'center', color: rgba(color), maxW: W - 40 });

    if (this.phase === 'menu') {
      const last = this.menu.buttons[this.menu.buttons.length - 1];
      const pw = Math.min(360, W - 32), top = this.modeVs.cy - 74, bottom = last.cy + last.h / 2 + 24;
      ui.panel(g, W / 2 - pw / 2, top, pw, bottom - top, { title: 'MODE' });
      // mode switch: two tabs
      for (const b of [this.modeVs, this.modeCo]) {
        b.glow = (b.glow || 0) + ((b.selected ? 1 : 0) - (b.glow || 0)) * 0.25;
        ui.tab(g, b.cx - b.w / 2, b.cy - b.h / 2 + 4, b.w, b.h - 8, b.text, { on: b.glow, a: b.hovered ? 1 : 0, color: b === this.modeVs ? C.gold : C.cyan });
      }
      this.menu.draw(g);
      ui.text(g, this.mode === 'coop' ? 'Up to 4 players over the internet' : 'Play 1-on-1 over the internet', W / 2, H - 60, { size: 13, align: 'center', color: rgba(C.mid, 0.8), maxW: W - 40 });
    } else if (this.phase === 'hosting') {
      this.drawCode(g, 'Waiting for player');
      this.cancelBtn.draw(g);
    } else if (this.phase === 'lobby') {
      // host co-op waiting room
      const pw = Math.min(360, W - 32), top = H / 2 - 190;
      ui.panel(g, W / 2 - pw / 2, top, pw, 312, { title: 'ROOM CODE' });
      ui.text(g, this.hub?.code || '…', W / 2, H / 2 - 92, { size: 60, weight: 300, track: 0.3, align: 'center', color: rgba(C.cyan), maxW: pw - 40 });
      const total = 1 + (this.hub?.count || 0);
      ui.text(g, 'PLAYERS', W / 2 - pw / 2 + 22, H / 2 - 28, { size: 10, weight: 700, track: 0.24, color: rgba(C.low) });
      ui.text(g, `${total} / 4`, W / 2 + pw / 2 - 22, H / 2 - 28, { size: 13, weight: 700, track: 0.1, align: 'right' });
      for (let i = 0; i < 4; i++) {
        const on = i < total, y = H / 2 + 12 + i * 26;
        g.fillStyle = rgba(C.mid, 0.1); g.fillRect(W / 2 - pw / 2 + 22, y - 13, pw - 44, ui.hair());
        ui.hudIconPips(g, W / 2 - pw / 2 + 24, y, on ? 1 : 0, 1, { size: 8, color: C.ok });
        ui.text(g, i === 0 ? 'HOST (YOU)' : (on ? `PLAYER ${i + 1}` : 'OPEN'), W / 2 - pw / 2 + 44, y + 0.5,
          { size: 13, weight: 600, track: 0.14, color: on ? PLAYER_COLORS[i % 4] : rgba(C.low, 0.7) });
      }
      status('SHARE THE CODE · PRESS START WHEN READY', H - 250, C.mid);
      if (total < 2) status('NEED AT LEAST ONE MORE PLAYER', H - 230, C.gold);
      this.startBtn.draw(g);
    } else if (this.phase === 'joining') {
      status(`CONNECTING${dots}`, H / 2);
      this.cancelBtn.draw(g);
    } else if (this.phase === 'lobby-guest') {
      ui.text(g, 'CONNECTED', W / 2, H / 2 - 40, { size: 28, weight: 300, track: 0.3, align: 'center', color: rgba(C.ok) });
      status(`WAITING FOR HOST TO START${dots}`, H / 2 + 10);
      this.cancelBtn.draw(g);
    } else if (this.phase === 'error') {
      const pw = Math.min(400, W - 32);
      ui.panel(g, W / 2 - pw / 2, H / 2 - 110, pw, 270, { accent: C.danger });
      ui.text(g, 'CONNECTION FAILED', W / 2, H / 2 - 62, { size: 22, weight: 300, track: 0.26, align: 'center', color: rgba(C.danger), maxW: pw - 40 });
      ui.text(g, this.errorText, W / 2, H / 2 - 22, { size: 13, align: 'center', color: rgba(C.mid), maxW: pw - 40 });
      this.errorMenu.draw(g);
    }
  }

  drawCode(g, waitMsg) {
    const { C, rgba } = ui;
    const pw = Math.min(360, W - 32);
    ui.panel(g, W / 2 - pw / 2, H / 2 - 130, pw, 230, { title: 'ROOM CODE' });
    ui.text(g, this.net?.code || '…', W / 2, H / 2 - 30, { size: 60, weight: 300, track: 0.3, align: 'center', color: rgba(C.cyan), maxW: pw - 40 });
    ui.text(g, 'Share this code with your friend', W / 2, H / 2 + 30, { size: 13, align: 'center', color: rgba(C.mid), maxW: pw - 40 });
    const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
    ui.text(g, `${waitMsg.toUpperCase()}${dots}`, W / 2, H / 2 + 70, { size: 12, weight: 700, track: 0.22, align: 'center', color: rgba(C.gold) });
  }
}
