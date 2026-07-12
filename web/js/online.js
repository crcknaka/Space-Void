// Online lobby: pick mode, create or join a room by code.
//   Versus = 1:1 (Net).  Co-op = up to 4 players (CoopHub host / CoopLink guest)
//   with a host waiting-room + START button.
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { Net, CoopHub, CoopLink } from './net.js';
import { VersusOnline } from './versus_online.js';
import { CoopHost, CoopGuest } from './coop_online.js';
import { PLAYER_COLORS } from './game.js';

let codeOverlay = null;
function askCode() {
  if (!codeOverlay) {
    codeOverlay = document.createElement('div');
    codeOverlay.style.cssText =
      'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.65);z-index:10;font-family:Orbitron,sans-serif;';
    codeOverlay.innerHTML = `
      <div style="background:#111;border:2px solid #09f;border-radius:10px;padding:26px 30px;text-align:center;max-width:90vw">
        <div style="color:#fff;font-size:19px;font-weight:700;margin-bottom:14px">ENTER ROOM CODE</div>
        <input id="codeov-input" maxlength="6" placeholder="ABCD" autocomplete="off" spellcheck="false"
          style="width:200px;max-width:70vw;background:#000;color:#4cf;border:1px solid #333;border-radius:6px;padding:10px 12px;font:700 24px Orbitron,sans-serif;text-align:center;letter-spacing:6px;outline:none;text-transform:uppercase">
        <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
          <button id="codeov-ok" style="background:#09f;color:#000;border:0;border-radius:6px;padding:10px 22px;font:700 15px Orbitron,sans-serif;cursor:pointer">JOIN</button>
          <button id="codeov-cancel" style="background:#444;color:#fff;border:0;border-radius:6px;padding:10px 22px;font:700 15px Orbitron,sans-serif;cursor:pointer">CANCEL</button>
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
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);
    drawText(g, 'ONLINE', W / 2, 110, 42, 'rgb(0,200,255)');

    if (this.phase === 'menu') {
      drawText(g, 'MODE', W / 2, H / 2 - 195, 18, 'rgb(160,160,160)');
      this.modeVs.draw(g); this.modeCo.draw(g);
      this.menu.draw(g);
      drawText(g, this.mode === 'coop' ? 'Up to 4 players over the internet' : 'Play 1-on-1 over the internet', W / 2, H - 60, 14, 'rgb(140,140,140)');
    } else if (this.phase === 'hosting') {
      this.drawCode(g, 'Waiting for player…');
      this.cancelBtn.draw(g);
    } else if (this.phase === 'lobby') {
      // host co-op waiting room
      drawText(g, 'ROOM CODE', W / 2, H / 2 - 150, 20, 'rgb(160,160,160)');
      drawText(g, this.hub?.code || '…', W / 2, H / 2 - 92, 72, 'rgb(0,255,140)');
      const total = 1 + (this.hub?.count || 0);
      drawText(g, `PLAYERS: ${total} / 4`, W / 2, H / 2 - 28, 24, '#fff');
      for (let i = 0; i < 4; i++) {
        const on = i < total;
        drawText(g, i === 0 ? 'HOST (YOU)' : (on ? `PLAYER ${i + 1}` : 'OPEN'), W / 2, H / 2 + 12 + i * 26, 16, on ? PLAYER_COLORS[i % 4] : 'rgb(90,90,90)');
      }
      drawText(g, 'Share the code · press START when ready', W / 2, H - 250, 14, 'rgb(150,150,150)');
      if (total < 2) drawText(g, 'need at least one more player', W / 2, H - 230, 13, 'rgb(255,150,80)');
      this.startBtn.draw(g);
    } else if (this.phase === 'joining') {
      const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
      drawText(g, `Connecting${dots}`, W / 2, H / 2, 22, 'rgb(255,210,80)');
      this.cancelBtn.draw(g);
    } else if (this.phase === 'lobby-guest') {
      drawText(g, 'CONNECTED', W / 2, H / 2 - 40, 30, 'rgb(0,255,140)');
      const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
      drawText(g, `Waiting for host to start${dots}`, W / 2, H / 2 + 10, 18, 'rgb(255,210,80)');
      this.cancelBtn.draw(g);
    } else if (this.phase === 'error') {
      drawText(g, 'CONNECTION FAILED', W / 2, H / 2 - 60, 30, 'rgb(255,80,80)');
      drawText(g, this.errorText, W / 2, H / 2 - 15, 15, 'rgb(200,200,200)');
      this.errorMenu.draw(g);
    }
  }

  drawCode(g, waitMsg) {
    drawText(g, 'ROOM CODE', W / 2, H / 2 - 90, 20, 'rgb(160,160,160)');
    drawText(g, this.net?.code || '…', W / 2, H / 2 - 30, 72, 'rgb(0,255,140)');
    drawText(g, 'Share this code with your friend', W / 2, H / 2 + 30, 16, 'rgb(200,200,200)');
    const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
    drawText(g, `${waitMsg}${dots}`, W / 2, H / 2 + 70, 18, 'rgb(255,210,80)');
  }
}
