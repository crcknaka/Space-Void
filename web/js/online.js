// Online lobby: pick mode, create or join a room by code, show connection status.
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { Net } from './net.js';
import { VersusOnline } from './versus_online.js';
import { CoopOnline } from './coop_online.js';

// DOM overlay to type a 4-char room code (reuses the name-input pattern)
let codeOverlay = null;
function askCode() {
  if (!codeOverlay) {
    codeOverlay = document.createElement('div');
    codeOverlay.style.cssText =
      'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.65);z-index:10;font-family:Orbitron,sans-serif;';
    codeOverlay.innerHTML = `
      <div style="background:#111;border:2px solid #09f;border-radius:10px;padding:26px 30px;text-align:center;max-width:90vw">
        <div style="color:#fff;font-size:19px;font-weight:700;margin-bottom:14px">ENTER ROOM CODE</div>
        <input id="codeov-input" maxlength="6" placeholder="ABCD" autocomplete="off" spellcheck="false"
          style="width:200px;max-width:70vw;background:#000;color:#4cf;border:1px solid #333;border-radius:6px;
          padding:10px 12px;font:700 24px Orbitron,sans-serif;text-align:center;letter-spacing:6px;outline:none;text-transform:uppercase">
        <div style="margin-top:16px;display:flex;gap:10px;justify-content:center">
          <button id="codeov-ok" style="background:#09f;color:#000;border:0;border-radius:6px;padding:10px 22px;
            font:700 15px Orbitron,sans-serif;cursor:pointer">JOIN</button>
          <button id="codeov-cancel" style="background:#444;color:#fff;border:0;border-radius:6px;padding:10px 22px;
            font:700 15px Orbitron,sans-serif;cursor:pointer">CANCEL</button>
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
    ok.onclick = () => {
      const c = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (c.length >= 4) done(c); else inp.focus();
    };
    cancel.onclick = () => done(null);
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') ok.onclick();
      if (e.key === 'Escape') cancel.onclick();
    };
  });
}

export class OnlineState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    this.phase = 'menu'; // menu | hosting | joining | error
    this.mode = 'versus';
    this.net = null;
    this.statusText = '';
    this.errorText = '';
    this.layout();
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    const cy = H / 2;
    this.modeVs = new Button('VERSUS', W / 2 - 80, cy - 150, 150, 54, 'rgb(255,140,0)', 'mode_versus');
    this.modeCo = new Button('COOP', W / 2 + 80, cy - 150, 150, 54, 'rgb(0,120,255)', 'mode_coop');
    this.menu = new ButtonGroup([
      new Button('CREATE ROOM', W / 2, cy - 50, 260, 60, 'rgb(0,220,130)', 'create'),
      new Button('JOIN ROOM', W / 2, cy + 30, 260, 60, 'rgb(0,150,255)', 'join'),
      new Button('BACK', W / 2, cy + 130, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
    this.cancelBtn = new ButtonGroup([
      new Button('CANCEL', W / 2, H - 120, 200, 56, 'rgb(255,0,0)', 'cancel'),
    ]);
    this.errorMenu = new ButtonGroup([
      new Button('TRY AGAIN', W / 2, H / 2 + 40, 220, 56, 'rgb(0,220,130)', 'retry'),
      new Button('BACK', W / 2, H / 2 + 110, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
    this.updateModeButtons();
  }

  updateModeButtons() {
    this.modeVs.selected = this.mode === 'versus';
    this.modeCo.selected = this.mode === 'coop';
  }

  onResize() { this.layout(); }

  startGame() {
    this.app.setLockWorld(true);
    if (this.mode === 'versus') this.app.setState(new VersusOnline(this.app, this.net));
    else this.app.setState(new CoopOnline(this.app, this.net, this.net.isHost));
  }

  wireNet() {
    this.net.onState = (s) => {
      if (s === 'open') { this.startGame(); return; }
      if (s === 'failed') {
        this.phase = 'error';
        this.errorText = this.net.isHost
          ? 'Connection failed. Try again or check your network.'
          : 'Could not connect — wrong code, or the host left.';
      }
    };
  }

  async host() {
    this.phase = 'hosting';
    this.statusText = 'Creating room…';
    this.net = new Net(true);
    this.wireNet();
    try {
      await this.net.createRoom();
      if (this.net.state !== 'open' && this.net.state !== 'connecting') {
        // createRoom resolved without a peer (timeout/cancel)
        if (this.phase === 'hosting' && this.net.state === 'failed') {
          this.phase = 'error';
          this.errorText = 'No one joined in time.';
        }
      }
    } catch {
      this.phase = 'error';
      this.errorText = 'Could not create the room.';
    }
  }

  async join() {
    const code = await askCode();
    if (!code) return;
    this.phase = 'joining';
    this.statusText = `Connecting to ${code}…`;
    this.net = new Net(false);
    this.wireNet();
    try {
      await this.net.joinRoom(code);
    } catch {
      this.phase = 'error';
      this.errorText = 'Could not connect.';
    }
  }

  cancelNet() {
    this.net?.cancel();
    this.net = null;
    this.phase = 'menu';
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);

    if (this.phase === 'menu') {
      // mode toggle
      for (const b of [this.modeVs, this.modeCo]) {
        const hov = b.contains(input.pointer.x, input.pointer.y);
        if (hov && !b.hovered) audio.play('hover', 0.35);
        b.hovered = hov;
        if (hov && input.pointer.justDown) {
          audio.play('click', 0.5);
          this.mode = b.action === 'mode_versus' ? 'versus' : 'coop';
          this.updateModeButtons();
        }
      }
      if (input.pressed.has('Tab')) {
        this.mode = this.mode === 'versus' ? 'coop' : 'versus';
        this.updateModeButtons();
      }
      const a = this.menu.update();
      if (a === 'create') this.host();
      else if (a === 'join') this.join();
      else if (a === 'back' || input.pressed.has('Escape')) this.app.goMenu();
    } else if (this.phase === 'hosting' || this.phase === 'joining') {
      const a = this.cancelBtn.update();
      if (a === 'cancel' || input.pressed.has('Escape')) this.cancelNet();
    } else if (this.phase === 'error') {
      const a = this.errorMenu.update();
      if (a === 'retry') { this.phase = 'menu'; }
      else if (a === 'back' || input.pressed.has('Escape')) this.app.goMenu();
    }
  }

  draw(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'ONLINE', W / 2, 110, 42, 'rgb(0,200,255)');

    if (this.phase === 'menu') {
      drawText(g, 'MODE', W / 2, H / 2 - 195, 18, 'rgb(160,160,160)');
      this.modeVs.draw(g);
      this.modeCo.draw(g);
      this.menu.draw(g);
      drawText(g, 'Play with a friend over the internet', W / 2, H - 60, 14, 'rgb(140,140,140)');
    } else if (this.phase === 'hosting') {
      drawText(g, `MODE: ${this.mode.toUpperCase()}`, W / 2, H / 2 - 150, 18, 'rgb(160,160,160)');
      if (this.net?.code) {
        drawText(g, 'ROOM CODE', W / 2, H / 2 - 90, 20, 'rgb(160,160,160)');
        drawText(g, this.net.code, W / 2, H / 2 - 30, 72, 'rgb(0,255,140)');
        drawText(g, 'Share this code with your friend', W / 2, H / 2 + 30, 16, 'rgb(200,200,200)');
        const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
        drawText(g, `Waiting for player${dots}`, W / 2, H / 2 + 70, 18, 'rgb(255,210,80)');
      } else {
        drawText(g, this.statusText, W / 2, H / 2, 20, 'rgb(200,200,200)');
      }
      this.cancelBtn.draw(g);
    } else if (this.phase === 'joining') {
      const dots = '.'.repeat(1 + (Math.floor(performance.now() / 400) % 3));
      drawText(g, `${this.statusText}${dots}`, W / 2, H / 2, 20, 'rgb(255,210,80)');
      this.cancelBtn.draw(g);
    } else if (this.phase === 'error') {
      drawText(g, 'CONNECTION FAILED', W / 2, H / 2 - 60, 30, 'rgb(255,80,80)');
      drawText(g, this.errorText, W / 2, H / 2 - 15, 15, 'rgb(200,200,200)');
      this.errorMenu.draw(g);
    }
  }
}
