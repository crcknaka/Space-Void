// Online Co-op — one player HOSTS the authoritative world and streams compact
// snapshots; the GUEST predicts its own ship and renders from snapshots.
import { W, H, STEP, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import { GameState } from './game.js';
import { Player, Explosion, RocketTrailParticle, SmokeParticle, Spark } from './entities.js';
import { tinted, glowBullet, glowEnemyBullet, glowEngine, drawGlow } from './fx.js';

const ETYPE = { basic: 0, weaver: 1, hunter: 2, tank: 3 };
const ETYPE_NAME = ['basic', 'weaver', 'hunter', 'tank'];
const ETINT = ['', 'rgba(0,230,190,0.35)', 'rgba(255,60,60,0.4)', 'rgba(190,110,255,0.42)'];
const PU_TYPES = ['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread', 'shield'];
const PU_IMG = { shooting: 'powerup', slow_motion: 'slow_motion_powerup', kill_all: 'kill_all_powerup', rocket: 'rocket_powerup', spread: 'spread_powerup' };
const SEND_MS = 22; // ~45Hz snapshots; guest extrapolates between them

// Factory: `new CoopOnline(app, net, isHost)` returns the right instance.
export function CoopOnline(app, net, isHost) {
  return isHost ? new CoopHost(app, net) : new CoopGuest(app, net);
}

/* ------------------------------------ HOST ------------------------------------ */

class CoopHost {
  constructor(app, net) { this.app = app; this.net = net; }

  enter() {
    this.guest = { x: 100, y: H / 3, has: false };
    this.sendAcc = 0;
    this.disconnected = false;
    this.reconnecting = false;
    this.overMenu = null;
    this.initGame();
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s) => {
      if (s === 'closed') this.disconnected = true;
      else if (s === 'reconnecting') this.reconnecting = true;
      else if (s === 'open') this.reconnecting = false;
    };
    this.net.send({ k: 'go' });
  }

  initGame() {
    this.g = new GameState(this.app, true, { online: true });
    this.g.enter();
    this.g.pauseDisabled = true;          // no pause in online
    this.g.player2.controls = {};         // guest drives player2, not local keys
    // record explosions to replay on the guest
    this._fx = [];
    const orig = this.g.explode.bind(this.g);
    this.g.explode = (x, y, sound = true, scale = 1) => { this._fx.push([Math.round(x), Math.round(y), +scale.toFixed(2)]); return orig(x, y, sound, scale); };
    this.overMenu = null;
  }

  playAgain() {
    this.net.send({ k: 'restart' });
    this.initGame();
    this.net.send({ k: 'go' });
  }

  onMessage(m) {
    if (m.k === 'in') { this.guest.x = m.x; this.guest.y = m.y; this.guest.has = true; }
    else if (m.k === 'rk') { if (this.g.player2.alive) this.g.player2.fireRocket(this.g); }
    else if (m.k === 'bye') this.disconnected = true;
  }

  update(dt) {
    if (input.pressed.has('Escape') || this.g.requestLeave) { this.leave(); return; }
    if (this.disconnected) { if (input.pressed.size || input.pointer.justDown) this.leave(); return; }

    // game over: offer PLAY AGAIN / LEAVE (host-driven)
    if (this.g.over && this.g.overAlpha >= 0.5) {
      if (!this.overMenu) {
        this.overMenu = new ButtonGroup([
          new Button('PLAY AGAIN', W / 2, H / 2 + 90, 220, 56, 'rgb(0,220,130)', 'again'),
          new Button('LEAVE', W / 2, H / 2 + 160, 220, 56, 'rgb(255,0,0)', 'leave'),
        ]);
      }
      const a = this.overMenu.update();
      if (a === 'again') { this.playAgain(); return; }
      if (a === 'leave') { this.leave(); return; }
      // keep streaming the frozen over-state so the guest shows game over
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_MS) { this.sendAcc = 0; this.net.send(this.snapshot()); }
      return;
    }

    // place guest-controlled ship before the world simulates collisions
    const p2 = this.g.player2;
    if (p2.alive && this.guest.has) {
      p2.x = clamp(this.guest.x, p2.w / 2, W - p2.w / 2);
      p2.y = clamp(this.guest.y, p2.h / 2, H - p2.h / 2);
    }

    this.g.update(dt); // explosions accumulate in this._fx across frames

    this.sendAcc += dt;
    if (this.sendAcc >= SEND_MS) {
      this.sendAcc = 0;
      this.net.send(this.snapshot());
      this._fx.length = 0; // clear only after the batch is sent (no lost explosions)
    }
  }

  snapshot() {
    const g = this.g;
    const m = g.speedMul; // velocities are per-step; guest extrapolates between snapshots
    const enc = (p) => [Math.round(p.x), Math.round(p.y), p.alive ? 1 : 0, p.lives, p.rockets, g.time < (p.invulnUntil || 0) ? 1 : 0];
    return {
      k: 'w',
      sc: g.score, lv: g.level,
      warn: g.bossWarnStart ? 1 : 0,
      ban: g.levelBanner ? g.levelBanner.level : 0,
      slow: g.speedMul < 1 ? 1 : 0,
      p1: enc(g.player1), p2: enc(g.player2),
      // [x, y, type, dying, hpFrac, w, vx, vy]
      en: g.enemies.map((e) => [Math.round(e.x), Math.round(e.y), e.isBoss ? 4 : ETYPE[e.type], e.dying ? 1 : 0,
        e.isBoss ? Math.max(0, e.health) / e.maxHealth : 1, Math.round(e.w),
        Math.round((e.vx || 0) * m * 10) / 10, Math.round((e.dying ? (e.vyFall || 0) : (e.vy || 0)) * m * 10) / 10]),
      eb: g.enemyBullets.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx * m), Math.round(b.vy * m)]),
      pb: g.bullets.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]),
      ro: g.rockets.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.angle)]),
      as: g.asteroids.map((a) => [Math.round(a.x), Math.round(a.y), Math.round(a.w / 2), Math.round(a.angle),
        Math.round(-a.vx * m * 10) / 10, Math.round(a.vy * m * 10) / 10]),
      pu: g.powerups.map((p) => [Math.round(p.x), Math.round(p.y), PU_TYPES.indexOf(p.type)]),
      fx: this._fx.slice(),
      over: g.over ? 1 : 0,
    };
  }

  leave() { try { this.net.send({ k: 'bye' }); } catch {} this.net.close(); this.app.goMenu(); }
  onResize() { this.g.onResize(); }

  draw(gg) {
    this.g.draw(gg);
    drawText(gg, 'ONLINE · HOST', W / 2, H - 16, 13, 'rgb(0,200,255)');
    drawPing(gg, this.net.rtt);
    if (this.overMenu && this.g.over) this.overMenu.draw(gg);
    if (this.reconnecting && !this.disconnected) {
      gg.fillStyle = 'rgba(0,0,0,0.5)'; gg.fillRect(0, 0, W, H);
      const dots = '.'.repeat(1 + (Math.floor(this.g.time / 400) % 3));
      drawText(gg, `RECONNECTING${dots}`, W / 2, H / 2, 30, 'rgb(255,210,80)');
    }
    if (this.disconnected) {
      gg.fillStyle = 'rgba(0,0,0,0.6)'; gg.fillRect(0, 0, W, H);
      drawText(gg, 'PARTNER DISCONNECTED', W / 2, H / 2, 26, 'rgb(255,90,90)');
      drawText(gg, 'press any key to return', W / 2, H / 2 + 40, 15, 'rgb(180,180,180)');
    }
  }
}

// shared ping badge
function drawPing(g, rtt) {
  if (!rtt) return;
  const col = rtt < 80 ? 'rgb(0,220,130)' : rtt < 160 ? 'rgb(255,210,60)' : 'rgb(255,90,90)';
  drawText(g, `${rtt} ms`, W / 2, H - 34, 13, col);
}

/* ------------------------------------ GUEST ----------------------------------- */

class CoopGuest extends BaseWorld {
  constructor(app, net) { super(app, 'game_background'); this.net = net; }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');
    this.initBackdrop();
    this.disconnected = false;
    this.reconnecting = false;
    this.frame = 0;

    // locally-predicted own ship (player2)
    this.me = new Player(images, { img: images.player2_ship, thrusters: images.thrusters.player2, controls: {}, autoShoot: false, useRockets: false });
    this.resetRound();

    this.puImg = {};
    for (const t of PU_TYPES) this.puImg[t] = t === 'shield' ? tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield') : images[PU_IMG[t]];
    this.enemyTint = {};

    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s) => {
      if (s === 'closed') this.disconnected = true;
      else if (s === 'reconnecting') this.reconnecting = true;
      else if (s === 'open') this.reconnecting = false;
    };
  }

  resetRound() {
    this.snap = null;
    this.phase = 'wait';
    this.sendAcc = 0;
    this.lastBan = 0;
    this.lastWarn = 0;
    this.me.x = 100; this.me.y = H / 3;
    this.meAlive = true; this.meLives = 3; this.meRockets = 3; this.meInv = 0;
    this.effects = [];
  }

  rocketBtn() { return { x: W - 70, y: H - 80, r: 44 }; }
  leaveBtn() { return { x: 34, y: 122, r: 22 }; }

  // touch: drag to move, tap rocket button to fire, tap X to leave
  handleTouch() {
    if (!input.isTouch) return;
    const rb = this.rocketBtn(), lb = this.leaveBtn();
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (Math.hypot(pt.x - lb.x, pt.y - lb.y) <= lb.r) { this.leave(); return; }
      if (Math.hypot(pt.x - rb.x, pt.y - rb.y) <= rb.r) { this.net.send({ k: 'rk' }); continue; }
      if (!this.drag && this.meAlive) this.drag = { id, px: pt.x, py: pt.y, ox: this.me.x, oy: this.me.y };
    }
    if (this.drag) {
      const pt = input.pointers.get(this.drag.id);
      if (pt && this.meAlive) {
        this.me.x = clamp(this.drag.ox + (pt.x - this.drag.px) * 1.25, this.me.w / 2, W - this.me.w / 2);
        this.me.y = clamp(this.drag.oy + (pt.y - this.drag.py) * 1.25, this.me.h / 2, H - this.me.h / 2);
      } else this.drag = null;
    }
  }

  onMessage(m) {
    if (m.k === 'restart') { this.resetRound(); }
    else if (m.k === 'go') { this.phase = 'play'; }
    else if (m.k === 'bye') this.disconnected = true;
    else if (m.k === 'w') {
      if (this.phase === 'wait') this.phase = 'play';
      this.snap = m;
      this.snapAt = this.time; // for render-time extrapolation
      // adopt authoritative own-ship status
      this.meAlive = m.p2[2] === 1; this.meLives = m.p2[3]; this.meRockets = m.p2[4]; this.meInv = m.p2[5];
      if (!this.meAlive) { this.me.x = m.p2[0]; this.me.y = m.p2[1]; } // freeze at host pos while dead/respawning
      // replay explosions + edge-triggered sfx
      for (const f of m.fx) {
        this.effects.push(new Explosion(f[0], f[1], this.app.images.explosion_spritesheet, this.time, f[2]));
        audio.play('explosion', 0.4);
      }
      if (m.ban && m.ban !== this.lastBan) { audio.playSynth('fanfare'); this.lastBan = m.ban; }
      if (m.warn && !this.lastWarn) audio.playSynth('warning');
      this.lastWarn = m.warn;
    }
  }

  tint(type, img) {
    if (type === 0 || type === 4) return img;
    const key = `enemy_${type}`;
    if (!this.enemyTint[key]) this.enemyTint[key] = tinted(this.app.images.enemy_ship, ETINT[type], key);
    return this.enemyTint[key];
  }

  update(dt) {
    this.k = dt / STEP;
    this.time += dt;
    this.frame++;
    this.updateBackdrop(dt);

    if (input.pressed.has('Escape')) { this.leave(); return; }
    if (this.disconnected) { if (input.pressed.size || input.pointer.justDown) this.leave(); return; }

    // predict own ship from local input
    if (this.phase === 'play' && this.meAlive) {
      const kk = input.keys, pad = input.pads[0];
      const boost = kk.has('ShiftLeft') || kk.has('ShiftRight') || (pad && pad.boost);
      const sp = (boost ? this.me.fastSpeed : this.me.defaultSpeed) * this.k;
      if (kk.has('KeyW') || kk.has('ArrowUp')) this.me.y -= sp;
      if (kk.has('KeyS') || kk.has('ArrowDown')) this.me.y += sp;
      if (kk.has('KeyA') || kk.has('ArrowLeft')) this.me.x -= sp;
      if (kk.has('KeyD') || kk.has('ArrowRight')) this.me.x += sp;
      if (pad) { this.me.x += pad.x * sp; this.me.y += pad.y * sp; }
      this.me.x = clamp(this.me.x, this.me.w / 2, W - this.me.w / 2);
      this.me.y = clamp(this.me.y, this.me.h / 2, H - this.me.h / 2);
      if (input.pressed.has('Space') || input.pressed.has('Enter') || input.pressed.has('NumpadEnter') || (pad && pad.fire && this.time - (this._lr || 0) > 300)) {
        this._lr = this.time; this.net.send({ k: 'rk' });
      }
      this.handleTouch();
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_MS) { this.sendAcc = 0; this.net.send({ k: 'in', x: Math.round(this.me.x), y: Math.round(this.me.y) }); }
    } else if (input.isTouch) {
      // still allow the leave button while dead/respawning
      const lb = this.leaveBtn();
      for (const [, pt] of input.pointers) if (pt.justDown && Math.hypot(pt.x - lb.x, pt.y - lb.y) <= lb.r) { this.leave(); return; }
    }
    if (this.time - (this.me.thrLast || 0) > 50) { this.me.thrLast = this.time; this.me.thrFrame = (this.me.thrFrame + 1) % this.me.thrusters.length; }

    // Cosmetic effects the host simulates but doesn't stream: regenerate them
    // locally from the snapshot so the guest sees rocket trails + wrecks that
    // spark, smoke and fall — matching the host's view.
    const s = this.snap;
    if (s && this.phase === 'play' && !s.over) {
      for (const r of s.ro) this.effects.push(new RocketTrailParticle(r[0], r[1], this.time));
      for (const e of s.en) {
        if (!e[3]) continue; // only dying wrecks
        if (Math.random() < 0.6) this.effects.push(new SmokeParticle(e[0], e[1], this.time));
        if (Math.random() < 0.25) this.effects.push(new Spark(e[0], e[1], this.time, -Math.PI / 2));
      }
    }

    for (const fx of this.effects) fx.update(this);
    this.effects = this.effects.filter((fx) => !fx.dead);
  }

  leave() { try { this.net.send({ k: 'bye' }); } catch {} this.net.close(); this.app.goMenu(); }

  draw(g) {
    const { images } = this.app;
    this.drawBackdrop(g);
    const s = this.snap;

    if (s) {
      // extrapolate positions between snapshots by velocity for smooth motion
      const ex = Math.min(this.time - (this.snapAt || this.time), 60) / STEP;
      for (const p of s.pu) { const t = PU_TYPES[p[2]] || 'shooting'; const img = this.puImg[t]; g.drawImage(img, p[0] - 30, p[1] - 15, 60, 30); }
      for (const a of s.as) { const ax = a[0] + (a[4] || 0) * ex, ay = a[1] + (a[5] || 0) * ex; g.save(); g.translate(ax, ay); g.rotate(a[3] * Math.PI / 180); g.drawImage(images.asteroid, -a[2], -a[2], a[2] * 2, a[2] * 2); g.restore(); }
      // enemies
      const thr = images.thrusters.enemy[this.frame >> 2 & 3];
      for (const e of s.en) {
        const w = e[5] || 50, h = e[2] === 4 ? w : Math.round(w * 0.6);
        const cx = e[0] + (e[6] || 0) * ex, cy = e[1] + (e[7] || 0) * ex;
        if (e[3]) g.globalAlpha = 0.6; // dying
        if (e[2] !== 4) {
          g.save(); g.translate(cx + w / 2 + 12, cy); g.scale(-1, 1); g.drawImage(thr, -32, -32, 64, 64); g.restore();
        }
        g.drawImage(this.tint(e[2], e[2] === 4 ? images.boss : images.enemy_ship), cx - w / 2, cy - h / 2, w, h);
        g.globalAlpha = 1;
        if (e[2] === 4) { // boss health bar
          const bw = 120; g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(cx - bw / 2, cy - h / 2 - 14, bw, 8);
          g.fillStyle = '#f33'; g.fillRect(cx - bw / 2, cy - h / 2 - 14, bw * e[4], 8);
        }
      }
      for (const b of s.pb) { const x = b[0] + (b[2] || 0) * ex, y = b[1] + (b[3] || 0) * ex; drawGlow(g, glowBullet, x, y); g.drawImage(images.bullet, x - 5, y - 2.5, 10, 5); }
      for (const b of s.eb) { const x = b[0] + (b[2] || 0) * ex, y = b[1] + (b[3] || 0) * ex; drawGlow(g, glowEnemyBullet, x, y); g.drawImage(images.enemy_bullet, x - 5, y - 2.5, 10, 5); }
      for (const r of s.ro) { const rad = r[2] * Math.PI / 180, x = r[0] + 8 * Math.cos(rad) * ex, y = r[1] + 8 * Math.sin(rad) * ex; drawGlow(g, glowEngine, x, y, 0.8); g.save(); g.translate(x, y); g.rotate(rad); g.drawImage(images.rocket, -10, -5, 20, 10); g.restore(); }
      for (const fx of this.effects) fx.draw(g, this);

      // player1 (host) from snapshot
      if (s.p1[2]) this.drawShip(g, images.player1_ship, images.thrusters.player1, s.p1[0], s.p1[1], false, s.p1[5]);
      // own ship (predicted)
      if (this.meAlive) this.drawShip(g, images.player2_ship, images.thrusters.player2, this.me.x, this.me.y, false, this.meInv);

      if (s.slow) { g.fillStyle = 'rgba(80,150,255,0.08)'; g.fillRect(0, 0, W, H); }

      // HUD
      drawText(g, `Score: ${s.sc}`, 10, 24, 26, '#fff', 'left');
      drawText(g, `Level: ${s.lv}`, W - 10, 24, 26, '#fff', 'right');
      drawText(g, 'P1', 10, 58, 22, '#fff', 'left');
      drawText(g, '♥'.repeat(Math.max(0, s.p1[3])), 48, 58, 22, 'rgb(255,80,90)', 'left');
      drawText(g, 'YOU', 10, 90, 22, 'rgb(0,255,140)', 'left');
      drawText(g, '♥'.repeat(Math.max(0, this.meLives)), 62, 90, 22, 'rgb(255,80,90)', 'left');
      drawText(g, `Rockets: ${this.meRockets}`, 150, 90, 22, '#fff', 'left');
      if (s.warn) { const bl = 0.5 + 0.5 * Math.sin(this.time / 90); g.globalAlpha = 0.6 + 0.4 * bl; drawText(g, '!! BOSS APPROACHING !!', W / 2, H / 2 - 200, 30, 'rgb(255,60,60)'); g.globalAlpha = 1; }
      if (s.over) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, W, H); drawText(g, 'GAME OVER', W / 2, H / 2 - 20, 52, 'rgb(255,0,0)'); drawText(g, 'waiting for host…', W / 2, H / 2 + 40, 16, 'rgb(180,180,180)'); }
    }

    // touch controls
    if (input.isTouch && !this.disconnected) {
      const rb = this.rocketBtn(), lb = this.leaveBtn();
      g.globalAlpha = 0.35; g.fillStyle = '#fff';
      g.beginPath(); g.arc(rb.x, rb.y, rb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.9; g.drawImage(images.rocket, rb.x - 20, rb.y - 18, 40, 20);
      drawText(g, `${this.meRockets}`, rb.x, rb.y + 16, 22, '#000');
      g.globalAlpha = 0.3; g.fillStyle = '#fff';
      g.beginPath(); g.arc(lb.x, lb.y, lb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.85; g.strokeStyle = '#000'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(lb.x - 6, lb.y - 6); g.lineTo(lb.x + 6, lb.y + 6);
      g.moveTo(lb.x + 6, lb.y - 6); g.lineTo(lb.x - 6, lb.y + 6); g.stroke();
      g.globalAlpha = 1;
    }

    if (this.phase === 'wait' && !this.reconnecting) drawText(g, 'Connecting to host…', W / 2, H / 2, 22, 'rgb(255,210,80)');
    drawText(g, 'ONLINE · GUEST', W / 2, H - 16, 13, 'rgb(0,200,255)');
    drawPing(g, this.net.rtt);

    if (this.reconnecting && !this.disconnected) {
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, W, H);
      const dots = '.'.repeat(1 + (Math.floor(this.time / 400) % 3));
      drawText(g, `RECONNECTING${dots}`, W / 2, H / 2, 30, 'rgb(255,210,80)');
    }
    if (this.disconnected) {
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, W, H);
      drawText(g, 'HOST DISCONNECTED', W / 2, H / 2, 26, 'rgb(255,90,90)');
      drawText(g, 'press any key to return', W / 2, H / 2 + 40, 15, 'rgb(180,180,180)');
    }
  }

  drawShip(g, img, thrusters, x, y, flip, inv) {
    const thr = thrusters[this.frame >> 2 & 3];
    if (inv) g.globalAlpha = 0.5 + 0.25 * Math.sin(this.time / 55);
    g.save(); g.translate(x - 25 - 12, y); g.drawImage(thr, -32, -32, 64, 64); g.restore();
    g.drawImage(img, x - 25, y - 15, 50, 30);
    g.globalAlpha = 1;
  }
}
