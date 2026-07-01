// Single / Co-op game mode — port of game.py
import { W, H, STEP, randInt, overlap, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import {
  Player, Enemy, Boss, Asteroid, PowerUp, Explosion,
  makeStarLayers, POWERUP_TYPES, POWERUP_IMG,
} from './entities.js';

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  rocket: 'Space', speed: 'ShiftLeft',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  rocket: 'Enter', rocketAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
};

export class GameState {
  constructor(app, coop) {
    this.app = app;
    this.coop = coop;
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('background_music');

    this.time = 0;
    this.score = 0;
    this.level = 1;
    this.nextBossScore = 100;
    this.bossSpawned = false;
    this.paused = false;
    this.speedMul = 1;
    this.slowMoEnd = 0;

    this.bullets = [];
    this.rockets = [];
    this.enemyBullets = [];
    this.enemies = [];       // includes boss
    this.asteroids = [];
    this.powerups = [];
    this.effects = [];       // explosions + rocket trails
    this.starLayers = makeStarLayers();

    this.enemyInterval = 2000;
    this.asteroidInterval = 5000;
    this.powerupInterval = 10000;  // game.py set 1000ms but the comment said 10s — fixed
    this.enemyAcc = 0;
    this.asteroidAcc = 0;
    this.powerupAcc = 0;

    this.bgX = 0;
    this.k = 1;
    this.shake = 0;
    this.over = false;
    this.overAlpha = 0;
    this.overMenu = null;
    this.pauseMenu = null;

    this.player1 = new Player(images, {
      img: images.player1_ship,
      thrusters: images.thrusters.player1,
      controls: P1_CONTROLS,
    });
    this.player1.x = 100;
    this.player1.y = this.coop ? H / 2 : H / 2;

    this.player2 = null;
    if (this.coop) {
      this.player2 = new Player(images, {
        img: images.player2_ship,
        thrusters: images.thrusters.player2,
        controls: P2_CONTROLS,
      });
      this.player2.x = 100;
      this.player2.y = H / 3;
    }

    // touch state (mobile: drag to move, on-screen rocket button)
    this.drag = null;
    this.rocketBtn = { x: W - 70, y: H - 80, r: 44 };

    this.rocketTargets = () => this.enemies.concat(this.asteroids);
  }

  players() {
    return this.player2 ? [this.player1, this.player2] : [this.player1];
  }

  explode(x, y, sound = true, scale = 1) {
    this.effects.push(new Explosion(x, y, this.app.images.explosion_spritesheet, this.time, scale));
    this.shake = Math.min(12, this.shake + 3 * scale);
    if (sound) audio.play('explosion', 0.5);
  }

  killPlayer(p) {
    this.explode(p.x, p.y, true, 1.6);
    p.alive = false;
  }

  levelUp() {
    this.score += 50;
    this.bossSpawned = false;
    this.level += 1;
    this.nextBossScore += this.level * 100;
    this.enemyInterval = Math.max(500, this.enemyInterval - 200);
    this.asteroidInterval = Math.max(2000, this.asteroidInterval - 500);
    for (const p of this.players()) p.rockets += 3;
  }

  update(dt) {
    this.k = dt / STEP;
    // --- pause handling ---
    if (input.pressed.has('KeyP') || input.pressed.has('Escape')) {
      if (!this.over) {
        this.paused = !this.paused;
        audio.play('click', 0.5);
        if (this.paused) {
          this.pauseMenu = new ButtonGroup([
            new Button('RESUME', W / 2, H / 2 - 40, 200, 60, 'rgb(0,255,0)', 'resume'),
            new Button('MAIN MENU', W / 2, H / 2 + 50, 200, 60, 'rgb(255,0,0)', 'main_menu'),
          ]);
        }
      }
    }

    if (this.paused) {
      const action = this.pauseMenu.update();
      if (action === 'resume') this.paused = false;
      else if (action === 'main_menu') this.app.goMenu();
      return;
    }

    if (this.over) {
      this.updateGameOver();
      return;
    }

    this.time += dt;

    // --- spawn timers (pygame USEREVENT timers) ---
    this.enemyAcc += dt;
    if (this.enemyAcc >= this.enemyInterval) {
      this.enemyAcc = 0;
      const chance = Math.min(10 + (this.level - 1) * 5, 100);
      const moveRandomly = randInt(1, 100) <= chance;
      this.enemies.push(new Enemy(this.app.images, this.level, moveRandomly, this.time));
    }
    this.powerupAcc += dt;
    if (this.powerupAcc >= this.powerupInterval) {
      this.powerupAcc = 0;
      const type = POWERUP_TYPES[randInt(0, POWERUP_TYPES.length - 1)];
      this.powerups.push(new PowerUp(this.app.images[POWERUP_IMG[type]], type));
    }
    this.asteroidAcc += dt;
    if (this.asteroidAcc >= this.asteroidInterval) {
      this.asteroidAcc = 0;
      this.asteroids.push(new Asteroid(this.app.images.asteroid, 'large'));
    }

    // --- boss spawn ---
    if (this.score >= this.nextBossScore && !this.bossSpawned) {
      this.enemies.push(new Boss(this.app.images, this.level, this.time));
      this.bossSpawned = true;
      for (const p of this.players()) p.rockets += 3;
    }

    // --- background scroll ---
    const bg = this.app.images.game_background;
    this.bgW = bg.width * (H / bg.height); // cover height, keep aspect
    this.bgX -= 0.1 * this.speedMul * this.k;
    if (this.bgX <= -this.bgW) this.bgX = 0;
    this.shake *= Math.pow(0.88, this.k);

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
    for (const layer of this.starLayers) for (const s of layer) s.update(this.k);

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

    // --- game over check ---
    if (this.players().every((p) => !p.alive)) {
      this.over = true;
      this.overAlpha = 0;
      this.app.saveHigh(this.score);
    }
  }

  handleTouch() {
    if (!input.isTouch) return;
    const p = this.player1;
    if (!p.alive) return;
    const pt = input.pointer;
    if (pt.justDown) {
      const d = Math.hypot(pt.x - this.rocketBtn.x, pt.y - this.rocketBtn.y);
      if (d <= this.rocketBtn.r) {
        p.fireRocket(this);
        return;
      }
      this.drag = { px: pt.x, py: pt.y, ox: p.x, oy: p.y };
    }
    if (pt.down && this.drag) {
      p.x = clamp(this.drag.ox + (pt.x - this.drag.px) * 1.25, p.w / 2, W - p.w / 2);
      p.y = clamp(this.drag.oy + (pt.y - this.drag.py) * 1.25, p.h / 2, H - p.h / 2);
    } else {
      this.drag = null;
    }
  }

  handleCollisions() {
    // player bullets & rockets vs enemies/boss
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      for (const [group, dmg, pts] of [[this.bullets, 1, 10], [this.rockets, 4, 20]]) {
        for (const b of group) {
          if (b.dead || !overlap(enemy, b, 0.9)) continue;
          b.dead = true;
          if (enemy.isBoss) {
            enemy.health -= dmg;
            if (enemy.health <= 0) {
              enemy.dead = true;
              this.explode(enemy.x, enemy.y, true, 2.5);
              this.levelUp();
            }
          } else {
            enemy.dead = true;
            this.explode(enemy.x, enemy.y);
            this.score += pts;
          }
          if (enemy.dead) break;
        }
        if (enemy.dead) break;
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
        this.score += 5;
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
        this.score += 10;
        break;
      }
    }

    // asteroids vs enemies (enemy dies, asteroid survives)
    for (const e of this.enemies) {
      if (e.dead || e.isBoss) continue;
      for (const a of this.asteroids) {
        if (a.dead || !overlap(e, a, 0.8)) continue;
        e.dead = true;
        this.explode(e.x, e.y);
        this.score += 10;
        break;
      }
    }

    // players vs enemy bullets / enemies / asteroids
    for (const p of this.players()) {
      if (!p.alive) continue;
      for (const b of this.enemyBullets) {
        if (!b.dead && overlap(p, b, 0.8)) { b.dead = true; this.killPlayer(p); break; }
      }
      if (!p.alive) continue;
      for (const e of this.enemies) {
        if (!e.dead && overlap(p, e, 0.8)) { e.dead = true; this.explode(e.x, e.y, false); this.killPlayer(p); break; }
      }
      if (!p.alive) continue;
      for (const a of this.asteroids) {
        if (!a.dead && overlap(p, a, 0.75)) { a.dead = true; this.killPlayer(p); break; }
      }
      if (!p.alive) continue;

      // power-ups
      for (const pu of this.powerups) {
        if (pu.dead || !overlap(p, pu, 0.9)) continue;
        pu.dead = true;
        if (pu.type === 'shooting') {
          p.powerUp(this);
          audio.play('powerup', 0.6);
        } else if (pu.type === 'slow_motion') {
          this.speedMul = 0.5;
          this.slowMoEnd = this.time + 10000;
          audio.play('powerup', 0.6);
        } else if (pu.type === 'kill_all') {
          for (const e of this.enemies) {
            if (!e.isBoss && !e.dead) { e.dead = true; this.explode(e.x, e.y, false); }
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
        }
      }
    }
  }

  updateGameOver() {
    if (this.overAlpha < 0.5) {
      this.overAlpha = Math.min(0.5, this.overAlpha + 0.02 * this.k); // fade like game.py
      return;
    }
    if (!this.overMenu) {
      this.overMenu = new ButtonGroup([
        new Button('RETRY', W / 2, H / 2 + 75, 200, 50, 'rgb(0,255,0)', 'retry'),
        new Button('MAIN MENU', W / 2, H / 2 + 145, 200, 50, 'rgb(255,0,0)', 'main_menu'),
      ]);
    }
    const action = this.overMenu.update();
    if (action === 'retry') this.app.setState(new GameState(this.app, this.coop));
    else if (action === 'main_menu') this.app.goMenu();
  }

  draw(g) {
    const { images } = this.app;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);

    g.save();
    if (this.shake > 0.3 && !this.paused && !this.over) {
      g.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // scrolling background (aspect-preserving cover)
    const bg = images.game_background;
    const bgW = this.bgW || bg.width * (H / bg.height);
    g.drawImage(bg, this.bgX, 0, bgW, H);
    g.drawImage(bg, this.bgX + bgW, 0, bgW, H);

    for (const layer of this.starLayers) for (const s of layer) s.draw(g);

    for (const pu of this.powerups) pu.draw(g, this);
    for (const a of this.asteroids) a.draw(g);
    for (const e of this.enemies) e.draw(g);
    for (const b of this.bullets) b.draw(g);
    for (const b of this.enemyBullets) b.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    for (const r of this.rockets) r.draw(g);
    for (const p of this.players()) p.draw(g);
    g.restore();

    // slow-motion tint
    if (this.speedMul < 1) {
      g.fillStyle = 'rgba(80,150,255,0.08)';
      g.fillRect(0, 0, W, H);
    }

    // HUD
    drawText(g, `Score: ${this.score}`, 10, 24, 26, '#fff', 'left');
    drawText(g, `Level: ${this.level}`, W - 10, 24, 26, '#fff', 'right');
    drawText(g, `P1 Rockets: ${this.player1.rockets}`, 10, 58, 26, '#fff', 'left');
    if (this.player2) drawText(g, `P2 Rockets: ${this.player2.rockets}`, 10, 92, 26, '#fff', 'left');
    if (this.speedMul < 1) drawText(g, 'SLOW-MO', W / 2, 24, 24, 'rgb(120,200,255)');

    // touch rocket button
    if (input.isTouch && !this.over && !this.paused) {
      const b = this.rocketBtn;
      g.globalAlpha = 0.35;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.9;
      const img = images.rocket;
      g.drawImage(img, b.x - 20, b.y - 18, 40, 20);
      drawText(g, `${this.player1.rockets}`, b.x, b.y + 16, 22, '#000');
      g.globalAlpha = 1;
    }

    if (this.paused) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, 0, W, H);
      drawText(g, 'PAUSED', W / 2, H / 2 - 130, 52, 'rgb(255,60,60)');
      this.pauseMenu.draw(g);
    }

    if (this.over) {
      g.fillStyle = `rgba(0,0,0,${this.overAlpha})`;
      g.fillRect(0, 0, W, H);
      if (this.overMenu) {
        drawText(g, 'GAME OVER', W / 2, H / 2 - 100, 56, 'rgb(255,0,0)');
        drawText(g, `Score: ${this.score}`, W / 2, H / 2 - 40, 30);
        drawText(g, `Best: ${this.app.highScore}`, W / 2, H / 2, 24, 'rgb(180,180,180)');
        this.overMenu.draw(g);
      }
    }
  }
}
