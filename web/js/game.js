// Single / Co-op / Daily game mode — port of game.py on top of BaseWorld
import { W, H, STEP, rand, randInt, overlap, clamp, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import {
  Player, Enemy, Boss, Asteroid, PowerUp, Explosion, Spark, Shockwave,
  Mine, MeshDebris, shatterSprite, RockDust, Comet, DistantConvoy, DistantRocks, Freighter, Skirmish, WarpStreak, Lightning,
  LaserBeam, ScorePopup,
  POWERUP_TYPES, POWERUP_IMG,
} from './entities.js';
import { makeNebulaField, tinted } from './fx.js';
import { askName, submitScore, savedName } from './lb.js';
import { bumpStats, vibrate, settings } from './settings.js';
import { progress, awardRun } from './progress.js';
import { SHIP_BY_ID } from './ships.js';
import { dailySeed, todayMod, useDailyAttempt, dailyAttemptsLeft, MODS } from './daily.js';
import { makeSpaceBackdrop, sectorName, SECTOR_THEMES } from './bggen.js';

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  rocket: 'Space', speed: 'ShiftLeft', laser: 'KeyE', laserAlt: 'KeyQ',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  rocket: 'Enter', rocketAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
  laser: 'Numpad1', laserAlt: 'Slash',
};

// Distinct per-player identity: HUD colour + ship tint (null = keep art as-is)
export const PLAYER_COLORS = ['rgb(90,200,255)', 'rgb(90,255,140)', 'rgb(255,170,60)', 'rgb(230,120,255)'];
const PLAYER_TINTS = [null, 'rgba(90,255,140,0.45)', 'rgba(255,150,40,0.55)', 'rgba(220,90,255,0.5)'];

// Colored ship sprite for player index i. Local modes keep the original
// player1/player2 art; online (colored) tints every ship a distinct hue.
export function playerShip(images, i, colored) {
  if (!colored) return i === 1 ? images.player2_ship : images.player1_ship;
  const tint = PLAYER_TINTS[i % PLAYER_TINTS.length];
  const base = i === 1 ? images.player2_ship : images.player1_ship;
  return tint ? tinted(base, tint, `ship_${i}`) : base;
}

export function spawnY(i, total) {
  return Math.round((H * (i + 1)) / (total + 1));
}

export class GameState extends BaseWorld {
  constructor(app, coop, opts = {}) {
    super(app, 'game_background');
    this.coop = coop;
    this.daily = !!opts.daily;
    this.online = !!opts.online;   // driven by CoopHost; no pause/menu/leaderboard
    this.canAutoPause = true;      // pause on window blur (offline; guarded in autoPause)
    this.extraPlayers = opts.extraPlayers || 0; // guest-controlled ships (online 4p)
    this.colored = !!opts.colored; // distinct ship colours per player
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');
    // daily challenge: everyone plays the same seeded spawn stream today
    setRngSeed(this.daily ? dailySeed() : null);
    this.mod = this.daily ? todayMod() : (MODS.find((m) => m.id === this.app.debugMod) || null);
    this._dailyCharged = false; // an attempt is spent only once the run is committed
    if (this.daily) this.pushToasts(bumpStats({ dailyRuns: 1 }));

    this.level = 1;
    this.nebulaHue = this.sectorTheme().hue; // themed nebula from the first sector
    this.initBackdrop();
    this.score = 0;
    if (!this.app.debugNoBg) this.bgOverride = makeSpaceBackdrop(this.app.debugBg || this.level, this.sectorTheme()); // per-level themed scene
    this.nextBossScore = 100;
    this.bossSpawned = false;
    this.slowMoEnd = 0;

    this.bullets = [];
    this.beams = []; // active player laser beams (hot damage windows)
    this.rockets = [];
    this.enemyBullets = [];
    this.enemyRockets = []; // homing rockets fired by high-level tanks
    this.mines = [];         // proximity mines laid by veteran tanks (level 6+)
    this.ambient = [];       // background flourishes: comets, distant convoys
    this.nextAmbientAt = this.mod?.convoy ? 4000 : 12000 + Math.random() * 20000; // raids start early
    this.enemies = [];       // includes boss
    this.asteroids = [];
    this.powerups = [];
    this.lb = { status: 'idle' }; // leaderboard submission state
    this.combo = 0;
    this.comboEnd = 0;
    this.mult = 1;
    this.multPulse = 0;
    this.spawnHoldUntil = 0;
    this.bossWarnStart = 0;
    this.bossReadyAt = 30000; // min wave time before the first boss
    this.runPowerups = 0;
    this.toasts = this.toasts || [];
    // dedicated generated pods; tint fallback if the generator didn't run
    this.shieldImg = images.shield_powerup || tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield');
    this.laserImg = images.laser_powerup || tinted(images.powerup, 'rgba(90,140,255,0.6)', 'powerup_laser');

    this.enemyInterval = 2000;
    this.asteroidInterval = 5000;
    this.powerupInterval = 10000;  // game.py set 1000ms but the comment said 10s — fixed
    this.enemyAcc = 0;
    this.asteroidAcc = 0;
    this.powerupAcc = 0;
    this.shower = null; // meteor shower event
    this.nextShowerAt = 45000 + randInt(0, 30000);

    this.shake = 0;
    this.over = false;
    this.overAlpha = 0;
    this.overMenu = null;
    this.levelBanner = null;

    // debug (?boss=N): instant beefed-up boss of level N for visual tuning
    if (this.app.debugBoss) {
      this.level = this.app.debugBoss;
      const b = new Boss(images, this.level, 0);
      b.health = b.maxHealth = b.maxHealth * (b.mega ? 2 : 6); // megas: reach phase 2 fast in tests
      this.enemies.push(b);
      this.bossSpawned = true;
    }

    // Build the player list. Local: 1 (single) or 2 (co-op) with keyboard
    // controls. Online co-op host: 1 local host + N guest-controlled ships
    // (extraPlayers), each a distinct colour so they're easy to tell apart.
    const total = 1 + (this.coop ? 1 : 0) + (this.extraPlayers || 0);
    this.playerList = [];
    for (let i = 0; i < total; i++) {
      const local = i === 0;
      const p = new Player(images, {
        img: playerShip(images, i, this.colored),
        thrusters: images.thrusters[i === 1 ? 'player2' : 'player1'],
        controls: local ? P1_CONTROLS : (i === 1 && !this.online ? P2_CONTROLS : {}),
        padIndex: local ? 0 : (i === 1 && !this.online ? 1 : null),
        autoShoot: true,
      });
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      p.slot = i;
      p.x = 100;
      p.y = spawnY(i, total);
      this.playerList.push(p);
    }
    this.player1 = this.playerList[0];
    this.player2 = this.playerList[1] || null;

    // touch state (mobile: drag to move, on-screen rocket button)
    this.drag = null;
    // first-run touch tutorial: ghost hints for ~10s
    this.tutUntil = 0;
    try {
      if (input.isTouch && !this.online && !this.daily && !localStorage.getItem('sv_tut')) this.tutUntil = 10000;
    } catch {}

    this._rtAt = -1; // per-frame cache key for rocketTargets()

    // selected ship (offline non-daily only — daily/versus/online stay stock
    // so their leaderboards and multiplayer sync are fair)
    if (!this.daily && !this.online) this.applyShip(this.player1);

    // apply daily modifier to the players
    if (this.mod) {
      for (const p of this.players()) {
        if (this.mod.startRockets) p.rockets = this.mod.startRockets;
        if (this.mod.rocketDelay) p.rocketDelay *= this.mod.rocketDelay;
        if (this.mod.playerBoost) p.fastSpeed += this.mod.playerBoost;
      }
    }
  }

  // Swap the local ship's hull + stats to the player's chosen ship. Cosmetic
  // sprite plus a stat block over Player defaults; keeps daily/online stock.
  applyShip(p) {
    const ship = SHIP_BY_ID[progress.selectedShip] || SHIP_BY_ID.vanguard;
    const spr = this.app.images.ships?.[ship.id];
    if (spr) p.img = spr; // baked hull carries its own bankFrames
    const s = ship.stats || {};
    if (s.defaultSpeed != null) p.defaultSpeed = s.defaultSpeed;
    if (s.fastSpeed != null) p.fastSpeed = s.fastSpeed;
    if (s.shootDelay != null) p.shootDelay = p.baseShootDelay = s.shootDelay;
    if (s.rockets != null) p.rockets = s.rockets;
    if (s.lasers != null) p.lasers = s.lasers;
    if (s.lives != null) p.lives = s.lives;
    if (s.w != null) p.w = s.w;
    if (s.h != null) p.h = s.h;
    if (s.startShield) p.shield = true;
  }

  players() {
    return this.playerList;
  }

  // Homing-rocket targets, computed once per frame (all rockets share it)
  // instead of allocating a filtered+concat array per rocket per frame.
  rocketTargets() {
    if (this._rtAt !== this.time) {
      this._rt = this.enemies.filter((e) => !e.dying).concat(this.asteroids);
      this._rtAt = this.time;
    }
    return this._rt;
  }

  rocketBtn() {
    return { x: W - 70, y: H - 80, r: 44 }; // live: follows resizes
  }

  laserBtn() {
    return { x: W - 70, y: H - 185, r: 38 }; // above the rocket button
  }

  pauseBtn() {
    return { x: W - 34, y: 72, r: 24 }; // touch pause, under the Level text
  }

  buildOverMenu() {
    const buttons = [];
    if (!this.daily || dailyAttemptsLeft() > 0) {
      buttons.push(new Button('RETRY', W / 2, H / 2 + 75, 200, 50, 'rgb(0,255,0)', 'retry'));
    }
    buttons.push(new Button('MAIN MENU', W / 2, H / 2 + 145, 200, 50, 'rgb(255,0,0)', 'main_menu'));
    return new ButtonGroup(buttons);
  }

  onResize() {
    super.onResize();
    if (this.overMenu) this.overMenu = this.buildOverMenu();
  }

  // visual biome for the current sector (cycles as levels climb)
  sectorTheme() {
    return SECTOR_THEMES[(this.level - 1) % SECTOR_THEMES.length];
  }

  logEvent(name) {
    // debug timeline (enabled with ?log)
    window.__svlog?.push(`${(this.time / 1000).toFixed(1)}s L${this.level} score=${this.score} ${name}`);
  }

  pushToasts(defs) {
    if (!defs?.length) return;
    this.toasts = this.toasts || [];
    for (const d of defs) this.toasts.push({ title: d.title, start: null });
    audio.playSynth('achieve');
  }

  // Elite: golden aura, triple hp/points, guaranteed power-up drop on death.
  makeElite(e) {
    e.elite = true;
    e.health = Math.max(2, e.health * 3);
    e.points *= 3;
  }

  // Materialise an enemy just inside the right edge with a warp-in ring
  // (enemies used to drift in from off-screen — invisible spawns).
  introEnemy(e, opts = {}) {
    if (this.mod?.enemySpeed) e.vx *= this.mod.enemySpeed;
    if (this.mod?.shootRate) e.shootDelay = Math.max(250, e.shootDelay * this.mod.shootRate);
    if (this.mod?.rocketDay && e.type === 'tank') {
      e.rocketLauncher = true;
      e.rocketDelay = Math.max(3200, e.rocketDelay * 0.6);
    }
    if (this.mod?.minefield && e.type === 'tank') e.minelayer = true;
    e.x = opts.x ?? W - randInt(40, 90);
    if (opts.dy) e.y = clamp(e.y + opts.dy, e.h / 2, H - e.h / 2);
    e.warpUntil = this.time + 550;
    this.effects.push(new Shockwave(e.x, e.y, this.time, e.elite ? 95 : 60,
      e.elite ? 'rgb(255,210,90)' : 'rgb(255,150,80)'));
    for (let i = 0; i < 4; i++) this.effects.push(new Spark(e.x, e.y, this.time, Math.PI));
    this.enemies.push(e);
  }

  // Wedge formation: a leader and two wingmen, dashes synchronized.
  spawnWedge() {
    const mk = () => new Enemy(this.app.images, this.level, 'basic', this.time, false);
    const bx = W - randInt(70, 100);
    const lead = mk();
    lead.y = clamp(lead.y, 100, H - 100);
    if (this.level >= 3 && randInt(1, 100) <= 12) this.makeElite(lead);
    this.introEnemy(lead, { x: bx });
    for (const s of [1, -1]) {
      const wing = mk();
      wing.y = lead.y;
      wing.vx = lead.vx;
      wing.canDash = lead.canDash;
      wing.nextDashAt = lead.nextDashAt;
      this.introEnemy(wing, { x: bx + 48, dy: s * 44 });
    }
  }

  pickEnemyType() {
    const r = rand(0, 100);
    const L = this.level;
    if (this.mod?.tankBias && r < 35) return 'tank';               // HEAVY ARMOR day
    if (this.mod?.lightOnly) return r < 45 ? 'weaver' : 'basic';   // THE SWARM day
    // deeper sectors thin out the fodder and lean on the specialist roster
    if (L >= 5 && r < 8) return 'carrier';
    if (L >= 5 && r < 20) return 'strafer';
    if (L >= 4 && r < 30) return 'sniper';
    if (L >= 3 && r < 42) return 'shieldbearer';
    if (L >= 4 && r < 56) return 'tank';
    if (L >= 3 && r < 74) return 'hunter';
    if (L >= 2 && r < (L >= 5 ? 92 : 82)) return 'weaver';
    return 'basic';
  }

  spawnSparks(x, y, count, dir = Math.PI) {
    for (let i = 0; i < count; i++) this.effects.push(new Spark(x, y, this.time, dir));
  }

  // dust burst when a rock cracks; amount/spread/loudness scale with the size
  spawnRockDust(x, y, w) {
    audio.playSynth('crack', x, Math.min(1.5, 0.6 + w / 160));
    const s = Math.max(0.7, w / 90);
    const grit = Math.round(8 + w * 0.16);
    for (let i = 0; i < grit; i++) this.effects.push(new RockDust(x, y, this.time, s));
    for (let i = 0; i < 4; i++) this.effects.push(new RockDust(x, y, this.time, s, true));
  }

  // ~1 in 9 rocks is volcanic — it blows a damaging shockwave when cracked
  pickRock() {
    const pool = this.app.images.asteroids;
    const volcanic = randInt(1, 9) === 1;
    const sub = pool.filter((r) => !!r.volcanic === volcanic);
    return sub[randInt(0, sub.length - 1)];
  }

  // volcanic rock cracked: a blast that torches nearby fighters and burns
  // enemy fire out of the air — never hurts the player, it's a reward
  volcanicBlast(a) {
    const r = a.size === 'large' ? 210 : a.size === 'medium' ? 130 : 70;
    this.effects.push(new Shockwave(a.x, a.y, this.time, r, 'rgb(255,120,60)'));
    audio.play('explosion', 0.45, a.x);
    this.shake = Math.min(12, this.shake + 4);
    for (const e of this.enemies) {
      if (e.dead || e.dying || e.isBoss) continue;
      if ((e.x - a.x) ** 2 + (e.y - a.y) ** 2 < r * r) {
        e.dead = true;
        this.explode(e.x, e.y, false);
        this.addKill(e.points || 10, e.x, e.y);
      }
    }
    for (const b of this.enemyBullets) {
      if (!b.dead && (b.x - a.x) ** 2 + (b.y - a.y) ** 2 < r * r) b.dead = true;
    }
  }

  popup(x, y, text, color) {
    this.effects.push(new ScorePopup(x, y, text, this.time, color));
    if (this.online) (this._spQ = this._spQ || []).push([Math.round(x), Math.round(y), text]);
  }

  // Piercing laser: a beam from the ship's nose to the right edge that stays
  // hot for ~450ms — everything on the line when it fires AND everything that
  // flies into it while it burns gets hit (once per beam). Burns enemy
  // bullets, blows wrecks, splits asteroids. Charges are finite (Player.lasers).
  laserBlast(p) {
    const x0 = p.x + p.w / 2;
    const y = p.y;
    this.effects.push(new LaserBeam(x0, y, this.time, undefined, 1, 900));
    if (this.online) (this._lzQ = this._lzQ || []).push([Math.round(x0), Math.round(y)]);
    audio.playSynth('plaser', p.x);
    vibrate(40);
    this.shake = Math.min(12, this.shake + 3);
    const bm = { x0, y, until: this.time + 450, hit: new Set() };
    this.beams.push(bm);
    this.laserBeamDamage(bm); // first tick lands instantly
  }

  laserBeamDamage(bm) {
    const { x0, y } = bm;
    const HALF = 14; // beam half-height for hit tests
    // enemy bullets on the line burn up
    for (const b of this.enemyBullets) {
      if (!b.dead && b.x > x0 && Math.abs(b.y - y) < HALF + 4) { b.dead = true; this.spawnSparks(b.x, b.y, 3); }
    }
    // enemies (incl. boss) — pierces through all of them, once per beam each
    for (const e of this.enemies) {
      if (e.dead || bm.hit.has(e) || e.x + e.w / 2 < x0 || Math.abs(e.y - y) > HALF + e.h * 0.4) continue;
      bm.hit.add(e);
      this.spawnSparks(Math.max(x0, e.x - e.w / 2), e.y, 10);
      if (e.dying) {
        e.dead = true;
        this.explode(e.x, e.y, true, 1.1);
        continue;
      }
      if (e.isBoss && e.deathSeq) continue; // already going down
      if (e.isBoss && e.shieldUntil > this.time) { // shield eats the beam
        e.shieldRipple = { a: Math.PI, start: this.time };
        audio.playSynth('shield_hit', e.x);
        continue;
      }
      if (e.takeDamage(2)) {
        this.addKill(e.points, e.x, e.y);
        this.pushToasts(bumpStats({ kills: 1 }));
        if (e.isBoss) {
          this.killBoss(e);
        } else {
          e.dead = true;
          this.explode(e.x, e.y, true, e.type === 'tank' ? 1.5 : 1);
          if (e.type === 'tank' && rand(0, 1) < 0.4) this.dropPowerup(e.x, e.y);
        }
      } else {
        audio.playSynth('hit', e.x, 1.2); // hull held against the beam
      }
    }
    // asteroids split like a bullet hit (the beam gouges a giant for 2),
    // once per beam each
    for (const a of this.asteroids) {
      if (a.dead || bm.hit.has(a) || a.x + a.w / 2 < x0 || Math.abs(a.y - y) > HALF + a.h * 0.35) continue;
      bm.hit.add(a);
      if (a.hp > 2) {
        a.hp -= 2;
        this.spawnSparks(a.x - a.w / 2, a.y, 6);
        for (let i = 0; i < 6; i++) this.effects.push(new RockDust(a.x - a.w / 2, a.y, this.time, 1));
        audio.playSynth('thock', a.x, 1.2);
        continue;
      }
      a.dead = true;
      this.explode(a.x, a.y, false);
      this.spawnRockDust(a.x, a.y, a.w);
      if (a.volcanic) this.volcanicBlast(a);
      this.addKill(5, a.x, a.y);
      this.asteroids.push(...a.breakApart(this.time));
    }
  }

  powerupImage(type) {
    if (type === 'shield') return this.shieldImg;
    if (type === 'laser') return this.laserImg;
    return this.app.images[POWERUP_IMG[type]];
  }

  dropPowerup(x, y) {
    const type = this.mod?.shieldsOnly ? 'shield' : POWERUP_TYPES[randInt(0, POWERUP_TYPES.length - 1)];
    const pu = new PowerUp(this.powerupImage(type), type);
    pu.x = x;
    pu.baseY = clamp(y, 40, H - 40);
    pu.y = pu.baseY;
    this.powerups.push(pu);
  }

  explode(x, y, sound = true, scale = 1) {
    this.effects.push(new Explosion(x, y, this.app.images.explosion_spritesheet, this.time, scale));
    this.shake = Math.min(12, this.shake + 3 * scale);
    if (sound) audio.play('explosion', 0.5, x);
  }

  killPlayer(p, hx, hy) {
    if (this.app.debugGod) return;
    if (this.time < (p.invulnUntil || 0)) return;
    this.resetCombo();
    if (p.shield && this.ionStorm?.phase !== 'active') {
      // shield absorbs the hit — hex bubble ripples out from the impact point
      p.shield = false;
      p.shieldRipple = { a: hx !== undefined ? Math.atan2(hy - p.y, hx - p.x) : Math.PI, start: this.time };
      p.invulnUntil = this.time + 1200;
      this.spawnSparks(p.x, p.y, 16);
      audio.playSynth('shield_pop', p.x);
      vibrate(50);
      this.pushToasts(bumpStats({ shieldSaves: 1 }));
      return;
    }
    if (this.shower) this.shower.survived = false; // shower bonus lost
    this.explode(p.x, p.y, true, 1.6);
    shatterSprite(this, p.img, p.x, p.y, p.w, { ry: 0, vx: -0.5 });
    vibrate(140);
    this.dmgFlash = 1; // red screen-edge pulse
    p.alive = false;
    p.lives -= 1;
    // the run's final death plays out in slow motion
    if (p.lives <= 0 && this.players().every((pp) => !pp.alive && pp.lives <= 0)) {
      this.slowmo = { t: 0, dur: 1700, depth: 0.9 };
    }
    if (p.lives > 0) p.respawnAt = this.time + 1500;
  }

  // Boss defeat → cinematic death sequence (entities.Boss.updateDeathSeq
  // spawns the chained explosions and calls levelUp at the final blast).
  killBoss(boss) {
    if (!boss.deathSeq) boss.startDeathSeq(this);
  }

  // combo: consecutive kills raise the score multiplier (up to x5); resets on hit or 4s idle
  addKill(points, x, y) {
    this.combo += 1;
    this.comboEnd = this.time + 4000;
    const tier = Math.min(5, 1 + Math.floor(this.combo / 5));
    if (tier > this.mult) {
      this.mult = tier;
      this.multPulse = this.time;
      audio.playSynth('combo');
      this.pushToasts(bumpStats({ maxMult: tier }));
    }
    const gained = points * this.mult * (this.mod?.scoreMul || 1);
    this.score += gained;
    if (x !== undefined) this.popup(x, y, `+${gained}`, this.mult > 1 ? 'rgb(255,215,90)' : 'rgb(220,220,220)');
  }

  resetCombo() {
    this.combo = 0;
    this.mult = 1;
  }

  levelUp(x, y) {
    this.score += 50;
    this.bossSpawned = false;
    this.level += 1;
    this.nextBossScore = this.score + 150 + this.level * 150;
    // guaranteed regular-wave time before the next boss, growing with level
    this.bossReadyAt = this.time + Math.min(70000, 45000 + (this.level - 1) * 5000);
    this.enemyInterval = Math.max(500, this.enemyInterval - 200);
    this.asteroidInterval = Math.max(2000, this.asteroidInterval - 500);
    for (const p of this.players()) { p.rockets += 3; p.lasers += 1; }
    // breather: no new spawns for a few seconds
    this.spawnHoldUntil = this.time + 4000;
    // fresh scene for the new level arrives via a hyperspace hop (after the
    // slow-mo): accelerate → swap the backdrop at peak speed → brake. The
    // heavy canvas generation lands mid-streak where a hitch can't be seen.
    this.nebulaHue = this.sectorTheme().hue;
    this.warpAt = this.time + 1500;
    this.bgZoomTarget = 1 + ((this.level - 1) % 4) * 0.05;
    // celebration: shockwave + smooth slow-mo dip + soft flash + banner
    this.effects.push(new Shockwave(x ?? W / 2, y ?? H / 2, this.time));
    this.slowmo = { t: 0, dur: 1400 };
    this.killFlash = 1;
    this.levelBanner = { level: this.level, start: this.time };
    this.logEvent('LEVELUP (boss killed)');
    audio.playSynth('fanfare');
    vibrate(80);
    this.bossKillCount = (this.bossKillCount || 0) + 1; // per-run, funds credits
    this.pushToasts(bumpStats({ bossKills: 1, maxLevel: this.level }));
  }

  update(dt) {
    // boss-kill celebration: the world eases into ~15% speed and back out
    // over 1.4s (sin dip) — reads as drama, not as a frame hitch
    if (this.slowmo && !this.over) {
      this.slowmo.t += dt;
      const p = this.slowmo.t / this.slowmo.dur;
      if (p >= 1) this.slowmo = null;
      else dt *= 1 - (this.slowmo.depth ?? 0.85) * Math.pow(Math.sin(p * Math.PI), 0.6);
    }
    this.k = dt / STEP;

    if (!this.over && this.handlePause()) return;

    if (this.over) {
      this.updateGameOver();
      return;
    }

    this.time += dt;
    if (this.daily) this.maybeConsumeDaily(); // charge once the run is committed, any exit path

    // hyperspace hop between levels: accelerate → swap the scene at peak
    // speed (the canvas-generation hitch hides in the streaks) → brake
    if (this.warpAt && this.time >= this.warpAt) {
      this.warpAt = 0;
      this.warp = { t: 0, swapped: false, dur: 2600 };
      audio.playSynth('warp');
      this._zoomAfterWarp = this.bgZoomTarget;
      this.bgZoomTarget += 0.1;        // subtle camera push while streaking
      this.spawnPlanet(W + 60);        // a star system sweeps past mid-jump
    }
    if (this.warp) {
      this.warp.t += dt;
      const p = this.warp.t / this.warp.dur;
      if (p >= 1) {
        this.warp = null;
        this.warpMul = 1;
        if (this._zoomAfterWarp != null) { this.bgZoomTarget = this._zoomAfterWarp; this._zoomAfterWarp = null; }
      } else {
        const env = p < 0.35 ? p / 0.35 : p > 0.65 ? (1 - p) / 0.35 : 1; // trapezoid
        this.warpMul = 1 + 27 * env * env * (3 - 2 * env);               // smoothstep edges
        if (!this.warp.swapped && p >= 0.45) {
          this.warp.swapped = true;
          if (!this.app.debugNoBg) this.bgOverride = makeSpaceBackdrop(this.app.debugBg || this.level, this.sectorTheme());
          this.nebulae = makeNebulaField(3, this.nebulaHue);
          this.killFlash = Math.max(this.killFlash || 0, 0.45); // soft blink at the jump
        }
        // streak density scales with speed
        const nS = this.warpMul > 4 ? Math.min(4, Math.round(this.warpMul / 7)) : 0;
        for (let i = 0; i < nS; i++) this.effects.push(new WarpStreak(this.time));
      }
    }

    // --- spawn timers (pygame USEREVENT timers); paused during the post-boss breather ---
    const spawningAllowed = this.time >= this.spawnHoldUntil;
    this.enemyAcc += dt;
    if (this.enemyAcc >= this.enemyInterval * (this.mod?.enemyRate || 1) && spawningAllowed) {
      this.enemyAcc = 0;
      if (this.level >= 2 && rand(0, 100) < 14 && !this.mod?.lightOnly) {
        this.spawnWedge(); // a wedge of three warps in as one formation
      } else {
        const chance = Math.min(10 + (this.level - 1) * 5, 100);
        const moveRandomly = randInt(1, 100) <= chance;
        const e = new Enemy(this.app.images, this.level, this.pickEnemyType(), this.time, moveRandomly);
        // elites grow more common as the run deepens (6% → ~18% by level 8)
        if (this.level >= 2 && randInt(1, 100) <= Math.min(18, 4 + this.level * 2)) this.makeElite(e);
        this.introEnemy(e);
      }
    }
    this.powerupAcc += dt;
    if (this.powerupAcc >= this.powerupInterval && spawningAllowed) {
      this.powerupAcc = 0;
      const type = this.mod?.shieldsOnly ? 'shield' : POWERUP_TYPES[randInt(0, POWERUP_TYPES.length - 1)];
      this.powerups.push(new PowerUp(this.powerupImage(type), type));
    }
    this.asteroidAcc += dt;
    if (this.asteroidAcc >= this.asteroidInterval * (this.mod?.asteroidRate || 1) && spawningAllowed) {
      this.asteroidAcc = 0;
      this.asteroids.push(new Asteroid(this.pickRock(), 'large'));
    }

    // --- meteor shower: klaxon warning, then a slanted rock storm ---
    if (!this.shower && this.time > this.nextShowerAt && spawningAllowed &&
        !this.bossSpawned && !this.bossWarnStart && !this.levelBanner) {
      this.shower = {
        warnUntil: this.time + 2200,
        until: this.time + 14000,
        acc: 400,
        dir: rand(0, 1) < 0.5 ? 1 : -1, // one slant per shower
        survived: true,
      };
      this.logEvent('METEOR SHOWER');
      audio.playSynth('storm');
      vibrate([50, 80, 50]);
    }
    if (this.shower && this.time > this.shower.warnUntil) {
      if (this.time < this.shower.until) {
        this.shower.acc += dt;
        if (this.shower.acc > 520 && spawningAllowed) {
          this.shower.acc = 0;
          const a = new Asteroid(this.pickRock(), rand(0, 1) < 0.45 ? 'medium' : 'large');
          a.vx = rand(3.5, 6.5);
          a.vy = this.shower.dir * rand(0.8, 2.2);
          a.rotSpeed *= 1.6;
          a.y = this.shower.dir > 0
            ? randInt(a.h / 2, (H * 0.6) | 0)
            : randInt((H * 0.4) | 0, H - a.h / 2);
          this.asteroids.push(a);
        }
      } else {
        if (this.shower.survived && this.players().some((p) => p.alive)) {
          this.score += 150;
          this.popup(W / 2, H * 0.25, 'SHOWER CLEARED +150', 'rgb(255,190,90)');
          audio.playSynth('combo');
        }
        this.shower = null;
        this.nextShowerAt = this.time + 65000 + randInt(0, 45000);
      }
    }

    // --- boss spawn: WARNING klaxon first, then the boss flies in.
    // Needs the score AND enough wave time (combo inflates the score) ---
    if (this.score >= this.nextBossScore && this.time >= this.bossReadyAt && !this.bossSpawned && !this.levelBanner) {
      if (!this.bossWarnStart) {
        this.bossWarnStart = this.time;
        this.logEvent('WARNING');
        audio.playSynth('warning');
        vibrate([60, 90, 60]);
      } else if (this.time - this.bossWarnStart > 2500) {
        this.bossWarnStart = 0;
        this.logEvent('BOSS SPAWN');
        const boss = new Boss(this.app.images, this.level, this.time);
        if (this.mod?.bossHp) {
          boss.health = boss.maxHealth = Math.round(boss.health * this.mod.bossHp);
        }
        this.enemies.push(boss);
        this.bossSpawned = true;
        for (const p of this.players()) p.rockets += 3;
        // dramatic entrance: red warp ring + screen shake
        this.effects.push(new Shockwave(W - 60, boss.y, this.time, 300, 'rgb(255,90,90)'));
        this.shake = Math.min(12, this.shake + 8);
      }
    }

    // --- respawns (lives system) ---
    for (const p of this.players()) {
      if (!p.alive && p.lives > 0 && p.respawnAt && this.time > p.respawnAt) {
        p.alive = true;
        p.respawnAt = 0;
        p.x = 100;
        p.y = spawnY(p.slot || 0, this.playerList.length);
        p.invulnUntil = this.time + 2500;
        audio.playSynth('respawn');
        // warp-in flourish: cyan ring + sparks at the spawn point
        this.effects.push(new Shockwave(p.x, p.y, this.time, 90, 'rgb(90,220,255)'));
        for (let i = 0; i < 8; i++) this.effects.push(new Spark(p.x, p.y, this.time, Math.PI));
      }
    }

    // --- ion storm: rare weather that silences every gun for a few seconds ---
    if (!this.ionStorm && this.time > (this.nextIonAt ??= this.app.debugIon ? 5000 : 80000 + randInt(0, 40000))) {
      this.ionStorm = { phase: 'warn', until: this.time + 2200 };
      audio.playSynth('warning');
    }
    if (this.ionStorm) {
      const st = this.ionStorm;
      if (st.phase === 'warn' && this.time >= st.until) {
        st.phase = 'active';
        st.until = this.time + randInt(6000, 9000);
        audio.playSynth('storm');
      } else if (st.phase === 'active') {
        if (this.time - (st.lastBolt || 0) > 380) {
          st.lastBolt = this.time;
          const bolt = new Lightning(this.time);
          this.effects.push(bolt);
          if (Math.random() < 0.5) audio.playSynth('zap', bolt.pts[0][0]);
        }
        if (this.time >= st.until) {
          this.ionStorm = null;
          this.nextIonAt = this.time + 70000 + randInt(0, 50000);
        }
      }
    }

    // --- ambient background flourishes (visual only, Math.random by design) ---
    if (this.time > this.nextAmbientAt) {
      if (this.mod?.convoy) { // CONVOY RAID: a steady stream of targets
        this.nextAmbientAt = this.time + 7000 + Math.random() * 6000;
        this.ambient.push(new Freighter(this.time));
      } else {
        this.nextAmbientAt = this.time + 18000 + Math.random() * 26000;
        const roll = Math.random();
        if (roll < 0.28) {
          // a quarter of comets are on a collision course with the planet
          const target = Math.random() < 0.25 ? this.planets?.[0] : null;
          this.ambient.push(new Comet(this.time, target));
        } else if (roll < 0.5) this.ambient.push(new DistantConvoy(this.app.images, this.time));
        else if (roll < 0.72) this.ambient.push(new Freighter(this.time));
        else if (roll < 0.86) this.ambient.push(new Skirmish(this.app.images, this.time));
        else this.ambient.push(new DistantRocks(this.app.images, this.time));
      }
    }
    for (const a of this.ambient) a.update(this);

    // --- backdrop + shake + combo/banner timers ---
    this.updateBackdrop(dt);
    this.shake *= Math.pow(0.88, this.k);
    if (this.combo > 0 && this.time > this.comboEnd) this.resetCombo();
    if (this.levelBanner && this.time - this.levelBanner.start >= 2200) this.levelBanner = null;
    if (this.dmgFlash > 0) this.dmgFlash = Math.max(0, this.dmgFlash - 0.03 * this.k);

    // --- updates ---
    for (const p of this.players()) p.update(this);
    // micro-parallax follows the lead ship
    const ptgt = -(this.player1.y - H / 2) * 0.02;
    this.parallaxOffY = (this.parallaxOffY || 0) + (ptgt - (this.parallaxOffY || 0)) * Math.min(1, 0.06 * this.k);
    this.updateCamera();
    this.handleTouch();
    // lasers stay hot for a while — keep burning whatever crosses the line
    if (this.beams.length) {
      this.beams = this.beams.filter((b) => this.time < b.until);
      for (const b of this.beams) this.laserBeamDamage(b);
    }
    for (const b of this.bullets) b.update(this);
    for (const r of this.rockets) r.update(this);
    for (const r of this.enemyRockets) r.update(this);
    for (const m of this.mines) {
      m.update(this);
      if (!m.dead && this.time > m.expireAt) { m.dead = true; this.explode(m.x, m.y, false, 0.7); }
    }
    for (const b of this.enemyBullets) b.update(this);
    for (const e of this.enemies) e.update(this);
    for (const a of this.asteroids) a.update(this);

    // rocks bounce off each other (impulse along the contact normal, mass ~ area).
    // Asteroid.vx is "leftward speed" (x -= vx), so convert to screen space first.
    for (let i = 0; i < this.asteroids.length; i++) {
      const a = this.asteroids[i];
      if (a.dead) continue;
      for (let j = i + 1; j < this.asteroids.length; j++) {
        const b = this.asteroids[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = (a.w + b.w) * 0.42;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1 || d2 >= min * min) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        const ma = a.w * a.w, mb = b.w * b.w;
        let avx = -a.vx, bvx = -b.vx;
        const rvn = (bvx - avx) * nx + (b.vy - a.vy) * ny;
        if (rvn < 0) { // approaching
          const imp = (2 * rvn) / (ma + mb);
          avx += imp * mb * nx; a.vy += imp * mb * ny;
          bvx -= imp * ma * nx; b.vy -= imp * ma * ny;
          a.vx = -avx; b.vx = -bvx;
          if (rvn < -1.6) { // hard knock: dust + tumble kick
            const mx = a.x + dx / 2, my = a.y + dy / 2;
            for (let k = 0; k < 4; k++) this.effects.push(new RockDust(mx, my, this.time, 0.8));
            a.rotSpeed *= -1; b.rotSpeed *= -1;
          }
        }
        const push = (min - d) / 2; // separate so they don't re-collide next frame
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
    for (const p of this.powerups) p.update(this);
    for (const fx of this.effects) fx.update(this);

    // --- collisions ---
    this.handleCollisions();

    // --- slow motion timeout ---
    if (this.slowMoEnd && this.time > this.slowMoEnd) {
      this.speedMul = 1;
      this.slowMoEnd = 0;
    }

    // 3D wreckage + guaranteed elite drops for ships destroyed on-screen
    for (const e of this.enemies) {
      if (e.dead && !e.isBoss && !e._shattered && e.x > -e.w && e.x < W + e.w * 1.5) {
        e._shattered = true;
        shatterSprite(this, e.img, e.x, e.y, e.w, { vx: e.vx * 0.5 });
        if (e.elite) this.dropPowerup(e.x, e.y);
      }
    }

    // --- cleanup ---
    this.bullets = this.bullets.filter((s) => !s.dead);
    this.rockets = this.rockets.filter((s) => !s.dead);
    this.enemyRockets = this.enemyRockets.filter((s) => !s.dead);
    this.mines = this.mines.filter((s) => !s.dead);
    this.ambient = this.ambient.filter((s) => !s.dead);
    this.enemyBullets = this.enemyBullets.filter((s) => !s.dead);
    this.enemies = this.enemies.filter((s) => !s.dead);
    this.asteroids = this.asteroids.filter((s) => !s.dead);
    this.powerups = this.powerups.filter((s) => !s.dead);
    this.effects = this.effects.filter((s) => !s.dead);

    // --- game over check: all players dead with no lives left ---
    if (this.players().every((p) => !p.alive && p.lives <= 0)) {
      this.over = true;
      this.overAlpha = 0;
      this.newBest = this.score > 0 && this.score > this.app.highScore; // capture before saveHigh
      if (this.newBest && !this.online) audio.playSynth('fanfare');
      this.app.saveHigh(this.score);
      // credits reward for the run (host-driven online runs award per client
      // through their own flow, so skip here)
      if (!this.online) this.reward = awardRun({ score: this.score, bossKills: this.bossKillCount || 0, newBest: this.newBest });
      this.pushToasts(bumpStats({ bestScore: this.score }));
    }
  }

  handleTouch() {
    if (!input.isTouch) return;
    const p = this.player1;
    if (!p.alive) return;
    const btn = this.rocketBtn();
    const lbtn = this.laserBtn();
    const pbtn = this.pauseBtn();
    // multi-touch: any new finger on the rocket/laser buttons fires; the pause
    // button pauses; the first other finger owns the movement drag
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (Math.hypot(pt.x - btn.x, pt.y - btn.y) <= btn.r) {
        p.fireRocket(this);
      } else if (Math.hypot(pt.x - lbtn.x, pt.y - lbtn.y) <= lbtn.r) {
        p.fireLaser(this);
      } else if (Math.hypot(pt.x - pbtn.x, pt.y - pbtn.y) <= pbtn.r) {
        // top-right button: leave in online, pause otherwise
        if (this.online) this.requestLeave = true;
        else this.togglePause();
        this.drag = null;
        return;
      } else if (!this.drag) {
        this.drag = { id, px: pt.x, py: pt.y, ox: p.x, oy: p.y };
      } else if (!this.online) {
        // quick two-finger tap (both fingers down & still) also pauses (offline only)
        const dp = input.pointers.get(this.drag.id);
        if (dp && performance.now() - dp.downAt < 400 && Math.hypot(dp.x - dp.sx, dp.y - dp.sy) < 15) {
          this.togglePause();
          this.drag = null;
          return;
        }
      }
    }
    if (this.drag) {
      const pt = input.pointers.get(this.drag.id);
      if (pt) {
        p.x = clamp(this.drag.ox + (pt.x - this.drag.px) * 1.25, p.w / 2, W - p.w / 2);
        p.y = clamp(this.drag.oy + (pt.y - this.drag.py) * 1.25, p.h / 2, H - p.h / 2);
      } else {
        this.drag = null; // finger lifted
      }
    }
  }

  handleCollisions() {
    // bullets & rockets vs FALLING WRECKS: shootable! sparks + knockback kick,
    // second bullet (or any rocket) blows them up for bonus points
    for (const w of this.enemies) {
      if (w.dead || !w.dying) continue;
      for (const [group, dmg, isRocket] of [[this.bullets, 1, false], [this.rockets, 2, true]]) {
        for (const b of group) {
          if (b.dead || !overlap(w, b, 0.85)) continue;
          b.dead = true;
          this.spawnSparks(b.x, b.y, isRocket ? 14 : 7, Math.PI + rand(-0.5, 0.5));
          if (w.wreckHit(dmg, isRocket ? 2.2 : 1.1)) {
            w.dead = true;
            this.explode(w.x, w.y, true, 1.15);
            this.addKill(isRocket ? 5 : 2, w.x, w.y);
          } else {
            audio.playSynth('hit', w.x, 0.9);
          }
          break;
        }
        if (w.dead) break;
      }
    }

    // player bullets & rockets vs enemies/boss — with juicy hit feedback
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.dying) continue;
      for (const [group, dmg, isRocket] of [[this.bullets, 1, false], [this.rockets, 4, true]]) {
        for (const b of group) {
          if (b.dead || !overlap(enemy, b, enemy.isBoss ? 0.78 : 0.9)) continue;
          b.dead = true;
          this.spawnSparks(b.x, b.y, isRocket ? 16 : 8);
          if (enemy.isBoss && enemy.deathSeq) { b.dead = true; continue; } // going down — hull soaks shots
          if (enemy.isBoss && enemy.shieldUntil > this.time) {
            // splash ripple + zap where the shot hit (pinged at most every 90ms)
            enemy.shieldRipple = { a: Math.atan2(b.y - enemy.y, b.x - enemy.x), start: this.time };
            if (this.time > (this._shieldPingAt || 0)) {
              this._shieldPingAt = this.time + 90;
              audio.playSynth('shield_hit', enemy.x);
            }
            continue;
          }
          const killed = enemy.takeDamage(dmg);
          if (!killed) {
            // survived the hit: flash + tiny kick + armor clank
            this.shake = Math.min(12, this.shake + (isRocket ? 2 : 0.7));
            if (isRocket) audio.play('explosion', 0.3, enemy.x);
            audio.playSynth('hit', enemy.x, isRocket ? 1.25 : 1);
            continue;
          }
          this.addKill(enemy.points + (isRocket ? 10 : 0), enemy.x, enemy.y);
          this.pushToasts(bumpStats({ kills: 1 }));
          if (enemy.isBoss) {
            this.killBoss(enemy);
          } else {
            if (enemy.type === 'tank' && rand(0, 1) < 0.4) this.dropPowerup(enemy.x, enemy.y);
            if (rand(0, 1) < 0.45) {
              // disabled, not destroyed: sparks, smoke, tumbles off-screen
              enemy.startDying();
              this.wreckCount = (this.wreckCount || 0) + 1; // for online sfx streaming
              this.spawnSparks(enemy.x, enemy.y, 10);
              audio.play('explosion', 0.3);
            } else {
              enemy.dead = true;
              this.explode(enemy.x, enemy.y, true, enemy.type === 'tank' ? 1.5 : 1);
            }
          }
          break;
        }
        if (enemy.dead || enemy.dying) break;
      }
    }

    // player bullets shoot down incoming enemy rockets (+5 pts)
    for (const r of this.enemyRockets) {
      if (r.dead) continue;
      for (const b of this.bullets) {
        if (b.dead || !overlap(r, b, 1.1)) continue;
        b.dead = true;
        r.dead = true;
        this.explode(r.x, r.y, true, 0.8);
        this.addKill(5, r.x, r.y);
        this.spawnSparks(r.x, r.y, 8);
        break;
      }
    }

    // Freighters under fire: all of them during CONVOY RAID, golden ones always
    {
      for (const a of this.ambient) {
        if (!(a instanceof Freighter) || a.dead) continue;
        if (!this.mod?.convoy && !a.golden) continue;
        const cx = a.x + a.img.width / 2, cy = a.y + a.img.height / 2;
        for (const b of this.bullets) {
          if (b.dead) continue;
          if (Math.abs(b.x - cx) > a.img.width * 0.45 || Math.abs(b.y - cy) > a.img.height * 0.42) continue;
          b.dead = true;
          a.hp = (a.hp ?? (a.golden ? 18 : 6)) - 1;
          this.spawnSparks(b.x, b.y, 4);
          if (a.hp > 0) audio.playSynth('hit', b.x, 0.7); // hull rings, holds
          if (a.hp <= 0) {
            a.dead = true;
            this.explode(cx, cy, true, 1.7);
            shatterSprite(this, a.img, cx, cy, a.img.width, { vis: 1, chunks: 7 });
            if (a.golden) { // treasure hauler: powerup rain
              this.addKill(100, cx, cy);
              for (const dx of [-50, 0, 50]) this.dropPowerup(cx + dx, cy + (dx ? 24 : -18));
              this.popup(cx, cy - 44, 'JACKPOT!', 'rgb(255,215,80)');
              audio.playSynth('fanfare');
            } else {
              this.addKill(50, cx, cy);
              this.dropPowerup(cx, cy);
            }
          }
          break;
        }
      }
    }

    // bullets vs mines: pop them from a distance (+5 pts)
    for (const m of this.mines) {
      if (m.dead) continue;
      for (const b of this.bullets) {
        if (b.dead || !overlap(m, b, 1)) continue;
        b.dead = true;
        m.dead = true;
        this.explode(m.x, m.y, true, 0.9);
        this.addKill(5, m.x, m.y);
        break;
      }
    }

    // bullets vs asteroids (asteroid breaks apart; giants soak several hits)
    for (const a of this.asteroids) {
      if (a.dead) continue;
      for (const b of this.bullets) {
        if (b.dead || !overlap(a, b, 0.8)) continue;
        b.dead = true;
        if (a.hp > 1) { // chipped, not cracked
          a.hp--;
          a.x += 4; // knocked back a touch
          this.spawnSparks(b.x, b.y, 5);
          for (let i = 0; i < 5; i++) this.effects.push(new RockDust(b.x, b.y, this.time, 0.8));
          audio.playSynth('thock', a.x);
          break;
        }
        a.dead = true;
        this.explode(a.x, a.y, false); // the crack sfx carries it — no fireball boom
        this.spawnRockDust(a.x, a.y, a.w);
        if (a.volcanic) this.volcanicBlast(a);
        this.addKill(a.huge ? 15 : 5, a.x, a.y);
        this.asteroids.push(...a.breakApart(this.time));
        break;
      }
    }

    // rockets vs asteroids (no break apart; a rocket gouges a giant for 2)
    for (const a of this.asteroids) {
      if (a.dead) continue;
      for (const r of this.rockets) {
        if (r.dead || !overlap(a, r, 0.8)) continue;
        r.dead = true;
        if (a.hp > 2) {
          a.hp -= 2;
          a.x += 10;
          this.explode(r.x, r.y, true, 0.7);
          for (let i = 0; i < 8; i++) this.effects.push(new RockDust(r.x, r.y, this.time, 1));
          audio.playSynth('thock', a.x, 1.3);
          break;
        }
        a.dead = true;
        this.explode(a.x, a.y, false);
        this.spawnRockDust(a.x, a.y, a.w);
        if (a.volcanic) this.volcanicBlast(a);
        this.addKill(a.huge ? 20 : 10, a.x, a.y);
        break;
      }
    }

    // enemy fire splashes on rocks — asteroids double as moving cover
    for (const b of this.enemyBullets) {
      if (b.dead) continue;
      for (const a of this.asteroids) {
        if (a.dead || !overlap(a, b, 0.7)) continue;
        b.dead = true;
        this.spawnSparks(b.x, b.y, 3, 0);
        break;
      }
    }
    for (const r of this.enemyRockets) {
      if (r.dead) continue;
      for (const a of this.asteroids) {
        if (a.dead || !overlap(a, r, 0.7)) continue;
        r.dead = true;
        this.explode(r.x, r.y, true, 0.6);
        break;
      }
    }

    // asteroids vs enemies (enemy dies, asteroid survives)
    for (const e of this.enemies) {
      if (e.dead || e.dying || e.isBoss) continue;
      for (const a of this.asteroids) {
        if (a.dead || !overlap(e, a, 0.8)) continue;
        e.dead = true;
        this.explode(e.x, e.y);
        this.score += 10;
        break;
      }
    }

    // asteroids vs the boss: a heavy rock slams in, crumbles and chips the
    // hull (never below 1 hp — the kill belongs to the player); everything
    // else the hull just shoves aside
    for (const e of this.enemies) {
      if (!e.isBoss || e.dead) continue;
      for (const a of this.asteroids) {
        if (a.dead || !overlap(e, a, 0.78)) continue;
        const shielded = e.shieldUntil > this.time;
        if (a.size === 'large' && !e.deathSeq && !shielded) {
          e.health = Math.max(1, e.health - (a.huge ? 2 : 1));
          e.flash = 1;
          this.shake = Math.min(12, this.shake + 2);
          this.spawnSparks(a.x + a.w / 4, a.y, 10);
          a.dead = true;
          this.explode(a.x, a.y, false);
          this.spawnRockDust(a.x, a.y, a.w);
          if (a.volcanic) this.volcanicBlast(a);
          continue;
        }
        // shove: send the rock away from the hull along the contact normal
        const dx = a.x - e.x, dy = a.y - e.y;
        const d = Math.hypot(dx, dy) || 1;
        const nx = dx / d, ny = dy / d;
        const sp = Math.max(1.6, Math.hypot(a.vx, a.vy));
        a.vx = -nx * sp; // stored vx is leftward speed
        a.vy = ny * sp;
        a.x += nx * 4; a.y += ny * 4;
        if (shielded) {
          e.shieldRipple = { a: Math.atan2(a.y - e.y, a.x - e.x), start: this.time };
          if (this.time > (this._shieldPingAt || 0)) {
            this._shieldPingAt = this.time + 90;
            audio.playSynth('shield_hit', e.x);
          }
        } else if (this.time > (a._shoveDustAt || 0)) {
          a._shoveDustAt = this.time + 250;
          for (let i = 0; i < 3; i++) this.effects.push(new RockDust(a.x, a.y, this.time, 0.8));
        }
      }
    }

    // falling wrecks crash into everything on the way down
    for (const w of this.enemies) {
      if (w.dead || !w.dying) continue;
      for (const e of this.enemies) {
        if (e === w || e.dead) continue;
        if (e.dying) {
          // wreck vs wreck: both go up in one blast
          if (overlap(w, e, 0.75)) {
            w.dead = true;
            e.dead = true;
            this.explode((w.x + e.x) / 2, (w.y + e.y) / 2, true, 1.3);
            break;
          }
          continue;
        }
        if (e.warpUntil && this.time < e.warpUntil) continue;
        if (!overlap(w, e, 0.8)) continue;
        if (e.isBoss) {
          // wreck slams into the boss hull: 1 damage + sparks
          w.dead = true;
          this.spawnSparks(w.x, w.y, 12);
          this.explode(w.x, w.y, true, 1.1);
          if (e.shieldUntil <= this.time && e.takeDamage(1)) {
            this.killBoss(e);
          }
        } else {
          // chain kill — the wreck takes a live fighter with it (score counts!)
          w.dead = true;
          e.dead = true;
          this.explode(e.x, e.y, true, 1.2);
          this.addKill(e.points, e.x, e.y);
          this.pushToasts(bumpStats({ kills: 1 }));
        }
        break;
      }
      if (w.dead) continue;
      // vs asteroids: the rock wins, the wreck detonates
      for (const a of this.asteroids) {
        if (a.dead || !overlap(w, a, 0.75)) continue;
        w.dead = true;
        this.explode(w.x, w.y, true, 1.1);
        break;
      }
    }

    // players vs enemy bullets / enemies / asteroids / power-ups
    for (const p of this.players()) {
      if (!p.alive) continue;
      for (const b of this.enemyBullets) {
        if (!b.dead && overlap(p, b, 0.8)) { b.dead = true; this.killPlayer(p, b.x, b.y); break; }
      }
      if (!p.alive) continue;
      for (const r of this.enemyRockets) {
        if (!r.dead && overlap(p, r, 0.85)) {
          r.dead = true;
          this.explode(r.x, r.y, true, 0.8);
          this.killPlayer(p, r.x, r.y);
          break;
        }
      }
      if (!p.alive) continue;
      for (const m of this.mines) {
        if (!m.dead && overlap(p, m, 0.9)) {
          m.dead = true;
          this.explode(m.x, m.y, true, 1.2);
          this.killPlayer(p, m.x, m.y);
          break;
        }
      }
      if (!p.alive) continue;
      for (const e of this.enemies) {
        if (e.dead || (e.warpUntil && this.time < e.warpUntil) || !overlap(p, e, 0.8)) continue;
        // falling wrecks are deadly too; the boss survives ramming (only the player dies)
        if (!e.isBoss) { e.dead = true; this.explode(e.x, e.y, false); }
        this.killPlayer(p, e.x, e.y);
        break;
      }
      if (!p.alive) continue;
      for (const a of this.asteroids) {
        if (!a.dead && overlap(p, a, 0.75)) {
          a.dead = true;
          this.spawnRockDust(a.x, a.y, a.w);
          if (a.volcanic) this.volcanicBlast(a);
          this.killPlayer(p, a.x, a.y);
          break;
        }
      }
      if (!p.alive) continue;

      // Remote (guest-controlled) ships pick up power-ups client-side to avoid
      // latency misses — the host applies those via grabPowerup(). Skip here.
      if (p.remote) continue;
      for (const pu of this.powerups) {
        if (pu.dead || !overlap(p, pu, 0.9)) continue;
        pu.dead = true;
        this.applyPowerup(p, pu.type);
      }
    }
  }

  // Spend a daily attempt once the run is committed (played >2s or scored),
  // so accidentally opening DAILY and backing straight out is free.
  maybeConsumeDaily() {
    if (this.daily && !this._dailyCharged && (this.time > 2000 || this.score > 0)) {
      this._dailyCharged = true;
      useDailyAttempt();
    }
  }

  // Apply a power-up's effect to a player (shared by local pickup + guest grab).
  applyPowerup(p, type) {
    this.runPowerups += 1;
    this.pushToasts(bumpStats({ maxRunPowerups: this.runPowerups }));
    const NAME = { shooting: 'RAPID FIRE', slow_motion: 'SLOW-MO', kill_all: 'NUKE', rocket: '+ROCKET', spread: 'SPREAD+', shield: 'SHIELD', laser: '+LASER' };
    const RING = {
      shooting: 'rgb(110,255,120)', slow_motion: 'rgb(255,180,60)', kill_all: 'rgb(255,80,200)',
      rocket: 'rgb(255,95,80)', spread: 'rgb(255,220,80)', shield: 'rgb(0,210,255)', laser: 'rgb(90,160,255)',
    };
    this.popup(p.x, p.y - 28, NAME[type] || type.toUpperCase(), RING[type] || 'rgb(120,255,180)');
    this.effects.push(new Shockwave(p.x, p.y, this.time, 70, RING[type] || 'rgb(120,255,180)'));
    if (type === 'shooting') { p.powerUp(this); audio.play('powerup', 0.6, p.x); }
    else if (type === 'slow_motion') { this.speedMul = 0.5; this.slowMoEnd = this.time + 10000; audio.play('powerup', 0.6); }
    else if (type === 'kill_all') {
      for (const e of this.enemies) if (!e.isBoss && !e.dead && !e.dying) { e.dead = true; this.explode(e.x, e.y, false); }
      for (const a of this.asteroids) if (!a.dead) { a.dead = true; this.explode(a.x, a.y, false); this.spawnRockDust(a.x, a.y, a.w); }
      for (const r of this.enemyRockets) if (!r.dead) { r.dead = true; this.explode(r.x, r.y, false, 0.8); }
      for (const m of this.mines) if (!m.dead) { m.dead = true; this.explode(m.x, m.y, false, 0.8); }
      audio.play('explosion', 0.6);
    }
    else if (type === 'rocket') { p.rockets += 1; audio.play('powerup', 0.6, p.x); }
    else if (type === 'spread') { p.spread = Math.min(5, p.spread + 1); audio.play('powerup', 0.6); } // capped so runs don't snowball
    else if (type === 'shield') { p.shield = true; audio.play('powerup', 0.6, p.x); }
    else if (type === 'laser') { p.lasers += 1; audio.play('powerup', 0.6, p.x); }
  }

  // Guest grabbed a power-up near (x,y): find & apply to that player.
  grabPowerup(p, x, y) {
    let best = null, bestD = 60 * 60;
    for (const pu of this.powerups) {
      if (pu.dead) continue;
      const d = (pu.x - x) ** 2 + (pu.y - y) ** 2;
      if (d < bestD) { bestD = d; best = pu; }
    }
    if (best) { best.dead = true; this.applyPowerup(p, best.type); }
  }

  updateGameOver() {
    if (this.overAlpha < 0.5) {
      this.overAlpha = Math.min(0.5, this.overAlpha + 0.02 * this.k); // fade like game.py
      return;
    }
    if (this.online) return; // host wrapper owns the online game-over flow
    if (!this.overMenu) this.overMenu = this.buildOverMenu();

    // one-time leaderboard submission — a saved name submits straight away,
    // otherwise ask once (and remember it for next time)
    if (this.lb.status === 'idle') {
      if (this.score <= 0) {
        this.lb.status = 'skipped';
      } else {
        const mode = this.daily ? 'daily' : this.coop ? 'coop' : 'single';
        const send = (name) => {
          this.lb = { status: 'sending' };
          submitScore(name, this.score, mode).then((res) => {
            this.lb = res && res.ok ? { status: 'done', rank: res.rank, top: res.top, name } : { status: 'offline' };
          });
        };
        const saved = savedName();
        if (saved) { send(saved); }
        else {
          this.lb.status = 'asking';
          askName().then((name) => name ? send(name) : (this.lb = { status: 'skipped' }));
        }
      }
    }
    if (this.lb.status === 'asking') return; // overlay is open, don't react to Enter/clicks

    const action = this.overMenu.update();
    const canRetry = !this.daily || dailyAttemptsLeft() > 0;
    const retryKey = input.pressed.has('Enter') || input.pressed.has('NumpadEnter') || input.pressed.has('KeyR');
    if (action === 'retry' || (retryKey && canRetry)) {
      this.app.setState(new GameState(this.app, this.coop, { daily: this.daily }));
    } else if (action === 'main_menu' || input.pressed.has('Escape') || input.pressed.has('KeyM')) {
      this.app.goMenu();
    }
  }

  // Cosmetic cinematic camera. A single UNIFORM transform (pivot-zoom ≥1 + a
  // small pan) is applied to the whole scene, so every sprite, bullet and
  // hitbox moves together — what you see still matches where collisions land.
  // No perspective/foreshortening on the play plane (that would be unfair).
  // The pan is CLAMPED to the zoom's hidden margin, so black edges are
  // impossible no matter how hard it leads. Offline only; online untouched.
  updateCamera() {
    // online keeps the fixed field; motionFx off = a calm static framing
    if (this.online || !settings.motionFx) { this.camZoom = 1; this.camPanX = this.camPanY = 0; this.camPivotX = W / 2; this.camPivotY = H / 2; return; }
    const k = this.k;
    const p = this.player1;
    // base zoom gives the pan/shake headroom to work in
    let targetZoom = 1.06, pivotX = W / 2, pivotY = H / 2;
    const dead = this.players().every((pp) => !pp.alive);
    const cinematic = (this.slowmo && dead) || this.bossWarnStart || (this.warp && this.warpMul > 2);
    if (this.slowmo && dead) {            // final-death: slow dramatic push-in on the ship
      targetZoom = 1.16; pivotX = p.x; pivotY = p.y;
    } else if (this.bossWarnStart) {      // boss approaching: ominous push toward its entry
      targetZoom = 1.08; pivotX = W * 0.7; pivotY = p.y;
    }
    if (this.warp && this.warpMul > 2) targetZoom += Math.min(0.09, (this.warpMul - 2) / 55); // hyperspace kick
    targetZoom += (this.killFlash || 0) * 0.05; // boss-kill punch rides the flash

    // --- alive follow: only while the normal cam is in charge ---
    let leadX = 0, leadY = 0;
    if (!cinematic) {
      const vy = p.y - (this._camPY ?? p.y);
      const vx = p.x - (this._camPX ?? p.x);
      leadY = -(p.y - H / 2) * 0.07 - vy * 2.4;      // frame the ship + anticipate its motion
      leadX = -(p.x - W * 0.32) * 0.05 - vx * 2.4;   // anchored around the left third it lives in
      if (p.boosting) { targetZoom += 0.03; leadX += 12; } // speed: push in, ship drifts back
      targetZoom += Math.min(0.03, (this.mult - 1) * 0.007); // combo heat: subtle push-in
    }
    this._camPY = p.y; this._camPX = p.x;

    const ez = 1 - Math.pow(0.86, k);
    this.camZoom = (this.camZoom ?? 1.06) + (targetZoom - (this.camZoom ?? 1.06)) * ez;
    this.camPivotX = (this.camPivotX ?? pivotX) + (pivotX - (this.camPivotX ?? pivotX)) * ez;
    this.camPivotY = (this.camPivotY ?? pivotY) + (pivotY - (this.camPivotY ?? pivotY)) * ez;

    // ease pan toward the lead, then clamp to the hidden margin (reserve a few
    // px for shake) so the transform can never pull the void into view
    this.camPanX = (this.camPanX ?? 0) + (leadX - (this.camPanX ?? 0)) * Math.min(1, 0.09 * k);
    this.camPanY = (this.camPanY ?? 0) + (leadY - (this.camPanY ?? 0)) * Math.min(1, 0.09 * k);
    const z = this.camZoom, safe = (m) => Math.max(0, m - 7);
    this.camPanX = clamp(this.camPanX, -safe((W - this.camPivotX) * (1 - 1 / z)), safe(this.camPivotX * (1 - 1 / z)));
    this.camPanY = clamp(this.camPanY, -safe((H - this.camPivotY) * (1 - 1 / z)), safe(this.camPivotY * (1 - 1 / z)));
  }

  draw(g) {
    const { images } = this.app;

    g.save();
    // cinematic camera (uniform → collisions stay honest) + screen shake
    const z = this.camZoom || 1;
    if (z !== 1) {
      const px = this.camPivotX ?? W / 2, py = this.camPivotY ?? H / 2;
      g.translate(px, py); g.scale(z, z); g.translate(-px, -py);
      g.translate(this.camPanX || 0, this.camPanY || 0);
    }
    if (this.shake > 0.3 && !this.paused && !this.over && settings.motionFx) {
      g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.drawBackdrop(g);
    for (const a of this.ambient) a.draw(g, this);

    for (const pu of this.powerups) pu.draw(g, this);
    for (const a of this.asteroids) a.draw(g);
    for (const m of this.mines) m.draw(g, this);
    for (const e of this.enemies) e.draw(g, this);
    for (const b of this.bullets) b.draw(g);
    for (const b of this.enemyBullets) b.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    for (const r of this.rockets) r.draw(g);
    for (const r of this.enemyRockets) r.draw(g);
    for (const p of this.players()) p.draw(g, this);
    g.restore();

    // slow-motion tint
    if (this.speedMul < 1) {
      g.fillStyle = 'rgba(80,150,255,0.08)';
      g.fillRect(0, 0, W, H);
    }

    // ion storm: blue static tint, glitch slices, banner
    if (this.ionStorm) {
      const active = this.ionStorm.phase === 'active';
      if (active) {
        g.fillStyle = `rgba(140,190,255,${0.045 + 0.03 * Math.sin(this.time / 55)})`;
        g.fillRect(0, 0, W, H);
        if (Math.random() < 0.3) {
          g.fillStyle = 'rgba(170,215,255,0.08)';
          g.fillRect(0, Math.random() * H, W, 2 + Math.random() * 9);
        }
      }
      const blink = 0.55 + 0.45 * Math.sin(this.time / 110);
      g.globalAlpha = active ? blink : Math.min(1, blink + 0.2);
      drawText(g, active ? '⚡ ION STORM — WEAPONS OFFLINE ⚡' : '⚡ ION STORM INCOMING ⚡',
        W / 2, 90, 20, 'rgb(150,205,255)');
      g.globalAlpha = 1;
    }

    // hyperspace: tunnel overlay — bright rushing core, edges falling dark
    if (this.warp && this.warpMul > 3) {
      const a = Math.min(1, (this.warpMul - 3) / 24);
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, `rgba(8,14,30,${0.5 * a})`);
      grad.addColorStop(0.32, 'rgba(160,200,255,0)');
      grad.addColorStop(0.5, `rgba(170,210,255,${0.1 * a})`);
      grad.addColorStop(0.68, 'rgba(160,200,255,0)');
      grad.addColorStop(1, `rgba(8,14,30,${0.5 * a})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }

    // boss-kill soft white flash, fading through the slow-mo
    if (this.killFlash > 0) {
      g.fillStyle = `rgba(255,240,205,${0.28 * this.killFlash})`;
      g.fillRect(0, 0, W, H);
      this.killFlash = Math.max(0, this.killFlash - 0.022 * this.k);
    }

    // last life: the screen edge breathes red
    const alive = this.players().filter((p) => p.alive || p.lives > 0);
    if (!this.over && alive.length && alive.every((p) => p.lives === 1)) {
      const breathe = 0.09 + 0.05 * Math.sin(this.time / 320);
      const vg = g.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.72);
      vg.addColorStop(0, 'rgba(255,0,0,0)');
      vg.addColorStop(1, `rgba(255,30,30,${breathe})`);
      g.fillStyle = vg;
      g.fillRect(0, 0, W, H);
    }

    // damage flash: red edge pulse when a life is lost
    if (this.dmgFlash > 0) {
      const grad = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.7);
      grad.addColorStop(0, 'rgba(255,0,0,0)');
      grad.addColorStop(1, `rgba(255,30,30,${0.35 * this.dmgFlash})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }

    // boss WARNING banner
    if (this.bossWarnStart) {
      const blink = 0.5 + 0.5 * Math.sin(this.time / 90);
      g.fillStyle = `rgba(255,0,0,${0.08 * blink})`;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 0.55 + 0.45 * blink;
      drawText(g, '!! WARNING !!', W / 2, H / 2 - 220, 46, 'rgb(255,60,60)');
      drawText(g, 'BOSS APPROACHING', W / 2, H / 2 - 178, 20, 'rgb(255,150,150)');
      g.globalAlpha = 1;
    }

    // meteor shower warning banner
    if (this.shower && this.time < this.shower.warnUntil) {
      const blink = 0.5 + 0.5 * Math.sin(this.time / 90);
      g.fillStyle = `rgba(255,140,40,${0.06 * blink})`;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 0.55 + 0.45 * blink;
      drawText(g, 'METEOR SHOWER', W / 2, H / 2 - 220, 42, 'rgb(255,170,70)');
      drawText(g, 'SURVIVE FOR A BONUS', W / 2, H / 2 - 180, 18, 'rgb(255,205,140)');
      g.globalAlpha = 1;
    }

    // LEVEL N banner: white flash → pop-in → hold → fade out
    if (this.levelBanner) {
      const t = (this.time - this.levelBanner.start) / 2200;
      if (t < 1) {
        if (t < 0.12) {
          g.fillStyle = `rgba(255,255,255,${0.18 * (1 - t / 0.12)})`;
          g.fillRect(0, 0, W, H);
        }
        const pop = Math.min(1, t * 6);
        const size = Math.round(64 * (0.6 + 0.4 * pop));
        const alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        g.globalAlpha = alpha * pop;
        const prevOp = g.globalCompositeOperation;
        g.globalCompositeOperation = 'lighter';
        drawText(g, `LEVEL ${this.levelBanner.level}`, W / 2, H / 2 - 180, size, 'rgb(120,80,20)');
        g.globalCompositeOperation = prevOp;
        drawText(g, `LEVEL ${this.levelBanner.level}`, W / 2, H / 2 - 180, size, 'rgb(255,215,90)');
        drawText(g, `— ${sectorName(this.levelBanner.level)} —`, W / 2, H / 2 - 180 + size * 0.72, Math.round(size * 0.3), 'rgb(150,200,255)');
        g.globalAlpha = alpha * 0.8;
        drawText(g, 'WAVE CLEARED', W / 2, H / 2 - 180 + size * 0.72 + 30, 15, 'rgb(200,200,200)');
        g.globalAlpha = 1;
      }
    }

    // HUD
    const scoreText = `Score: ${this.score}`;
    drawText(g, scoreText, 10, 24, 26, '#fff', 'left');
    if (this.mult > 1) {
      // badge sits right after the score text, shifting as the score grows
      const mx = 10 + g.measureText(scoreText).width + 14;
      const pulse = this.time - this.multPulse < 400 ? 1.4 - (this.time - this.multPulse) / 1000 : 1;
      drawText(g, `x${this.mult}`, mx, 24, Math.round(24 * pulse), 'rgb(255,210,60)', 'left');
      // combo time bar
      const frac = Math.max(0, (this.comboEnd - this.time) / 4000);
      g.fillStyle = 'rgba(255,210,60,0.8)';
      g.fillRect(mx, 38, 46 * frac, 3);
    }
    drawText(g, `Level: ${this.level}`, W - 10, 24, 26, '#fff', 'right');
    drawText(g, sectorName(this.level), W - 10, 44, 12, 'rgba(160,190,220,0.75)', 'right');
    if (this.daily) drawText(g, `DAILY · ${this.mod.name}`, W - 10, 64, 15, 'rgb(255,210,60)', 'right');

    // daily modifier intro banner (first seconds of the run)
    if (this.daily && this.time < 3600 && !this.over) {
      const t = this.time / 3600;
      const alpha = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
      g.globalAlpha = alpha;
      drawText(g, this.mod.name, W / 2, H / 2 - 130, 44, 'rgb(255,210,60)');
      drawText(g, this.mod.desc, W / 2, H / 2 - 90, 20, 'rgb(220,220,220)');
      drawText(g, `attempt ${'●'.repeat(3 - dailyAttemptsLeft())}${'○'.repeat(dailyAttemptsLeft())}`, W / 2, H / 2 - 58, 15, 'rgb(160,160,160)');
      g.globalAlpha = 1;
    }
    // lives + rockets per player (colour-coded)
    const shown = this.playerList.filter((p) => !p.gone); // drop guests who left
    const many = shown.length > 2;
    const fs = many ? 18 : 22;
    shown.forEach((p, i) => {
      const y = 58 + i * (many ? 26 : 32);
      drawText(g, `P${p.slot + 1}`, 10, y, fs, p.color, 'left');
      drawText(g, '♥'.repeat(Math.max(0, p.lives)), 44, y, fs, 'rgb(255,80,90)', 'left');
      // out-of-ammo dry-fire briefly flashes the counter red
      const rkCol = this.time - (p.rkEmptyFlash || 0) < 300 ? 'rgb(255,80,80)' : '#fff';
      const lzCol = this.time - (p.lzEmptyFlash || 0) < 300 ? 'rgb(255,80,80)' : 'rgb(120,220,255)';
      drawText(g, `🚀${p.rockets}`, many ? 108 : 124, y, fs, rkCol, 'left');
      drawText(g, `⚡${p.lasers}`, many ? 168 : 192, y, fs, lzCol, 'left');
    });
    if (this.speedMul < 1) drawText(g, 'SLOW-MO', W / 2, 24, 24, 'rgb(120,200,255)');

    // first-run touch tutorial overlay
    if (this.tutUntil && !this.over) {
      if (this.time >= this.tutUntil) {
        this.tutUntil = 0;
        try { localStorage.setItem('sv_tut', '1'); } catch {}
      } else {
        const a = Math.min(1, (this.tutUntil - this.time) / 1500) * 0.85;
        const pulse = 1 + 0.12 * Math.sin(this.time / 250);
        g.globalAlpha = a;
        // move hint at the left third
        const hx = W * 0.3, hy = H * 0.62;
        g.strokeStyle = 'rgb(140,210,255)';
        g.lineWidth = 2;
        g.beginPath(); g.arc(hx, hy, 26 * pulse, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(hx, hy, 5, 0, Math.PI * 2); g.stroke();
        drawText(g, 'DRAG ANYWHERE TO MOVE', hx, hy + 56, 16, 'rgb(140,210,255)');
        drawText(g, 'GUNS FIRE ON THEIR OWN', hx, hy + 80, 13, 'rgba(200,220,240,0.85)');
        // button hints
        const rb = this.rocketBtn(), lb2 = this.laserBtn();
        g.beginPath(); g.arc(rb.x, rb.y, (rb.r + 8) * pulse, 0, Math.PI * 2); g.stroke();
        drawText(g, 'ROCKET', rb.x - rb.r - 12, rb.y, 15, 'rgb(140,210,255)', 'right');
        g.beginPath(); g.arc(lb2.x, lb2.y, (lb2.r + 8) * pulse, 0, Math.PI * 2); g.stroke();
        drawText(g, 'LASER', lb2.x - lb2.r - 12, lb2.y, 15, 'rgb(140,210,255)', 'right');
        g.globalAlpha = 1;
      }
    }

    // achievement toasts
    this.drawToasts(g);

    // touch controls: rocket button + pause button
    if (input.isTouch && !this.over && !this.paused) {
      const b = this.rocketBtn();
      g.globalAlpha = 0.35;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.9;
      g.drawImage(images.rocket, b.x - 20, b.y - 18, 40, 20);
      drawText(g, `${this.player1.rockets}`, b.x, b.y + 16, 22, '#000');

      // laser button (charges + cooldown arc)
      const lb = this.laserBtn();
      const p1 = this.player1;
      const cd = Math.max(0, p1.lastLaser + p1.laserDelay - this.time) / p1.laserDelay;
      const ready = p1.lasers > 0 && cd <= 0;
      g.globalAlpha = ready ? 0.4 : 0.22;
      g.fillStyle = ready ? 'rgb(120,220,255)' : '#888';
      g.beginPath(); g.arc(lb.x, lb.y, lb.r, 0, Math.PI * 2); g.fill();
      if (cd > 0) { // cooldown sweep
        g.globalAlpha = 0.5;
        g.strokeStyle = '#fff'; g.lineWidth = 4;
        g.beginPath(); g.arc(lb.x, lb.y, lb.r - 3, -Math.PI / 2, -Math.PI / 2 + (1 - cd) * Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 0.95;
      drawText(g, '⚡', lb.x, lb.y - 4, 26, '#000');
      drawText(g, `${p1.lasers}`, lb.x, lb.y + 18, 20, '#000');

      const pb = this.pauseBtn();
      g.globalAlpha = 0.3;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(pb.x, pb.y, pb.r - 4, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.85;
      if (this.online) {
        // leave (X)
        g.strokeStyle = '#000'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(pb.x - 6, pb.y - 6); g.lineTo(pb.x + 6, pb.y + 6);
        g.moveTo(pb.x + 6, pb.y - 6); g.lineTo(pb.x - 6, pb.y + 6); g.stroke();
      } else {
        g.fillStyle = '#000';
        g.fillRect(pb.x - 7, pb.y - 8, 5, 16); // pause bars
        g.fillRect(pb.x + 2, pb.y - 8, 5, 16);
      }
      g.globalAlpha = 1;
    }

    this.drawPauseOverlay(g);

    if (this.over) {
      g.fillStyle = `rgba(0,0,0,${this.overAlpha})`;
      g.fillRect(0, 0, W, H);
      if (this.online && this.overAlpha >= 0.5) {
        drawText(g, 'GAME OVER', W / 2, H / 2 - 44, 56, 'rgb(255,0,0)');
        drawText(g, `LOST IN ${sectorName(this.level)}`, W / 2, H / 2 - 6, 14, 'rgba(160,190,220,0.8)');
        drawText(g, `Score: ${this.score}`, W / 2, H / 2 + 26, 30);
      }
      if (this.overMenu) {
        drawText(g, 'GAME OVER', W / 2, H / 2 - 100, 56, 'rgb(255,0,0)');
        drawText(g, `LOST IN ${sectorName(this.level)}`, W / 2, H / 2 - 64, 14, 'rgba(160,190,220,0.8)');
        drawText(g, `Score: ${this.score}`, W / 2, H / 2 - 38, 30);
        if (this.newBest) {
          const pulse = 0.72 + 0.28 * Math.sin(this.time / 170);
          g.globalAlpha = pulse;
          drawText(g, '★ NEW BEST! ★', W / 2, H / 2 - 11, 25, 'rgb(255,215,80)');
          g.globalAlpha = 1;
        } else {
          drawText(g, `Best: ${this.app.highScore}`, W / 2, H / 2 - 12, 24, 'rgb(180,180,180)');
        }
        // credits earned this run + running balance
        if (this.reward && this.reward.total > 0) {
          drawText(g, `+${this.reward.total} CR  ·  ${progress.credits} total`, W / 2, H / 2 + 14, 20, 'rgb(255,205,70)');
        }
        if (this.daily) {
          const left = dailyAttemptsLeft();
          drawText(g, left > 0 ? `DAILY ATTEMPTS LEFT: ${left}` : 'NO DAILY ATTEMPTS LEFT TODAY',
            W / 2, H / 2 + 38, 16, left > 0 ? 'rgb(255,210,60)' : 'rgb(255,110,110)');
        }
        this.overMenu.draw(g);

        // leaderboard block under the buttons
        const ly = H / 2 + 195;
        if (this.lb.status === 'done') {
          if (this.lb.rank > 0 && this.lb.rank <= 10) {
            drawText(g, `${this.daily ? 'DAILY' : 'GLOBAL'} RANK: #${this.lb.rank}`, W / 2, ly, 22, 'rgb(255,210,80)');
          }
          if (this.lb.top?.length) {
            drawText(g, this.daily ? '— DAILY TOP —' : '— GLOBAL TOP —', W / 2, ly + 30, 16, 'rgb(140,140,140)');
            this.lb.top.slice(0, 5).forEach((e, i) => {
              const mine = this.lb.rank === i + 1;
              const col = mine ? 'rgb(0,255,140)' : 'rgb(200,200,200)';
              drawText(g, `${i + 1}. ${e.name}`, W / 2 - 130, ly + 56 + i * 24, 16, col, 'left');
              drawText(g, `${e.score}`, W / 2 + 130, ly + 56 + i * 24, 16, col, 'right');
            });
          }
        } else if (this.lb.status === 'sending') {
          drawText(g, 'Submitting score…', W / 2, ly, 16, 'rgb(140,140,140)');
        } else if (this.lb.status === 'offline') {
          drawText(g, 'Leaderboard unavailable', W / 2, ly, 16, 'rgb(120,120,120)');
        }

        // keyboard shortcut hint at the foot of the screen
        if (this.lb.status !== 'asking') {
          const canRetry = !this.daily || dailyAttemptsLeft() > 0;
          drawText(g, canRetry ? 'Enter / R — retry     Esc — menu' : 'Esc — menu',
            W / 2, H - 22, 13, 'rgba(175,175,175,0.85)');
        }
      }
    }
  }

  // pause overlay + this run's stats above the base menu
  drawPauseOverlay(g) {
    if (!this.paused) return;
    super.drawPauseOverlay(g);
    const secs = Math.floor(this.time / 1000);
    const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    drawText(g, `SCORE ${this.score}     LEVEL ${this.level}     ${mmss}`,
      W / 2, H / 2 - 168, 18, 'rgba(200,220,255,0.9)');
  }

  drawToasts(g) {
    if (!this.toasts?.length) return;
    const now = performance.now();
    let y = 130;
    this.toasts = this.toasts.filter((t) => {
      if (t.start == null) t.start = now;
      const age = now - t.start;
      if (age > 3200) return false;
      const slide = Math.min(1, age / 250);
      const fade = age > 2700 ? 1 - (age - 2700) / 500 : 1;
      g.globalAlpha = slide * fade;
      drawText(g, `🏆 ${t.title}`, W / 2, y - 20 * (1 - slide), 20, 'rgb(255,210,60)');
      g.globalAlpha = 1;
      y += 30;
      return true;
    });
  }
}
