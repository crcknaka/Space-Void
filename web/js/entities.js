// Game entities — port of game_classes.py with web polish:
// delta-timed movement (world.k = dt / 16.67ms), glows, ship tilt.
// Speed constants are px per 60Hz step — same numbers as the pygame version.
import { W, H, rand, randInt, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { glowBullet, glowEnemyBullet, glowPowerup, glowEngine, glowExplosion, drawGlow } from './fx.js';

/* ---------------------------------- stars ---------------------------------- */

export class Star {
  constructor(x, y, speed, size, opacity) {
    this.x = x; this.y = y;
    this.speed = speed;
    this.size = size;
    this.opacity = opacity / 255;
  }
  update(k = 1) {
    this.x -= this.speed * k;
    if (this.x < 0) {
      this.x = W;
      this.y = randInt(0, H);
    }
  }
  draw(g) {
    g.globalAlpha = this.opacity;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
}

export class StaticStar {
  constructor(x, y, size, opacity) {
    this.x = x; this.y = y;
    this.size = size;
    this.opacity = opacity;
    this.maxOpacity = opacity;
    this.fading = Math.random() < 0.5;
    this.fadeSpeed = rand(0.1, 0.5);
    this.color = `rgb(${randInt(0, 255)},${randInt(0, 255)},255)`; // white..blue tint like menu.py
  }
  update(k = 1) {
    const d = this.fadeSpeed * k;
    if (this.fading) {
      this.opacity -= d;
      if (this.opacity <= 0) { this.opacity = 0; this.fading = false; }
    } else {
      this.opacity += d;
      if (this.opacity >= this.maxOpacity) { this.opacity = this.maxOpacity; this.fading = true; }
    }
  }
  draw(g) {
    g.globalAlpha = this.opacity / 255;
    g.fillStyle = this.color;
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
}

export function makeStarLayers() {
  const layers = [];
  for (let i = 0; i < 3; i++) {
    const layer = [];
    for (let n = 0; n < 50; n++) {
      layer.push(new Star(randInt(0, W), randInt(0, H), rand(0.1 * (i + 1), 1.1 * (i + 1)), randInt(1, 2), randInt(30, 100)));
    }
    layers.push(layer);
  }
  return layers;
}

/* --------------------------------- bullets --------------------------------- */

export class Bullet {
  constructor(edgeX, y, img, speedx, angle = 0) {
    this.img = img;
    this.w = 10; this.h = 5;
    this.x = speedx > 0 ? edgeX + this.w / 2 : edgeX - this.w / 2;
    this.y = y;
    this.vx = speedx;
    this.vy = speedx * Math.tan((angle * Math.PI) / 180); // spread, like game_classes.py
    this.dead = false;
    this.flip = speedx < 0;
  }
  update(world) {
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    if (this.x - this.w / 2 > W || this.x + this.w / 2 < 0 || this.y < -20 || this.y > H + 20) this.dead = true;
  }
  draw(g) {
    drawGlow(g, glowBullet, this.x, this.y);
    if (this.flip) {
      g.save(); g.translate(this.x, this.y); g.scale(-1, 1);
      g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
      g.restore();
    } else {
      g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    }
  }
}

export class EnemyBullet {
  constructor(x, y, img, vx = -8, vy = 0) {
    this.img = img;
    this.w = 10; this.h = 5;
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.dead = false;
  }
  update(world) {
    this.x += this.vx * world.speedMul * world.k; // affected by slow-motion
    this.y += this.vy * world.speedMul * world.k;
    if (this.x < -20 || this.x > W + 20 || this.y < -20 || this.y > H + 20) this.dead = true;
  }
  draw(g) {
    drawGlow(g, glowEnemyBullet, this.x, this.y);
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
  }
}

/* --------------------------------- rockets --------------------------------- */

export class RocketTrailParticle {
  constructor(x, y, time) {
    this.size = randInt(2, 4);
    this.x = x; this.y = y;
    this.vx = rand(-1, 1); this.vy = rand(-1, 1);
    this.spawn = time;
    this.life = 500;
    this.alpha = 0.6;
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    this.alpha = Math.max(0, (150 - age * (150 / this.life)) / 255);
  }
  draw(g) {
    g.globalAlpha = this.alpha;
    g.fillStyle = 'rgb(255,165,0)';
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
}

export class Rocket {
  constructor(x, y, img) {
    this.img = img;
    this.w = 20; this.h = 10;
    this.x = x; this.y = y;
    this.speed = 8;
    this.rotSpeed = 2;   // degrees per 60Hz step
    this.angle = 0;      // 0 = pointing right
    this.lastEmit = 0;
    this.dead = false;
  }
  update(world) {
    // steer toward nearest target (enemy / boss / asteroid)
    let target = null, minD = Infinity;
    for (const t of world.rocketTargets()) {
      const d = Math.hypot(this.x - t.x, this.y - t.y);
      if (d < minD) { minD = d; target = t; }
    }
    if (target) {
      const targetAngle = (Math.atan2(target.y - this.y, target.x - this.x) * 180) / Math.PI;
      let diff = (targetAngle - this.angle) % 360;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      this.angle += clamp(diff, -this.rotSpeed * world.k, this.rotSpeed * world.k);
    }
    const rad = (this.angle * Math.PI) / 180;
    this.x += this.speed * Math.cos(rad) * world.k;
    this.y += this.speed * Math.sin(rad) * world.k;
    if (world.time - this.lastEmit > 14) {
      world.effects.push(new RocketTrailParticle(this.x, this.y, world.time));
      this.lastEmit = world.time;
    }
    if (this.x < -30 || this.x > W + 30 || this.y < -30 || this.y > H + 30) this.dead = true;
  }
  draw(g) {
    drawGlow(g, glowEngine, this.x, this.y, 0.8);
    g.save();
    g.translate(this.x, this.y);
    g.rotate((this.angle * Math.PI) / 180);
    g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
    g.restore();
  }
}

/* --------------------------------- player ---------------------------------- */

export class Player {
  constructor(images, opts) {
    this.img = opts.img;
    this.thrusters = opts.thrusters;
    this.controls = opts.controls;
    this.facingLeft = !!opts.facingLeft;
    this.shipFlipped = !!opts.shipFlipped;
    this.autoShoot = opts.autoShoot !== false;
    this.useRockets = opts.useRockets !== false;
    this.bulletImg = images.bullet;
    this.rocketImg = images.rocket;

    this.w = 50; this.h = 30;
    this.x = 100; this.y = H / 2;
    this.alive = true;

    this.defaultSpeed = 5;
    this.fastSpeed = 8;
    this.shootDelay = 500;
    this.lastShot = 0;
    this.poweredUp = false;
    this.powerEnd = 0;
    this.spread = 1;         // bullets per volley (spread powerup)
    this.rockets = 3;
    this.rocketDelay = 700;
    this.lastRocket = 0;
    this.thrFrame = 0;
    this.thrLast = 0;
    this.tilt = 0;           // visual tilt when moving vertically
  }

  update(world) {
    if (!this.alive) return;
    const k = input.keys;
    const c = this.controls;
    const fast = k.has(c.speed) || (c.speedAlt && k.has(c.speedAlt));
    const sp = (fast ? this.fastSpeed : this.defaultSpeed) * world.k;
    let dy = 0;
    if (k.has(c.up)) { this.y -= sp; dy = -1; }
    if (k.has(c.down)) { this.y += sp; dy = 1; }
    if (k.has(c.left)) this.x -= sp;
    if (k.has(c.right)) this.x += sp;

    this.x = clamp(this.x, this.w / 2, W - this.w / 2);
    this.y = clamp(this.y, this.h / 2, H - this.h / 2);

    // smooth visual tilt toward movement direction
    const targetTilt = dy * 0.14 * (this.facingLeft ? -1 : 1);
    this.tilt += (targetTilt - this.tilt) * Math.min(1, 0.18 * world.k);

    if (this.autoShoot) this.shoot(world);
    if (this.useRockets && (k.has(c.rocket) || (c.rocketAlt && k.has(c.rocketAlt)))) this.fireRocket(world);

    if (world.time - this.thrLast > 50) {
      this.thrLast = world.time;
      this.thrFrame = (this.thrFrame + 1) % this.thrusters.length;
    }
    if (this.poweredUp && world.time > this.powerEnd) {
      this.shootDelay = 500;
      this.poweredUp = false;
    }
  }

  shoot(world) {
    if (world.time - this.lastShot <= this.shootDelay) return;
    const vx = this.facingLeft ? -10 : 10;
    const edgeX = this.facingLeft ? this.x - this.w / 2 : this.x + this.w / 2;
    const spreadAngle = 10;
    const start = -((this.spread - 1) * spreadAngle) / 2;
    for (let i = 0; i < this.spread; i++) {
      world.bullets.push(new Bullet(edgeX, this.y, this.bulletImg, vx, start + i * spreadAngle));
    }
    this.lastShot = world.time;
    audio.play('gun', 0.22);
  }

  fireRocket(world) {
    if (this.rockets <= 0 || world.time - this.lastRocket <= this.rocketDelay) return;
    world.rockets.push(new Rocket(this.x, this.y, this.rocketImg));
    this.lastRocket = world.time;
    this.rockets--;
    audio.play('rocket', 0.5);
  }

  powerUp(world) {
    this.shootDelay = 200;
    this.poweredUp = true;
    this.powerEnd = world.time + 5000;
  }

  draw(g) {
    if (!this.alive) return;
    const thr = this.thrusters[this.thrFrame];
    const side = this.facingLeft ? 1 : -1;

    g.save();
    g.translate(this.x, this.y);
    g.rotate(this.tilt);

    // engine glow + thruster behind the ship
    drawGlow(g, glowEngine, side * (this.w / 2 + 10), 0);
    g.save();
    g.translate(side * (this.w / 2 + 12), 0);
    if (this.facingLeft) g.scale(-1, 1);
    g.drawImage(thr, -32, -32, 64, 64);
    g.restore();

    if (this.shipFlipped) g.scale(-1, 1);
    g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
    g.restore();
  }
}

/* --------------------------------- enemies --------------------------------- */

export class Enemy {
  constructor(images, level, moveRandomly, time) {
    this.img = images.enemy_ship;
    this.thrusters = images.thrusters.enemy;
    this.bulletImg = images.enemy_bullet;
    this.w = 50; this.h = 30;
    this.x = W + randInt(50, 100);
    this.y = randInt(this.h / 2, H - this.h / 2);
    this.vx = randInt(-3, -1) - (level - 1);      // faster with level
    this.vy = moveRandomly ? randInt(-2, 2) : 0;
    this.shootDelay = Math.max(300, randInt(1500, 3000) - (level - 1) * 100);
    this.lastShot = time;
    this.thrFrame = 0;
    this.thrLast = time;
    this.dead = false;
    this.isBoss = false;
  }
  update(world) {
    this.x += this.vx * world.speedMul * world.k;
    this.y += this.vy * world.speedMul * world.k;
    if (this.y - this.h / 2 < 0 || this.y + this.h / 2 > H) this.vy *= -1;
    if (this.x + this.w / 2 < 0) { this.dead = true; return; }

    if (world.time - this.lastShot > this.shootDelay) {
      world.enemyBullets.push(new EnemyBullet(this.x - this.w / 2, this.y, this.bulletImg));
      this.lastShot = world.time;
    }
    if (world.time - this.thrLast > 50) {
      this.thrLast = world.time;
      this.thrFrame = (this.thrFrame + 1) % this.thrusters.length;
    }
  }
  draw(g) {
    // flipped thruster on the right side (exhaust), like Enemy.update_thruster
    const thr = this.thrusters[this.thrFrame];
    drawGlow(g, glowEngine, this.x + this.w / 2 + 10, this.y);
    g.save();
    g.translate(this.x + this.w / 2 + 12, this.y);
    g.scale(-1, 1);
    g.drawImage(thr, -32, -32, 64, 64);
    g.restore();
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
  }
}

export class Boss {
  constructor(images, level, time) {
    this.img = images.boss;
    this.bulletImg = images.enemy_bullet;
    this.w = 150; this.h = 150;
    this.x = W + this.w / 2;
    this.y = H / 2;
    this.vx = -1 - (level - 1) * 0.5;
    this.shootDelay = Math.max(500, 1000 - (level - 1) * 100);
    this.lastShot = time;
    this.health = 5 + (level - 1) * 5;
    this.maxHealth = this.health;
    this.dead = false;
    this.isBoss = true;
  }
  update(world) {
    this.x += this.vx * world.speedMul * world.k;
    if (this.x + this.w / 2 <= W - 150) this.vx = 0; // park at position, like Boss.update

    if (world.time - this.lastShot > this.shootDelay) {
      for (const a of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
        const rad = (a * Math.PI) / 180;
        world.enemyBullets.push(new EnemyBullet(this.x, this.y, this.bulletImg, -8 * Math.cos(rad), -8 * Math.sin(rad)));
      }
      this.lastShot = world.time;
    }
  }
  draw(g) {
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    // health bar (web improvement so boss progress is visible)
    const bw = 120, bh = 8;
    const px = this.x - bw / 2, py = this.y - this.h / 2 - 14;
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(px, py, bw, bh);
    g.fillStyle = '#f33';
    g.fillRect(px, py, (bw * Math.max(0, this.health)) / this.maxHealth, bh);
  }
}

/* -------------------------------- asteroids -------------------------------- */

export class Asteroid {
  constructor(img, size) {
    this.img = img;
    this.size = size;
    this.angle = 0;
    if (size === 'large') {
      this.rotSpeed = rand(0.5, 1);
      const s = randInt(80, 150); this.w = s; this.h = s;
      this.vx = rand(1, 2); this.vy = rand(-1, 1);
    } else if (size === 'medium') {
      this.rotSpeed = rand(1, 2);
      const s = randInt(40, 80); this.w = s; this.h = s;
      this.vx = rand(2, 4); this.vy = rand(-2, 2);
    } else {
      this.rotSpeed = rand(2, 3);
      const s = randInt(20, 40); this.w = s; this.h = s;
      this.vx = rand(4, 6); this.vy = rand(-3, 3);
    }
    this.x = W + randInt(5, 10) + this.w / 2;
    this.y = randInt(this.h / 2, H - this.h / 2);
    this.dead = false;
  }
  update(world) {
    this.angle += this.rotSpeed * world.speedMul * world.k * 0.33; // pygame rotated every 50ms tick
    this.x -= this.vx * world.speedMul * world.k;
    this.y += this.vy * world.speedMul * world.k;
    if (this.x + this.w / 2 < 0 || this.y - this.h / 2 > H || this.y + this.h / 2 < 0) this.dead = true;
  }
  breakApart() {
    const next = { large: 'medium', medium: 'small', small: null }[this.size];
    if (!next) return [];
    const count = this.size === 'medium' ? randInt(2, 3) : 2;
    const pieces = [];
    for (let i = 0; i < count; i++) {
      const a = new Asteroid(this.img, next);
      a.x = this.x; a.y = this.y;
      a.vx = rand(-3, 3);
      a.vy = rand(-3, 3);
      pieces.push(a);
    }
    return pieces;
  }
  draw(g) {
    g.save();
    g.translate(this.x, this.y);
    g.rotate((this.angle * Math.PI) / 180);
    g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
    g.restore();
  }
}

/* -------------------------------- power-ups -------------------------------- */

export const POWERUP_TYPES = ['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread'];
export const POWERUP_IMG = {
  shooting: 'powerup',
  slow_motion: 'slow_motion_powerup',
  kill_all: 'kill_all_powerup',
  rocket: 'rocket_powerup',
  spread: 'spread_powerup',
};

export class PowerUp {
  constructor(img, type) {
    this.img = img;
    this.type = type;
    this.w = 60; this.h = 30;
    this.x = W + randInt(50, 100) + this.w / 2;
    this.baseY = randInt(60, H - 60);
    this.y = this.baseY;
    this.vx = -3;
    this.phase = rand(0, Math.PI * 2);
    this.dead = false;
  }
  update(world) {
    this.x += this.vx * world.k; // not affected by slow-motion, like PowerUp.update
    this.y = this.baseY + Math.sin(world.time / 300 + this.phase) * 6; // gentle bobbing
    if (this.x + this.w / 2 < 0) this.dead = true;
  }
  draw(g, world) {
    const pulse = 0.85 + 0.15 * Math.sin(world.time / 200 + this.phase);
    drawGlow(g, glowPowerup, this.x, this.y, pulse);
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
  }
}

/* -------------------------------- explosion -------------------------------- */

export class Explosion {
  constructor(x, y, sheet, time, scale = 1) {
    this.sheet = sheet;
    this.frames = 5;
    this.fw = sheet.width / 5;
    this.fh = sheet.height;
    this.x = x; this.y = y;
    this.spawn = time;
    this.frameRate = 50;
    this.scale = scale;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn >= this.frames * this.frameRate) this.dead = true;
  }
  draw(g, world) {
    const progress = (world.time - this.spawn) / (this.frames * this.frameRate);
    const idx = Math.min(this.frames - 1, Math.floor(progress * this.frames));
    drawGlow(g, glowExplosion, this.x, this.y, (0.6 + progress) * this.scale * (1 - progress * 0.7));
    const w = this.fw * this.scale, h = this.fh * this.scale;
    g.drawImage(this.sheet, idx * this.fw, 0, this.fw, this.fh, this.x - w / 2, this.y - h / 2, w, h);
  }
}
