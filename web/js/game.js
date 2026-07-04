// Single / Co-op / Daily game mode — port of game.py on top of BaseWorld
import { W, H, STEP, rand, randInt, overlap, clamp, setRngSeed } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { BaseWorld } from './world.js';
import {
  Player, Enemy, Boss, Asteroid, PowerUp, Explosion, Spark, Shockwave,
  POWERUP_TYPES, POWERUP_IMG,
} from './entities.js';
import { makeNebulaField, tinted } from './fx.js';
import { askName, submitScore } from './lb.js';
import { bumpStats, vibrate } from './settings.js';
import { dailySeed, todayMod, useDailyAttempt, dailyAttemptsLeft } from './daily.js';

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  rocket: 'Space', speed: 'ShiftLeft',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  rocket: 'Enter', rocketAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
};

export class GameState extends BaseWorld {
  constructor(app, coop, opts = {}) {
    super(app, 'game_background');
    this.coop = coop;
    this.daily = !!opts.daily;
    this.online = !!opts.online; // driven by CoopHost; no pause/menu/leaderboard
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');
    // daily challenge: everyone plays the same seeded spawn stream today
    setRngSeed(this.daily ? dailySeed() : null);
    this.mod = this.daily ? todayMod() : null;
    if (this.daily) {
      useDailyAttempt();
      this.pushToasts(bumpStats({ dailyRuns: 1 }));
    }

    this.initBackdrop();
    this.score = 0;
    this.level = 1;
    this.nextBossScore = 100;
    this.bossSpawned = false;
    this.slowMoEnd = 0;

    this.bullets = [];
    this.rockets = [];
    this.enemyBullets = [];
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
    // cyan-tinted shield powerup sprite
    this.shieldImg = tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield');

    this.enemyInterval = 2000;
    this.asteroidInterval = 5000;
    this.powerupInterval = 10000;  // game.py set 1000ms but the comment said 10s — fixed
    this.enemyAcc = 0;
    this.asteroidAcc = 0;
    this.powerupAcc = 0;

    this.shake = 0;
    this.over = false;
    this.overAlpha = 0;
    this.overMenu = null;
    this.levelBanner = null;

    this.player1 = new Player(images, {
      img: images.player1_ship,
      thrusters: images.thrusters.player1,
      controls: P1_CONTROLS,
      padIndex: 0,
    });
    this.player1.x = 100;
    this.player1.y = H / 2;

    this.player2 = null;
    if (this.coop) {
      this.player2 = new Player(images, {
        img: images.player2_ship,
        thrusters: images.thrusters.player2,
        controls: P2_CONTROLS,
        padIndex: 1,
      });
      this.player2.x = 100;
      this.player2.y = H / 3;
    }

    // touch state (mobile: drag to move, on-screen rocket button)
    this.drag = null;

    this.rocketTargets = () => this.enemies.filter((e) => !e.dying).concat(this.asteroids);

    // apply daily modifier to the players
    if (this.mod) {
      for (const p of this.players()) {
        if (this.mod.startRockets) p.rockets = this.mod.startRockets;
        if (this.mod.rocketDelay) p.rocketDelay *= this.mod.rocketDelay;
        if (this.mod.playerBoost) p.fastSpeed += this.mod.playerBoost;
      }
    }
  }

  players() {
    return this.player2 ? [this.player1, this.player2] : [this.player1];
  }

  rocketBtn() {
    return { x: W - 70, y: H - 80, r: 44 }; // live: follows resizes
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

  pickEnemyType() {
    const r = rand(0, 100);
    if (this.mod?.tankBias && r < 35) return 'tank';               // HEAVY ARMOR day
    if (this.mod?.lightOnly) return r < 45 ? 'weaver' : 'basic';   // THE SWARM day
    if (this.level >= 4 && r < 12) return 'tank';
    if (this.level >= 3 && r >= 12 && r < 32) return 'hunter';
    if (this.level >= 2 && r >= 32 && r < 57) return 'weaver';
    return 'basic';
  }

  spawnSparks(x, y, count, dir = Math.PI) {
    for (let i = 0; i < count; i++) this.effects.push(new Spark(x, y, this.time, dir));
  }

  powerupImage(type) {
    return type === 'shield' ? this.shieldImg : this.app.images[POWERUP_IMG[type]];
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
    if (sound) audio.play('explosion', 0.5);
  }

  killPlayer(p) {
    if (this.app.debugGod) return;
    if (this.time < (p.invulnUntil || 0)) return;
    this.resetCombo();
    if (p.shield) {
      // shield absorbs the hit
      p.shield = false;
      p.invulnUntil = this.time + 1200;
      this.spawnSparks(p.x, p.y, 16);
      audio.playSynth('shield_pop');
      vibrate(50);
      this.pushToasts(bumpStats({ shieldSaves: 1 }));
      return;
    }
    this.explode(p.x, p.y, true, 1.6);
    vibrate(140);
    p.alive = false;
    p.lives -= 1;
    if (p.lives > 0) p.respawnAt = this.time + 1500;
  }

  // combo: consecutive kills raise the score multiplier (up to x5); resets on hit or 4s idle
  addKill(points) {
    this.combo += 1;
    this.comboEnd = this.time + 4000;
    const tier = Math.min(5, 1 + Math.floor(this.combo / 5));
    if (tier > this.mult) {
      this.mult = tier;
      this.multPulse = this.time;
      audio.playSynth('combo');
      this.pushToasts(bumpStats({ maxMult: tier }));
    }
    this.score += points * this.mult * (this.mod?.scoreMul || 1);
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
    for (const p of this.players()) p.rockets += 3;
    // breather: no new spawns for a few seconds
    this.spawnHoldUntil = this.time + 4000;
    // fresh nebula palette + planet zoom step for the new level
    this.nebulaHue = (170 + (this.level - 1) * 47) % 360;
    this.nebulae = makeNebulaField(3, this.nebulaHue);
    this.bgZoomTarget = 1 + ((this.level - 1) % 4) * 0.05;
    // celebration: shockwave from the boss + LEVEL N banner + fanfare
    this.effects.push(new Shockwave(x ?? W / 2, y ?? H / 2, this.time));
    this.levelBanner = { level: this.level, start: this.time };
    this.logEvent('LEVELUP (boss killed)');
    audio.playSynth('fanfare');
    vibrate(80);
    this.pushToasts(bumpStats({ bossKills: 1, maxLevel: this.level }));
  }

  update(dt) {
    this.k = dt / STEP;

    if (!this.over && this.handlePause()) return;

    if (this.over) {
      this.updateGameOver();
      return;
    }

    this.time += dt;

    // --- spawn timers (pygame USEREVENT timers); paused during the post-boss breather ---
    const spawningAllowed = this.time >= this.spawnHoldUntil;
    this.enemyAcc += dt;
    if (this.enemyAcc >= this.enemyInterval * (this.mod?.enemyRate || 1) && spawningAllowed) {
      this.enemyAcc = 0;
      const chance = Math.min(10 + (this.level - 1) * 5, 100);
      const moveRandomly = randInt(1, 100) <= chance;
      const e = new Enemy(this.app.images, this.level, this.pickEnemyType(), this.time, moveRandomly);
      if (this.mod?.enemySpeed) e.vx *= this.mod.enemySpeed;
      if (this.mod?.shootRate) e.shootDelay = Math.max(250, e.shootDelay * this.mod.shootRate);
      this.enemies.push(e);
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
      this.asteroids.push(new Asteroid(this.app.images.asteroid, 'large'));
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
      }
    }

    // --- respawns (lives system) ---
    for (const p of this.players()) {
      if (!p.alive && p.lives > 0 && p.respawnAt && this.time > p.respawnAt) {
        p.alive = true;
        p.respawnAt = 0;
        p.x = 100;
        p.y = p === this.player2 ? H / 3 : H / 2;
        p.invulnUntil = this.time + 2500;
        audio.playSynth('respawn');
      }
    }

    // --- backdrop + shake + combo/banner timers ---
    this.updateBackdrop(dt);
    this.shake *= Math.pow(0.88, this.k);
    if (this.combo > 0 && this.time > this.comboEnd) this.resetCombo();
    if (this.levelBanner && this.time - this.levelBanner.start >= 2200) this.levelBanner = null;

    // --- updates ---
    for (const p of this.players()) p.update(this);
    this.handleTouch();
    for (const b of this.bullets) b.update(this);
    for (const r of this.rockets) r.update(this);
    for (const b of this.enemyBullets) b.update(this);
    for (const e of this.enemies) e.update(this);
    for (const a of this.asteroids) a.update(this);
    for (const p of this.powerups) p.update(this);
    for (const fx of this.effects) fx.update(this);

    // --- collisions ---
    this.handleCollisions();

    // --- slow motion timeout ---
    if (this.slowMoEnd && this.time > this.slowMoEnd) {
      this.speedMul = 1;
      this.slowMoEnd = 0;
    }

    // --- cleanup ---
    this.bullets = this.bullets.filter((s) => !s.dead);
    this.rockets = this.rockets.filter((s) => !s.dead);
    this.enemyBullets = this.enemyBullets.filter((s) => !s.dead);
    this.enemies = this.enemies.filter((s) => !s.dead);
    this.asteroids = this.asteroids.filter((s) => !s.dead);
    this.powerups = this.powerups.filter((s) => !s.dead);
    this.effects = this.effects.filter((s) => !s.dead);

    // --- game over check: all players dead with no lives left ---
    if (this.players().every((p) => !p.alive && p.lives <= 0)) {
      this.over = true;
      this.overAlpha = 0;
      this.app.saveHigh(this.score);
      this.pushToasts(bumpStats({ bestScore: this.score }));
    }
  }

  handleTouch() {
    if (!input.isTouch) return;
    const p = this.player1;
    if (!p.alive) return;
    const btn = this.rocketBtn();
    const pbtn = this.pauseBtn();
    // multi-touch: any new finger on the rocket button fires; the pause button
    // pauses; the first other finger owns the movement drag
    for (const [id, pt] of input.pointers) {
      if (!pt.justDown) continue;
      if (Math.hypot(pt.x - btn.x, pt.y - btn.y) <= btn.r) {
        p.fireRocket(this);
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
    // player bullets & rockets vs enemies/boss — with juicy hit feedback
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.dying) continue;
      for (const [group, dmg, isRocket] of [[this.bullets, 1, false], [this.rockets, 4, true]]) {
        for (const b of group) {
          if (b.dead || !overlap(enemy, b, enemy.isBoss ? 0.78 : 0.9)) continue;
          b.dead = true;
          this.spawnSparks(b.x, b.y, isRocket ? 16 : 8);
          if (enemy.isBoss && enemy.shieldUntil > this.time) continue; // shield phase absorbs the hit
          const killed = enemy.takeDamage(dmg);
          if (!killed) {
            // survived the hit: flash + tiny kick, no explosion
            this.shake = Math.min(12, this.shake + (isRocket ? 2 : 0.7));
            audio.play('explosion', isRocket ? 0.3 : 0.12);
            continue;
          }
          this.addKill(enemy.points + (isRocket ? 10 : 0));
          this.pushToasts(bumpStats({ kills: 1 }));
          if (enemy.isBoss) {
            enemy.dead = true;
            this.explode(enemy.x, enemy.y, true, 2.5);
            this.levelUp(enemy.x, enemy.y);
          } else {
            if (enemy.type === 'tank' && rand(0, 1) < 0.4) this.dropPowerup(enemy.x, enemy.y);
            if (rand(0, 1) < 0.45) {
              // disabled, not destroyed: sparks, smoke, tumbles off-screen
              enemy.startDying();
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

    // bullets vs asteroids (asteroid breaks apart)
    for (const a of this.asteroids) {
      if (a.dead) continue;
      for (const b of this.bullets) {
        if (b.dead || !overlap(a, b, 0.8)) continue;
        b.dead = true;
        a.dead = true;
        this.explode(a.x, a.y);
        this.addKill(5);
        this.asteroids.push(...a.breakApart());
        break;
      }
    }

    // rockets vs asteroids (no break apart)
    for (const a of this.asteroids) {
      if (a.dead) continue;
      for (const r of this.rockets) {
        if (r.dead || !overlap(a, r, 0.8)) continue;
        r.dead = true;
        a.dead = true;
        this.explode(a.x, a.y);
        this.addKill(10);
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
            e.dead = true;
            this.explode(e.x, e.y, true, 2.5);
            this.levelUp(e.x, e.y);
          }
        } else {
          // chain kill — the wreck takes a live fighter with it (score counts!)
          w.dead = true;
          e.dead = true;
          this.explode(e.x, e.y, true, 1.2);
          this.addKill(e.points);
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
        if (!b.dead && overlap(p, b, 0.8)) { b.dead = true; this.killPlayer(p); break; }
      }
      if (!p.alive) continue;
      for (const e of this.enemies) {
        if (e.dead || (e.warpUntil && this.time < e.warpUntil) || !overlap(p, e, 0.8)) continue;
        // falling wrecks are deadly too; the boss survives ramming (only the player dies)
        if (!e.isBoss) { e.dead = true; this.explode(e.x, e.y, false); }
        this.killPlayer(p);
        break;
      }
      if (!p.alive) continue;
      for (const a of this.asteroids) {
        if (!a.dead && overlap(p, a, 0.75)) { a.dead = true; this.killPlayer(p); break; }
      }
      if (!p.alive) continue;

      for (const pu of this.powerups) {
        if (pu.dead || !overlap(p, pu, 0.9)) continue;
        pu.dead = true;
        this.runPowerups += 1;
        this.pushToasts(bumpStats({ maxRunPowerups: this.runPowerups }));
        if (pu.type === 'shooting') {
          p.powerUp(this);
          audio.play('powerup', 0.6);
        } else if (pu.type === 'slow_motion') {
          this.speedMul = 0.5;
          this.slowMoEnd = this.time + 10000;
          audio.play('powerup', 0.6);
        } else if (pu.type === 'kill_all') {
          for (const e of this.enemies) {
            if (!e.isBoss && !e.dead && !e.dying) { e.dead = true; this.explode(e.x, e.y, false); }
          }
          for (const a of this.asteroids) {
            if (!a.dead) { a.dead = true; this.explode(a.x, a.y, false); }
          }
          audio.play('explosion', 0.6);
        } else if (pu.type === 'rocket') {
          p.rockets += 1;
          audio.play('powerup', 0.6);
        } else if (pu.type === 'spread') {
          p.spread += 1;
          audio.play('powerup', 0.6);
        } else if (pu.type === 'shield') {
          p.shield = true;
          audio.play('powerup', 0.6);
        }
      }
    }
  }

  updateGameOver() {
    if (this.overAlpha < 0.5) {
      this.overAlpha = Math.min(0.5, this.overAlpha + 0.02 * this.k); // fade like game.py
      return;
    }
    if (this.online) return; // host wrapper owns the online game-over flow
    if (!this.overMenu) this.overMenu = this.buildOverMenu();

    // one-time leaderboard submission
    if (this.lb.status === 'idle') {
      if (this.score <= 0) {
        this.lb.status = 'skipped';
      } else {
        this.lb.status = 'asking';
        askName().then((name) => {
          if (!name) { this.lb = { status: 'skipped' }; return; }
          this.lb = { status: 'sending' };
          const mode = this.daily ? 'daily' : this.coop ? 'coop' : 'single';
          submitScore(name, this.score, mode).then((res) => {
            this.lb = res && res.ok
              ? { status: 'done', rank: res.rank, top: res.top, name }
              : { status: 'offline' };
          });
        });
      }
    }
    if (this.lb.status === 'asking') return; // overlay is open, don't react to Enter/clicks

    const action = this.overMenu.update();
    if (action === 'retry') this.app.setState(new GameState(this.app, this.coop, { daily: this.daily }));
    else if (action === 'main_menu') this.app.goMenu();
  }

  draw(g) {
    const { images } = this.app;

    g.save();
    if (this.shake > 0.3 && !this.paused && !this.over) {
      g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.drawBackdrop(g);

    for (const pu of this.powerups) pu.draw(g, this);
    for (const a of this.asteroids) a.draw(g);
    for (const e of this.enemies) e.draw(g, this);
    for (const b of this.bullets) b.draw(g);
    for (const b of this.enemyBullets) b.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    for (const r of this.rockets) r.draw(g);
    for (const p of this.players()) p.draw(g, this);
    g.restore();

    // slow-motion tint
    if (this.speedMul < 1) {
      g.fillStyle = 'rgba(80,150,255,0.08)';
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
        g.globalAlpha = alpha * 0.8;
        drawText(g, 'WAVE CLEARED', W / 2, H / 2 - 180 + size * 0.75, 18, 'rgb(200,200,200)');
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
    if (this.daily) drawText(g, `DAILY · ${this.mod.name}`, W - 10, 52, 15, 'rgb(255,210,60)', 'right');

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
    // lives + rockets per player
    const p1 = this.player1;
    drawText(g, 'P1', 10, 58, 22, '#fff', 'left');
    drawText(g, '♥'.repeat(Math.max(0, p1.lives)), 48, 58, 22, 'rgb(255,80,90)', 'left');
    drawText(g, `Rockets: ${p1.rockets}`, 128, 58, 22, '#fff', 'left');
    if (this.player2) {
      const p2 = this.player2;
      drawText(g, 'P2', 10, 90, 22, '#fff', 'left');
      drawText(g, '♥'.repeat(Math.max(0, p2.lives)), 48, 90, 22, 'rgb(255,80,90)', 'left');
      drawText(g, `Rockets: ${p2.rockets}`, 128, 90, 22, '#fff', 'left');
    }
    if (this.speedMul < 1) drawText(g, 'SLOW-MO', W / 2, 24, 24, 'rgb(120,200,255)');

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
        drawText(g, 'GAME OVER', W / 2, H / 2 - 40, 56, 'rgb(255,0,0)');
        drawText(g, `Score: ${this.score}`, W / 2, H / 2 + 20, 30);
      }
      if (this.overMenu) {
        drawText(g, 'GAME OVER', W / 2, H / 2 - 100, 56, 'rgb(255,0,0)');
        drawText(g, `Score: ${this.score}`, W / 2, H / 2 - 40, 30);
        drawText(g, `Best: ${this.app.highScore}`, W / 2, H / 2, 24, 'rgb(180,180,180)');
        if (this.daily) {
          const left = dailyAttemptsLeft();
          drawText(g, left > 0 ? `DAILY ATTEMPTS LEFT: ${left}` : 'NO DAILY ATTEMPTS LEFT TODAY',
            W / 2, H / 2 + 32, 17, left > 0 ? 'rgb(255,210,60)' : 'rgb(255,110,110)');
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
      }
    }
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
