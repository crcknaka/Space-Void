// Single / Co-op / Daily game mode — port of game.py on top of BaseWorld
import { W, H, STEP, rand, randInt, overlap, clamp, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { ButtonGroup, UIButton } from './ui.js';
import * as ui from './ui.js';
import { BaseWorld } from './world.js';
import {
  Player, Enemy, Boss, Asteroid, PowerUp, Explosion, Spark, Shockwave, Bullet, Rocket,
  Mine, MeshDebris, shatterSprite, RockDust, HeatRing, LightBurst, Comet, DistantConvoy, DistantRocks, Freighter, Skirmish, SpaceBattle, WarpStreak, Lightning,
  LaserBeam, ScorePopup,
  POWERUP_TYPES, POWERUP_IMG,
} from './entities.js';
import { makeNebulaField, tinted } from './fx.js';
import { askName, submitScore, savedName } from './lb.js';
import { bumpStats, vibrate, settings } from './settings.js';
import { progress, awardRun } from './progress.js';
import { SHIP_BY_ID } from './ships.js';
import { WEAPON_BY_ID } from './weapons.js';
import { dailySeed, todayMod, useDailyAttempt, dailyAttemptsLeft, MODS } from './daily.js';
import { makeSpaceBackdrop, sectorName, SECTOR_THEMES } from './bggen.js';

const { C, rgba } = ui;
const HUD_RED = '255,96,108'; // lives / boss hull
const ION = '150,205,255';

// tiny HUD glyphs, centred on (x, y); s = overall height
function glyphRocket(g, x, y, s, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x - s * 0.6, y - s * 0.5); g.lineTo(x - s * 0.3, y - s * 0.2); g.lineTo(x + s * 0.25, y - s * 0.2);
  g.lineTo(x + s * 0.7, y); g.lineTo(x + s * 0.25, y + s * 0.2); g.lineTo(x - s * 0.3, y + s * 0.2);
  g.lineTo(x - s * 0.6, y + s * 0.5); g.lineTo(x - s * 0.45, y);
  g.closePath(); g.fill();
}
function glyphBolt(g, x, y, s, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x + s * 0.15, y - s * 0.6); g.lineTo(x - s * 0.35, y + s * 0.08); g.lineTo(x - s * 0.02, y + s * 0.08);
  g.lineTo(x - s * 0.15, y + s * 0.6); g.lineTo(x + s * 0.35, y - s * 0.08); g.lineTo(x + s * 0.02, y - s * 0.08);
  g.closePath(); g.fill();
}

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  rocket: 'Space', speed: 'ShiftLeft', laser: 'KeyE', laserAlt: 'KeyQ',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  rocket: 'Enter', rocketAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
  laser: 'Numpad1', laserAlt: 'Slash',
};

// 3D chase camera looks down +x, so the keys rotate with it: A/D strafe, W/S fore/aft
const P1_CHASE_CONTROLS = { ...P1_CONTROLS, up: 'KeyA', down: 'KeyD', left: 'KeyS', right: 'KeyW' };
const P2_CHASE_CONTROLS = { ...P2_CONTROLS, up: 'ArrowLeft', down: 'ArrowRight', left: 'ArrowDown', right: 'ArrowUp' };

// Distinct per-player identity: HUD colour + ship tint (null = keep art as-is)
export const PLAYER_COLORS = ['rgb(90,200,255)', 'rgb(90,255,140)', 'rgb(255,170,60)', 'rgb(230,120,255)'];
const PLAYER_TINTS = [null, 'rgba(90,255,140,0.45)', 'rgba(255,150,40,0.55)', 'rgba(220,90,255,0.5)'];

// Colored ship sprite for player index i. Local modes keep the original
// player1/player2 art; online (colored) tints every ship a distinct hue.
// shipId (online co-op cosmetic) swaps in that player's chosen hull; index 0
// stays untinted so its natural colours (and bank frames) show through.
export function playerShip(images, i, colored, shipId) {
  const custom = shipId && images.ships && images.ships[shipId];
  const base = custom || (i === 1 ? images.player2_ship : images.player1_ship);
  if (!colored) return base;
  const tint = PLAYER_TINTS[i % PLAYER_TINTS.length];
  return tint ? tinted(base, tint, `hull_${i}_${shipId || 'def'}`) : base;
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

    // selected ship + permanent upgrades (offline non-daily only — daily/
    // versus/online stay stock so their leaderboards and sync are fair)
    if (!this.daily && !this.online) { this.applyShip(this.player1); this.applyUpgrades(this.player1); }
    for (const p of this.players()) p.maxLives = p.lives; // baseline for damage visuals

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
    const ship = SHIP_BY_ID[this.app.debugShip] || SHIP_BY_ID[progress.selectedShip] || SHIP_BY_ID.vanguard;
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

  // Permanent meta-upgrades, stacked on top of the ship's stats.
  applyUpgrades(p) {
    const u = progress.upgrades || {};
    if (u.hull) p.lives += u.hull;
    if (u.thrusters) { p.defaultSpeed += 0.4 * u.thrusters; p.fastSpeed += 0.4 * u.thrusters; }
    if (u.reactor) { const f = 1 - 0.06 * u.reactor; p.shootDelay *= f; p.baseShootDelay *= f; }
    if (u.arsenal) p.rockets += u.arsenal;
    if (u.deflector) p.shield = true;
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
    return { x: W - 34, y: 80, r: 24 }; // touch pause, under the level plate
  }

  camBtn() {
    return { x: W - 88, y: 80, r: 22 }; // touch: next 3D camera (left of pause)
  }

  overdriveBtn() {
    // cockpit view: the bottom of the screen is the dashboard — the button
    // moves up under the compact meter in the top-right corner
    const v3 = this.app.view3d;
    if (!this.online && v3?.active && v3.mode === 'cockpit') return { x: W - 56, y: 204, r: 40 };
    return { x: W / 2, y: H - 56, r: 44 }; // appears bottom-centre only when ready
  }

  overdriveReady() {
    return !this.online && (this.overdrive || 0) >= 1 && !(this.overUntil && this.time < this.overUntil);
  }

  // OVERDRIVE: a super meter that fills with kills; when full the player
  // unleashes a ~5s window of rapid, hot, wide fire that also burns incoming
  // enemy fire near the ship. Key F / gamepad Y / on-screen button.
  updateOverdrive() {
    if (this.online) return;
    const active = this.overUntil && this.time < this.overUntil;
    const pad = input.pads[0];
    const trig = input.pressed.has('KeyF') || (pad && pad.fire3) || this._overTouch;
    this._overTouch = false;
    if (!active && (this.overdrive || 0) >= 1 && trig) {
      this.overUntil = this.time + 5000;
      this.overdrive = 0;
      audio.playSynth('overdrive');
      this.shake = Math.min(12, this.shake + 6);
      this.impactFx = Math.max(this.impactFx || 0, 0.7);
      for (const p of this.players()) if (p.alive) this.effects.push(new Shockwave(p.x, p.y, this.time, 130, 'rgb(255,210,80)'));
      vibrate([30, 40, 30]);
    }
    if (active) { // aura: melt enemy fire that comes close
      for (const p of this.players()) {
        if (!p.alive) continue;
        for (const b of this.enemyBullets) {
          if (!b.dead && (b.x - p.x) ** 2 + (b.y - p.y) ** 2 < 74 * 74) { b.dead = true; this.spawnSparks(b.x, b.y, 2); }
        }
      }
    }
  }

  // secondary weapon module: auto-fires on its own cadence beside the main gun
  fireSecondary() {
    if (this.online || this.daily) return;
    const w = WEAPON_BY_ID[progress.secondary];
    if (!w || !w.cadence) return;
    const p = this.player1;
    if (!p || !p.alive || this.ionStorm?.phase === 'active') return;
    if (this.time - (this.secAt || 0) < w.cadence) return;
    this.secAt = this.time;
    const edgeX = p.x + p.w / 2;
    const imgs = this.app.images;
    if (w.id === 'scatter') {
      for (const ang of [-26, -13, 0, 13, 26]) {
        this.bullets.push(new Bullet(edgeX, p.y, imgs.bullet2 || imgs.bullet, 10, ang));
      }
      audio.play('gun', 0.24, p.x, 0.8);
    } else if (w.id === 'seeker') {
      const rk = new Rocket(p.x, p.y, imgs.rocket);
      rk.w = 30; rk.h = 15;
      this.rockets.push(rk);
      audio.play('rocket', 0.4, p.x);
    } else if (w.id === 'pulse') {
      const R = 100;
      this.effects.push(new Shockwave(p.x, p.y, this.time, R, 'rgb(120,220,255)'));
      this.effects.push(new LightBurst(p.x, p.y, this.time, 120, '120,220,255'));
      for (const e of this.enemies) {
        if (e.dead || e.dying || e.isBoss) continue;
        if ((e.x - p.x) ** 2 + (e.y - p.y) ** 2 < R * R && (e.health || 1) <= 1) {
          e.dead = true; this.explode(e.x, e.y, false); this.addKill(e.points || 10, e.x, e.y);
        }
      }
      for (const b of this.enemyBullets) if (!b.dead && (b.x - p.x) ** 2 + (b.y - p.y) ** 2 < R * R) b.dead = true;
      audio.playSynth('shield_pop', p.x);
    }
  }

  // glowing gold aura around each ship during OVERDRIVE (world space)
  drawOverdriveAura(g) {
    const rem = Math.min(1, (this.overUntil - this.time) / 1600); // fade out near the end
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    for (const p of this.players()) {
      if (!p.alive) continue;
      const pulse = 0.6 + 0.4 * Math.sin(this.time / 70);
      const r = 40 + 6 * Math.sin(this.time / 90);
      const gr = g.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * 1.3);
      gr.addColorStop(0, `rgba(255,210,90,${0.26 * pulse * rem})`);
      gr.addColorStop(1, 'rgba(255,180,40,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, r * 1.3, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `rgba(255,220,120,${0.5 * pulse * rem})`;
      g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
    }
    g.globalCompositeOperation = prev;
  }

  // OVERDRIVE meter + ready prompt / touch button (screen space). In the
  // cockpit view the bottom of the screen is the dashboard, so the meter
  // shrinks into the top-right corner under the level plate.
  drawOverdriveHUD(g) {
    if (this.online) return;
    const active = this.overUntil && this.time < this.overUntil;
    const pit = this._hudPit, m = this.overdrive || 0;
    const bw = pit ? 150 : 240;
    const bx = pit ? W - 14 - bw : W / 2 - bw / 2;
    const by = pit ? (input.isTouch ? (this.daily ? 152 : 128) : this.daily ? 108 : 84) : H - 30;
    const lx = pit ? W - 14 : W / 2, al = pit ? 'right' : 'center';
    if (active) {
      const rem = (this.overUntil - this.time) / 5000;
      // gold edge vignette
      const vg = g.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.74);
      vg.addColorStop(0, 'rgba(255,190,40,0)');
      vg.addColorStop(1, `rgba(255,190,40,${0.09 * (0.6 + 0.4 * Math.sin(this.time / 60))})`);
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
      ui.hudLabel(g, 'OVERDRIVE', lx, by - 12, { size: 11, weight: 700, track: 0.3, align: al, color: rgba(C.gold) });
      ui.hudBar(g, bx, by, bw, 6, rem, { color: C.gold, segs: pit ? 12 : 20, back: 0.22, glow: true });
      return;
    }
    // charging bar (hidden until it starts filling)
    if (m > 0 || this.overdriveReady()) {
      const ready = this.overdriveReady();
      g.fillStyle = rgba(C.ink, 0.45); g.fillRect(bx - 3, by - 3, bw + 6, 12);
      ui.hudBar(g, bx, by, bw, 6, m, { color: m >= 1 ? C.gold : C.cyan, segs: pit ? 12 : 20, back: 0.2, glow: ready });
      if (ready) {
        const pulse = 0.6 + 0.4 * Math.sin(this.time / 110);
        g.globalAlpha = pulse;
        if (input.isTouch) {
          const ob = this.overdriveBtn();
          ui.glow(g, C.gold, ob.x, ob.y, ob.r * 1.5, ob.r * 1.5, 0.5);
          g.beginPath(); g.arc(ob.x, ob.y, ob.r, 0, Math.PI * 2);
          g.fillStyle = rgba(C.gold, 0.9); g.fill();
          ui.text(g, 'OD', ob.x, ob.y + 1, { size: 20, weight: 700, track: 0.1, align: 'center', color: rgba(C.ink) });
        } else if (pit) {
          ui.hudLabel(g, 'OVERDRIVE READY · F', lx, by - 12, { size: 10, weight: 700, track: 0.2, align: 'right', color: rgba(C.gold) });
        } else {
          const tw = ui.measure(g, 'OVERDRIVE READY', { size: 11, weight: 700, track: 0.3 });
          ui.hudLabel(g, 'OVERDRIVE READY', W / 2 - 16, by - 14, { size: 11, weight: 700, track: 0.3, align: 'center', color: rgba(C.gold) });
          ui.keyHints(g, W / 2 - 16 + tw / 2 + 10, by - 14, [['F', '']], { size: 10 });
        }
        g.globalAlpha = 1;
      } else {
        ui.hudLabel(g, 'OVERDRIVE', lx, by - 11, { size: 9, weight: 700, track: 0.28, align: al, color: rgba(C.low) });
      }
    }
  }

  buildOverMenu() {
    const buttons = [];
    if (!this.daily || dailyAttemptsLeft() > 0) {
      buttons.push(new UIButton('RETRY', W / 2, H / 2 + 88, 240, 50, C.cyan, 'retry'));
    }
    buttons.push(new UIButton('MAIN MENU', W / 2, H / 2 + 156, 240, 50, C.cyan, 'main_menu'));
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

  // a hero planet currently on screen (comet impact target); null if none
  visiblePlanet() {
    const cands = (this.planets || []).filter((pl) =>
      pl.x + pl.img.width > W * 0.12 && pl.x < W * 0.88);
    return cands.length ? cands[randInt(0, cands.length - 1)] : null;
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
    e.img = this.app.images[`enemy_${e.type}_elite`] || e.img; // (baked from the 3D elite hull, when available)
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
  // a killed brood bursts into two small fast fragments that scatter apart
  spawnSplit(e) {
    e._split = true;
    for (const dy of [-1, 1]) {
      const f = new Enemy(this.app.images, Math.max(1, this.level - 1), 'basic', this.time);
      f.w = 32; f.h = 20; f.health = 1; f.points = 5;
      f.img = this.app.images.enemy_drone || f.img;
      f.x = e.x; f.y = clamp(e.y + dy * 16, 20, H - 20);
      f.vx = -(3 + this.level * 0.2);
      f.vy = dy * rand(1, 2.6);
      f.canDash = true;
      f.nextDashAt = this.time + randInt(500, 1500);
      f.warpUntil = this.time + 250;
      this.enemies.push(f);
      this.effects.push(new Shockwave(f.x, f.y, this.time, 42));
    }
    audio.play('explosion', 0.4, e.x);
  }

  spawnWedge() {
    const mk = () => new Enemy(this.app.images, this.level, 'basic', this.time, false);
    const bx = W - randInt(70, 100);
    const lead = mk();
    lead.y = clamp(lead.y, 100, H - 100);
    if (this.level >= 3 && randInt(1, 100) <= 12) this.makeElite(lead);
    this.introEnemy(lead, { x: bx });
    // the flight arrives as a vee, an echelon stepped back toward the open side, or
    // line abreast; wingmen keep station on the leader (Enemy.fly) and scatter if it dies
    const shape = randInt(0, 3);
    const open = lead.y < H / 2 ? 1 : -1;
    const slots = shape === 2 ? [[36, open * 40], [72, open * 80]]
      : shape === 3 ? [[0, 56], [0, -56]]
        : [[48, 44], [48, -44]];
    lead.wingmen = 2; // a flight leader holds its course: no second pass, no pairing up
    for (const [dx, dy] of slots) {
      const wing = mk();
      wing.y = lead.y;
      wing.vx = lead.vx;
      wing.canDash = lead.canDash;
      wing.nextDashAt = lead.nextDashAt;
      wing.leader = lead;
      wing.slot = { dx, dy };
      this.introEnemy(wing, { x: bx + dx, dy });
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
    if (L >= 3 && r < 40) return 'brood';
    if (L >= 3 && r < 50) return 'shieldbearer';
    if (L >= 4 && r < 62) return 'tank';
    if (L >= 3 && r < 78) return 'hunter';
    if (L >= 2 && r < (L >= 5 ? 92 : 84)) return 'weaver';
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
    this.effects.push(new LightBurst(x, y, this.time, 46 + 42 * scale)); // lights nearby ships/rocks
    this.shake = Math.min(12, this.shake + 3 * scale);
    if (scale >= 1.7) this.effects.push(new HeatRing(x, y, this.time, 40 * scale)); // refraction shimmer
    if (scale >= 1.4) this.impactFx = Math.min(1, Math.max(this.impactFx || 0, scale / 2.4)); // screen punch
    if (sound) audio.play('explosion', 0.5, x);
  }

  killPlayer(p, hx, hy) {
    if (hx != null) p.hitAt = { x: hx, y: hy, power: 1 };
    if (this.app.debugGod) return;
    if (this.time < (p.invulnUntil || 0)) return;
    if (p.shield && this.ionStorm?.phase !== 'active') {
      // shield absorbs the hit — combo survives (a save, not a death)
      p.shield = false;
      p.shieldRipple = { a: hx !== undefined ? Math.atan2(hy - p.y, hx - p.x) : Math.PI, start: this.time };
      p.invulnUntil = this.time + 1200;
      this.spawnSparks(p.x, p.y, 16);
      audio.playSynth('shield_pop', p.x);
      vibrate(50);
      this.pushToasts(bumpStats({ shieldSaves: 1 }));
      return;
    }
    this.resetCombo(); // a real death — the multiplier drops
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
    if (!this.online) this.overdrive = Math.min(1, (this.overdrive || 0) + 0.045); // fuel the OVERDRIVE meter
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
    if (x !== undefined && gained > 0) this.popup(x, y, `+${gained}`, this.mult > 1 ? 'rgb(255,215,90)' : 'rgb(220,220,220)');
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
    if (!this.online) this.overdrive = Math.min(1, (this.overdrive || 0) + 0.25);
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

    // 3D renderer: V cycles the camera (top → tilt → chase), G swaps to the
    // classic canvas graphics and back (offline; online keeps the fixed field)
    const v3 = this.online ? null : this.app.view3d;
    if (v3 && input.pressed.has('KeyV')) v3.cycle();
    if (v3 && input.pressed.has('KeyG')) v3.setEnabled(!v3.enabled);
    const chase = !!(v3?.active && (v3.mode === 'chase' || v3.mode === 'cockpit')); // both look down +x
    this.player1.controls = chase ? P1_CHASE_CONTROLS : P1_CONTROLS;
    this.player1.chase = chase;
    this.pitView = !!(v3?.active && v3.mode === 'cockpit');
    for (const pl of this.players()) pl.xLimit = this.pitView ? 0.34 : 0;
    if (this.player2 && !this.online) {
      this.player2.controls = chase ? P2_CHASE_CONTROLS : P2_CONTROLS;
      this.player2.chase = chase;
    }

    if (this.app.debugFreezeAt && this.time >= this.app.debugFreezeAt) return; // debug still frame
    if (this.app.debugAutoFire && this.time - (this._dbgFire || 0) > 1600) { // debug: exercise laser + rockets
      this._dbgFire = this.time;
      this.player1.lasers = Math.max(this.player1.lasers, 1); this.player1.rockets = Math.max(this.player1.rockets, 2);
      this.player1.fireLaser(this); this.player1.fireRocket(this);
    }
    if (this.app.debugBossDie && this.time >= this.app.debugBossDie) {
      const b = this.enemies.find((e) => e.isBoss && !e.deathSeq);
      if (b) { b.health = Math.min(b.health, 1); b.shieldUntil = 0; b.shieldBreaks = []; }
    }

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
        if (roll < 0.26) {
          // many comets are now on a collision course with a visible planet
          const target = Math.random() < 0.4 ? this.visiblePlanet() : null;
          this.ambient.push(new Comet(this.time, target));
        } else if (roll < 0.44) this.ambient.push(new DistantConvoy(this.app.images, this.time));
        else if (roll < 0.6) this.ambient.push(new Freighter(this.time));
        else if (roll < 0.74) this.ambient.push(new Skirmish(this.app.images, this.time));
        else if (roll < 0.86) this.ambient.push(new SpaceBattle(this.app.images, this.time));
        else this.ambient.push(new DistantRocks(this.app.images, this.time));
      }
    }
    for (const a of this.ambient) a.update(this);

    // --- eclipse: rarely a planet slides through the sector's light and the
    // scene dims while a corona flares around its limb (backdrop-only dim) ---
    this.nextEclipseAt ??= this.time + 60000 + randInt(0, 60000);
    if (!this.eclipse && this.time > this.nextEclipseAt && !this.bossSpawned && !this.bossWarnStart && !this.warp) {
      const pl = this.visiblePlanet();
      if (pl) this.eclipse = { start: this.time, dur: 6500, planet: pl };
      else this.nextEclipseAt = this.time + 12000; // no planet up — try again soon
    }
    if (this.eclipse && this.time - this.eclipse.start > this.eclipse.dur) {
      this.eclipse = null;
      this.nextEclipseAt = this.time + 80000 + randInt(0, 70000);
    }

    // --- gravity well: a rare singularity that bends fire, flings rocks and
    // sucks in power-ups; a gentle (dodgeable) tug on the ship, lethal core ---
    this.nextSingAt ??= this.time + 90000 + randInt(0, 70000);
    if (!this.singularity && this.time > this.nextSingAt && spawningAllowed &&
        !this.bossSpawned && !this.bossWarnStart && !this.warp && !this.ionStorm && !this.shower) {
      this.singularity = { x: W * (0.55 + Math.random() * 0.2), y: H * (0.3 + Math.random() * 0.4), start: this.time, dur: 10000, coreR: 0, env: 0 };
      audio.playSynth('storm');
      this.logEvent('SINGULARITY');
      vibrate([40, 60, 40]);
    }
    if (this.singularity) {
      const s = this.singularity;
      const t = (this.time - s.start) / s.dur;
      if (t >= 1) { this.singularity = null; this.nextSingAt = this.time + 120000 + randInt(0, 90000); }
      else {
        s.env = t < 0.15 ? t / 0.15 : t > 0.82 ? (1 - t) / 0.18 : 1; // grow / hold / collapse
        s.coreR = 26 * s.env;
        s.x -= 0.12 * this.speedMul * this.k; // drifts left with the world
        this.applySingularity();
      }
    }

    // --- reactive music: boss / combo / overdrive swell the soundtrack ---
    if (!this.online && this.time - (this._musAt || 0) > 150) {
      this._musAt = this.time;
      const bossUp = this.enemies.some((e) => e.isBoss && !e.deathSeq);
      let inten = bossUp ? 0.6 : 0;
      inten += Math.min(0.4, (this.mult - 1) * 0.1);
      if (this.overUntil && this.time < this.overUntil) inten += 0.4;
      if (this.ionStorm?.phase === 'active') inten += 0.15;
      audio.setMusicIntensity(Math.min(1, inten));
    }

    // --- backdrop + shake + combo/banner timers ---
    this.updateBackdrop(dt);
    this.shake *= Math.pow(0.88, this.k);
    if (this.combo > 0 && this.time > this.comboEnd) this.resetCombo();
    if (this.levelBanner && this.time - this.levelBanner.start >= 2200) this.levelBanner = null;
    if (this.dmgFlash > 0) this.dmgFlash = Math.max(0, this.dmgFlash - 0.03 * this.k);
    if (this.impactFx > 0) this.impactFx = Math.max(0, this.impactFx - 0.07 * this.k);

    // --- updates ---
    for (const p of this.players()) p.update(this);
    // micro-parallax follows the lead ship
    const ptgt = -(this.player1.y - H / 2) * 0.02;
    this.parallaxOffY = (this.parallaxOffY || 0) + (ptgt - (this.parallaxOffY || 0)) * Math.min(1, 0.06 * this.k);
    this.updateCamera();
    this.handleTouch();
    this.updateOverdrive();
    this.fireSecondary();
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
        if (e.type === 'brood' && !e._split) this.spawnSplit(e); // bursts into fragments
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
    // hold the transition while the final-death slow-mo plays, so its
    // time-dilation + camera push-in actually run before the screen freezes
    if (this.players().every((p) => !p.alive && p.lives <= 0) && !this.slowmo) {
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
    const obtn = this.overdriveBtn();
    // multi-touch: any new finger on the rocket/laser buttons fires; the pause
    // button pauses; the first other finger owns the movement drag
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (this.overdriveReady() && Math.hypot(pt.x - obtn.x, pt.y - obtn.y) <= obtn.r) {
        this._overTouch = true;
      } else if (Math.hypot(pt.x - btn.x, pt.y - btn.y) <= btn.r) {
        p.fireRocket(this);
      } else if (Math.hypot(pt.x - lbtn.x, pt.y - lbtn.y) <= lbtn.r) {
        p.fireLaser(this);
      } else if (!this.online && this.app.view3d?.active && Math.hypot(pt.x - this.camBtn().x, pt.y - this.camBtn().y) <= this.camBtn().r) {
        this.app.view3d.cycle();
        this.drag = null; // the drag axes rotate with the camera
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
        // chase camera: dragging up flies forward (+x), dragging right strafes (+y)
        const ddx = p.chase ? -(pt.y - this.drag.py) : pt.x - this.drag.px;
        const ddy = p.chase ? pt.x - this.drag.px : pt.y - this.drag.py;
        p.x = clamp(this.drag.ox + ddx * 1.25, p.w / 2, Math.min(W - p.w / 2, p._xr ?? W));
        p.y = clamp(this.drag.oy + ddy * 1.25, p.h / 2, H - p.h / 2);
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
          if (b.dead || !overlap(enemy, b, enemy.isBoss ? 0.78 : this.pitView ? 1.3 : 0.9)) continue; // from the cockpit hostiles are drawn larger up close: the guns agree
          b.dead = true;
          enemy.hitAt = { x: b.x, y: b.y, power: isRocket ? 1 : 0.5 }; // (the 3D view scorches the hull there)
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
            if (enemy.type !== 'brood' && rand(0, 1) < 0.45) {
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
      for (const b of this.enemyBullets) if (!b.dead) { b.dead = true; this.spawnSparks(b.x, b.y, 3); } // clear fire in flight too
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

    const v3 = !this.online && this.app.view3d?.active ? this.app.view3d : null;
    if (v3) this.draw3D(g, v3); else {
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
    if (this.eclipse) this.drawEclipse(g);
    if (this.singularity) this.drawSingularity(g);

    for (const pu of this.powerups) pu.draw(g, this);
    for (const a of this.asteroids) a.draw(g);
    for (const m of this.mines) m.draw(g, this);
    for (const e of this.enemies) e.draw(g, this);
    for (const b of this.bullets) b.draw(g);
    for (const b of this.enemyBullets) b.draw(g);
    for (const fx of this.effects) {
      if (fx instanceof ScorePopup) { // kit type instead of the sprite-era font
        const t = (this.time - fx.spawn) / fx.life;
        this.drawPopup(g, fx, fx.x, fx.y - t * 34, t);
      } else fx.draw(g, this);
    }
    for (const r of this.rockets) r.draw(g);
    for (const r of this.enemyRockets) r.draw(g);
    if (this.overUntil && this.time < this.overUntil) this.drawOverdriveAura(g); // behind the ships
    for (const p of this.players()) p.draw(g, this);
    g.restore();
    // 3D was asked for but is not (yet) drawing: say why instead of silently showing classic
    const v3c = this.online ? null : this.app.view3d;
    ui.begin(g);
    if (v3c?.enabled && (v3c.loading || v3c.failed)) ui.hudLabel(g, v3c.label, 12, H - 16, { size: 10, color: rgba(C.low) });
    }
    this._hudPit = !!(v3 && v3.mode === 'cockpit'); // cockpit: the lower third is the dashboard

    // slow-motion tint
    if (this.speedMul < 1) {
      g.fillStyle = 'rgba(80,150,255,0.08)';
      g.fillRect(0, 0, W, H);
    }
    if (!this.over) this.drawOverdriveHUD(g);

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
      this.drawBanner(g, this._hudPit ? 150 : 112, null, active ? 'ION STORM — WEAPONS OFFLINE' : 'ION STORM INCOMING', ION, g.globalAlpha);
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
      g.fillStyle = `rgba(255,240,205,${(v3 ? 0.07 : 0.28) * this.killFlash})`; // 3D already blooms: a hint is enough
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
      this.drawBanner(g, H / 2 - 200, 'WARNING', 'BOSS APPROACHING', C.danger, g.globalAlpha);
      g.globalAlpha = 1;
    }

    // meteor shower warning banner
    if (this.shower && this.time < this.shower.warnUntil) {
      const blink = 0.5 + 0.5 * Math.sin(this.time / 90);
      g.fillStyle = `rgba(255,140,40,${0.06 * blink})`;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 0.55 + 0.45 * blink;
      this.drawBanner(g, H / 2 - 200, 'METEOR SHOWER', 'SURVIVE FOR A BONUS', '255,170,80', g.globalAlpha);
      g.globalAlpha = 1;
    }

    // LEVEL N banner: white flash → pop-in → hold → fade out
    if (this.levelBanner) {
      const t = (this.time - this.levelBanner.start) / 2200;
      if (t < 1) {
        if (t < 0.12) {
          g.fillStyle = `rgba(255,255,255,${(v3 ? 0.05 : 0.18) * (1 - t / 0.12)})`;
          g.fillRect(0, 0, W, H);
        }
        const pop = Math.min(1, t * 6);
        const alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        this.drawBanner(g, H / 2 - 180, `LEVEL ${this.levelBanner.level}`, sectorName(this.levelBanner.level).toUpperCase(), C.gold,
          alpha * pop, 30 + 16 * pop, 'WAVE CLEARED');
      }
    }

    this.drawHud(g, v3);

    // daily modifier intro banner (first seconds of the run)
    if (this.daily && this.time < 3600 && !this.over) {
      const t = this.time / 3600;
      const alpha = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
      const left = dailyAttemptsLeft();
      this.drawBanner(g, H / 2 - 110, this.mod.name, this.mod.desc.toUpperCase(), C.gold, alpha, 40, `ATTEMPT ${3 - left} / 3`);
    }

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
        g.strokeStyle = rgba(C.cyan);
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(hx, hy, 26 * pulse, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(hx, hy, 5, 0, Math.PI * 2); g.stroke();
        ui.hudLabel(g, 'DRAG ANYWHERE TO MOVE', hx, hy + 56, { size: 13, weight: 700, track: 0.2, align: 'center', color: rgba(C.cyan), maxW: W * 0.56 });
        ui.hudLabel(g, 'GUNS FIRE ON THEIR OWN', hx, hy + 78, { size: 10.5, track: 0.2, align: 'center', color: rgba(C.mid), maxW: W * 0.56 });
        // button hints
        const rb = this.rocketBtn(), lb2 = this.laserBtn();
        g.beginPath(); g.arc(rb.x, rb.y, (rb.r + 8) * pulse, 0, Math.PI * 2); g.stroke();
        ui.hudLabel(g, 'ROCKET', rb.x - rb.r - 16, rb.y, { size: 12, weight: 700, track: 0.2, align: 'right', color: rgba(C.cyan) });
        g.beginPath(); g.arc(lb2.x, lb2.y, (lb2.r + 8) * pulse, 0, Math.PI * 2); g.stroke();
        ui.hudLabel(g, 'LASER', lb2.x - lb2.r - 16, lb2.y, { size: 12, weight: 700, track: 0.2, align: 'right', color: rgba(C.cyan) });
        g.globalAlpha = 1;
      }
    }

    // achievement toasts
    this.drawToasts(g);

    // touch controls: rocket button + pause button
    if (input.isTouch && !this.over && !this.paused) {
      // glass discs: dark fill so they hold up over a bright sky, coloured ring
      const disc = (b, r, color, ring = 0.8) => {
        g.beginPath(); g.arc(b.x, b.y, r, 0, Math.PI * 2);
        g.fillStyle = rgba(C.ink, 0.5); g.fill();
        g.strokeStyle = rgba(color, ring); g.lineWidth = 1.5; g.stroke();
        g.beginPath(); g.arc(b.x, b.y, r - 5, 0, Math.PI * 2);
        g.strokeStyle = rgba(color, 0.16); g.lineWidth = 1; g.stroke();
      };
      const num = (n, x, y, color) => ui.text(g, String(n), x, y, { size: 17, weight: 700, align: 'center', color });
      const b = this.rocketBtn();
      const hasRk = this.player1.rockets > 0;
      disc(b, b.r, hasRk ? C.hi : C.low, hasRk ? 0.8 : 0.4);
      g.globalAlpha = hasRk ? 0.95 : 0.4;
      g.drawImage(images.rocket, b.x - 20, b.y - 20, 40, 20);
      g.globalAlpha = 1;
      num(this.player1.rockets, b.x, b.y + 17, rgba(hasRk ? C.hi : C.low));

      // laser button (charges + cooldown arc)
      const lb = this.laserBtn();
      const p1 = this.player1;
      const cd = Math.max(0, p1.lastLaser + p1.laserDelay - this.time) / p1.laserDelay;
      const ready = p1.lasers > 0 && cd <= 0;
      disc(lb, lb.r, ready ? C.cyan : C.low, ready ? 0.9 : 0.4);
      if (cd > 0) { // cooldown sweep
        g.strokeStyle = rgba(C.cyan, 0.9); g.lineWidth = 3;
        g.beginPath(); g.arc(lb.x, lb.y, lb.r - 2, -Math.PI / 2, -Math.PI / 2 + (1 - cd) * Math.PI * 2); g.stroke();
      }
      glyphBolt(g, lb.x, lb.y - 9, 20, rgba(ready ? C.cyan : C.low));
      num(p1.lasers, lb.x, lb.y + 16, rgba(ready ? C.hi : C.low));

      if (!this.online && this.app.view3d?.active) { // camera button
        const cb = this.camBtn();
        disc(cb, cb.r - 2, C.mid, 0.6);
        ui.text(g, 'CAM', cb.x, cb.y + 0.5, { size: 9.5, weight: 700, track: 0.12, align: 'center', color: rgba(C.hi) });
      }
      const pb = this.pauseBtn();
      disc(pb, pb.r - 2, C.mid, 0.6);
      if (this.online) {
        // leave (X)
        g.strokeStyle = rgba(C.hi); g.lineWidth = 2;
        g.beginPath(); g.moveTo(pb.x - 6, pb.y - 6); g.lineTo(pb.x + 6, pb.y + 6);
        g.moveTo(pb.x + 6, pb.y - 6); g.lineTo(pb.x - 6, pb.y + 6); g.stroke();
      } else {
        g.fillStyle = rgba(C.hi);
        g.fillRect(pb.x - 6, pb.y - 7, 4, 14); // pause bars
        g.fillRect(pb.x + 2, pb.y - 7, 4, 14);
      }
    }

    this.drawPauseOverlay(g);

    if (this.over) {
      g.fillStyle = `rgba(0,0,0,${this.overAlpha})`;
      g.fillRect(0, 0, W, H);
      if (this.online && this.overAlpha >= 0.5) this.drawOverHead(g, H / 2 - 44, false);
      if (this.overMenu) this.drawResults(g);
    }

    // big-hit / boss-phase screen punch: additive ghosts of the frame offset
    // left+right for a chromatic-split impact (device pixels, motion off)
    if (this.impactFx > 0.03 && settings.motionFx) {
      const cv = g.canvas, off = Math.round(this.impactFx * cv.width * 0.004);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.28 * this.impactFx;
      g.drawImage(cv, -off, 0);
      g.drawImage(cv, off, 0);
      g.restore();
    }
  }

  // 3D view: the WebGL layer under this canvas draws the world; here only
  // clear to transparent and add the bits Boss.draw used to paint in 2D
  draw3D(g, v3) {
    g.clearRect(0, 0, W, H);
    try { v3.render(this); } catch (e) { // never leave a dead frame: classic takes over from the next one
      console.error('3D view failed, falling back to classic graphics:', e);
      window.__svlog?.push(`ERR 3D render: ${e.message} | ${(e.stack || '').split('\n')[1] || ''}`);
      v3.failed = true;
    }
    ui.begin(g);
    // score popups live in sim space — pin them to where that point lands on screen
    for (const fx of this.effects) {
      if (!(fx instanceof ScorePopup) || fx.dead) continue;
      const sp = v3.toScreen(fx.x, fx.y);
      if (!sp) continue;
      const t = (this.time - fx.spawn) / fx.life;
      this.drawPopup(g, fx, sp.x, sp.y - 18 - t * 30, t);
    }
    if (v3.mode === 'cockpit' && this.player1.alive && !this.over) this.drawPitAids(g, v3);
    // camera hint: bottom-left, lifted above the dashboard in the cockpit view
    if (!input.isTouch && !this.over && !this.paused) {
      g.globalAlpha = 0.8;
      ui.keyHints(g, 12, v3.mode === 'cockpit' ? 126 : H - 20, [['V', v3.label], ['G', 'CLASSIC GRAPHICS']], { size: 9.5, gap: 14 });
      g.globalAlpha = 1;
    }
  }

  // floating score / pickup text
  drawPopup(g, fx, x, y, t) {
    const a = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
    const o = { size: 14 + 3 * Math.max(0, 1 - t * 5), weight: 700, track: 0.06, align: 'center' };
    ui.text(g, fx.text, x + 1, y + 1, { ...o, color: 'rgba(0,0,0,0.65)', alpha: a });
    ui.text(g, fx.text, x, y, { ...o, color: fx.color, alpha: a });
  }

  // Centre-screen announcement: a dark band that fades out sideways (so it
  // reads over a nebula or an explosion), accent hairlines, light tracked title.
  // title may be null for a one-line notice.
  drawBanner(g, cy, title, sub, c, alpha = 1, size = 42, note = null) {
    const prev = g.globalAlpha;
    g.globalAlpha = 1;
    const bw = Math.min(W * 0.48, 460), h = title ? size * 1.15 + 34 : 30, top = cy - h / 2;
    for (const [dir, x] of [['l', W / 2 - bw], ['r', W / 2]]) {
      ui.fade(g, '2,5,10', dir, x, top, bw, h, 0.62 * alpha);
      ui.fade(g, c, dir, x, top, bw, ui.hair() * 1.5, 0.9 * alpha);
      ui.fade(g, c, dir, x, top + h - ui.hair() * 1.5, bw, ui.hair() * 1.5, 0.9 * alpha);
    }
    if (title) {
      ui.text(g, title, W / 2, cy - 10, { size, weight: 300, track: 0.3, align: 'center', color: rgba(c), alpha, maxW: W - 40 });
      ui.text(g, sub, W / 2, cy + size * 0.5 + 6, { size: 11, weight: 700, track: 0.3, align: 'center', color: rgba(C.hi, 0.9), alpha, maxW: W - 40 });
    } else {
      ui.text(g, sub, W / 2, cy + 0.5, { size: 12, weight: 700, track: 0.3, align: 'center', color: rgba(c), alpha, maxW: W - 40 });
    }
    if (note) ui.hudLabel(g, note, W / 2, top + h + 16, { size: 10, weight: 700, track: 0.3, align: 'center', color: rgba(C.mid, 0.9 * alpha) });
    g.globalAlpha = prev;
  }

  // Top HUD: score + combo and one row per player on the left, level + sector
  // on the right, the boss hull bar in the middle (under the left plate on
  // narrow / portrait screens). Plates keep it legible over a bright sky.
  drawHud(g, v3) {
    ui.scrim(g, 'top', 100, v3 ? 0.5 : 0.3);
    const shown = this.playerList.filter((p) => !p.gone); // drop guests who left
    const many = shown.length > 2, rowH = many ? 21 : 25;
    const lx = 8, ly = 8, lw = 232, lh = 56 + shown.length * rowH + 5;
    ui.hudPanel(g, lx, ly, lw, lh, { alpha: 0.5 });
    ui.text(g, 'SCORE', lx + 14, ly + 14, { size: 9, weight: 700, track: 0.28, color: rgba(C.low) });
    const sw = ui.text(g, ui.fmt(this.score), lx + 14, ly + 36, { size: 24, weight: 600, track: 0.03, color: '#fff' });
    if (this.mult > 1) {
      // badge sits right after the score, shifting as the score grows
      const mx = lx + 14 + sw + 14;
      const pulse = this.time - this.multPulse < 400 ? 1.4 - (this.time - this.multPulse) / 1000 : 1;
      ui.text(g, `×${this.mult}`, mx, ly + 36, { size: Math.round(19 * pulse), weight: 700, color: rgba(C.gold) });
      // combo time bar
      ui.hudBar(g, mx, ly + 49, 44, 2.5, Math.max(0, (this.comboEnd - this.time) / 4000), { color: C.gold, back: 0.2 });
    }
    g.fillStyle = rgba(C.mid, 0.14); g.fillRect(lx + 14, ly + 56, lw - 28, ui.hair());
    // lives + rockets + beam charges per player (colour-coded)
    shown.forEach((p, i) => {
      const y = ly + 59 + rowH * (i + 0.5);
      ui.text(g, `P${p.slot + 1}`, lx + 14, y + 0.5, { size: 11, weight: 700, track: 0.08, color: p.color });
      // compact form past 5 lives (hull upgrades / Juggernaut) so the pips
      // don't run into the rocket counter
      const lives = Math.max(0, p.lives);
      if (lives > 5) {
        ui.hudIconPips(g, lx + 44, y, 1, 1, { color: HUD_RED, size: 9 });
        ui.text(g, `×${lives}`, lx + 58, y + 0.5, { size: 13, weight: 700, color: rgba(HUD_RED) });
      } else {
        ui.hudIconPips(g, lx + 44, y, lives, Math.min(5, Math.max(lives, p.maxLives || 3)), { color: HUD_RED, size: 9, gap: 4 });
      }
      // out-of-ammo dry-fire briefly flashes the counter red
      const rk = this.time - (p.rkEmptyFlash || 0) < 300 ? rgba(C.danger) : rgba(p.rockets > 0 ? C.hi : C.low);
      const lz = this.time - (p.lzEmptyFlash || 0) < 300 ? rgba(C.danger) : rgba(p.lasers > 0 ? C.cyan : C.low);
      glyphRocket(g, lx + 132, y, 11, rk);
      ui.text(g, String(p.rockets), lx + 145, y + 0.5, { size: 14, weight: 700, color: rk });
      glyphBolt(g, lx + 186, y, 13, lz);
      ui.text(g, String(p.lasers), lx + 196, y + 0.5, { size: 14, weight: 700, color: lz });
    });

    // level + sector, top-right
    const rw = 204, rx = W - 8 - rw;
    ui.hudPanel(g, rx, 8, rw, 44, { alpha: 0.5, edge: 'right' });
    ui.text(g, 'LEVEL', W - 22, 20, { size: 9, weight: 700, track: 0.28, align: 'right', color: rgba(C.low) });
    const nw = ui.text(g, String(this.level).padStart(2, '0'), W - 22, 38, { size: 22, weight: 600, align: 'right', color: '#fff' });
    ui.text(g, sectorName(this.level).toUpperCase(), W - 22 - nw - 12, 39, {
      size: 10, weight: 600, track: 0.14, align: 'right', color: rgba(C.mid, 0.9), maxW: rw - nw - 40,
    });
    // on touch the pause button sits top-right at y~72, so drop the DAILY tag below it
    if (this.daily) {
      const dy = input.isTouch ? 120 : 74, label = `DAILY · ${this.mod.name}`;
      const dw = ui.measure(g, label, { size: 10.5, weight: 700, track: 0.14 }) + 16;
      g.fillStyle = rgba(C.ink, 0.5); g.fillRect(W - 8 - dw, dy - 10, dw, 20);
      ui.chip(g, W - 8, dy, label, { color: C.gold, align: 'right' });
    }
    if (this.speedMul < 1) ui.hudLabel(g, 'SLOW-MO', W / 2, 24, { size: 12, weight: 700, track: 0.4, align: 'center', color: rgba(C.cyan) });

    // boss hull
    const boss = this.enemies.find((e) => e.isBoss && !e.dead);
    if (!boss) { this._bossGhost = 1; return; }
    const narrow = W < 760;
    const bw = narrow ? W - 40 : Math.min(440, W * 0.34), bx = W / 2 - bw / 2;
    const by = narrow ? (this.daily && input.isTouch ? 158 : ly + lh + 26) : 60;
    const v = Math.max(0, boss.health) / boss.maxHealth;
    // trailing "recent damage" level eases down behind the real one
    this._bossGhost = Math.max(v, (this._bossGhost ?? 1) - 0.004 * (this.k || 1));
    const col = boss.shieldUntil > this.time ? C.cyan : boss.flash > 0.05 ? C.white : HUD_RED;
    g.fillStyle = rgba(C.ink, 0.55); g.fillRect(bx - 5, by - 5, bw + 10, 17);
    g.fillStyle = rgba(HUD_RED, 0.9); g.fillRect(bx - 5, by - 5, 2, 17); g.fillRect(bx + bw + 3, by - 5, 2, 17);
    ui.hudBar(g, bx, by, bw, 7, v, { color: col, back: 0.16, ghost: this._bossGhost });
    ui.hudLabel(g, boss.shieldUntil > this.time ? 'SHIELDED' : this.app.view3d?.bossName?.(boss) || (boss.mega ? 'MEGA BOSS' : 'BOSS'), bx - 4, by - 15, { size: 9.5, weight: 700, track: 0.3, color: rgba(col === C.white ? HUD_RED : col) });
    ui.hudLabel(g, `${Math.ceil(v * 100)}%`, bx + bw + 4, by - 15, { size: 10, weight: 700, track: 0.08, align: 'right', color: rgba(C.hi) });
  }

  // GAME OVER heading block (also used alone by the online wrapper's flow)
  drawOverHead(g, y, big = true) {
    ui.text(g, 'GAME OVER', W / 2, y, { size: big ? 38 : 44, weight: 300, track: 0.36, align: 'center', color: rgba(C.danger), maxW: W - 40 });
    ui.text(g, `LOST IN ${sectorName(this.level).toUpperCase()}`, W / 2, y + 36, { size: 10.5, weight: 700, track: 0.26, align: 'center', color: rgba(C.low), maxW: W - 40 });
    ui.text(g, ui.fmt(this.score), W / 2, y + 70, { size: 34, weight: 600, track: 0.04, align: 'center', color: '#fff' });
  }

  // results: heading, best / reward lines, the two buttons, leaderboard slice
  drawResults(g) {
    const cy = H / 2, pw = Math.min(380, W - 32), top = cy - 148, bottom = cy + 198;
    ui.panel(g, W / 2 - pw / 2, top, pw, bottom - top, { accent: C.danger, fill: 0.74 });
    this.drawOverHead(g, cy - 108);
    if (this.newBest) {
      // performance.now(): world time is frozen once the run is over
      ui.chip(g, W / 2, cy - 4, 'NEW BEST', { color: C.gold, align: 'center', filled: true, h: 22, size: 11, a: 0.72 + 0.28 * Math.sin(performance.now() / 170) });
    } else {
      ui.text(g, `BEST  ${ui.fmt(this.app.highScore)}`, W / 2, cy - 4, { size: 12, weight: 700, track: 0.2, align: 'center', color: rgba(C.mid, 0.85) });
    }
    // credits earned this run + running balance
    if (this.reward && this.reward.total > 0) {
      ui.text(g, `+${ui.fmt(this.reward.total)} CR  ·  ${ui.fmt(progress.credits)} TOTAL`, W / 2, cy + 20, { size: 13, weight: 700, track: 0.14, align: 'center', color: rgba(C.gold), maxW: pw - 40 });
    }
    if (this.daily) {
      const left = dailyAttemptsLeft();
      ui.text(g, left > 0 ? `DAILY ATTEMPTS LEFT: ${left}` : 'NO DAILY ATTEMPTS LEFT TODAY', W / 2, cy + 42,
        { size: 11, weight: 700, track: 0.18, align: 'center', color: rgba(left > 0 ? C.gold : C.danger), maxW: pw - 40 });
    }
    this.overMenu.draw(g);

    // leaderboard block under the panel
    const ly = bottom + 22, x0 = W / 2 - pw / 2 + 12, x1 = W / 2 + pw / 2 - 12;
    const head = { size: 10, weight: 700, track: 0.24 };
    if (this.lb.status === 'done') {
      if (this.lb.top?.length) ui.text(g, this.daily ? 'DAILY TOP' : 'GLOBAL TOP', x0, ly, { ...head, color: rgba(C.low) });
      if (this.lb.rank > 0 && this.lb.rank <= 10) {
        ui.text(g, `${this.daily ? 'DAILY' : 'GLOBAL'} RANK  #${this.lb.rank}`, this.lb.top?.length ? x1 : W / 2, ly,
          { ...head, size: 11, align: this.lb.top?.length ? 'right' : 'center', color: rgba(C.gold) });
      }
      if (this.lb.top?.length) {
        g.fillStyle = rgba(C.mid, 0.2); g.fillRect(x0, ly + 12, x1 - x0, ui.hair());
        this.lb.top.slice(0, 5).forEach((e, i) => {
          const mine = this.lb.rank === i + 1, y = ly + 28 + i * 21;
          const col = rgba(mine ? C.ok : C.mid);
          ui.text(g, String(i + 1).padStart(2, '0'), x0, y, { size: 11, weight: 700, color: rgba(mine ? C.ok : C.low) });
          ui.text(g, e.name, x0 + 30, y, { size: 13, weight: 600, track: 0.08, color: col, maxW: pw * 0.5 });
          ui.text(g, ui.fmt(e.score), x1, y, { size: 13, weight: 600, align: 'right', color: col });
        });
      }
    } else if (this.lb.status === 'sending') {
      ui.text(g, 'SUBMITTING SCORE…', W / 2, ly, { ...head, align: 'center', color: rgba(C.low) });
    } else if (this.lb.status === 'offline') {
      ui.text(g, 'LEADERBOARD UNAVAILABLE', W / 2, ly, { ...head, align: 'center', color: rgba(C.low, 0.8) });
    }

    // keyboard shortcut hint at the foot of the screen
    if (this.lb.status !== 'asking' && !input.isTouch) {
      const canRetry = !this.daily || dailyAttemptsLeft() > 0;
      ui.keyHints(g, W / 2, H - 20, canRetry ? [['ENTER', 'RETRY'], ['R', 'RETRY'], ['ESC', 'MENU']] : [['ESC', 'MENU']], { align: 'center', size: 10 });
    }
  }

  // Helmet-sight symbology for the cockpit view, where depth along the lane is
  // the hard part: a gun pipper, a box on every hostile (red once it is on the
  // ship's line), a diamond on each shot that is going to connect, and edge
  // chevrons for anything outside the canopy.
  drawPitAids(g, v3) {
    const p = this.player1, t = this.time, sm = this.speedMul || 1;
    g.save();
    g.lineWidth = Math.max(1, ui.hair() * 1.3);
    const pip = v3.toScreen(p.x + 620, p.y);
    if (pip) {
      g.strokeStyle = rgba(C.cyan, 0.8);
      g.beginPath(); g.arc(pip.x, pip.y, 9, 0, Math.PI * 2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(pip.x + dx * 13, pip.y + dy * 13); g.lineTo(pip.x + dx * 21, pip.y + dy * 21); }
      g.stroke();
      g.fillStyle = rgba(C.cyan, 0.95);
      g.fillRect(pip.x - 1, pip.y - 1, 2, 2);
    }
    const chevron = (y, right, hot) => {
      const x = right ? W - 26 : 26, d = right ? 1 : -1;
      g.strokeStyle = hot ? rgba(C.danger, 0.95) : rgba(C.gold, 0.7);
      g.beginPath(); g.moveTo(x - d * 8, y - 11); g.lineTo(x + d * 6, y); g.lineTo(x - d * 8, y + 11); g.stroke();
    };
    for (const e of this.enemies) {
      if (e.dead || e.dying || e.x < p.x + 20) continue;
      const a = v3.toScreen(e.x, e.y - e.h / 2), b = v3.toScreen(e.x, e.y + e.h / 2);
      if (!a || !b) continue;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const lined = Math.abs(e.y - p.y) < (e.h + p.h) * 0.5;
      if (cx < 8 || cx > W - 8) { chevron(Math.max(90, Math.min(H * 0.6, cy)), cx > W / 2, lined); continue; }
      const r = Math.max(9, Math.min(150, Math.abs(b.x - a.x) * 0.62)), c = Math.max(4, r * 0.34);
      g.strokeStyle = e.isBoss ? rgba(C.danger, 0.55) : lined ? rgba(C.danger, 0.95) : rgba(C.gold, 0.6);
      g.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        g.moveTo(cx + sx * r, cy + sy * r - sy * c); g.lineTo(cx + sx * r, cy + sy * r); g.lineTo(cx + sx * r - sx * c, cy + sy * r);
      }
      g.stroke();
    }
    // incoming fire that will actually cross the ship
    const warn = (x, y, vx, vy, size) => {
      if (vx > -0.4 || x <= p.x) return;
      const steps = (x - p.x) / -vx;
      if (steps > 110 || Math.abs(y + vy * steps - p.y) - (size + p.h * 0.8) / 2 > 4) return;
      const sp = v3.toScreen(x, y);
      if (!sp) return;
      const r = 5 + 9 * (1 - steps / 110), blink = steps < 35 ? 0.55 + 0.45 * Math.sin(t / 45) : 1;
      g.strokeStyle = rgba(C.danger, 0.9 * blink);
      g.beginPath(); g.moveTo(sp.x, sp.y - r); g.lineTo(sp.x + r, sp.y); g.lineTo(sp.x, sp.y + r); g.lineTo(sp.x - r, sp.y); g.closePath(); g.stroke();
    };
    for (const b of this.enemyBullets) if (!b.dead) warn(b.x, b.y, b.vx * sm, b.vy * sm, 10);
    for (const a of this.asteroids) if (!a.dead) warn(a.x, a.y, -a.vx * sm, a.vy * sm, a.w * 0.75);
    for (const r of this.enemyRockets) if (!r.dead) warn(r.x, r.y, (r.vx ?? -4) * sm, (r.vy ?? 0) * sm, r.w);
    g.restore();
  }

  // gravity well physics: inverse-square pull on projectiles, rocks, power-ups
  // and the ship; anything reaching the core is consumed (the ship dies).
  applySingularity() {
    const s = this.singularity;
    const G = 32000 * s.env, MIN = 46, k = this.k;
    const pull = (ox, oy) => {
      const dx = s.x - ox, dy = s.y - oy;
      const d2 = Math.max(MIN * MIN, dx * dx + dy * dy);
      const d = Math.sqrt(d2);
      const f = (G / d2) * k;
      return { fx: (dx / d) * f, fy: (dy / d) * f, d };
    };
    for (const a of this.asteroids) { // rocks get flung, then swallowed
      if (a.dead) continue;
      const p = pull(a.x, a.y);
      a.vx -= p.fx; a.vy += p.fy; // a.vx is leftward speed → subtract to add screen vx
      if (p.d < s.coreR + a.w * 0.3) { a.dead = true; this.spawnRockDust(a.x, a.y, a.w); }
    }
    for (const arr of [this.bullets, this.enemyBullets]) {
      for (const b of arr) {
        if (b.dead) continue;
        const p = pull(b.x, b.y);
        b.vx += p.fx; b.vy += p.fy;
        if (p.d < s.coreR) b.dead = true;
      }
    }
    for (const pu of this.powerups) { // drawn in
      if (pu.dead) continue;
      const p = pull(pu.x, pu.baseY);
      pu.vx += p.fx * 0.8;
      pu.baseY += clamp(p.fy, -1.6, 1.6);
      if (p.d < s.coreR + 8) pu.dead = true;
    }
    for (const pl of this.players()) { // a gentle, fightable tug; lethal core
      if (!pl.alive) continue;
      const p = pull(pl.x, pl.y);
      pl.x = clamp(pl.x + clamp(p.fx, -1.7, 1.7), pl.w / 2, W - pl.w / 2);
      pl.y = clamp(pl.y + clamp(p.fy, -1.7, 1.7), pl.h / 2, H - pl.h / 2);
      if (p.d < s.coreR + pl.h * 0.35) this.killPlayer(pl, s.x, s.y);
    }
  }

  // gravity well visual: accretion glow + rotating arcs + black event horizon
  drawSingularity(g) {
    const s = this.singularity;
    const R = Math.max(1, s.coreR), t = this.time - s.start;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const glow = g.createRadialGradient(s.x, s.y, R * 0.85, s.x, s.y, R * 3.4);
    glow.addColorStop(0, `rgba(180,120,255,${0.55 * s.env})`);
    glow.addColorStop(0.4, `rgba(90,60,200,${0.22 * s.env})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(s.x, s.y, R * 3.4, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 2; i++) { // rotating accretion arcs
      g.strokeStyle = `rgba(215,175,255,${0.5 * s.env})`;
      g.lineWidth = 2;
      const a0 = t / 260 + i * Math.PI;
      g.beginPath(); g.arc(s.x, s.y, R * 1.7, a0, a0 + Math.PI * 0.85); g.stroke();
    }
    g.globalCompositeOperation = prev;
    g.fillStyle = '#000';
    g.beginPath(); g.arc(s.x, s.y, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = `rgba(150,110,220,${0.75 * s.env})`;
    g.lineWidth = 2;
    g.beginPath(); g.arc(s.x, s.y, R, 0, Math.PI * 2); g.stroke();
  }

  // eclipse: dim the backdrop and flare a corona around the eclipsing planet
  drawEclipse(g) {
    const e = this.eclipse;
    const t = (this.time - e.start) / e.dur;
    const env = t < 0.2 ? t / 0.2 : t > 0.7 ? (1 - t) / 0.3 : 1; // fade in / hold / out
    g.fillStyle = `rgba(4,6,14,${0.5 * env})`;
    g.fillRect(0, 0, W, H);
    const pl = e.planet;
    const cx = pl.x + pl.img.width / 2, cy = pl.y + pl.img.height / 2;
    const r = pl.img.planetR || pl.img.height / 2.7;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = env * (0.5 + 0.14 * Math.sin(this.time / 130));
    const cor = g.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.4);
    cor.addColorStop(0, 'rgba(0,0,0,0)');
    cor.addColorStop(0.45, 'rgba(255,240,210,0.55)');
    cor.addColorStop(1, 'rgba(255,240,210,0)');
    g.fillStyle = cor;
    g.beginPath(); g.arc(cx, cy, r * 1.4, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }

  // pause overlay: the base world draws the panel + menu, this adds the run's stats
  drawPauseOverlay(g) {
    if (!this.paused) return;
    const secs = Math.floor(this.time / 1000);
    super.drawPauseOverlay(g, [['SCORE', ui.fmt(this.score)], ['LEVEL', String(this.level)],
      ['TIME', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`]]);
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
      const tw = ui.measure(g, t.title, { size: 12, weight: 700, track: 0.16 }) + 128, ty = y - 20 * (1 - slide);
      ui.hudPanel(g, W / 2 - tw / 2, ty - 15, tw, 30, { alpha: 0.7, accent: C.gold, edge: 'left' });
      ui.text(g, 'ACHIEVEMENT', W / 2 - tw / 2 + 16, ty + 0.5, { size: 9, weight: 700, track: 0.24, color: rgba(C.gold) });
      ui.text(g, t.title, W / 2 + tw / 2 - 14, ty + 0.5, { size: 12, weight: 700, track: 0.16, align: 'right', color: '#fff' });
      g.globalAlpha = 1;
      y += 36;
      return true;
    });
  }
}
