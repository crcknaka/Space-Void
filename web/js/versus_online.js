// Online Versus — first to 10, two peers over WebRTC.
// Authority model: each client fully owns its own ship and its own death.
// You render remote bullets from spawn events and check them against YOURSELF;
// when you're hit you die locally and tell the opponent (who scored).
import { makeSpaceBackdrop } from './bggen.js';
import { W, H, STEP, clamp, overlap, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import { Player, Bullet, Explosion, BoostParticle, Rocket, LaserBeam } from './entities.js';
import { savedName } from './lb.js';
import { VsArena, applyVsPod } from './versus_arena.js';

const SCORE_LIMIT = 10;
const SEND_MS = 33; // ~30Hz ship state
const RK_MAX = 3, RK_REGEN = 3500, RK_CD = 700;
const LZ_MAX = 2, LZ_REGEN = 6000, LZ_CD = 1000, LZ_BAND = 22;

export class VersusOnline extends BaseWorld {
  constructor(app, net) {
    super(app, 'versus_background');
    this.net = net;
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('versus_music');
    this.initBackdrop();
    this.bgOverride = makeSpaceBackdrop(777); // same procedural arena for both peers

    this.localId = this.net.isHost ? 1 : 2;
    this.remoteId = this.localId === 1 ? 2 : 1;
    this.score1 = 0;
    this.score2 = 0;
    this.winner = null;
    this.disconnected = false;
    this.reconnecting = false;
    this.rematchMe = false;
    this.rematchThem = false;
    this.endMenu = null;
    this.sendAcc = 0;
    this.localRespawn = 0;

    // host = P1 (left, faces right); guest = P2 (right, faces left, flipped)
    const mkLocal = () => this.localId === 1
      ? new Player(images, { img: images.player1_ship, thrusters: images.thrusters.player1, controls: {}, autoShoot: false, useRockets: false })
      : new Player(images, { img: images.player2_ship, thrusters: images.thrusters.player2, controls: {}, autoShoot: false, useRockets: false, facingLeft: true, shipFlipped: true });
    const mkRemote = () => this.localId === 1
      ? new Player(images, { img: images.player2_ship, thrusters: images.thrusters.player2, controls: {}, autoShoot: false, useRockets: false, facingLeft: true, shipFlipped: true })
      : new Player(images, { img: images.player1_ship, thrusters: images.thrusters.player1, controls: {}, autoShoot: false, useRockets: false });

    this.local = mkLocal();
    this.remote = mkRemote();
    this.spawnLocal();
    this.remote.x = this.remoteId === 1 ? 80 : W - 80;
    this.remote.y = H / 2;
    this.remote.tx = this.remote.x;
    this.remote.ty = this.remote.y;
    this.remote.alive = true;

    this.localBullets = [];   // mine — remote checks these
    this.remoteBullets = [];  // opponent's — I check these vs myself
    this.localRockets = [];   // mine — cosmetic, home toward the opponent
    this.remoteRockets = [];  // incoming — home toward me, checked vs me
    // hazards + pods: the host decides spawns and mirrors them; both peers
    // simulate the same objects, and I still only judge hits on MY ship
    this.arena = new VsArena(images, {
      authority: this.net.isHost,
      send: (e) => this.net.send({ k: 'hz', ...e }),
    });
    this.resetAmmo();

    this.myName = savedName() || 'PILOT';
    this.oppName = 'OPPONENT';

    // start countdown; host kicks it off so both start together
    this.phase = this.net.isHost ? 'countdown' : 'wait';
    this.countdown = 3000;
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onState = (s) => {
      if (s === 'closed') this.disconnected = true;
      else if (s === 'reconnecting') this.reconnecting = true;
      else if (s === 'open') this.reconnecting = false;
    };
    this.net.send({ k: 'hi', name: this.myName });
    if (this.net.isHost) this.net.send({ k: 'go' });
  }

  resetAmmo() {
    const p = this.local;
    p.rockets = 2; p.lasers = 1;
    p.rkRegenAt = 0; p.lzRegenAt = 0;
    p.lastRk = -9999; p.lastLz = -9999;
    p.shield = false; p.spreadUntil = 0;
  }

  localDie(hx, hy) {
    if (this.time < (this.local.invulnUntil || 0)) return; // spawn / shield-pop grace
    if (this.local.shield) { // shield pod absorbs one hit of anything
      const p = this.local;
      p.shield = false;
      p.shieldRipple = { a: hx !== undefined ? Math.atan2(hy - p.y, hx - p.x) : Math.PI, start: this.time };
      p.invulnUntil = this.time + 800;
      audio.playSynth('shield_pop', p.x);
      return;
    }
    this.local.alive = false;
    this.localRespawn = this.time + 1000;
    this.effects.push(new Explosion(this.local.x, this.local.y, this.app.images.explosion_spritesheet, this.time));
    audio.play('explosion', 0.5);
    if (this.localId === 1) this.score2 += 1; else this.score1 += 1;
    this.checkWinner();
    this.net.send({ k: 'd', s1: this.score1, s2: this.score2 });
  }

  resetMatch() {
    this.score1 = 0; this.score2 = 0;
    this.winner = null; this.endMenu = null;
    this.rematchMe = false; this.rematchThem = false;
    this.localBullets = []; this.remoteBullets = [];
    this.localRockets = []; this.remoteRockets = [];
    this.arena.reset(this.time);
    this.resetAmmo();
    this.spawnLocal();
    this.remote.alive = true;
    this.phase = 'countdown';
    this.countdown = 3000;
  }

  players() { return [this.local, this.remote]; }

  spawnLocal() {
    const p = this.local;
    if (this.localId === 1) p.x = 80; else p.x = W - 80;
    p.y = H / 2;
    p.alive = true;
    p.invulnUntil = this.time + 1500;
  }

  leaveBtn() { return { x: 34, y: 70, r: 22 }; } // below the score HUD
  rocketBtn() { return { x: W - 70, y: H - 80, r: 44 }; }
  laserBtn() { return { x: W - 70, y: H - 185, r: 38 }; }

  // touch: drag to move (auto-fire while alive); buttons for rocket/laser/leave
  handleTouch() {
    if (!input.isTouch) return;
    const lb = this.leaveBtn(), rb = this.rocketBtn(), zb = this.laserBtn();
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (Math.hypot(pt.x - lb.x, pt.y - lb.y) <= lb.r) { this.leave(); return; }
      if (Math.hypot(pt.x - rb.x, pt.y - rb.y) <= rb.r) { this.fireRocketTouch(); continue; }
      if (Math.hypot(pt.x - zb.x, pt.y - zb.y) <= zb.r) { this.fireLaserTouch(); continue; }
      if (!this.drag && this.local.alive) this.drag = { id, px: pt.x, py: pt.y, ox: this.local.x, oy: this.local.y };
    }
    if (this.drag) {
      const pt = input.pointers.get(this.drag.id);
      if (pt && this.local.alive) {
        this.local.x = clamp(this.drag.ox + (pt.x - this.drag.px) * 1.25, this.local.w / 2, W - this.local.w / 2);
        this.local.y = clamp(this.drag.oy + (pt.y - this.drag.py) * 1.25, this.local.h / 2, H - this.local.h / 2);
      } else this.drag = null;
    }
  }

  onMessage(m) {
    if (m.k === 'go' && this.phase === 'wait') { this.phase = 'countdown'; this.countdown = 3000; }
    else if (m.k === 'hi') { this.oppName = String(m.name || 'OPPONENT').slice(0, 14); }
    else if (m.k === 's') { this.remote.tx = m.x; this.remote.ty = m.y; this.remote.alive = !!m.a; this.remote.shield = !!m.sh; }
    else if (m.k === 'f') {
      // Bullet auto-flips its sprite from the sign of vx, so left-moving
      // opponent shots render correctly with no extra handling.
      this.remoteBullets.push(new Bullet(m.x, m.y, this.app.images.bullet, m.vx, m.a || 0));
      audio.play('gun', 0.22, m.x, 0.95 + Math.random() * 0.1);
    }
    else if (m.k === 'hz') { this.arena.apply(this, m); }         // host-spawned hazard/pod
    else if (m.k === 'pt') { this.arena.removePod(m.id); }        // opponent claimed a pod
    else if (m.k === 'rf') {
      // incoming rocket homes toward MY ship; I check it against myself
      const angle = this.remoteId === 1 ? 0 : 180;
      this.remoteRockets.push(new Rocket(m.x, m.y, this.app.images.rocket, this.local, angle));
      audio.play('rocket', 0.5, m.x);
    }
    else if (m.k === 'lf') {
      // incoming laser: show the beam, and if I'm on its path I die
      this.effects.push(new LaserBeam(m.x0, m.y, this.time, 'rgb(255,120,120)', m.dir));
      audio.playSynth('plaser', m.x0);
      if (this.local.alive && this.time > (this.local.invulnUntil || 0) &&
          Math.abs(this.local.y - m.y) < LZ_BAND && (m.dir > 0 ? this.local.x > m.x0 : this.local.x < m.x0)) {
        this.localDie(m.x0, m.y);
      }
    }
    // The victim is authoritative for the score after its own death and sends
    // the resulting totals; the receiver ADOPTS them (never increments) so a
    // lost/duplicated packet can't desync who's winning across the two screens.
    else if (m.k === 'd') {
      this.score1 = m.s1; this.score2 = m.s2;
      this.effects.push(new Explosion(this.remote.x, this.remote.y, this.app.images.explosion_spritesheet, this.time));
      audio.play('explosion', 0.5);
      audio.play(this.remoteId === 1 ? 'player2_kill' : 'player1_kill', 0.7);
      this.checkWinner();
    }
    else if (m.k === 'rm') { this.rematchThem = true; if (this.rematchMe) this.resetMatch(); }
    else if (m.k === 'bye') { this.disconnected = true; }
  }

  checkWinner() {
    if (this.score1 >= SCORE_LIMIT) this.winner = 'PLAYER 1';
    else if (this.score2 >= SCORE_LIMIT) this.winner = 'PLAYER 2';
  }

  moveLocal(dt) {
    const p = this.local;
    if (!p.alive) return;
    const k = input.keys;
    const pad = input.pads[0];
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') || (pad && pad.boost);
    const sp = (boost ? p.fastSpeed : p.defaultSpeed) * (dt / STEP);
    let dy = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) { p.y -= sp; dy = -1; }
    if (k.has('KeyS') || k.has('ArrowDown')) { p.y += sp; dy = 1; }
    if (k.has('KeyA') || k.has('ArrowLeft')) p.x -= sp;
    if (k.has('KeyD') || k.has('ArrowRight')) p.x += sp;
    if (pad) { p.x += pad.x * sp; p.y += pad.y * sp; if (Math.abs(pad.y) > 0.3) dy = Math.sign(pad.y); }
    p.x = clamp(p.x, p.w / 2, W - p.w / 2);
    p.y = clamp(p.y, p.h / 2, H - p.h / 2);
    const targetTilt = dy * 0.14 * (p.facingLeft ? -1 : 1);
    p.tilt += (targetTilt - p.tilt) * Math.min(1, 0.18 * (dt / STEP));
    if (boost && this.time - (p._lt || 0) > 24) {
      p._lt = this.time;
      const bx = p.facingLeft ? p.x + p.w / 2 + 8 : p.x - p.w / 2 - 8;
      this.effects.push(new BoostParticle(bx, p.y, this.time));
    }
    const vx = p.facingLeft ? -10 : 10;
    const edgeX = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    // shoot — auto-fire on touch (no room for a fire button while dragging)
    const firing = input.isTouch || k.has('Space') || k.has('Enter') || k.has('NumpadEnter') || (pad && pad.fire);
    if (firing && this.time - p.lastShot > p.shootDelay) {
      const n = p.spreadUntil > this.time ? 3 : 1; // spread pod: 3-bolt fan
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * 8;
        this.localBullets.push(new Bullet(edgeX, p.y, this.app.images.bullet, vx, a));
        this.net.send({ k: 'f', x: edgeX, y: p.y, vx, a });
      }
      p.lastShot = this.time;
      audio.play('gun', 0.22, edgeX, 0.95 + Math.random() * 0.1);
    }
    // rocket (E / Slash / pad X)
    if ((k.has('KeyE') || k.has('Slash') || (pad && pad.fire2)) && p.rockets > 0 && this.time - p.lastRk > RK_CD) {
      p.lastRk = this.time; p.rockets--;
      const rk = new Rocket(edgeX, p.y, this.app.images.rocket, this.remote, p.facingLeft ? 180 : 0);
      this.localRockets.push(rk);
      this.net.send({ k: 'rf', x: Math.round(edgeX), y: Math.round(p.y) });
      audio.play('rocket', 0.5, edgeX);
    }
    // laser (Q / Period / pad Y)
    if ((k.has('KeyQ') || k.has('Period') || (pad && pad.fire3)) && p.lasers > 0 && this.time - p.lastLz > LZ_CD) {
      p.lastLz = this.time; p.lasers--;
      const dir = p.facingLeft ? -1 : 1;
      this.effects.push(new LaserBeam(edgeX, p.y, this.time, 'rgb(120,220,255)', dir));
      audio.playSynth('plaser', edgeX);
      this.net.send({ k: 'lf', x0: Math.round(edgeX), y: Math.round(p.y), dir });
    }
    // thruster anim
    if (this.time - p.thrLast > 50) { p.thrLast = this.time; p.thrFrame = (p.thrFrame + 1) % p.thrusters.length; }
  }

  fireLaserTouch() {
    const p = this.local;
    if (!p.alive || p.lasers <= 0 || this.time - p.lastLz <= LZ_CD) return;
    p.lastLz = this.time; p.lasers--;
    const edgeX = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    const dir = p.facingLeft ? -1 : 1;
    this.effects.push(new LaserBeam(edgeX, p.y, this.time, 'rgb(120,220,255)', dir));
    audio.playSynth('plaser', p.x);
    this.net.send({ k: 'lf', x0: Math.round(edgeX), y: Math.round(p.y), dir });
  }

  fireRocketTouch() {
    const p = this.local;
    if (!p.alive || p.rockets <= 0 || this.time - p.lastRk <= RK_CD) return;
    p.lastRk = this.time; p.rockets--;
    const edgeX = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    this.localRockets.push(new Rocket(edgeX, p.y, this.app.images.rocket, this.remote, p.facingLeft ? 180 : 0));
    this.net.send({ k: 'rf', x: Math.round(edgeX), y: Math.round(p.y) });
    audio.play('rocket', 0.5, p.x);
  }

  update(dt) {
    this.k = dt / STEP;
    this.time += dt;
    this.updateBackdrop(dt);

    // re-announce our name shortly after connect to beat the handshake race
    // (whoever entered first may have sent 'hi' before the peer wired onMessage)
    if (!this._hiDone && this.time > 600) { this._hiDone = true; this.net.send({ k: 'hi', name: this.myName }); }

    if (this.disconnected) {
      if (input.pressed.size || input.pointer.justDown) { this.leave(); return; }
      return;
    }

    if (this.winner) {
      // settle projectiles/effects, offer rematch or leave
      for (const b of this.localBullets) b.update(this);
      for (const b of this.remoteBullets) b.update(this);
      for (const fx of this.effects) fx.update(this);
      this.localBullets = this.localBullets.filter((b) => !b.dead);
      this.remoteBullets = this.remoteBullets.filter((b) => !b.dead);
      this.localRockets = []; this.remoteRockets = [];
      this.effects = this.effects.filter((fx) => !fx.dead);
      if (!this.endMenu) {
        this.endMenu = new ButtonGroup([
          new Button('REMATCH', W / 2, H / 2 + 70, 220, 56, 'rgb(0,220,130)', 'rematch'),
          new Button('LEAVE', W / 2, H / 2 + 140, 220, 56, 'rgb(255,0,0)', 'leave'),
        ]);
      }
      if (!this.rematchMe) {
        const a = this.endMenu.update();
        if (a === 'rematch') { this.rematchMe = true; this.net.send({ k: 'rm' }); if (this.rematchThem) this.resetMatch(); }
        else if (a === 'leave') { this.leave(); return; }
      }
      return;
    }

    if (this.phase !== 'playing') {
      this.countdown -= dt;
      // remote thruster anim during countdown too
      if (this.phase === 'countdown' && this.countdown <= 0) this.phase = 'playing';
    }

    // interpolate remote ship
    this.remote.x += (this.remote.tx - this.remote.x) * Math.min(1, 0.3 * this.k);
    this.remote.y += (this.remote.ty - this.remote.y) * Math.min(1, 0.3 * this.k);
    if (this.time - (this.remote.thrLast || 0) > 50) { this.remote.thrLast = this.time; this.remote.thrFrame = (this.remote.thrFrame + 1) % this.remote.thrusters.length; }

    if (this.phase === 'playing') {
      this.moveLocal(dt);
      this.handleTouch();

      // local respawn
      if (!this.local.alive && this.localRespawn && this.time > this.localRespawn) {
        this.spawnLocal();
        this.localRespawn = 0;
      }

      // regen secondary ammo
      if (this.local.alive) {
        const p = this.local;
        if (p.rockets < RK_MAX && this.time > p.rkRegenAt) { p.rockets++; p.rkRegenAt = this.time + RK_REGEN; }
        if (p.lasers < LZ_MAX && this.time > p.lzRegenAt) { p.lasers++; p.lzRegenAt = this.time + LZ_REGEN; }
      }

      // projectiles
      for (const b of this.localBullets) b.update(this);
      for (const b of this.remoteBullets) b.update(this);
      for (const r of this.localRockets) r.update(this);
      for (const r of this.remoteRockets) r.update(this);

      // arena hazards: spawn (host) / advance, bend fire near the well,
      // soak shots on rocks; only MY ship is judged here (I own my death)
      this.arena.update(this);
      this.arena.applyGravity(this, [this.localBullets, this.remoteBullets], [this.local],
        () => this.localDie(this.arena.sing.x, this.arena.sing.y));
      this.arena.collideBullets(this, [this.localBullets, this.remoteBullets, this.localRockets, this.remoteRockets]);
      if (this.local.alive) {
        const hit = this.arena.hazardHit(this, this.local);
        if (hit) this.localDie(hit.x, hit.y);
      }
      if (this.local.alive) {
        const pod = this.arena.tryPickup(this, this.local);
        if (pod) { applyVsPod(this.local, pod.type, this.time); this.net.send({ k: 'pt', id: pod.id }); }
      }

      // remote bullets & rockets vs local ship — I own my death
      if (this.local.alive && this.time > (this.local.invulnUntil || 0)) {
        for (const b of this.remoteBullets) {
          if (b.dead) continue;
          if (Math.abs(b.x - this.local.x) < (b.w + this.local.w * 0.8) / 2 &&
              Math.abs(b.y - this.local.y) < (b.h + this.local.h * 0.8) / 2) {
            b.dead = true; this.localDie(b.x, b.y); break;
          }
        }
        for (const r of this.remoteRockets) {
          if (!r.dead && overlap(this.local, r, 0.9)) { r.dead = true; this.localDie(r.x, r.y); break; }
        }
      }

      // send ship state
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_MS) {
        this.sendAcc = 0;
        this.net.send({ k: 's', x: Math.round(this.local.x), y: Math.round(this.local.y), a: this.local.alive ? 1 : 0, sh: this.local.shield ? 1 : 0 });
      }
    }

    for (const fx of this.effects) fx.update(this);
    this.localBullets = this.localBullets.filter((b) => !b.dead);
    this.remoteBullets = this.remoteBullets.filter((b) => !b.dead);
    this.localRockets = this.localRockets.filter((r) => !r.dead);
    this.remoteRockets = this.remoteRockets.filter((r) => !r.dead);
    this.effects = this.effects.filter((fx) => !fx.dead);
  }

  leave() {
    try { this.net.send({ k: 'bye' }); } catch {}
    this.net.close();
    this.app.goMenu();
  }

  draw(g) {
    this.drawBackdrop(g);
    this.arena.draw(g, this);

    for (const b of this.localBullets) b.draw(g);
    for (const b of this.remoteBullets) b.draw(g);
    for (const r of this.localRockets) r.draw(g);
    for (const r of this.remoteRockets) r.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    if (this.remote.alive) this.remote.draw(g, this);
    this.local.draw(g, this);

    // HUD — P1 left, P2 right; names shown, your side marked
    const p1c = this.localId === 1 ? 'rgb(0,255,140)' : '#fff';
    const p2c = this.localId === 2 ? 'rgb(0,255,140)' : '#fff';
    // clip long names so the side scores never run into the centered "First to N"
    const clip = (s) => (s.length > 9 ? `${s.slice(0, 9)}…` : s);
    const name1 = clip(this.localId === 1 ? this.myName : this.oppName);
    const name2 = clip(this.localId === 2 ? this.myName : this.oppName);
    drawText(g, `${name1}: ${this.score1}`, 10, 24, 22, p1c, 'left');
    drawText(g, `${name2}: ${this.score2}`, W - 10, 24, 22, p2c, 'right');
    drawText(g, `First to ${SCORE_LIMIT}`, W / 2, 24, 16, 'rgb(160,160,160)');
    // my secondary ammo
    drawText(g, `🚀${this.local.rockets} ⚡${this.local.lasers}`, W / 2, 50, 16, 'rgb(120,220,255)');
    this.drawPing(g);

    // touch controls: leave + rocket + laser
    if (input.isTouch && !this.winner && !this.disconnected) {
      const lb = this.leaveBtn();
      g.globalAlpha = 0.3; g.fillStyle = '#fff';
      g.beginPath(); g.arc(lb.x, lb.y, lb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.85; g.strokeStyle = '#000'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(lb.x - 6, lb.y - 6); g.lineTo(lb.x + 6, lb.y + 6);
      g.moveTo(lb.x + 6, lb.y - 6); g.lineTo(lb.x - 6, lb.y + 6); g.stroke();
      g.globalAlpha = 1;
      // rocket button (bottom-right) + laser button (above it)
      const rb = this.rocketBtn(), zb = this.laserBtn();
      g.globalAlpha = this.local.rockets > 0 ? 0.4 : 0.2; g.fillStyle = '#fff';
      g.beginPath(); g.arc(rb.x, rb.y, rb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.9; g.drawImage(this.app.images.rocket, rb.x - 20, rb.y - 18, 40, 20);
      drawText(g, `${this.local.rockets}`, rb.x, rb.y + 16, 20, '#000');
      g.globalAlpha = this.local.lasers > 0 ? 0.4 : 0.2; g.fillStyle = 'rgb(120,220,255)';
      g.beginPath(); g.arc(zb.x, zb.y, zb.r, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 0.95; drawText(g, '⚡', zb.x, zb.y - 4, 26, '#000'); drawText(g, `${this.local.lasers}`, zb.x, zb.y + 18, 20, '#000');
      g.globalAlpha = 1;
    }

    if (this.phase === 'wait') {
      drawText(g, 'Waiting for host…', W / 2, H / 2, 22, 'rgb(255,210,80)');
    } else if (this.phase === 'countdown') {
      const n = Math.ceil(this.countdown / 1000);
      drawText(g, n > 0 ? String(n) : 'FIGHT!', W / 2, H / 2, 90, 'rgb(255,210,80)');
    }

    if (this.winner) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, 0, W, H);
      const iWon = (this.winner === 'PLAYER 1' && this.localId === 1) || (this.winner === 'PLAYER 2' && this.localId === 2);
      drawText(g, iWon ? 'YOU WIN!' : 'YOU LOSE', W / 2, H / 2 - 60, 56, iWon ? 'rgb(0,255,140)' : 'rgb(255,90,90)');
      drawText(g, `${this.winner} · ${this.score1} – ${this.score2}`, W / 2, H / 2 - 10, 24, '#fff');
      if (this.rematchMe) {
        drawText(g, this.rematchThem ? 'starting…' : 'waiting for partner…', W / 2, H / 2 + 90, 18, 'rgb(255,210,80)');
      } else {
        if (this.rematchThem) drawText(g, 'partner wants a rematch!', W / 2, H / 2 + 30, 16, 'rgb(0,255,140)');
        this.endMenu?.draw(g);
      }
    } else if (this.disconnected) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, 0, W, H);
      drawText(g, 'OPPONENT DISCONNECTED', W / 2, H / 2 - 10, 28, 'rgb(255,90,90)');
      drawText(g, 'press any key to return', W / 2, H / 2 + 40, 16, 'rgb(180,180,180)');
    } else if (this.reconnecting) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, W, H);
      const dots = '.'.repeat(1 + (Math.floor(this.time / 400) % 3));
      drawText(g, `RECONNECTING${dots}`, W / 2, H / 2, 30, 'rgb(255,210,80)');
    }
  }

  // ping badge, colour-coded by latency
  drawPing(g) {
    const r = this.net.rtt || 0;
    if (!r) return;
    const col = r < 80 ? 'rgb(0,220,130)' : r < 160 ? 'rgb(255,210,60)' : 'rgb(255,90,90)';
    drawText(g, `${r} ms`, W / 2, 74, 13, col); // below the ammo line — no overlap
  }

  onResize() { super.onResize(); }
}
