// Online Co-op — one player HOSTS the authoritative world and streams compact
// snapshots; the GUEST predicts its own ship and renders from snapshots.
import { W, H, STEP, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { drawText } from './ui.js';
import { BaseWorld } from './world.js';
import { GameState } from './game.js';
import { Player, Explosion, RocketTrailParticle, SmokeParticle, Spark } from './entities.js';
import { tinted, glowBullet, glowEnemyBullet, glowEngine, drawGlow } from './fx.js';

const ETYPE = { basic: 0, weaver: 1, hunter: 2, tank: 3 };
const ETYPE_NAME = ['basic', 'weaver', 'hunter', 'tank'];
const ETINT = ['', 'rgba(0,230,190,0.35)', 'rgba(255,60,60,0.4)', 'rgba(190,110,255,0.42)'];
const PU_TYPES = ['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread', 'shield'];
const PU_IMG = { shooting: 'powerup', slow_motion: 'slow_motion_powerup', kill_all: 'kill_all_powerup', rocket: 'rocket_powerup', spread: 'spread_powerup' };
const SEND_MS = 33;

// Factory: `new CoopOnline(app, net, isHost)` returns the right instance.
export function CoopOnline(app, net, isHost) {
  return isHost ? new CoopHost(app, net) : new CoopGuest(app, net);
}

/* ------------------------------------ HOST ------------------------------------ */

class CoopHost {
  constructor(app, net) { this.app = app; this.net = net; }

  enter() {
    this.g = new GameState(this.app, true, { online: true });
    this.g.enter();
    this.g.pauseDisabled = true;          // no pause in online
    this.g.player2.controls = {};         // guest drives player2, not local keys
    // record explosions to replay on the guest
    this._fx = [];
    const orig = this.g.explode.bind(this.g);
    this.g.explode = (x, y, sound = true, scale = 1) => { this._fx.push([Math.round(x), Math.round(y), +scale.toFixed(2)]); return orig(x, y, sound, scale); };

    this.guest = { x: 100, y: H / 3, has: false };
    this.sendAcc = 0;
    this.disconnected = false;
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s) => { if (s === 'closed') this.disconnected = true; };
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
    if (this.g.over && this.g.overAlpha >= 0.5 && (input.pressed.size || input.pointer.justDown)) { this.leave(); return; }

    // place guest-controlled ship before the world simulates collisions
    const p2 = this.g.player2;
    if (p2.alive && this.guest.has) {
      p2.x = clamp(this.guest.x, p2.w / 2, W - p2.w / 2);
      p2.y = clamp(this.guest.y, p2.h / 2, H - p2.h / 2);
    }

    this._fx.length = 0;
    this.g.update(dt);

    this.sendAcc += dt;
    if (this.sendAcc >= SEND_MS) {
      this.sendAcc = 0;
      this.net.send(this.snapshot());
    }
  }

  snapshot() {
    const g = this.g;
    const enc = (p) => [Math.round(p.x), Math.round(p.y), p.alive ? 1 : 0, p.lives, p.rockets, g.time < (p.invulnUntil || 0) ? 1 : 0];
    return {
      k: 'w',
      sc: g.score, lv: g.level,
      warn: g.bossWarnStart ? 1 : 0,
      ban: g.levelBanner ? g.levelBanner.level : 0,
      slow: g.speedMul < 1 ? 1 : 0,
      p1: enc(g.player1), p2: enc(g.player2),
      en: g.enemies.map((e) => [Math.round(e.x), Math.round(e.y), e.isBoss ? 4 : ETYPE[e.type], e.dying ? 1 : 0, e.isBoss ? Math.max(0, e.health) / e.maxHealth : 1, Math.round(e.w)]),
      eb: g.enemyBullets.map((b) => [Math.round(b.x), Math.round(b.y)]),
      pb: g.bullets.map((b) => [Math.round(b.x), Math.round(b.y), b.flip ? 1 : 0]),
      ro: g.rockets.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.angle)]),
      as: g.asteroids.map((a) => [Math.round(a.x), Math.round(a.y), Math.round(a.w / 2), Math.round(a.angle)]),
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
    if (this.disconnected) {
      gg.fillStyle = 'rgba(0,0,0,0.6)'; gg.fillRect(0, 0, W, H);
      drawText(gg, 'PARTNER DISCONNECTED', W / 2, H / 2, 26, 'rgb(255,90,90)');
      drawText(gg, 'press any key to return', W / 2, H / 2 + 40, 15, 'rgb(180,180,180)');
    }
  }
}

/* ------------------------------------ GUEST ----------------------------------- */

class CoopGuest extends BaseWorld {
  constructor(app, net) { super(app, 'game_background'); this.net = net; }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');
    this.initBackdrop();
    this.snap = null;
    this.disconnected = false;
    this.phase = 'wait';
    this.sendAcc = 0;
    this.frame = 0;
    this.lastBan = 0;
    this.lastWarn = 0;

    // locally-predicted own ship (player2)
    this.me = new Player(images, { img: images.player2_ship, thrusters: images.thrusters.player2, controls: {}, autoShoot: false, useRockets: false });
    this.me.x = 100; this.me.y = H / 3;
    this.meAlive = true; this.meLives = 3; this.meRockets = 3; this.meInv = 0;

    this.puImg = {};
    for (const t of PU_TYPES) this.puImg[t] = t === 'shield' ? tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield') : images[PU_IMG[t]];
    this.enemyTint = {};

    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s) => { if (s === 'closed') this.disconnected = true; };
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
    if (m.k === 'go') { this.phase = 'play'; }
    else if (m.k === 'bye') this.disconnected = true;
    else if (m.k === 'w') {
      if (this.phase === 'wait') this.phase = 'play';
      this.snap = m;
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
      for (const p of s.pu) { const t = PU_TYPES[p[2]] || 'shooting'; const img = this.puImg[t]; g.drawImage(img, p[0] - 30, p[1] - 15, 60, 30); }
      for (const a of s.as) { g.save(); g.translate(a[0], a[1]); g.rotate(a[3] * Math.PI / 180); g.drawImage(images.asteroid, -a[2], -a[2], a[2] * 2, a[2] * 2); g.restore(); }
      // enemies
      const thr = images.thrusters.enemy[this.frame >> 2 & 3];
      for (const e of s.en) {
        const w = e[5] || 50, h = e[2] === 4 ? w : Math.round(w * 0.6);
        if (e[3]) g.globalAlpha = 0.6; // dying
        if (e[2] !== 4) {
          g.save(); g.translate(e[0] + w / 2 + 12, e[1]); g.scale(-1, 1); g.drawImage(thr, -32, -32, 64, 64); g.restore();
        }
        g.drawImage(this.tint(e[2], e[2] === 4 ? images.boss : images.enemy_ship), e[0] - w / 2, e[1] - h / 2, w, h);
        g.globalAlpha = 1;
        if (e[2] === 4) { // boss health bar
          const bw = 120; g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(e[0] - bw / 2, e[1] - h / 2 - 14, bw, 8);
          g.fillStyle = '#f33'; g.fillRect(e[0] - bw / 2, e[1] - h / 2 - 14, bw * e[4], 8);
        }
      }
      for (const b of s.pb) { drawGlow(g, glowBullet, b[0], b[1]); g.drawImage(images.bullet, b[0] - 5, b[1] - 2.5, 10, 5); }
      for (const b of s.eb) { drawGlow(g, glowEnemyBullet, b[0], b[1]); g.drawImage(images.enemy_bullet, b[0] - 5, b[1] - 2.5, 10, 5); }
      for (const r of s.ro) { drawGlow(g, glowEngine, r[0], r[1], 0.8); g.save(); g.translate(r[0], r[1]); g.rotate(r[2] * Math.PI / 180); g.drawImage(images.rocket, -10, -5, 20, 10); g.restore(); }
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

    if (this.phase === 'wait') drawText(g, 'Connecting to host…', W / 2, H / 2, 22, 'rgb(255,210,80)');
    drawText(g, 'ONLINE · GUEST', W / 2, H - 16, 13, 'rgb(0,200,255)');

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
