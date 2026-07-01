// Game entities — port of game_classes.py with web polish:
// delta-timed movement (world.k = dt / 16.67ms), glows, ship tilt.
// Speed constants are px per 60Hz step — same numbers as the pygame version.
import { W, H, rand, randInt, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { glowBullet, glowEnemyBullet, glowPowerup, glowEngine, glowExplosion, drawGlow, tinted } from './fx.js';

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
    this.padIndex = opts.padIndex ?? null; // gamepad slot (0 = P1, 1 = P2)
  }

  pad() {
    return this.padIndex != null ? input.pads[this.padIndex] : null;
  }

  update(world) {
    if (!this.alive) return;
    const k = input.keys;
    const c = this.controls;
    const pad = this.pad();
    const fast = k.has(c.speed) || (c.speedAlt && k.has(c.speedAlt)) || (pad && pad.boost);
    const sp = (fast ? this.fastSpeed : this.defaultSpeed) * world.k;
    let dy = 0;
    if (k.has(c.up)) { this.y -= sp; dy = -1; }
    if (k.has(c.down)) { this.y += sp; dy = 1; }
    if (k.has(c.left)) this.x -= sp;
    if (k.has(c.right)) this.x += sp;
    if (pad) {
      this.x += pad.x * sp;
      this.y += pad.y * sp;
      if (Math.abs(pad.y) > 0.3) dy = Math.sign(pad.y);
    }

    this.x = clamp(this.x, this.w / 2, W - this.w / 2);
    this.y = clamp(this.y, this.h / 2, H - this.h / 2);

    // smooth visual tilt toward movement direction
    const targetTilt = dy * 0.14 * (this.facingLeft ? -1 : 1);
    this.tilt += (targetTilt - this.tilt) * Math.min(1, 0.18 * world.k);

    if (this.autoShoot) this.shoot(world);
    if (this.useRockets && (k.has(c.rocket) || (c.rocketAlt && k.has(c.rocketAlt)) || (pad && pad.fire))) this.fireRocket(world);

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

/* -------------------------------- hit sparks -------------------------------- */

export class Spark {
  constructor(x, y, time, dir = Math.PI) {
    this.x = x; this.y = y;
    const a = dir + (Math.random() - 0.5) * 1.8;
    const sp = 2 + Math.random() * 4.5;
    this.vx = Math.cos(a) * sp;
    this.vy = Math.sin(a) * sp;
    this.life = 180 + Math.random() * 220;
    this.spawn = time;
    this.size = 1 + Math.random() * 2;
    this.hue = 25 + Math.random() * 35; // orange..yellow
    this.alpha = 1;
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    this.vx *= Math.pow(0.95, world.k);
    this.vy *= Math.pow(0.95, world.k);
    this.alpha = 1 - age / this.life;
  }
  draw(g) {
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = this.alpha;
    g.fillStyle = `hsl(${this.hue},100%,${60 + this.alpha * 25}%)`;
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }
}

/* -------------------------------- smoke trail -------------------------------- */

export class SmokeParticle {
  constructor(x, y, time) {
    this.x = x + rand(-4, 4);
    this.y = y + rand(-4, 4);
    this.vx = rand(-0.3, 0.4);
    this.vy = rand(-0.5, -0.1); // smoke drifts up slightly
    this.size = rand(3, 6);
    this.grow = rand(0.06, 0.14);
    this.life = rand(700, 1300);
    this.spawn = time;
    this.alpha = 0.35;
    this.shade = randInt(90, 150);
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    this.size += this.grow * world.k;
    this.alpha = 0.35 * (1 - age / this.life);
  }
  draw(g) {
    g.globalAlpha = this.alpha;
    g.fillStyle = `rgb(${this.shade},${this.shade},${this.shade})`;
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
}

/* --------------------------------- enemies --------------------------------- */

// type: basic | weaver (sine path) | hunter (homes on player) | tank (armored, drops loot)
const ENEMY_TINT = {
  weaver: 'rgba(0,230,190,0.35)',
  hunter: 'rgba(255,60,60,0.4)',
  tank: 'rgba(190,110,255,0.42)',
};
const ENEMY_POINTS = { basic: 10, weaver: 15, hunter: 20, tank: 30 };

export class Enemy {
  constructor(images, level, type, time, moveRandomly = false) {
    this.type = type;
    this.img = type === 'basic'
      ? images.enemy_ship
      : tinted(images.enemy_ship, ENEMY_TINT[type], `enemy_${type}`);
    this.thrusters = images.thrusters.enemy;
    this.bulletImg = images.enemy_bullet;
    this.w = type === 'tank' ? 66 : 50;
    this.h = type === 'tank' ? 40 : 30;
    this.x = W + randInt(50, 100);
    this.y = randInt(this.h / 2, H - this.h / 2);
    // armored enemies need multiple hits; armor grows with level
    if (type === 'tank') this.health = 3 + Math.floor(Math.max(0, level - 4) / 3);
    else if (type === 'hunter') this.health = level >= 5 ? 2 : 1;
    else if (type === 'weaver') this.health = level >= 6 ? 2 : 1;
    else this.health = 1;
    this.points = ENEMY_POINTS[type];
    this.flash = 0;
    this.dead = false;
    this.dying = false;      // sparking, smoking, falling off-screen
    this.isBoss = false;
    this.thrFrame = 0;
    this.thrLast = time;

    if (type === 'weaver') {
      this.vx = randInt(-3, -2) - (level - 1) * 0.7;
      this.vy = 0;
      this.amp = randInt(50, 130);
      this.freq = rand(0.002, 0.004);
      this.phase = rand(0, Math.PI * 2);
      this.baseY = clamp(this.y, this.amp + 20, H - this.amp - 20);
      this.shootDelay = Math.max(300, randInt(1300, 2600) - (level - 1) * 100);
    } else if (type === 'hunter') {
      this.vx = -(3.5 + (level - 1) * 0.4);
      this.vy = 0;
      this.shootDelay = Infinity; // rams instead of shooting
    } else if (type === 'tank') {
      this.vx = -(1 + (level - 1) * 0.3);
      this.vy = 0;
      this.shootDelay = Math.max(500, randInt(2000, 3500) - (level - 1) * 100);
    } else {
      this.vx = randInt(-3, -1) - (level - 1);      // faster with level
      this.vy = moveRandomly ? randInt(-2, 2) : 0;
      this.shootDelay = Math.max(300, randInt(1500, 3000) - (level - 1) * 100);
    }
    this.lastShot = time;
  }

  takeDamage(dmg) {
    this.health -= dmg;
    this.flash = 1;
    return this.health <= 0;
  }

  // Instead of exploding: spark, smoke and fall off-screen.
  // Each wreck falls its own way: tumbling, flat wobbling or burning dive.
  startDying() {
    this.dying = true;
    this.vx = this.vx * rand(0.15, 0.7) + rand(-0.6, 0.4);
    this.vyFall = rand(0.2, 1.8);
    this.gravity = rand(0.03, 0.11);
    const style = Math.random();
    if (style < 0.38) {
      // flat fall, hull rocking side to side
      this.spinMode = 'wobble';
      this.wobbleAmp = rand(14, 42);
      this.wobbleFreq = rand(0.003, 0.008);
      this.wobblePhase = rand(0, Math.PI * 2);
    } else {
      // tumbling — speed and direction vary a lot
      this.spinMode = 'spin';
      this.spin = rand(0.5, 5.5) * (Math.random() < 0.5 ? -1 : 1);
    }
    this.burning = Math.random() < 0.4; // some wrecks catch fire
    this.smokeRate = rand(45, 110);
    this.spinAngle = 0;
    this.lastSmoke = 0;
    this.flash = 1;
  }

  update(world) {
    if (this.dying) {
      const m = world.speedMul * world.k;
      this.x += this.vx * m;
      this.vyFall += this.gravity * world.k;   // gravity takes over
      this.y += this.vyFall * m;
      if (this.spinMode === 'spin') {
        this.spinAngle += this.spin * world.k;
      } else {
        this.spinAngle = Math.sin(world.time * this.wobbleFreq + this.wobblePhase) * this.wobbleAmp;
      }
      if (world.time - this.lastSmoke > this.smokeRate) {
        this.lastSmoke = world.time;
        world.effects.push(new SmokeParticle(this.x, this.y, world.time));
        const sparkChance = this.burning ? 0.8 : 0.3;
        if (Math.random() < sparkChance) world.effects.push(new Spark(this.x, this.y, world.time, -Math.PI / 2));
      }
      if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.09 * world.k);
      if (this.y - this.h > H + 60 || this.x + this.w < -60) this.dead = true;
      return;
    }

    const m = world.speedMul * world.k;
    this.x += this.vx * m;

    if (this.type === 'weaver') {
      this.y = this.baseY + Math.sin(world.time * this.freq + this.phase) * this.amp;
    } else if (this.type === 'hunter') {
      // home vertically on the nearest living player
      let target = null, minD = Infinity;
      for (const p of world.players()) {
        if (!p.alive) continue;
        const d = Math.abs(p.x - this.x) + Math.abs(p.y - this.y);
        if (d < minD) { minD = d; target = p; }
      }
      if (target) this.y += clamp((target.y - this.y) * 0.06, -3.2, 3.2) * m;
    } else {
      this.y += this.vy * m;
      if (this.y - this.h / 2 < 0 || this.y + this.h / 2 > H) this.vy *= -1;
    }

    if (this.x + this.w / 2 < 0) { this.dead = true; return; }

    if (world.time - this.lastShot > this.shootDelay) {
      world.enemyBullets.push(new EnemyBullet(this.x - this.w / 2, this.y, this.bulletImg));
      this.lastShot = world.time;
    }
    if (world.time - this.thrLast > 50) {
      this.thrLast = world.time;
      this.thrFrame = (this.thrFrame + 1) % this.thrusters.length;
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.09 * world.k);
  }

  draw(g, world) {
    if (this.dying) {
      // falling wreck: no engine flame, darkened hull
      if (this.burning) drawGlow(g, glowEngine, this.x, this.y, 1.6 + 0.4 * Math.sin((world?.time ?? 0) / 90));
      g.save();
      g.translate(this.x, this.y);
      g.rotate((this.spinAngle * Math.PI) / 180);
      g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
      g.globalAlpha = 0.45;
      g.drawImage(tinted(this.img, 'rgba(0,0,0,1)', `black_enemy_${this.type}`),
        -this.w / 2, -this.h / 2, this.w, this.h);
      g.globalAlpha = 1;
      if (this.flash > 0.05) {
        g.globalAlpha = this.flash * 0.85;
        g.drawImage(tinted(this.img, 'rgba(255,255,255,1)', `white_enemy_${this.type}`),
          -this.w / 2, -this.h / 2, this.w, this.h);
        g.globalAlpha = 1;
      }
      g.restore();
      return;
    }
    // flipped thruster on the right side (exhaust), like Enemy.update_thruster
    const thr = this.thrusters[this.thrFrame];
    drawGlow(g, glowEngine, this.x + this.w / 2 + 10, this.y);
    if (this.type === 'hunter') {
      // menacing pulsing red glow
      const pulse = 0.7 + 0.3 * Math.sin((world?.time ?? 0) / 120);
      drawGlow(g, glowEnemyBullet, this.x, this.y, 2.6 * pulse);
    }
    g.save();
    g.translate(this.x + this.w / 2 + 12, this.y);
    g.scale(-1, 1);
    g.drawImage(thr, -32, -32, 64, 64);
    g.restore();
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    if (this.flash > 0.05) {
      g.globalAlpha = this.flash * 0.85;
      g.drawImage(tinted(this.img, 'rgba(255,255,255,1)', `white_enemy_${this.type}`),
        this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
      g.globalAlpha = 1;
    }
  }
}

export class Boss {
  constructor(images, level, time) {
    this.img = images.boss;
    this.whiteImg = tinted(images.boss, 'rgba(255,255,255,1)', 'boss_white');
    this.bulletImg = images.enemy_bullet;
    this.w = 150; this.h = 150;
    this.x = W + this.w / 2;
    this.y = H / 2;
    this.vx = -1 - (level - 1) * 0.5;
    this.level = level;
    this.spawnTime = time;
    this.shootDelay = Math.max(800, 1700 - (level - 1) * 120); // gap between volleys
    this.lastShot = time;
    this.queue = [];       // scheduled shots of the current volley
    this.patIdx = 0;
    this.patterns = ['fan'];
    if (level >= 2) this.patterns.push('aimed');
    if (level >= 3) this.patterns.push('spiral');
    if (level >= 4) this.patterns.push('ring');
    this.health = 5 + (level - 1) * 5;
    this.maxHealth = this.health;
    this.flash = 0;
    this.points = 0;       // levelUp() awards the +50, like game.py
    this.dead = false;
    this.isBoss = true;
    this.parked = false;
  }

  takeDamage(dmg) {
    this.health -= dmg;
    this.flash = 1;
    return this.health <= 0;
  }

  buildVolley(world) {
    const pat = this.patterns[this.patIdx++ % this.patterns.length];
    const t0 = world.time;
    const shots = [];
    if (pat === 'fan') {
      for (const a of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
        shots.push({ t: t0, angle: 180 + a });
      }
    } else if (pat === 'aimed') {
      for (let i = 0; i < 3; i++) shots.push({ t: t0 + i * 150, angle: 'aim' });
    } else if (pat === 'spiral') {
      for (let i = 0; i < 16; i++) shots.push({ t: t0 + i * 90, angle: 115 + i * 17 });
    } else if (pat === 'ring') {
      for (let i = 0; i < 14; i++) shots.push({ t: t0, angle: (360 / 14) * i });
    }
    return shots;
  }

  fire(shot, world) {
    let deg = shot.angle;
    if (deg === 'aim') {
      let target = null, minD = Infinity;
      for (const p of world.players()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - this.x, p.y - this.y);
        if (d < minD) { minD = d; target = p; }
      }
      if (!target) return;
      deg = (Math.atan2(target.y - this.y, target.x - this.x) * 180) / Math.PI;
    }
    const rad = (deg * Math.PI) / 180;
    world.enemyBullets.push(new EnemyBullet(this.x, this.y, this.bulletImg, 8 * Math.cos(rad), 8 * Math.sin(rad)));
  }

  update(world) {
    this.x += this.vx * world.speedMul * world.k;
    if (!this.parked && this.x + this.w / 2 <= W - 150) {
      this.vx = 0;
      this.parked = true;
      this.floatStart = world.time; // sine starts at phase 0 → no teleport on park
    }
    if (this.parked) {
      // gentle vertical float so patterns sweep the field
      const amp = Math.min(180, H / 2 - this.h / 2 - 30);
      this.y = H / 2 + Math.sin((world.time - this.floatStart) / 1400) * amp;
    }

    if (!this.queue.length && world.time - this.lastShot > this.shootDelay) {
      this.lastShot = world.time;
      this.queue = this.buildVolley(world);
    }
    while (this.queue.length && this.queue[0].t <= world.time) {
      this.fire(this.queue.shift(), world);
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.07 * world.k);
  }

  draw(g) {
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    if (this.flash > 0.05) {
      g.globalAlpha = this.flash * 0.75;
      g.drawImage(this.whiteImg, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
      g.globalAlpha = 1;
    }
    // health bar
    const bw = 120, bh = 8;
    const px = this.x - bw / 2, py = this.y - this.h / 2 - 14;
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(px, py, bw, bh);
    g.fillStyle = this.flash > 0.05 ? '#fff' : '#f33';
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

/* -------------------------------- shockwave --------------------------------- */

export class Shockwave {
  constructor(x, y, time, maxR = 320) {
    this.x = x; this.y = y;
    this.spawn = time;
    this.maxR = maxR;
    this.life = 700;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const t = Math.min(1, (world.time - this.spawn) / this.life);
    const ease = 1 - Math.pow(1 - t, 2);
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 1 - t;
    g.lineWidth = 10 * (1 - t) + 1;
    g.strokeStyle = 'rgb(255,200,110)';
    g.beginPath();
    g.arc(this.x, this.y, ease * this.maxR, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
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
