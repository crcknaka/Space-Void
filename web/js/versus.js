// Versus mode — port of versus.py (first to 10 kills), on top of BaseWorld
import { makeSpaceBackdrop } from './bggen.js';
import { W, H, STEP, randInt, overlap, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import { Player, Bullet, Explosion, Rocket, LaserBeam } from './entities.js';
import { VsArena, applyVsPod } from './versus_arena.js';

const SCORE_LIMIT = 10;
const RK_MAX = 3, RK_REGEN = 3500, RK_CD = 700;   // rockets: 3 max, refill every 3.5s
const LZ_MAX = 2, LZ_REGEN = 6000, LZ_CD = 1000;  // lasers: 2 max, refill every 6s
const LZ_BAND = 22;

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  shoot: 'Space', speed: 'ShiftLeft', rocket: 'KeyE', laser: 'KeyQ',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  shoot: 'Enter', shootAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
  rocket: 'Slash', laser: 'Period',
};

export class VersusState extends BaseWorld {
  constructor(app) {
    super(app, 'versus_background');
    this.canAutoPause = true; // local hotseat: pause on window blur
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('versus_music');
    setRngSeed(null);

    this.initBackdrop();
    this.bgOverride = makeSpaceBackdrop(777); // same procedural arena for both peers
    this.score1 = 0;
    this.score2 = 0;
    this.winner = null;
    this.winMenu = null;

    this.bullets1 = [];
    this.bullets2 = [];
    this.rockets = []; // each carries .ownerId (1|2); homes on the opponent

    this.player1 = new Player(images, {
      img: images.player1_ship,
      thrusters: images.thrusters.player1,
      controls: P1_CONTROLS,
      autoShoot: false,      // versus.py auto-fired due to a bug; manual fire is the intended design
      useRockets: false,
      padIndex: 0,
    });
    this.player2 = new Player(images, {
      img: images.player2_ship,
      thrusters: images.thrusters.player2,
      controls: P2_CONTROLS,
      facingLeft: true,
      shipFlipped: true,
      autoShoot: false,
      useRockets: false,
      padIndex: 1,
    });
    for (const p of [this.player1, this.player2]) {
      p.rockets = 2; p.lasers = 1;       // starting secondary ammo
      p.rkRegenAt = 0; p.lzRegenAt = 0;
      p.lastRk = -9999; p.lastLz = -9999;
      p.spreadUntil = 0;
    }
    this.arena = new VsArena(images); // hazards + pods; local play is always authority
    this.respawn1 = 0;
    this.respawn2 = 0;
    this.spawn(this.player1, 1);
    this.spawn(this.player2, 2);
  }

  // regenerate secondary ammo over time
  regen(p) {
    if (p.rockets < RK_MAX && this.time > p.rkRegenAt) { p.rockets++; p.rkRegenAt = this.time + RK_REGEN; }
    if (p.lasers < LZ_MAX && this.time > p.lzRegenAt) { p.lasers++; p.lzRegenAt = this.time + LZ_REGEN; }
  }

  fireRocketVs(p, id, opponent, controls) {
    const k = input.keys, pad = p.pad();
    if (!(k.has(controls.rocket) || (pad && pad.fire2))) return;
    if (p.rockets <= 0 || this.time - p.lastRk <= RK_CD) return;
    p.lastRk = this.time; p.rockets--;
    const angle = p.facingLeft ? 180 : 0;
    const rk = new Rocket(p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2, p.y, this.app.images.rocket, opponent, angle);
    rk.ownerId = id;
    this.rockets.push(rk);
    audio.play('rocket', 0.5, rk.x);
  }

  fireLaserVs(p, id, opponent, controls) {
    const k = input.keys, pad = p.pad();
    if (!(k.has(controls.laser) || (pad && pad.fire3))) return;
    if (p.lasers <= 0 || this.time - p.lastLz <= LZ_CD) return;
    p.lastLz = this.time; p.lasers--;
    const x0 = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    const dir = p.facingLeft ? -1 : 1;
    this.effects.push(new LaserBeam(x0, p.y, this.time, 'rgb(120,220,255)', dir));
    audio.playSynth('plaser', p.x);
    this.shake = Math.min(12, (this.shake || 0) + 3);
    // instant hit if the opponent is on the beam's path and side
    if (opponent.alive && Math.abs(opponent.y - p.y) < LZ_BAND && (dir > 0 ? opponent.x > x0 : opponent.x < x0)) {
      this.kill(opponent, id, x0, p.y);
    }
  }

  players() {
    return [this.player1, this.player2];
  }

  spawn(p, side) {
    p.y = randInt(50, H - 50);
    p.x = side === 1 ? randInt(50, W / 2 - 50) + p.w / 2 : randInt(W / 2 + 50, W - 50) - p.w / 2;
    p.alive = true;
    p.invulnUntil = this.time + 1500; // grace blink, same as online
  }

  buildWinMenu() {
    return new ButtonGroup([
      new Button('RETRY', W / 2, H / 2 + 60, 200, 60, 'rgb(0,255,0)', 'retry'),
      new Button('MAIN MENU', W / 2, H / 2 + 145, 200, 60, 'rgb(255,0,0)', 'main_menu'),
    ]);
  }

  onResize() {
    super.onResize();
    if (this.winMenu) this.winMenu = this.buildWinMenu();
  }

  shootFor(p, bullets, controls) {
    if (!p.alive) return;
    const k = input.keys;
    const pad = p.pad();
    const firing = k.has(controls.shoot) || (controls.shootAlt && k.has(controls.shootAlt)) || (pad && pad.fire);
    if (!firing) return;
    if (this.time - p.lastShot <= p.shootDelay) return;
    const vx = p.facingLeft ? -10 : 10;
    const edgeX = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    const n = p.spreadUntil > this.time ? 3 : 1; // spread pod: 3-bolt fan
    for (let i = 0; i < n; i++) bullets.push(new Bullet(edgeX, p.y, this.app.images.bullet, vx, (i - (n - 1) / 2) * 8));
    p.lastShot = this.time;
    audio.play('gun', 0.22, p.x, 0.95 + Math.random() * 0.1);
  }

  update(dt) {
    this.k = dt / STEP;

    if (this.winner) {
      const action = this.winMenu.update();
      if (action === 'retry') this.app.setState(new VersusState(this.app));
      else if (action === 'main_menu') this.app.goMenu();
      return;
    }

    if (this.handlePause()) return;

    this.time += dt;
    this.updateBackdrop(dt);

    this.shake = (this.shake || 0) * Math.pow(0.88, this.k);
    this.player1.update(this);
    this.player2.update(this);
    this.shootFor(this.player1, this.bullets1, P1_CONTROLS);
    this.shootFor(this.player2, this.bullets2, P2_CONTROLS);
    if (this.player1.alive) { this.regen(this.player1); this.fireRocketVs(this.player1, 1, this.player2, P1_CONTROLS); this.fireLaserVs(this.player1, 1, this.player2, P1_CONTROLS); }
    if (this.player2.alive) { this.regen(this.player2); this.fireRocketVs(this.player2, 2, this.player1, P2_CONTROLS); this.fireLaserVs(this.player2, 2, this.player1, P2_CONTROLS); }

    for (const b of this.bullets1) b.update(this);
    for (const b of this.bullets2) b.update(this);
    for (const r of this.rockets) r.update(this);
    for (const fx of this.effects) fx.update(this);

    // arena hazards: spawn/advance, bend fire near the well, soak shots on rocks
    this.arena.update(this);
    this.arena.applyGravity(this, [this.bullets1, this.bullets2], [this.player1, this.player2],
      (pl) => this.kill(pl, pl === this.player1 ? 2 : 1, this.arena.sing.x, this.arena.sing.y, true));
    this.arena.collideBullets(this, [this.bullets1, this.bullets2, this.rockets]);
    for (const [p, other] of [[this.player1, 2], [this.player2, 1]]) {
      if (p.alive) {
        const hit = this.arena.hazardHit(this, p);
        if (hit) this.kill(p, other, hit.x, hit.y, true);
      }
      if (p.alive) {
        const pod = this.arena.tryPickup(this, p);
        if (pod) applyVsPod(p, pod.type, this.time);
      }
    }

    // rockets vs the opponent
    for (const r of this.rockets) {
      if (r.dead) continue;
      const foe = r.ownerId === 1 ? this.player2 : this.player1;
      if (foe.alive && this.time > (foe.invulnUntil || 0) && overlap(foe, r, 0.9)) { r.dead = true; this.kill(foe, r.ownerId, r.x, r.y); }
    }

    // hits
    if (this.player1.alive && this.time > (this.player1.invulnUntil || 0)) {
      for (const b of this.bullets2) {
        if (!b.dead && overlap(this.player1, b, 0.8)) {
          b.dead = true;
          this.kill(this.player1, 2, b.x, b.y);
          break;
        }
      }
    }
    if (this.player2.alive && this.time > (this.player2.invulnUntil || 0)) {
      for (const b of this.bullets1) {
        if (!b.dead && overlap(this.player2, b, 0.8)) {
          b.dead = true;
          this.kill(this.player2, 1, b.x, b.y);
          break;
        }
      }
    }

    // respawns (1 second, like versus.py)
    if (!this.player1.alive && this.respawn1 && this.time > this.respawn1) {
      this.spawn(this.player1, 1);
      this.respawn1 = 0;
    }
    if (!this.player2.alive && this.respawn2 && this.time > this.respawn2) {
      this.spawn(this.player2, 2);
      this.respawn2 = 0;
    }

    this.bullets1 = this.bullets1.filter((b) => !b.dead);
    this.bullets2 = this.bullets2.filter((b) => !b.dead);
    this.rockets = this.rockets.filter((r) => !r.dead);
    this.effects = this.effects.filter((fx) => !fx.dead);

    // winner check
    if (this.score1 >= SCORE_LIMIT || this.score2 >= SCORE_LIMIT) {
      this.winner = this.score1 >= SCORE_LIMIT ? 'PLAYER 1' : 'PLAYER 2';
      this.winMenu = this.buildWinMenu();
    }
  }

  // hazard=true: environmental death (opponent still scores, no kill voice)
  kill(p, byPlayer, hx, hy, hazard) {
    if (this.time < (p.invulnUntil || 0)) return; // spawn / shield-pop grace
    if (p.shield) { // shield pod absorbs one hit of anything
      p.shield = false;
      p.shieldRipple = { a: hx !== undefined ? Math.atan2(hy - p.y, hx - p.x) : Math.PI, start: this.time };
      p.invulnUntil = this.time + 800;
      audio.playSynth('shield_pop', p.x);
      return;
    }
    this.effects.push(new Explosion(p.x, p.y, this.app.images.explosion_spritesheet, this.time));
    audio.play('explosion', 0.5);
    if (!hazard) audio.play(byPlayer === 1 ? 'player1_kill' : 'player2_kill', 0.7);
    p.alive = false;
    if (byPlayer === 1) { this.score1 += 1; this.respawn2 = this.time + 1000; }
    else { this.score2 += 1; this.respawn1 = this.time + 1000; }
  }

  draw(g) {
    this.drawBackdrop(g);
    this.arena.draw(g, this);

    for (const b of this.bullets1) b.draw(g);
    for (const b of this.bullets2) b.draw(g);
    for (const r of this.rockets) r.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    this.player1.draw(g, this);
    this.player2.draw(g, this);

    drawText(g, `P1: ${this.score1}`, 10, 24, 26, '#fff', 'left');
    drawText(g, `P2: ${this.score2}`, W - 10, 24, 26, '#fff', 'right');
    drawText(g, `First to ${SCORE_LIMIT}`, W / 2, 24, 18, 'rgb(160,160,160)');
    // secondary-ammo readout per player
    drawText(g, `🚀${this.player1.rockets} ⚡${this.player1.lasers}`, 10, 50, 16, 'rgb(120,220,255)', 'left');
    drawText(g, `🚀${this.player2.rockets} ⚡${this.player2.lasers}`, W - 10, 50, 16, 'rgb(120,220,255)', 'right');

    this.drawPauseOverlay(g);

    if (this.winner) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, 0, W, H);
      drawText(g, `${this.winner} WINS!`, W / 2, H / 2 - 100, 56);
      this.winMenu.draw(g);
    }
  }
}
