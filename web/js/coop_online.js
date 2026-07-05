// Online Co-op for up to 4 players. Star topology: the HOST runs the one
// authoritative world (a GameState with N players) and streams compact 45Hz
// snapshots to every guest; each guest predicts its own ship and renders the
// rest from snapshots. Ships are colour-coded per player.
import { W, H, STEP, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import { GameState, PLAYER_COLORS, playerShip, spawnY } from './game.js';
import { Player, Explosion, RocketTrailParticle, SmokeParticle, Spark, LaserBeam, ScorePopup } from './entities.js';
import { tinted, glowBullet, glowEnemyBullet, glowEngine, drawGlow } from './fx.js';

const ETYPE = { basic: 0, weaver: 1, hunter: 2, tank: 3 };
const ETINT = ['', 'rgba(0,230,190,0.35)', 'rgba(255,60,60,0.4)', 'rgba(190,110,255,0.42)'];
const PU_TYPES = ['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread', 'shield', 'laser'];
const PU_IMG = { shooting: 'powerup', slow_motion: 'slow_motion_powerup', kill_all: 'kill_all_powerup', rocket: 'rocket_powerup', spread: 'spread_powerup' };
const SEND_MS = 33; // ~30Hz snapshots (mobile-friendly; guest extrapolates)

// shared ping badge
function drawPing(g, rtt, label) {
  if (!rtt) return;
  const col = rtt < 80 ? 'rgb(0,220,130)' : rtt < 160 ? 'rgb(255,210,60)' : 'rgb(255,90,90)';
  drawText(g, `${label || ''}${rtt} ms`, W / 2, H - 34, 13, col);
}

/* ------------------------------------ HOST ------------------------------------ */

export class CoopHost {
  constructor(app, hub) { this.app = app; this.hub = hub; }

  enter() {
    this.disconnected = false; // host never "disconnects"; guests may leave
    this.overMenu = null;
    this.slotOrder = [...this.hub.peers.keys()]; // slot -> player index (1..3)
    this.inputs = new Map();  // slot -> {x,y}
    this.sendAcc = 0;
    this.hub.onMessage = (slot, m) => this.onMessage(slot, m);
    this.hub.onGuestLeave = (slot) => this.onLeave(slot);
    this.initGame();
    this.broadcastGo();
  }

  playerIndexOf(slot) { return this.slotOrder.indexOf(slot) + 1; } // host is 0

  initGame() {
    const guests = this.slotOrder.length;
    this.g = new GameState(this.app, true, { online: true, extraPlayers: Math.max(0, guests - 1), colored: true });
    this.g.enter();
    this.g.pauseDisabled = true;
    for (let i = 1; i < this.g.playerList.length; i++) { this.g.playerList[i].controls = {}; this.g.playerList[i].remote = true; }
    this._fx = [];
    this._sd = [];          // sound events to replay on guests
    this._prevRockets = 0;
    this._prevRunPU = 0;
    this._prevShots = 0;
    this._prevWreck = 0;
    const orig = this.g.explode.bind(this.g);
    this.g.explode = (x, y, sound = true, scale = 1) => { this._fx.push([Math.round(x), Math.round(y), +scale.toFixed(2)]); return orig(x, y, sound, scale); };
    this.overMenu = null;
  }

  broadcastGo() {
    const n = this.g.playerList.length;
    for (const slot of this.slotOrder) this.hub.sendTo(slot, { k: 'go', me: this.playerIndexOf(slot), n });
  }

  playAgain() {
    this.slotOrder = [...this.hub.peers.keys()]; // drop guests who left
    this.initGame();
    this.hub.broadcast({ k: 'restart' });
    this.broadcastGo();
  }

  onMessage(slot, m) {
    const idx = this.playerIndexOf(slot);
    if (idx < 1) return;
    const p = this.g.playerList[idx];
    if (!p) return;
    if (m.k === 'in') { this.inputs.set(slot, { x: m.x, y: m.y }); }
    else if (m.k === 'rk') { if (p.alive) p.fireRocket(this.g); }
    else if (m.k === 'lz') { if (p.alive) p.fireLaser(this.g); }
    else if (m.k === 'grab') { if (p.alive) this.g.grabPowerup(p, m.x, m.y); } // client-side pickup
  }

  onLeave(slot) {
    const idx = this.playerIndexOf(slot);
    if (idx >= 1 && this.g.playerList[idx]) {
      const p = this.g.playerList[idx];
      p.alive = false; p.lives = 0; p.gone = true; // that player drops out
    }
  }

  update(dt) {
    if (input.pressed.has('Escape') || this.g.requestLeave) { this.leave(); return; }

    // game over: PLAY AGAIN / LEAVE (host-driven)
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
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_MS) { this.sendAcc = 0; this.flushNet(); }
      return;
    }

    // apply each guest's input to its ship before the world simulates
    for (const slot of this.slotOrder) {
      const idx = this.playerIndexOf(slot);
      const p = this.g.playerList[idx];
      const inp = this.inputs.get(slot);
      if (p && p.alive && !p.gone && inp) {
        p.x = clamp(inp.x, p.w / 2, W - p.w / 2);
        p.y = clamp(inp.y, p.h / 2, H - p.h / 2);
      }
    }

    this.g.update(dt);

    // detect events to replay their sfx on guests
    const g = this.g;
    if (g.rockets.length > this._prevRockets) this._sd.push('rocket');
    if (g.runPowerups > this._prevRunPU) this._sd.push('powerup');
    const shots = (g._shots || 0) - this._prevShots;
    for (let i = 0; i < Math.min(shots, 4); i++) this._sd.push('gun');   // gunfire
    const wrecks = (g.wreckCount || 0) - this._prevWreck;
    for (let i = 0; i < Math.min(wrecks, 3); i++) this._sd.push('siren'); // downed enemy wail
    this._prevRockets = g.rockets.length;
    this._prevRunPU = g.runPowerups;
    this._prevShots = g._shots || 0;
    this._prevWreck = g.wreckCount || 0;

    this.sendAcc += dt;
    if (this.sendAcc >= SEND_MS) {
      this.sendAcc = 0;
      this.flushNet();
    }
  }

  // Snapshot goes UNRELIABLE (a drop is healed by the next one), but one-shot
  // events (explosions, sounds, laser beams, score popups) must never be lost —
  // they ride a separate RELIABLE 'ev' message, sent only when non-empty.
  flushNet() {
    this.hub.broadcast(this.snapshot());
    const g = this.g;
    const lz = g._lzQ || [], sp = g._spQ || [];
    if (this._fx.length || this._sd.length || lz.length || sp.length) {
      this.hub.broadcast({ k: 'ev', fx: this._fx.slice(), sd: this._sd.slice(), lz: lz.slice(), sp: sp.slice() });
      this._fx.length = 0;
      this._sd.length = 0;
      lz.length = 0;
      sp.length = 0;
    }
  }

  snapshot() {
    const g = this.g;
    const m = g.speedMul;
    const enc = (p) => [Math.round(p.x), Math.round(p.y), p.alive ? 1 : 0, p.lives, p.rockets, g.time < (p.invulnUntil || 0) ? 1 : 0, p.lasers, p.shield ? 1 : 0];
    return {
      k: 'w',
      sc: g.score, lv: g.level, warn: g.bossWarnStart ? 1 : 0,
      ban: g.levelBanner ? g.levelBanner.level : 0, slow: g.speedMul < 1 ? 1 : 0, over: g.over ? 1 : 0,
      ps: g.playerList.map(enc),
      // integer velocities keep packets small; extrapolation over ~33ms doesn't need decimals.
      // boss rows carry 3 extra fields so guests can SEE the laser + shield (else they
      // die to an invisible instakill beam from level 3 on).
      en: g.enemies.map((e) => {
        const row = [Math.round(e.x), Math.round(e.y), e.isBoss ? 4 : ETYPE[e.type], e.dying ? 1 : 0,
          e.isBoss ? Math.round(Math.max(0, e.health) / Math.max(1, e.maxHealth) * 100) / 100 : 1, Math.round(e.w),
          Math.round((e.vx || 0) * m), Math.round((e.dying ? (e.vyFall || 0) : (e.vy || 0)) * m)];
        if (e.isBoss) row.push(e.laser ? (e.laser.phase === 'fire' ? 2 : 1) : 0, Math.round(e.laser ? e.laser.y : 0), e.shieldUntil > g.time ? 1 : 0);
        return row;
      }),
      eb: g.enemyBullets.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx * m), Math.round(b.vy * m)]),
      pb: g.bullets.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]),
      ro: g.rockets.map((r) => [Math.round(r.x), Math.round(r.y), Math.round(r.angle)]),
      as: g.asteroids.map((a) => [Math.round(a.x), Math.round(a.y), Math.round(a.w / 2), Math.round(a.angle),
        Math.round(-a.vx * m), Math.round(a.vy * m)]),
      pu: g.powerups.map((p) => [Math.round(p.x), Math.round(p.y), PU_TYPES.indexOf(p.type)]),
    };
  }

  leave() { try { this.hub.broadcast({ k: 'bye' }); } catch {} this.hub.close(); this.app.goMenu(); }
  onResize() { this.g.onResize(); }

  draw(gg) {
    this.g.draw(gg);
    drawText(gg, `ONLINE · HOST · ${this.g.playerList.length}P`, W / 2, H - 16, 13, 'rgb(0,200,255)');
    drawPing(gg, this.hub.avgPing(), '~');
    if (this.overMenu && this.g.over) this.overMenu.draw(gg);
  }
}

/* ------------------------------------ GUEST ----------------------------------- */

export class CoopGuest extends BaseWorld {
  constructor(app, link, me, total) {
    super(app, 'game_background');
    this.net = link;
    this.meIndex = me;   // our player index (1..3)
    this.total = total;
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');
    this.initBackdrop();
    this.disconnected = false;
    this.reconnecting = false;
    this.frame = 0;

    this.me = new Player(images, { img: playerShip(images, this.meIndex, true), thrusters: images.thrusters[this.meIndex === 1 ? 'player2' : 'player1'], controls: {}, autoShoot: false, useRockets: false });
    this.myColor = PLAYER_COLORS[this.meIndex % PLAYER_COLORS.length];
    this.resetRound();

    // pre-tint ship sprites for every player index
    this.shipImg = [];
    for (let i = 0; i < 4; i++) this.shipImg[i] = playerShip(images, i, true);
    // Robust: any type without a dedicated image falls back to the base sprite
    // so a new powerup type can never crash the guest with drawImage(undefined).
    this.puImg = {};
    for (const t of PU_TYPES) {
      this.puImg[t] = t === 'shield' ? tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield')
        : t === 'laser' ? tinted(images.powerup, 'rgba(90,140,255,0.6)', 'powerup_laser')
        : (images[PU_IMG[t]] || images.powerup);
    }
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
    this.phase = 'play';
    this.sendAcc = 0;
    this.lastBan = 0;
    this.lastWarn = 0;
    this.me.x = 100; this.me.y = spawnY(this.meIndex, this.total || 2);
    this.meAlive = true; this.meLives = 3; this.meRockets = 3; this.meLasers = 2; this.meInv = 0;
    this.dmgFlash = 0;
    this._lzCd = 0; // local cooldown echo for the button arc
    this.effects = [];
  }

  rocketBtn() { return { x: W - 70, y: H - 80, r: 44 }; }
  laserBtn() { return { x: W - 70, y: H - 185, r: 38 }; }
  leaveBtn() { return { x: 34, y: 122, r: 22 }; }

  tryLaser() {
    if (this.meLasers <= 0 || this.time < this._lzCd) return;
    this._lzCd = this.time + 1200;
    this.net.send({ k: 'lz' });
  }

  handleTouch() {
    if (!input.isTouch) return;
    const rb = this.rocketBtn(), lb = this.leaveBtn();
    const zb = this.laserBtn();
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (Math.hypot(pt.x - lb.x, pt.y - lb.y) <= lb.r) { this.leave(); return; }
      if (Math.hypot(pt.x - rb.x, pt.y - rb.y) <= rb.r) { this.net.send({ k: 'rk' }); continue; }
      if (Math.hypot(pt.x - zb.x, pt.y - zb.y) <= zb.r) { this.tryLaser(); continue; }
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
    else if (m.k === 'go') { if (typeof m.n === 'number') this.total = m.n; if (typeof m.me === 'number') this.meIndex = m.me; }
    else if (m.k === 'bye') this.disconnected = true;
    else if (m.k === 'ev') {
      // one-shot events arrive reliably — never lost even if snapshots drop
      for (const f of m.fx || []) { this.effects.push(new Explosion(f[0], f[1], this.app.images.explosion_spritesheet, this.time, f[2])); audio.play('explosion', 0.4); }
      for (const s of m.sd || []) {
        if (s === 'siren') audio.playSynth('siren');
        else audio.play(s, s === 'gun' ? 0.2 : s === 'rocket' ? 0.5 : 0.6);
      }
      for (const l of m.lz || []) { this.effects.push(new LaserBeam(l[0], l[1], this.time)); audio.playSynth('plaser'); }
      for (const s of m.sp || []) this.effects.push(new ScorePopup(s[0], s[1], s[2], this.time));
    }
    else if (m.k === 'w') {
      this.snap = m;
      this.snapAt = this.time;
      const mine = m.ps[this.meIndex];
      if (mine) {
        const wasAlive = this.meAlive;
        this.meAlive = mine[2] === 1; this.meLives = mine[3]; this.meRockets = mine[4]; this.meInv = mine[5];
        this.meLasers = mine[6] ?? this.meLasers;
        this.meShield = mine[7] === 1;
        if (wasAlive && !this.meAlive) { this.dmgFlash = 1; } // I just died: red pulse
        if (!this.meAlive) { this.me.x = mine[0]; this.me.y = mine[1]; }
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

    if (this.meAlive && !(this.snap && this.snap.over)) {
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
      if (input.pressed.has('Space') || input.pressed.has('Enter') || input.pressed.has('NumpadEnter') || (pad && pad.fire && this.time - (this._lr || 0) > 300)) { this._lr = this.time; this.net.send({ k: 'rk' }); }
      if (input.pressed.has('KeyE') || input.pressed.has('KeyQ') || (pad && pad.fire2)) this.tryLaser();
      this.handleTouch();
      // client-side power-up grab: I see the overlap locally, tell the host
      if (this.snap && this.time - (this._grabT || 0) > 300) {
        for (const pu of this.snap.pu) {
          if (Math.abs(pu[0] - this.me.x) < 45 && Math.abs(pu[1] - this.me.y) < 32) {
            this._grabT = this.time; this.net.send({ k: 'grab', x: pu[0], y: pu[1] }); break;
          }
        }
      }
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_MS) { this.sendAcc = 0; this.net.send({ k: 'in', x: Math.round(this.me.x), y: Math.round(this.me.y) }); }
    } else if (input.isTouch) {
      const lb = this.leaveBtn();
      for (const [, pt] of input.pointers) if (pt.justDown && Math.hypot(pt.x - lb.x, pt.y - lb.y) <= lb.r) { this.leave(); return; }
    }
    if (this.time - (this.me.thrLast || 0) > 50) { this.me.thrLast = this.time; this.me.thrFrame = (this.me.thrFrame + 1) % this.me.thrusters.length; }

    // regenerate cosmetic effects locally from the snapshot
    const s = this.snap;
    if (s && !s.over) {
      for (const r of s.ro) this.effects.push(new RocketTrailParticle(r[0], r[1], this.time));
      for (const e of s.en) {
        if (!e[3]) continue;
        if (Math.random() < 0.6) this.effects.push(new SmokeParticle(e[0], e[1], this.time));
        if (Math.random() < 0.25) this.effects.push(new Spark(e[0], e[1], this.time, -Math.PI / 2));
      }
    }
    for (const fx of this.effects) fx.update(this);
    this.effects = this.effects.filter((fx) => !fx.dead);
  }

  leave() { try { this.net.send({ k: 'bye' }); } catch {} this.net.close(); this.app.goMenu(); }

  // Boss laser telegraph (phase 1) / beam (phase 2) — mirrors Boss.draw so
  // guests can see and dodge the instakill beam.
  drawBossLaser(g, bx, w, phase, y) {
    if (!phase) return;
    const t = this.time, x0 = bx - w / 2 + 10, prev = g.globalCompositeOperation;
    g.save(); g.globalCompositeOperation = 'lighter';
    if (phase === 1) {
      g.globalAlpha = 0.35 + 0.3 * Math.sin(t / 60);
      g.strokeStyle = 'rgb(255,60,60)'; g.lineWidth = 2; g.setLineDash([10, 8]);
      g.beginPath(); g.moveTo(x0, y); g.lineTo(0, y); g.stroke(); g.setLineDash([]);
    } else {
      g.globalAlpha = 0.9 * (0.8 + 0.2 * Math.sin(t / 25));
      const grad = g.createLinearGradient(0, y - 16, 0, y + 16);
      grad.addColorStop(0, 'rgba(255,60,60,0)'); grad.addColorStop(0.5, 'rgba(255,180,160,0.95)'); grad.addColorStop(1, 'rgba(255,60,60,0)');
      g.fillStyle = grad; g.fillRect(0, y - 16, x0, 32);
      g.globalAlpha = 0.9; g.fillStyle = '#fff'; g.fillRect(0, y - 3, x0, 6);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = prev; g.restore();
  }

  drawShieldRing(g, x, y) {
    const prev = g.globalCompositeOperation;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const r = 36 + 2 * Math.sin(this.time / 140);
    g.globalAlpha = 0.55; g.lineWidth = 2.5; g.strokeStyle = 'rgb(80,220,255)';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.12; g.fillStyle = 'rgb(80,220,255)'; g.fill();
    g.restore();
    g.globalCompositeOperation = prev;
  }

  drawShip(g, img, thrusters, x, y, inv) {
    const thr = thrusters[this.frame >> 2 & 3];
    if (inv) g.globalAlpha = 0.5 + 0.25 * Math.sin(this.time / 55);
    g.save(); g.translate(x - 25 - 12, y); g.drawImage(thr, -32, -32, 64, 64); g.restore();
    g.drawImage(img, x - 25, y - 15, 50, 30);
    g.globalAlpha = 1;
  }

  draw(g) {
    const { images } = this.app;
    this.drawBackdrop(g);
    const s = this.snap;

    if (s) {
      const ex = Math.min(this.time - (this.snapAt || this.time), 90) / STEP;
      for (const p of s.pu) { const img = this.puImg[PU_TYPES[p[2]]] || images.powerup; g.drawImage(img, p[0] - 30, p[1] - 15, 60, 30); }
      for (const a of s.as) { const ax = a[0] + (a[4] || 0) * ex, ay = a[1] + (a[5] || 0) * ex; g.save(); g.translate(ax, ay); g.rotate(a[3] * Math.PI / 180); g.drawImage(images.asteroid, -a[2], -a[2], a[2] * 2, a[2] * 2); g.restore(); }
      const thr = images.thrusters.enemy[this.frame >> 2 & 3];
      for (const e of s.en) {
        const w = e[5] || 50, h = e[2] === 4 ? w : Math.round(w * 0.6);
        const cx = e[0] + (e[6] || 0) * ex, cy = e[1] + (e[7] || 0) * ex;
        if (e[2] === 4) this.drawBossLaser(g, cx, w, e[8] || 0, e[9] || 0); // laser behind the boss
        if (e[3]) g.globalAlpha = 0.6;
        if (e[2] !== 4) { g.save(); g.translate(cx + w / 2 + 12, cy); g.scale(-1, 1); g.drawImage(thr, -32, -32, 64, 64); g.restore(); }
        g.drawImage(this.tint(e[2], e[2] === 4 ? images.boss : images.enemy_ship), cx - w / 2, cy - h / 2, w, h);
        g.globalAlpha = 1;
        if (e[2] === 4) {
          if (e[10]) { // shield ring
            g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.5 + 0.2 * Math.sin(this.time / 90);
            g.strokeStyle = 'rgb(90,220,255)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, w / 2 + 14, 0, Math.PI * 2); g.stroke(); g.restore();
          }
          const bw = 120; g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(cx - bw / 2, cy - h / 2 - 14, bw, 8);
          g.fillStyle = e[10] ? 'rgb(90,220,255)' : '#f33'; g.fillRect(cx - bw / 2, cy - h / 2 - 14, bw * e[4], 8);
        }
      }
      for (const b of s.pb) { const x = b[0] + (b[2] || 0) * ex, y = b[1] + (b[3] || 0) * ex; drawGlow(g, glowBullet, x, y); g.drawImage(images.bullet, x - 5, y - 2.5, 10, 5); }
      for (const b of s.eb) { const x = b[0] + (b[2] || 0) * ex, y = b[1] + (b[3] || 0) * ex; drawGlow(g, glowEnemyBullet, x, y); g.drawImage(images.enemy_bullet, x - 5, y - 2.5, 10, 5); }
      for (const r of s.ro) { const rad = r[2] * Math.PI / 180, x = r[0] + 8 * Math.cos(rad) * ex, y = r[1] + 8 * Math.sin(rad) * ex; drawGlow(g, glowEngine, x, y, 0.8); g.save(); g.translate(x, y); g.rotate(rad); g.drawImage(images.rocket, -10, -5, 20, 10); g.restore(); }
      for (const fx of this.effects) fx.draw(g, this);

      // players: others from snapshot, self predicted (+ shield bubbles)
      const thrOf = (i) => images.thrusters[i === 1 ? 'player2' : 'player1'];
      s.ps.forEach((p, i) => {
        if (i === this.meIndex) return;
        if (p[2]) { this.drawShip(g, this.shipImg[i], thrOf(i), p[0], p[1], p[5]); if (p[7]) this.drawShieldRing(g, p[0], p[1]); }
      });
      if (this.meAlive) { this.drawShip(g, this.shipImg[this.meIndex], this.me.thrusters, this.me.x, this.me.y, this.meInv); if (this.meShield) this.drawShieldRing(g, this.me.x, this.me.y); }

      if (s.slow) { g.fillStyle = 'rgba(80,150,255,0.08)'; g.fillRect(0, 0, W, H); }

      // red edge pulse when this guest loses a life
      if (this.dmgFlash > 0) {
        this.dmgFlash = Math.max(0, this.dmgFlash - 0.03 * this.k);
        const grad = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.7);
        grad.addColorStop(0, 'rgba(255,0,0,0)');
        grad.addColorStop(1, `rgba(255,30,30,${0.35 * this.dmgFlash})`);
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }

      // HUD — all players, colour-coded, own marked
      drawText(g, `Score: ${s.sc}`, 10, 24, 26, '#fff', 'left');
      drawText(g, `Level: ${s.lv}`, W - 10, 24, 26, '#fff', 'right');
      const many = s.ps.length > 2, fs = many ? 18 : 22;
      s.ps.forEach((p, i) => {
        const y = 58 + i * (many ? 26 : 32);
        const lives = i === this.meIndex ? this.meLives : p[3];
        drawText(g, i === this.meIndex ? 'YOU' : `P${i + 1}`, 10, y, fs, PLAYER_COLORS[i % 4], 'left');
        drawText(g, '♥'.repeat(Math.max(0, lives)), i === this.meIndex ? 62 : 44, y, fs, 'rgb(255,80,90)', 'left');
      });
      if (s.warn) { const bl = 0.5 + 0.5 * Math.sin(this.time / 90); g.globalAlpha = 0.6 + 0.4 * bl; drawText(g, '!! BOSS APPROACHING !!', W / 2, H / 2 - 200, 30, 'rgb(255,60,60)'); g.globalAlpha = 1; }
      if (s.over) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, W, H); drawText(g, 'GAME OVER', W / 2, H / 2 - 20, 52, 'rgb(255,0,0)'); drawText(g, 'waiting for host…', W / 2, H / 2 + 40, 16, 'rgb(180,180,180)'); }
    }

    if (input.isTouch && !this.disconnected) {
      const rb = this.rocketBtn(), lb = this.leaveBtn(), zb = this.laserBtn();
      g.globalAlpha = 0.35; g.fillStyle = '#fff'; g.beginPath(); g.arc(rb.x, rb.y, rb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.9; g.drawImage(images.rocket, rb.x - 20, rb.y - 18, 40, 20); drawText(g, `${this.meRockets}`, rb.x, rb.y + 16, 22, '#000');
      // laser button with cooldown arc
      const cd = Math.max(0, this._lzCd - this.time) / 1200;
      const ready = this.meLasers > 0 && cd <= 0;
      g.globalAlpha = ready ? 0.4 : 0.22;
      g.fillStyle = ready ? 'rgb(120,220,255)' : '#888';
      g.beginPath(); g.arc(zb.x, zb.y, zb.r, 0, Math.PI * 2); g.fill();
      if (cd > 0) { g.globalAlpha = 0.5; g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(zb.x, zb.y, zb.r - 3, -Math.PI / 2, -Math.PI / 2 + (1 - cd) * Math.PI * 2); g.stroke(); }
      g.globalAlpha = 0.95;
      drawText(g, '⚡', zb.x, zb.y - 4, 26, '#000');
      drawText(g, `${this.meLasers}`, zb.x, zb.y + 18, 20, '#000');
      g.globalAlpha = 0.3; g.fillStyle = '#fff'; g.beginPath(); g.arc(lb.x, lb.y, lb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.85; g.strokeStyle = '#000'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(lb.x - 6, lb.y - 6); g.lineTo(lb.x + 6, lb.y + 6); g.moveTo(lb.x + 6, lb.y - 6); g.lineTo(lb.x - 6, lb.y + 6); g.stroke();
      g.globalAlpha = 1;
    }

    drawText(g, `ONLINE · P${this.meIndex + 1}`, W / 2, H - 16, 13, this.myColor);
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

  onResize() { super.onResize(); }
}
