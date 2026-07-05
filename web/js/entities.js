// Game entities — port of game_classes.py with web polish:
// delta-timed movement (world.k = dt / 16.67ms), glows, ship tilt.
// Speed constants are px per 60Hz step — same numbers as the pygame version.
import { W, H, rand, randInt, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { glowBullet, glowEnemyBullet, glowPowerup, glowEngine, glowExplosion, drawGlow, tinted } from './fx.js';

/* ---------------------------------- stars ---------------------------------- */
// Stars render from small pre-baked sprites (drawImage) instead of per-frame
// arc()+fill() — ~150 stars per scene, this is markedly cheaper.

const starSpriteCache = new Map();
function starSprite(color) {
  let c = starSpriteCache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(8, 8, 0, 8, 8, 8);
  grad.addColorStop(0, color);
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 16);
  starSpriteCache.set(color, c);
  return c;
}

export class Star {
  constructor(x, y, speed, size, opacity) {
    this.x = x; this.y = y;
    this.speed = speed;
    this.size = size;
    this.opacity = opacity / 255;
    this.sprite = starSprite('#fff');
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
    const d = this.size * 2.6;
    g.drawImage(this.sprite, this.x - d / 2, this.y - d / 2, d, d);
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
    this.sprite = starSprite(`rgb(${randInt(0, 255)},${randInt(0, 255)},255)`); // white..blue tint like menu.py
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
    const d = this.size * 2.6;
    g.drawImage(this.sprite, this.x - d / 2, this.y - d / 2, d, d);
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

// Cyan streak behind a boosting player ship
export class BoostParticle {
  constructor(x, y, time) {
    this.x = x; this.y = y + rand(-7, 7);
    this.vx = rand(-1.6, -0.8);
    this.vy = rand(-0.3, 0.3);
    this.size = rand(1.5, 3);
    this.life = 320;
    this.spawn = time;
    this.alpha = 0.8;
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    this.alpha = 0.8 * (1 - age / this.life);
  }
  draw(g) {
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = this.alpha;
    g.fillStyle = 'rgb(120,220,255)';
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
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
    this.lasers = 2;         // piercing beam charges (finite, like rockets)
    this.laserDelay = 1200;
    this.lastLaser = -9999;  // usable from the very first frame
    this.thrFrame = 0;
    this.thrLast = 0;
    this.tilt = 0;           // visual tilt when moving vertically
    this.padIndex = opts.padIndex ?? null; // gamepad slot (0 = P1, 1 = P2)
    this.lives = 3;
    this.shield = false;      // absorbs one hit
    this.invulnUntil = 0;     // respawn / shield-pop grace period
    this.respawnAt = 0;
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

    // boost trail
    this.boosting = fast;
    if (fast && world.effects && world.time - (this.lastTrail || 0) > 24) {
      this.lastTrail = world.time;
      const backX = this.facingLeft ? this.x + this.w / 2 + 8 : this.x - this.w / 2 - 8;
      world.effects.push(new BoostParticle(backX, this.y, world.time));
    }

    // smooth visual tilt toward movement direction
    const targetTilt = dy * 0.14 * (this.facingLeft ? -1 : 1);
    this.tilt += (targetTilt - this.tilt) * Math.min(1, 0.18 * world.k);

    if (this.autoShoot) this.shoot(world);
    if (this.useRockets && (k.has(c.rocket) || (c.rocketAlt && k.has(c.rocketAlt)) || (pad && pad.fire))) this.fireRocket(world);
    if (this.useRockets && (k.has(c.laser) || (c.laserAlt && k.has(c.laserAlt)) || (pad && pad.fire2))) this.fireLaser(world);

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
    if (world.effects) world.effects.push(new MuzzleFlash(edgeX, this.y, world.time));
    this.lastShot = world.time;
    world._shots = (world._shots || 0) + 1; // for online sfx streaming
    audio.play('gun', 0.22);
  }

  fireRocket(world) {
    if (this.rockets <= 0 || world.time - this.lastRocket <= this.rocketDelay) return;
    world.rockets.push(new Rocket(this.x, this.y, this.rocketImg));
    this.lastRocket = world.time;
    this.rockets--;
    audio.play('rocket', 0.5);
  }

  fireLaser(world) {
    if (!world.laserBlast) return;
    if (this.lasers <= 0 || world.time - this.lastLaser <= this.laserDelay) return;
    this.lastLaser = world.time;
    this.lasers--;
    world.laserBlast(this); // world resolves the hitscan + visuals + sfx
  }

  powerUp(world) {
    this.shootDelay = 200;
    this.poweredUp = true;
    this.powerEnd = world.time + 5000;
  }

  draw(g, world) {
    if (!this.alive) return;
    const t = world?.time ?? 0;
    const invuln = this.invulnUntil && t < this.invulnUntil;
    const thr = this.thrusters[this.thrFrame];
    const side = this.facingLeft ? 1 : -1;

    if (invuln) g.globalAlpha = 0.45 + 0.25 * Math.sin(t / 55); // blink during grace period

    g.save();
    g.translate(this.x, this.y);
    g.rotate(this.tilt);

    // engine glow + thruster behind the ship (flares up while boosting)
    drawGlow(g, glowEngine, side * (this.w / 2 + 10), 0, this.boosting ? 1.7 : 1);
    g.save();
    g.translate(side * (this.w / 2 + 12), 0);
    if (this.facingLeft) g.scale(-1, 1);
    g.drawImage(thr, -32, -32, 64, 64);
    g.restore();

    if (this.shipFlipped) g.scale(-1, 1);
    g.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
    g.restore();
    g.globalAlpha = 1;

    // shield bubble
    if (this.shield) {
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      const r = 36 + 2 * Math.sin(t / 140);
      g.globalAlpha = 0.55;
      g.lineWidth = 2.5;
      g.strokeStyle = 'rgb(80,220,255)';
      g.beginPath();
      g.arc(this.x, this.y, r, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.12;
      g.fillStyle = 'rgb(80,220,255)';
      g.fill();
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }
  }
}

/* -------------------------------- hit sparks -------------------------------- */

export class Spark {
  constructor(x, y, time, dir = Math.PI) {
    this.x = x; this.y = y;
    const a = dir + rand(-0.9, 0.9);
    const sp = rand(2, 6.5);
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
    const style = rand(0, 1);
    if (style < 0.38) {
      // flat fall, hull rocking side to side
      this.spinMode = 'wobble';
      this.wobbleAmp = rand(14, 42);
      this.wobbleFreq = rand(0.003, 0.008);
      this.wobblePhase = rand(0, Math.PI * 2);
    } else {
      // tumbling — speed and direction vary a lot
      this.spinMode = 'spin';
      this.spin = rand(0.5, 5.5) * (rand(0, 1) < 0.5 ? -1 : 1);
    }
    this.burning = rand(0, 1) < 0.4; // some wrecks catch fire
    this.smokeRate = rand(45, 110);
    this.spinAngle = 0;
    this.lastSmoke = 0;
    this.flash = 1;
    this.wreckHp = 2; // wrecks are shootable: 2 bullet hits (or 1 rocket) finish them
    audio.playSynth('siren'); // dying wail
  }

  // A hit on a falling wreck: sparks + knockback kick; returns true when it blows up.
  wreckHit(dmg, kickX) {
    this.flash = 1;
    this.wreckHp -= dmg;
    this.vx += kickX;                       // shove along the shot direction
    this.vyFall = Math.min(this.vyFall, 0) - rand(0.6, 1.4); // bounce upward
    if (this.spinMode === 'spin') this.spin *= rand(1.2, 1.8);
    return this.wreckHp <= 0;
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

    const warping = this.warpUntil && world.time < this.warpUntil;
    if (!warping && world.time - this.lastShot > this.shootDelay) {
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
    // warp-in materialisation: scale + fade over ~0.5s
    const t = world?.time ?? 0;
    const warp = this.warpUntil && t < this.warpUntil;
    if (warp) {
      const f = 1 - (this.warpUntil - t) / 550;
      g.save();
      g.translate(this.x, this.y);
      const s = 0.35 + 0.65 * f;
      g.scale(s, s);
      g.translate(-this.x, -this.y);
      g.globalAlpha = 0.3 + 0.7 * f;
    }

    // flipped thruster on the right side (exhaust), like Enemy.update_thruster
    const thr = this.thrusters[this.thrFrame];
    drawGlow(g, glowEngine, this.x + this.w / 2 + 10, this.y);
    if (this.type === 'hunter') {
      // menacing pulsing red glow
      const pulse = 0.7 + 0.3 * Math.sin(t / 120);
      drawGlow(g, glowEnemyBullet, this.x, this.y, 2.6 * pulse);
    }
    g.save();
    g.translate(this.x + this.w / 2 + 12, this.y);
    g.scale(-1, 1);
    g.drawImage(thr, -32, -32, 64, 64);
    g.restore();
    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    if (this.flash > 0.05) {
      g.globalAlpha = warp ? 0.6 : this.flash * 0.85;
      g.drawImage(tinted(this.img, 'rgba(255,255,255,1)', `white_enemy_${this.type}`),
        this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
      g.globalAlpha = 1;
    }
    if (warp) {
      g.globalAlpha = 1;
      g.restore();
    }
  }
}

// Boss tint palette cycles with level — every boss looks different
const BOSS_TINTS = [null, 'rgba(255,70,70,0.35)', 'rgba(90,255,140,0.32)', 'rgba(110,160,255,0.35)', 'rgba(255,150,240,0.35)'];

export class Boss {
  constructor(images, level, time) {
    this.images = images; // kept for minion spawning
    const tint = BOSS_TINTS[(level - 1) % BOSS_TINTS.length];
    this.img = tint ? tinted(images.boss, tint, `boss_tint_${(level - 1) % BOSS_TINTS.length}`) : images.boss;
    this.whiteImg = tinted(images.boss, 'rgba(255,255,255,1)', 'boss_white');
    this.bulletImg = images.enemy_bullet;
    const size = Math.min(210, 150 * (1 + (level - 1) * 0.06)); // bosses grow with level
    this.w = size; this.h = size;
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
    if (level >= 2) this.patterns.push('aimed', 'minions');
    if (level >= 3) this.patterns.push('spiral', 'laser');
    if (level >= 4) this.patterns.push('ring');
    this.health = 5 + (level - 1) * 5;
    this.maxHealth = this.health;
    this.shieldUntil = 0;                                  // invulnerable phase
    this.shieldBreaks = level >= 4 ? [0.66, 0.33] : [];    // health fractions that trigger shields
    this.laser = null;     // {phase: 'telegraph'|'fire', until, y}
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

  nearestPlayer(world) {
    let target = null, minD = Infinity;
    for (const p of world.players()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      if (d < minD) { minD = d; target = p; }
    }
    return target;
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
    } else if (pat === 'minions') {
      // warp in escort fighters: ring flash + chirp + scale-in materialisation
      audio.playSynth('warp');
      for (let i = -1; i <= 1; i++) {
        const e = new Enemy(this.images, Math.max(1, this.level - 1), 'basic', world.time);
        e.x = this.x - this.w / 2 - 20;
        e.y = clamp(this.y + i * 80, 30, H - 30);
        e.warpUntil = world.time + 550;
        world.enemies.push(e);
        world.effects.push(new Shockwave(e.x, e.y, world.time, 70));
        for (let s = 0; s < 6; s++) world.effects.push(new Spark(e.x, e.y, world.time, Math.PI));
      }
    } else if (pat === 'laser') {
      // telegraph first, then the beam fires along the frozen line
      this.laser = { phase: 'telegraph', until: t0 + 900, y: this.y };
      audio.playSynth('laser_charge');
    }
    return shots;
  }

  fire(shot, world) {
    let deg = shot.angle;
    if (deg === 'aim') {
      const target = this.nearestPlayer(world);
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
      this.floatBase = 0;
    }
    if (this.parked && !this.laser) {
      // gentle vertical float so patterns sweep the field
      const amp = Math.min(180, H / 2 - this.h / 2 - 30);
      this.y = H / 2 + Math.sin((world.time - this.floatStart - this.floatBase) / 1400) * amp;
    }

    // shield phases at health thresholds
    if (this.shieldBreaks.length && this.health / this.maxHealth <= this.shieldBreaks[0]) {
      this.shieldBreaks.shift();
      this.shieldUntil = world.time + 2500;
    }

    // laser state machine
    if (this.laser) {
      if (this.laser.phase === 'telegraph' && world.time >= this.laser.until) {
        this.laser = { phase: 'fire', until: world.time + 700, y: this.laser.y };
        audio.playSynth('laser_fire');
      } else if (this.laser.phase === 'fire') {
        // beam kills players crossing it
        for (const p of world.players()) {
          if (p.alive && p.x < this.x && Math.abs(p.y - this.laser.y) < 22) {
            world.killPlayer(p);
          }
        }
        if (world.time >= this.laser.until) {
          // resume floating from the frozen position without a jump
          this.floatStart = world.time;
          this.floatBase = -Math.asin(clamp((this.y - H / 2) / Math.max(1, Math.min(180, H / 2 - this.h / 2 - 30)), -1, 1)) * 1400;
          this.laser = null;
        }
      }
    }

    if (!this.laser && !this.queue.length && world.time - this.lastShot > this.shootDelay) {
      this.lastShot = world.time;
      this.queue = this.buildVolley(world);
    }
    while (this.queue.length && this.queue[0].t <= world.time) {
      this.fire(this.queue.shift(), world);
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.07 * world.k);
  }

  draw(g, world) {
    const t = world?.time ?? 0;

    // laser: telegraph line, then the beam
    if (this.laser) {
      const y = this.laser.y;
      const x0 = this.x - this.w / 2 + 10;
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      if (this.laser.phase === 'telegraph') {
        g.globalAlpha = 0.35 + 0.3 * Math.sin(t / 60);
        g.strokeStyle = 'rgb(255,60,60)';
        g.lineWidth = 2;
        g.setLineDash([10, 8]);
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(0, y);
        g.stroke();
        g.setLineDash([]);
      } else {
        const flick = 0.8 + 0.2 * Math.sin(t / 25);
        g.globalAlpha = 0.9 * flick;
        const grad = g.createLinearGradient(0, y - 16, 0, y + 16);
        grad.addColorStop(0, 'rgba(255,60,60,0)');
        grad.addColorStop(0.5, 'rgba(255,180,160,0.95)');
        grad.addColorStop(1, 'rgba(255,60,60,0)');
        g.fillStyle = grad;
        g.fillRect(0, y - 16, x0, 32);
        g.globalAlpha = 0.9;
        g.fillStyle = '#fff';
        g.fillRect(0, y - 3, x0, 6);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }

    g.drawImage(this.img, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    if (this.flash > 0.05) {
      g.globalAlpha = this.flash * 0.75;
      g.drawImage(this.whiteImg, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
      g.globalAlpha = 1;
    }

    // shield bubble while invulnerable
    if (this.shieldUntil > t) {
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.5 + 0.2 * Math.sin(t / 90);
      g.lineWidth = 3;
      g.strokeStyle = 'rgb(90,220,255)';
      g.beginPath();
      g.arc(this.x, this.y, this.w / 2 + 14, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.1;
      g.fillStyle = 'rgb(90,220,255)';
      g.fill();
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }

    // health bar
    const bw = 120, bh = 8;
    const px = this.x - bw / 2, py = this.y - this.h / 2 - 14;
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(px, py, bw, bh);
    g.fillStyle = this.shieldUntil > t ? 'rgb(90,220,255)' : this.flash > 0.05 ? '#fff' : '#f33';
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

export const POWERUP_TYPES = ['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread', 'shield', 'laser'];
export const POWERUP_IMG = {
  shooting: 'powerup',
  slow_motion: 'slow_motion_powerup',
  kill_all: 'kill_all_powerup',
  rocket: 'rocket_powerup',
  spread: 'spread_powerup',
  shield: 'powerup', // base image, tinted cyan at load
  laser: 'powerup',  // base image, tinted blue at load
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

/* ------------------------------ player laser beam ---------------------------- */
// Visual for the instantaneous piercing beam (damage is resolved on fire).
export class LaserBeam {
  constructor(x0, y, time, color = 'rgb(120,220,255)') {
    this.x0 = x0; this.y = y;
    this.spawn = time;
    this.life = 520; // lingering beam so it reads clearly
    this.color = color;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const t = (world.time - this.spawn) / this.life;
    const a = 1 - t;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.75 * a;
    const grad = g.createLinearGradient(0, this.y - 12, 0, this.y + 12);
    grad.addColorStop(0, 'rgba(120,220,255,0)');
    grad.addColorStop(0.5, this.color);
    grad.addColorStop(1, 'rgba(120,220,255,0)');
    g.fillStyle = grad;
    g.fillRect(this.x0, this.y - 12 * a, W - this.x0, 24 * a);
    g.globalAlpha = 0.95 * a;
    g.fillStyle = '#fff';
    g.fillRect(this.x0, this.y - 2.5 * a, W - this.x0, 5 * a);
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }
}

/* ------------------------------- score popups -------------------------------- */
export class ScorePopup {
  constructor(x, y, text, time, color = 'rgb(255,215,90)') {
    this.x = x; this.y = y;
    this.text = text;
    this.spawn = time;
    this.life = 800;
    this.color = color;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const t = (world.time - this.spawn) / this.life;
    g.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    g.font = `bold 16px "Orbitron", sans-serif`;
    g.fillStyle = this.color;
    g.textAlign = 'center';
    g.fillText(this.text, this.x, this.y - t * 34); // floats upward
    g.globalAlpha = 1;
  }
}

/* ------------------------------- muzzle flash -------------------------------- */
export class MuzzleFlash {
  constructor(x, y, time) {
    this.x = x; this.y = y;
    this.spawn = time;
    this.life = 70;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const a = 1 - (world.time - this.spawn) / this.life;
    drawGlow(g, glowBullet, this.x, this.y, 1.6 * a);
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
