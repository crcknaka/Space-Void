// Game entities — port of game_classes.py with web polish:
// delta-timed movement (world.k = dt / 16.67ms), glows, ship tilt.
// Speed constants are px per 60Hz step — same numbers as the pygame version.
import { W, H, rand, randInt, clamp } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { glowBullet, glowEnemyBullet, glowPowerup, glowEngine, glowExplosion, glowElite, drawGlow, tinted, drawShieldBubble } from './fx.js';
import { renderMesh, fitTransform, projectPoint, VIEW } from './mesh3d.js';
import { genBoss, genBossCore, BOSS_VIEW, aimYaw } from './bossgen.js';
import { genFreighter } from './shipgen.js';

// Ships draw ~25% larger than their (unchanged) hitboxes — reads better on
// small screens, and the forgiving 0.8-shrink collision keeps feeling fair.
export const VIS = 1.25;

// Draws engine flames at a sprite's baked nozzle points (img.nozzles, sprite
// px — see procassets.js). Call inside a context translated to ship center.
// opts.flip mirrors the plume (left-facing sprites exhaust to the right).
export function drawFlames(g, img, thr, w, h, opts = {}) {
  // NOTE: no drawGlow here — the flame frames carry their own baked halo, and
  // a composite-mode toggle per nozzle per ship flushes the GPU batch (slow).
  const boost = opts.boost ? 1.45 : 1;
  const list = img.nozzles;
  // sputter (falling wrecks): per-nozzle malfunction — dead engines stay
  // dark, live ones cough and gutter instead of burning steady
  const sp = opts.sputter;
  const flicker = (i) => {
    const st = sp.states[i] || sp.states[0];
    if (st.dead) return 0;
    if (Math.sin(sp.t / 63 + st.ph * 2.3) < -0.55) return 0; // full dropout
    return 0.35 + 0.65 * Math.abs(Math.sin(sp.t / 47 + st.ph) * Math.sin(sp.t / 19 + st.ph * 1.7));
  };
  if (!list || !list.length) { // legacy fallback: one centered flame at the tail
    const f = sp ? flicker(0) : 1;
    if (f < 0.08) return;
    const s = 40 * boost * (sp ? 0.45 + 0.55 * f : 1);
    g.save();
    g.translate((opts.flip ? 1 : -1) * (w / 2 + 2), 0);
    if (opts.flip) g.scale(-1, 1);
    if (sp) g.globalAlpha = 0.4 + 0.6 * f;
    g.drawImage(thr, -s * 0.75, -s / 2, s, s);
    g.globalAlpha = 1;
    g.restore();
    return;
  }
  // afterburner: the plume stretches lengthwise, not just scales — reads as speed
  const stretch = opts.boost ? 1.55 : 1;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    const f = sp ? flicker(i) : 1;
    if (f < 0.08) continue;
    const ox = (n.x / img.width) * w - w / 2;
    const oy = (n.y / img.height) * h - h / 2;
    const rw = (n.r / img.width) * w; // engine radius in world px
    const s = clamp(rw * 9, 20, 60) * boost * (sp ? 0.45 + 0.55 * f : 1);
    const sw = s * stretch;
    g.save();
    g.translate(ox, oy);
    if (opts.flip) g.scale(-1, 1);
    if (sp) g.globalAlpha = 0.4 + 0.6 * f;
    g.drawImage(thr, -sw * (48 / 64), -s / 2, sw, s); // nozzle anchor at canvas x=48
    g.globalAlpha = 1;
    if (opts.boost) { // second additive pass — hotter, longer tongue
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.6;
      g.drawImage(thr, -sw * (48 / 64) * 1.25, -s * 0.35, sw * 1.25, s * 0.7);
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }
    g.restore();
  }
}

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
    this.twk = Math.random() < 0.12 ? Math.random() * 6 : -1; // a few stars twinkle
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
    g.globalAlpha = this.opacity * (this.twk < 0 ? 1 : 0.55 + 0.45 * Math.sin(performance.now() / 320 + this.twk));
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
    if (this.tier === 3 && world.effects && world.time - (this._tr || 0) > 85) {
      this._tr = world.time; // plasma ember trail at max combo — subtle, not a smoke wall
      world.effects.push(new BoostParticle(this.x - 6, this.y, world.time, 'rgb(130,210,255)', -1, 0.5));
    }
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

// Streak behind a boosting ship (cyan for players; enemies pass their own color)
export class BoostParticle {
  constructor(x, y, time, color = 'rgb(120,220,255)', dir = -1, scale = 1) {
    this.color = color;
    this.x = x; this.y = y + rand(-7, 7) * scale;
    this.vx = rand(0.8, 1.6) * dir;
    this.vy = rand(-0.3, 0.3);
    this.size = rand(1.5, 3) * scale;
    this.life = 320;
    this.spawn = time;
    this.alpha = 0.8 * Math.min(1, 0.3 + scale * 0.7);
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
    g.fillStyle = this.color;
    g.beginPath();
    g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }
}

export class Rocket {
  constructor(x, y, img, forcedTarget = null, angle = 0) {
    this.img = img;
    this.w = 20; this.h = 10;
    this.x = x; this.y = y;
    this.speed = 8;
    this.rotSpeed = 2;   // degrees per 60Hz step
    this.angle = angle;  // 0 = pointing right
    this.forcedTarget = forcedTarget; // versus: home on a specific ship
    this.lastEmit = 0;
    this.dead = false;
  }
  update(world) {
    // steer toward a forced target (versus / enemy fire) or the nearest world target
    let target = this.forcedTarget && this.forcedTarget.alive !== false ? this.forcedTarget : null;
    if (!target && !this.enemyFire) { // enemy rockets never retarget onto enemies
      let minD = Infinity;
      for (const t of world.rocketTargets ? world.rocketTargets() : []) {
        const d = Math.hypot(this.x - t.x, this.y - t.y);
        if (d < minD) { minD = d; target = t; }
      }
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
    this.images = images; // combo tiers swap the bolt sprite at shoot time
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
    if (world.ionStorm?.phase === 'active') return; // ion storm: guns are dead
    if (world.time - this.lastShot <= this.shootDelay) return;
    const vx = this.facingLeft ? -10 : 10;
    const edgeX = this.facingLeft ? this.x - this.w / 2 : this.x + this.w / 2;
    const spreadAngle = 10;
    const start = -((this.spread - 1) * spreadAngle) / 2;
    // combo heat: hotter, larger bolts at x3+, plasma at x5
    const tier = (world.mult || 1) >= 5 ? 3 : (world.mult || 1) >= 3 ? 2 : 1;
    const img = tier === 3 ? this.images.bullet3 || this.bulletImg
      : tier === 2 ? this.images.bullet2 || this.bulletImg : this.bulletImg;
    for (let i = 0; i < this.spread; i++) {
      const b = new Bullet(edgeX, this.y, img, vx, start + i * spreadAngle);
      b.tier = tier;
      if (tier > 1) { b.w = tier === 3 ? 14 : 12; b.h = tier === 3 ? 7 : 6; }
      world.bullets.push(b);
    }
    if (world.effects) world.effects.push(new MuzzleFlash(edgeX, this.y, world.time));
    this.lastShot = world.time;
    world._shots = (world._shots || 0) + 1; // for online sfx streaming
    // combo heat in the sound too: hotter tiers drop the pitch (meatier bolt),
    // per-shot jitter keeps autofire from sounding like a loop
    const rate = (tier === 3 ? 0.86 : tier === 2 ? 0.94 : 1) * (0.95 + Math.random() * 0.1);
    audio.play('gun', tier === 3 ? 0.28 : 0.22, this.x, rate);
    if (tier === 3) audio.playSynth('plasma', this.x);
  }

  fireRocket(world) {
    if (this.rockets <= 0) { // out of ammo: dry-fire click + HUD flash (rate-limited)
      if (world.time - (this.rkEmptyAt || 0) > 400) {
        this.rkEmptyAt = this.rkEmptyFlash = world.time;
        audio.playSynth('empty', this.x);
      }
      return;
    }
    if (world.time - this.lastRocket <= this.rocketDelay) return; // on cooldown: silent
    world.rockets.push(new Rocket(this.x, this.y, this.rocketImg));
    this.lastRocket = world.time;
    this.rockets--;
    audio.play('rocket', 0.5, this.x);
  }

  fireLaser(world) {
    if (!world.laserBlast) return;
    if (this.lasers <= 0) { // out of charges: dry-fire click + HUD flash (rate-limited)
      if (world.time - (this.lzEmptyAt || 0) > 400) {
        this.lzEmptyAt = this.lzEmptyFlash = world.time;
        audio.playSynth('empty', this.x);
      }
      return;
    }
    if (world.time - this.lastLaser <= this.laserDelay) return; // on cooldown: silent
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

    if (invuln) g.globalAlpha = 0.45 + 0.25 * Math.sin(t / 55); // blink during grace period

    // 3D bank: generated ships carry pre-baked roll frames (img.bankFrames);
    // pick one from the tilt and keep only a soft residual 2D rotation.
    const bank = this.img.bankFrames;
    let img = this.img;
    if (bank) {
      const f = (this.tilt * (this.facingLeft ? -1 : 1)) / 0.14; // -1..1
      img = bank[Math.max(0, Math.min(bank.length - 1, Math.round((f + 1) * (bank.length - 1) / 2)))];
    }

    const vw = this.w * VIS, vh = this.h * VIS;
    const bob = Math.sin(t / 480 + (this.slot || 0) * 2) * 1.2; // idle hover
    g.save();
    g.translate(this.x, this.y + bob);
    g.rotate(this.tilt * (bank ? 0.35 : 1));
    if (this.shipFlipped) g.scale(-1, 1);
    // engine flames at the sprite's real nozzles (afterburner while boosting
    // or riding a hyperspace jump)
    drawFlames(g, this.img, thr, vw, vh, { boost: this.boosting || (world?.warpMul || 1) > 4 });
    g.drawImage(img, -vw / 2, -vh / 2, vw, vh);
    g.restore();
    g.globalAlpha = 1;

    // hexagonal shield bubble (+ impact ripple set by killPlayer)
    if (this.shield || (this.shieldRipple && t - this.shieldRipple.start < 450)) {
      const r = 36 + 2 * Math.sin(t / 140);
      const rip = this.shieldRipple ? { a: this.shieldRipple.a, p: (t - this.shieldRipple.start) / 450 } : null;
      drawShieldBubble(g, this.x, this.y, r, t, 'rgb(80,220,255)', rip && rip.p < 1 ? rip : null);
    }
  }
}

/* ------------------------------- mesh debris -------------------------------- */
// Real 3D wreckage: a destroyed ship's source mesh is split into face
// clusters that tumble apart, inheriting the ship's motion. Sprites baked by
// procassets carry their mesh (img.mesh) + px-per-unit scale (img.fitScale).

export class MeshDebris {
  constructor(sub, x, y, scale, time, opts = {}) {
    this.sub = sub;
    this.x = x; this.y = y;
    this.scale = scale;
    this.spawn = time;
    this.life = 900 + Math.random() * 600;
    this.vx = (opts.vx || 0) + (Math.random() - 0.5) * 2.4;
    this.vy = (opts.vy || 0) + (Math.random() - 0.5) * 2.4;
    this.srx = (Math.random() - 0.5) * 0.16;
    this.sry = (Math.random() - 0.5) * 0.16;
    this.ry0 = opts.ry ?? Math.PI;
    this.burning = Math.random() < 0.35;
    this.lastSmoke = 0;
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    if (this.burning && world.time - this.lastSmoke > 90) {
      this.lastSmoke = world.time;
      world.effects.push(new SmokeParticle(this.x, this.y, world.time));
    }
  }
  draw(g, world) {
    const age = world.time - this.spawn;
    const t = age / this.life;
    g.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    renderMesh(g, this.sub, {
      x: this.x, y: this.y, scale: this.scale,
      rx: VIEW.rx + this.srx * age / 16,
      ry: this.ry0 + this.sry * age / 16,
    });
    g.globalAlpha = 1;
  }
}

// Splits img.mesh into `chunks` clusters and spawns tumbling debris at (x,y).
// drawW is the entity hitbox width (visual VIS scaling applied here).
export function shatterSprite(world, img, x, y, drawW, opts = {}) {
  const mesh = img.mesh;
  if (!mesh || !img.fitScale) return;
  let live = 0; // debris budget: chain kills must not melt weak devices
  for (const f of world.effects) if (f instanceof MeshDebris) live++;
  if (live > 28) return;
  const scale = img.fitScale * (drawW * (opts.vis ?? VIS) / img.width);
  const n = opts.chunks || 4 + ((Math.random() * 3) | 0);
  const cents = mesh.faces.map((f) => {
    let cx = 0, cy = 0, cz = 0;
    for (const vi of f.v) { cx += mesh.verts[vi][0]; cy += mesh.verts[vi][1]; cz += mesh.verts[vi][2]; }
    return [cx / f.v.length, cy / f.v.length, cz / f.v.length];
  });
  const seeds = [];
  for (let i = 0; i < n; i++) seeds.push(cents[(Math.random() * cents.length) | 0]);
  const groups = Array.from({ length: n }, () => []);
  cents.forEach((c, fi) => {
    let bi = 0, bd = Infinity;
    seeds.forEach((s, si) => {
      const d = (c[0] - s[0]) ** 2 + (c[1] - s[1]) ** 2 + (c[2] - s[2]) ** 2;
      if (d < bd) { bd = d; bi = si; }
    });
    groups[bi].push(fi);
  });
  const facing = opts.ry ?? Math.PI; // ships face left by default in game
  for (const grp of groups) {
    if (!grp.length) continue;
    // compact sub-mesh: remap only the verts this chunk uses
    const map = new Map();
    const verts = [];
    const faces = grp.map((fi) => {
      const f = mesh.faces[fi];
      return {
        ...f,
        v: f.v.map((vi) => {
          if (!map.has(vi)) { map.set(vi, verts.length); verts.push(mesh.verts[vi]); }
          return map.get(vi);
        }),
      };
    });
    // chunk centroid → spawn offset + outward kick (mirror x for left-facing)
    let gx = 0, gz = 0;
    for (const fi of grp) { gx += cents[fi][0]; gz += cents[fi][2]; }
    gx /= grp.length; gz /= grp.length;
    const sx = (facing === Math.PI ? -gx : gx) * scale;
    const sy = gz * Math.sin(VIEW.rx) * scale;
    world.effects.push(new MeshDebris({ verts, faces }, x + sx, y + sy, scale, world.time, {
      ...opts, ry: facing,
      vx: (opts.vx || 0) + sx * 0.04,
      vy: (opts.vy || 0) + sy * 0.04,
    }));
  }
}

/* ---------------------------------- mines ----------------------------------- */
// Proximity mines laid by high-level tanks. Shot down for points, lethal on contact.

export function drawMine(g, x, y, t, phase = 0) {
  const blink = Math.max(0, Math.sin(t / 160 + phase));
  drawGlow(g, glowEnemyBullet, x, y, 0.7 + blink * 0.8);
  const grad = g.createRadialGradient(x - 3, y - 3, 1, x, y, 11);
  grad.addColorStop(0, 'rgb(96,102,116)');
  grad.addColorStop(0.7, 'rgb(46,50,60)');
  grad.addColorStop(1, 'rgb(24,26,34)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.fill();
  const rot = t / 1300 + phase;
  g.fillStyle = 'rgb(70,74,86)';
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * Math.PI * 2;
    g.beginPath();
    g.arc(x + Math.cos(a) * 10.5, y + Math.sin(a) * 10.5, 2.2, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = `rgba(255,64,52,${0.3 + 0.7 * blink})`;
  g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.fill();
}

export class Mine {
  constructor(x, y, time) {
    this.x = x; this.y = y;
    this.w = 24; this.h = 24;
    this.spawn = time;
    this.expireAt = time + 20000;
    this.phase = rand(0, Math.PI * 2);
    this.dead = false;
  }
  update(world) {
    this.x -= 0.5 * world.speedMul * world.k;
    this.y += Math.sin(world.time / 700 + this.phase) * 0.15 * world.k;
    if (this.x < -30) this.dead = true;
  }
  draw(g, world) {
    drawMine(g, this.x, this.y, world.time, this.phase);
  }
}

/* ------------------------------ ambient events ------------------------------- */
// Rare background flourishes: a comet streaking by, a distant convoy passing.
// Pure eye-candy — Math.random by design (never touches the seeded game RNG).

export class Comet {
  constructor(time, target = null) {
    this.x = W * (0.3 + Math.random() * 0.7);
    this.y = -30;
    this.target = target; // planet layer entry → impact trajectory
    const sp = 2.6 + Math.random() * 2;
    if (target) {
      const tx = target.x + target.img.width / 2;
      const ty = target.y + target.img.height / 2;
      const d = Math.hypot(tx - this.x, ty - this.y) || 1;
      this.vx = ((tx - this.x) / d) * sp;
      this.vy = ((ty - this.y) / d) * sp;
    } else {
      const a = Math.PI * (0.62 + Math.random() * 0.2); // down-left diagonal
      this.vx = Math.cos(a) * sp;
      this.vy = Math.abs(Math.sin(a)) * sp;
    }
    this.spawn = time;
    this.hue = Math.random() < 0.5 ? '200,230,255' : '255,225,180';
    this.dead = false;
  }
  update(world) {
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    // impact: the comet dies in a flash on the planet's face
    const t = this.target;
    if (t && !t.dead) {
      const cx = t.x + t.img.width / 2, cy = t.y + t.img.height / 2;
      const r = (t.img.planetR || t.img.height / 2.7) * 0.85;
      if (Math.hypot(this.x - cx, this.y - cy) < r) {
        this.dead = true;
        world.effects.push(new ImpactFlash(this.x, this.y, world.time));
        if (world.effects) world.effects.push(new Shockwave(this.x, this.y, world.time, 60, 'rgb(255,230,170)'));
      }
    }
    if (this.y > H + 60 || this.x < -160) this.dead = true;
  }
  draw(g) {
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const tx = -this.vx * 34, ty = -this.vy * 34; // tail opposite of travel
    const grad = g.createLinearGradient(this.x, this.y, this.x + tx, this.y + ty);
    grad.addColorStop(0, `rgba(${this.hue},0.8)`);
    grad.addColorStop(1, `rgba(${this.hue},0)`);
    g.strokeStyle = grad;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(this.x, this.y);
    g.lineTo(this.x + tx, this.y + ty);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(this.x, this.y, 2, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = prev;
  }
}

// Bright bloom where a comet strikes a planet — a background wow-moment.
export class ImpactFlash {
  constructor(x, y, time) {
    this.x = x; this.y = y;
    this.spawn = time;
    this.life = 900;
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const t = (world.time - this.spawn) / this.life;
    const r = 6 + 26 * t;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const grad = g.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
    grad.addColorStop(0, `rgba(255,245,220,${0.9 * (1 - t)})`);
    grad.addColorStop(0.5, `rgba(255,190,110,${0.5 * (1 - t)})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(this.x, this.y, r, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = prev;
  }
}

// Background skirmish: a convoy flees while two pirates chase, tracers flying.
// Pure theatre at silhouette scale — none of it touches gameplay.
export class Skirmish {
  constructor(images, time) {
    this.ships = tinted(images.enemy_basic, 'rgba(22,28,40,0.96)', 'convoy_silhouette');
    this.pirate = tinted(images.enemy_hunter, 'rgba(42,20,24,0.96)', 'pirate_silhouette');
    this.n = 2 + ((Math.random() * 2) | 0);
    this.x = W + 40;
    this.y = 60 + Math.random() * (H * 0.55);
    this.v = 0.55 + Math.random() * 0.25; // fleeing — faster than a convoy
    this.s = 15 + Math.random() * 7;
    this.lastShot = 0;
    this.tracers = []; // [x, y, len, born]
    this.casualtyAt = time + 4000 + Math.random() * 6000;
    this.dead = false;
  }
  update(world) {
    this.x -= this.v * world.k * (world.warpMul || 1);
    if (world.time - this.lastShot > 700 + Math.random() * 900) {
      this.lastShot = world.time;
      // muzzle of one of the two pirates (their sprites face left)
      const pi = (Math.random() * 2) | 0;
      const px = this.x + this.s * (2.6 + pi * 1.6);
      const py = this.y + this.s * 0.9 + pi * this.s * 0.9 + this.s * 0.315;
      this.tracers.push([px - 2, py, this.s * 1.2, world.time]);
    }
    for (const tr of this.tracers) tr[0] -= 3.2 * world.k;
    // tracers die when they reach the convoy (or age out)
    this.tracers = this.tracers.filter((tr) => world.time - tr[3] < 700 && tr[0] > this.x - this.s);
    if (!this.hit && world.time > this.casualtyAt && this.n > 1) {
      this.hit = true; // one convoy ship doesn't make it
      this.n -= 1;
      world.effects.push(new ImpactFlash(this.x + this.s * 0.8, this.y, world.time));
    }
    if (this.x + this.n * this.s * 1.6 + this.s * 5 < -40) this.dead = true;
  }
  draw(g, world) {
    g.globalAlpha = 0.85;
    for (let i = 0; i < this.n; i++) { // the fleeing convoy
      g.drawImage(this.ships, this.x + i * this.s * 1.5, this.y + Math.sin(i * 1.7) * this.s * 0.5, this.s, this.s * 0.6);
    }
    const py = this.y + this.s * 0.9;
    for (let i = 0; i < 2; i++) { // pirates behind
      g.drawImage(this.pirate, this.x + this.s * (2.6 + i * 1.6), py + i * this.s * 0.9, this.s * 1.05, this.s * 0.63);
    }
    g.globalAlpha = 1;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    for (const tr of this.tracers) {
      const a = 1 - (world.time - tr[3]) / 500;
      g.strokeStyle = `rgba(255,120,90,${0.7 * a})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(tr[0], tr[1]);
      g.lineTo(tr[0] + tr[2], tr[1]);
      g.stroke();
    }
    g.globalCompositeOperation = prev;
  }
}

export class DistantConvoy {
  constructor(images, time) {
    this.img = tinted(images.enemy_basic, 'rgba(22,28,40,0.96)', 'convoy_silhouette');
    this.n = 3 + ((Math.random() * 3) | 0);
    this.x = W + 40;
    this.y = 60 + Math.random() * (H * 0.5);
    this.v = 0.35 + Math.random() * 0.3;
    this.s = 16 + Math.random() * 8; // tiny: far away
    this.dead = false;
  }
  update(world) {
    this.x -= this.v * world.k;
    if (this.x + this.n * this.s * 1.6 < -40) this.dead = true;
  }
  draw(g) {
    g.globalAlpha = 0.85;
    for (let i = 0; i < this.n; i++) {
      const x = this.x + i * this.s * 1.6;
      const y = this.y + Math.sin(i * 1.7) * this.s * 0.5;
      g.drawImage(this.img, x, y, this.s, this.s * 0.6);
      // faint engine dot
      g.fillStyle = 'rgba(255,170,90,0.5)';
      g.fillRect(x + this.s - 1, y + this.s * 0.28, 1.5, 1.5);
    }
    g.globalAlpha = 1;
  }
}

// Loose cluster of far-off rocks drifting behind the action — dark tinted
// asteroid sprites on a slow parallax so the sector reads deep.
export class DistantRocks {
  constructor(images, time) {
    const pool = images.asteroids || [images.asteroid];
    this.rocks = [];
    const n = 3 + ((Math.random() * 4) | 0);
    for (let i = 0; i < n; i++) {
      const vi = (Math.random() * pool.length) | 0;
      this.rocks.push({
        img: tinted(pool[vi], 'rgba(26,30,42,0.93)', `belt_rock_${vi}`),
        x: W + 30 + Math.random() * 260,
        y: 30 + Math.random() * (H - 60),
        s: 8 + Math.random() * 18,
        v: 0.12 + Math.random() * 0.2,
        rot: Math.random() * 360,
        rv: (Math.random() - 0.5) * 0.5,
      });
    }
    this.dead = false;
  }
  update(world) {
    let alive = false;
    for (const r of this.rocks) {
      r.x -= r.v * world.k;
      r.rot += r.rv * world.k;
      if (r.x > -40) alive = true;
    }
    if (!alive) this.dead = true;
  }
  draw(g) {
    g.globalAlpha = 0.8;
    for (const r of this.rocks) {
      g.save();
      g.translate(r.x, r.y);
      g.rotate((r.rot * Math.PI) / 180);
      g.drawImage(r.img, -r.s / 2, -r.s / 2, r.s, r.s);
      g.restore();
    }
    g.globalAlpha = 1;
  }
}

// Huge cargo hauler crossing far behind the action — baked once per sighting
// from a fresh seed, rendered dim so it reads as a distant silhouette.
export class Freighter {
  constructor(time, forceGolden = false) {
    this.golden = forceGolden || Math.random() < 0.05; // rare treasure hauler
    const mesh = genFreighter((Math.random() * 1e9) | 0, this.golden);
    const wpx = Math.ceil(300 + Math.random() * 220);
    const c = document.createElement('canvas');
    c.width = wpx;
    c.height = Math.ceil(wpx * 0.3);
    const fit = fitTransform(mesh, c.width, c.height, BOSS_VIEW, 0.95);
    renderMesh(c.getContext('2d'), mesh, { ...BOSS_VIEW, ...fit, gain: this.golden ? 1 : 0.5, ambient: this.golden ? 0.45 : 0.3 });
    c.mesh = mesh;          // convoy-raid mode shatters these
    c.fitScale = fit.scale;
    this.img = c;
    this.x = W + 60;
    this.y = 30 + Math.random() * (H * 0.65);
    this.v = 0.22 + Math.random() * 0.25;
    this.phase = Math.random() * 1000;
    this.dead = false;
  }
  update(world) {
    // the golden hauler rides the hyperspace jump with you — it must not be
    // swept off-screen the moment a boss dies
    const wm = this.golden ? 1 : (world.warpMul || 1);
    this.x -= this.v * wm * world.k;
    if (this.x + this.img.width < -60) this.dead = true;
  }
  draw(g, world) {
    const t = world?.time ?? 0;
    if (this.golden) { // it glimmers — you're meant to chase it
      drawGlow(g, glowElite, this.x + this.img.width / 2, this.y + this.img.height / 2,
        (this.img.width / 34) * (0.9 + 0.15 * Math.sin(t / 220)));
    }
    g.globalAlpha = 0.92;
    g.drawImage(this.img, this.x, this.y);
    g.globalAlpha = 1;
    // blinking nav strobe + steady engine embers
    if (Math.sin((t + this.phase) / 260) > 0.75) {
      g.fillStyle = 'rgba(255,110,90,0.9)';
      g.fillRect(this.x + this.img.width * 0.68, this.y + this.img.height * 0.28, 2.5, 2.5);
    }
    g.fillStyle = 'rgba(255,180,100,0.55)';
    g.fillRect(this.x + this.img.width * 0.03, this.y + this.img.height * 0.46, 3, 2);
    // dim cabin windows breathing slowly along the hull
    for (let i = 0; i < 5; i++) {
      const a = 0.1 + 0.13 * (0.5 + 0.5 * Math.sin(t / 430 + this.phase + i * 1.7));
      g.fillStyle = `rgba(190,215,255,${a})`;
      g.fillRect(this.x + this.img.width * (0.22 + i * 0.13), this.y + this.img.height * 0.5, 2, 1.5);
    }
  }
}

/* -------------------------------- lightning --------------------------------- */
// Ion-storm bolt: a jagged polyline flashing across the sky.

export class Lightning {
  constructor(time) {
    this.spawn = time;
    this.life = 170;
    this.dead = false;
    this.pts = [];
    let x = Math.random() * W;
    for (let y = -10; y < H + 30; y += 45 + Math.random() * 55) {
      this.pts.push([x, y]);
      x += (Math.random() - 0.5) * 95;
    }
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const a = Math.max(0, 1 - (world.time - this.spawn) / this.life);
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    for (const [lw, aa] of [[5, 0.22], [1.9, 0.85]]) {
      g.globalAlpha = a * aa;
      g.strokeStyle = 'rgb(190,220,255)';
      g.lineWidth = lw;
      g.beginPath();
      this.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = prev;
  }
}

/* ------------------------------- warp streaks ------------------------------- */
// Star-line streaks during the hyperspace hop between levels.

export class WarpStreak {
  constructor(time) {
    this.x = W + 60;
    this.y = Math.random() * H;
    this.v = 30 + Math.random() * 22;
    this.len = 70 + Math.random() * 160;
    this.a = 0.2 + Math.random() * 0.35;
    this.spawn = time;
    this.dead = false;
  }
  update(world) {
    this.x -= this.v * world.k;
    if (this.x + this.len < 0) this.dead = true;
  }
  draw(g) {
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const grad = g.createLinearGradient(this.x, 0, this.x + this.len, 0);
    grad.addColorStop(0, `rgba(200,225,255,${this.a})`);
    grad.addColorStop(1, 'rgba(200,225,255,0)');
    g.strokeStyle = grad;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(this.x, this.y);
    g.lineTo(this.x + this.len, this.y);
    g.stroke();
    g.globalCompositeOperation = prev;
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

/* -------------------------------- rock dust -------------------------------- */

// Dust burst for a cracking asteroid: gritty square motes plus a few soft
// tan puffs. Replaces 3D mesh debris, which clashed with the photo-style
// rock sprites (the rock already splits into real pieces via breakApart).
export class RockDust {
  constructor(x, y, time, scale = 1, soft = false) {
    this.soft = soft;
    this.x = x + rand(-6, 6) * scale;
    this.y = y + rand(-6, 6) * scale;
    const a = rand(0, Math.PI * 2);
    const sp = (soft ? rand(0.3, 1.2) : rand(0.8, 3.4)) * (0.7 + scale * 0.5);
    this.vx = Math.cos(a) * sp - 0.5; // drifts left with the world flow
    this.vy = Math.sin(a) * sp;
    this.size = (soft ? rand(4, 9) : rand(1, 3.2)) * scale;
    this.grow = soft ? rand(0.05, 0.1) : 0;
    this.life = soft ? rand(500, 900) : rand(280, 700);
    this.spawn = time;
    this.shade = randInt(105, 170);
    this.alpha = 1;
    this.dead = false;
  }
  update(world) {
    const age = world.time - this.spawn;
    if (age > this.life) { this.dead = true; return; }
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    this.vx *= Math.pow(0.96, world.k);
    this.vy *= Math.pow(0.96, world.k);
    this.size += this.grow * world.k;
    this.alpha = 1 - age / this.life;
  }
  draw(g) {
    const s = this.shade;
    g.fillStyle = `rgb(${s},${Math.round(s * 0.94)},${Math.round(s * 0.84)})`;
    if (this.soft) {
      g.globalAlpha = this.alpha * 0.22;
      g.beginPath();
      g.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      g.fill();
    } else {
      g.globalAlpha = this.alpha * 0.9;
      g.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
    }
    g.globalAlpha = 1;
  }
}

/* --------------------------------- enemies --------------------------------- */

// type: basic | weaver (sine path) | hunter (homes on player) | tank (armored, drops loot)
const ENEMY_TINT = {
  weaver: 'rgba(0,230,190,0.35)',
  hunter: 'rgba(255,60,60,0.4)',
  tank: 'rgba(190,110,255,0.42)',
  sniper: 'rgba(90,110,255,0.4)',
  carrier: 'rgba(255,170,60,0.4)',
  shieldbearer: 'rgba(90,230,255,0.4)',
};
const ENEMY_POINTS = { basic: 10, weaver: 15, hunter: 20, tank: 30, sniper: 25, carrier: 35, shieldbearer: 30 };
const ENEMY_SIZE = { tank: [66, 40], sniper: [54, 24], carrier: [72, 44], shieldbearer: [52, 32] };

export class Enemy {
  constructor(images, level, type, time, moveRandomly = false) {
    this.type = type;
    // each type has its own generated ship; tint fallback covers a missing key
    this.img = images[`enemy_${type}`]
      || (type === 'basic' ? images.enemy_ship : tinted(images.enemy_ship, ENEMY_TINT[type], `enemy_${type}`));
    this.thrusters = images.thrusters.enemy;
    this.bulletImg = images.enemy_bullet;
    this.rocketImg = images.enemy_rocket || images.rocket;
    [this.w, this.h] = ENEMY_SIZE[type] || [50, 30];
    this.images = images; // carriers spawn drones later
    this.x = W + randInt(50, 100);
    this.y = randInt(this.h / 2, H - this.h / 2);
    // armored enemies need multiple hits; armor grows with level
    if (type === 'tank') this.health = 3 + Math.floor(Math.max(0, level - 4) / 3);
    else if (type === 'hunter') this.health = level >= 5 ? 2 : 1;
    else if (type === 'weaver') this.health = level >= 6 ? 2 : 1;
    else if (type === 'sniper') this.health = 2;
    else if (type === 'carrier') this.health = 4 + Math.floor(level / 3);
    else if (type === 'shieldbearer') this.health = 2;
    else this.health = 1;
    if (type === 'shieldbearer') this.shieldHp = 2; // own hex bubble, absorbs hits first
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
    } else if (type === 'sniper') {
      this.vx = -(2.4 + level * 0.15);
      this.vy = 0;
      this.holdX = W - randInt(70, 150); // parks near the right edge
      this.shootDelay = Infinity;        // fires via the telegraph cycle
      this.aim = null;                   // { y, until }
      this.nextAimAt = time + randInt(1400, 2600);
    } else if (type === 'carrier') {
      this.vx = -(0.8 + level * 0.12);
      this.vy = 0;
      this.shootDelay = Math.max(900, randInt(2600, 3800) - level * 100);
      this.nextDroneAt = time + randInt(2500, 4200);
    } else if (type === 'shieldbearer') {
      this.vx = -(1.7 + level * 0.18);
      this.vy = moveRandomly ? randInt(-1, 1) : 0;
      this.shootDelay = Math.max(600, randInt(1900, 3200) - level * 100);
    } else {
      this.vx = randInt(-3, -1) - (level - 1);      // faster with level
      this.vy = moveRandomly ? randInt(-2, 2) : 0;
      this.shootDelay = Math.max(300, randInt(1500, 3000) - (level - 1) * 100);
    }
    this.lastShot = time;

    // level scaling: veterans fire twin bolts, tanks launch homing rockets
    this.twinShot = (type === 'basic' || type === 'weaver')
      && level >= 3 && randInt(1, 100) <= Math.min(60, 10 + level * 8);
    this.level = level;
    this.nextMineAt = time + randInt(4000, 7000); // tank minelaying (level 6+)
    // afterburner dashes (hunters always lunge; light ships sometimes; tanks never)
    this.canDash = level >= 2 && (type === 'hunter' || (type !== 'tank' && randInt(1, 100) <= 45));
    this.boosting = false;
    this.dashUntil = 0;
    this.nextDashAt = time + randInt(2000, 5000);
    this.rocketLauncher = type === 'tank' && level >= 4;
    this.rocketDelay = Math.max(4500, 9500 - level * 400);
    this.lastRocketAt = time + randInt(1500, 3500); // no volley right at spawn
  }

  takeDamage(dmg) {
    if (this.shieldHp > 0) {
      this.shieldHp -= dmg;
      this.flash = 0.5;
      this.shieldRipple = { a: Math.PI, start: this._t || 0 };
      audio.playSynth('shield_hit', this.x);
      return false;
    }
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

    // afterburner dash — mirrors the player's boost (flame stretches in draw)
    this.boosting = world.time < this.dashUntil;
    if (this.canDash && !this.boosting && world.time > this.nextDashAt
        && !(this.warpUntil && world.time < this.warpUntil)) {
      this.boosting = true;
      this.dashUntil = world.time + randInt(500, 900);
      this.nextDashAt = world.time + randInt(3500, 7500);
    }
    if (this.boosting && world.effects && world.time - (this.lastTrail || 0) > 30) {
      this.lastTrail = world.time;
      world.effects.push(new BoostParticle(this.x + this.w / 2 + 6, this.y, world.time, 'rgb(255,180,90)', 1));
    }

    const m = world.speedMul * world.k * (this.boosting ? 1.9 : 1);
    this._t = world.time;
    // snipers stop at their perch instead of flying across
    if (this.type === 'sniper' && this.x <= this.holdX) {
      // hold position; drift toward the nearest player's y
      let tgt = null, md = Infinity;
      for (const p of world.players()) {
        if (!p.alive) continue;
        const d = Math.abs(p.y - this.y);
        if (d < md) { md = d; tgt = p; }
      }
      if (tgt && !this.aim) this.y += clamp(tgt.y - this.y, -1.1, 1.1) * m;
    } else {
      this.x += this.vx * m;
    }

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
    const stormOut = world.ionStorm?.phase === 'active'; // ion storm: all guns down

    // sniper telegraph → high-velocity bolt
    if (this.type === 'sniper' && !warping && !stormOut && this.x <= this.holdX + 4) {
      if (!this.aim && world.time > this.nextAimAt) {
        this.aim = { y: this.y, until: world.time + 800 };
      } else if (this.aim && world.time >= this.aim.until) {
        world.enemyBullets.push(new EnemyBullet(this.x - this.w / 2, this.aim.y, this.bulletImg, -19, 0));
        audio.play('gun', 0.3, this.x, 0.78 + Math.random() * 0.06); // deeper: reads as the sniper's heavy rifle
        this.aim = null;
        this.nextAimAt = world.time + Math.max(1800, randInt(2800, 4400) - this.level * 100);
      }
    }
    if (stormOut) this.aim = null;

    // carriers launch a pair of drones once on-screen
    if (this.type === 'carrier' && !warping && this.x < W - 80 && world.time > this.nextDroneAt) {
      this.nextDroneAt = world.time + randInt(5000, 8000);
      audio.playSynth('warp');
      for (const dy of [-30, 30]) {
        const d = new Enemy(this.images, Math.max(1, this.level - 1), 'basic', world.time);
        d.w = 34; d.h = 20;
        d.health = 1;
        d.points = 5;
        d.x = this.x - this.w / 2 - 12;
        d.y = clamp(this.y + dy, 20, H - 20);
        d.vx = -(2.6 + this.level * 0.2);
        d.canDash = true;
        d.nextDashAt = world.time + randInt(500, 1500);
        d.warpUntil = world.time + 350;
        world.enemies.push(d);
        world.effects.push(new Shockwave(d.x, d.y, world.time, 42));
      }
    }

    if (!warping && !stormOut && world.time - this.lastShot > this.shootDelay) {
      const bx = this.x - this.w / 2;
      if (this.twinShot) {
        world.enemyBullets.push(new EnemyBullet(bx, this.y - 5, this.bulletImg));
        world.enemyBullets.push(new EnemyBullet(bx, this.y + 5, this.bulletImg));
      } else {
        world.enemyBullets.push(new EnemyBullet(bx, this.y, this.bulletImg));
      }
      this.lastShot = world.time;
    }
    // heavy tanks lob a slow homing rocket at the nearest player (shootable)
    if (this.rocketLauncher && world.enemyRockets && !warping && !stormOut
        && world.time - this.lastRocketAt > this.rocketDelay) {
      this.lastRocketAt = world.time;
      let target = null, minD = Infinity;
      for (const p of world.players()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - this.x, p.y - this.y);
        if (d < minD) { minD = d; target = p; }
      }
      if (target) {
        const rk = new Rocket(this.x - this.w / 2, this.y, this.rocketImg, target, 180);
        rk.speed = 5.5;    // slower than the player's — dodgeable
        rk.rotSpeed = 1.4;
        rk.enemyFire = true;
        world.enemyRockets.push(rk);
        audio.play('rocket', 0.35, this.x);
      }
    }
    // veteran tanks are minelayers too
    if (this.type === 'tank' && (this.level >= 6 || this.minelayer) && world.mines && !warping
        && world.time > this.nextMineAt) {
      this.nextMineAt = world.time + randInt(6000, 9000);
      if (world.mines.length < 5) world.mines.push(new Mine(this.x + this.w / 2 + 10, this.y, world.time));
    }
    if (world.time - this.thrLast > 50) {
      this.thrLast = world.time;
      this.thrFrame = (this.thrFrame + 1) % this.thrusters.length;
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.09 * world.k);
  }

  draw(g, world) {
    const vw = this.w * VIS, vh = this.h * VIS;
    if (this.dying) {
      // falling wreck: darkened hull, engines malfunctioning — some nozzles
      // dead, the rest cough and gutter instead of burning steady
      if (this.burning) drawGlow(g, glowEngine, this.x, this.y, 1.6 + 0.4 * Math.sin((world?.time ?? 0) / 90));
      g.save();
      g.translate(this.x, this.y);
      g.rotate((this.spinAngle * Math.PI) / 180);
      if (!this._sputter) {
        const n = Math.max(1, (this.img.nozzles || []).length);
        this._sputter = Array.from({ length: n }, () => ({ dead: Math.random() < 0.4, ph: Math.random() * 7 }));
        if (this._sputter.every((s) => s.dead)) this._sputter[0].dead = false; // one keeps coughing
      }
      const dt0 = world?.time ?? 0;
      drawFlames(g, this.img, this.thrusters[((dt0 / 60) | 0) % this.thrusters.length], vw, vh,
        { flip: true, sputter: { t: dt0, states: this._sputter } });
      g.drawImage(this.img, -vw / 2, -vh / 2, vw, vh);
      g.globalAlpha = 0.45;
      g.drawImage(tinted(this.img, 'rgba(0,0,0,1)', `black_enemy_${this.type}`),
        -vw / 2, -vh / 2, vw, vh);
      g.globalAlpha = 1;
      if (this.flash > 0.05) {
        g.globalAlpha = this.flash * 0.85;
        g.drawImage(tinted(this.img, 'rgba(255,255,255,1)', `white_enemy_${this.type}`),
          -vw / 2, -vh / 2, vw, vh);
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

    // sniper: thin blinking aim line while telegraphing
    if (this.aim) {
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.3 + 0.35 * Math.sin(t / 45);
      g.strokeStyle = 'rgb(255,80,80)';
      g.lineWidth = 1.5;
      g.setLineDash([7, 6]);
      g.beginPath();
      g.moveTo(this.x - this.w / 2, this.aim.y);
      g.lineTo(0, this.aim.y);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }

    // elite: pulsing golden aura + oversized gold copy peeking out as an outline
    if (this.elite) {
      const pulse = 0.85 + 0.25 * Math.sin(t / 130);
      drawGlow(g, glowElite, this.x, this.y, 2.1 * pulse);
      g.globalAlpha = 0.9;
      g.drawImage(tinted(this.img, 'rgba(255,205,80,1)', `gold_enemy_${this.type}`),
        this.x - (vw * 1.12) / 2, this.y - (vh * 1.12) / 2, vw * 1.12, vh * 1.12);
      g.globalAlpha = 1;
    }

    // engine flames on the tail (right side of the left-facing sprite)
    const thr = this.thrusters[this.thrFrame];
    if (this.type === 'hunter') {
      // menacing pulsing red glow
      const pulse = 0.7 + 0.3 * Math.sin(t / 120);
      drawGlow(g, glowEnemyBullet, this.x, this.y, 2.6 * pulse);
    }
    g.save();
    g.translate(this.x, this.y);
    drawFlames(g, this.img, thr, vw, vh, { flip: true, boost: this.boosting });
    g.restore();
    g.drawImage(this.img, this.x - vw / 2, this.y - vh / 2, vw, vh);
    if (this.flash > 0.05) {
      g.globalAlpha = warp ? 0.6 : this.flash * 0.85;
      g.drawImage(tinted(this.img, 'rgba(255,255,255,1)', `white_enemy_${this.type}`),
        this.x - vw / 2, this.y - vh / 2, vw, vh);
      g.globalAlpha = 1;
    }
    if (warp) {
      g.globalAlpha = 1;
      g.restore();
    }

    // shieldbearer's own hex bubble (with impact ripples)
    if (this.shieldHp > 0) {
      const rip = this.shieldRipple ? { a: this.shieldRipple.a, p: (t - this.shieldRipple.start) / 450 } : null;
      drawShieldBubble(g, this.x, this.y, Math.max(vw, vh) * 0.62, t, 'rgb(120,235,255)', rip && rip.p < 1 ? rip : null);
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
    if (level >= 3) this.patterns.push('spiral', 'laser', 'rockets');
    if (level >= 4) this.patterns.push('ring');
    if (level >= 5) this.patterns.push('wall');
    if (level >= 6) this.patterns.push('sweep');
    // level flavor: every 3rd boss is a carrier (constant escorts), every 4th a rammer
    if (level % 3 === 0) this.patterns.push('minions', 'minions');
    if (level % 4 === 0) this.patterns.push('ram', 'ram');
    this.laser2 = null; // sweeping beam {phase, until, ang, dir}
    this.ram = null;    // charge attack {phase, until, retX}
    // every 5th boss is a MEGA: tougher, and at half health the hull blows
    // away to reveal a core with rotating cross-beams
    this.mega = level % 5 === 0;
    if (this.mega) this.health = this.maxHealth = Math.round(this.maxHealth * 1.5);
    this.phase2 = false;
    this.coreBeams = null; // { ang, activeAt }
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

    // modular live-rendered boss: generated hull + tracking turrets
    this.gen = genBoss(level);
    this.fit = fitTransform(this.gen.core, this.w, this.h, BOSS_VIEW, 0.9);
    // pseudo-sprite so drawFlames() can anchor plumes on the live render
    this.flameImg = {
      width: this.w, height: this.h,
      nozzles: this.gen.core.nozzles.map((n) => {
        const p = projectPoint(BOSS_VIEW, this.fit, [n.x, n.y, n.z]);
        return { x: p.x, y: p.y, r: n.r * p.s };
      }),
    };
    this.thrusters = images.thrusters.enemy;
  }

  takeDamage(dmg) {
    this.health -= dmg;
    this.flash = 1;
    return this.health <= 0;
  }

  // Cinematic death: ~1.7s of chained hull explosions and shudder, then the
  // final blast + 3D debris + levelUp. Started via world.killBoss().
  startDeathSeq(world) {
    if (this.deathSeq) return;
    this.deathSeq = { start: world.time, last: 0 };
    this.laser = null;
    this.queue = [];
    audio.playSynth('siren');
  }

  startPhase2(world) {
    this.phase2 = true;
    this.laser = null;
    this.laser2 = null;
    this.ram = null;
    this.queue = [];
    this.shieldUntil = 0;
    for (const tr of this.gen.turrets) tr.dead = true;
    // the hull blows away…
    world.explode(this.x, this.y, true, 2.2);
    world.effects.push(new Shockwave(this.x, this.y, world.time, 320));
    shatterSprite(world, { mesh: this.gen.core, fitScale: this.fit.scale, width: this.w },
      this.x, this.y, this.w, { vis: 1, chunks: 8, vx: 0.6 });
    // …revealing the core
    this.w = this.h = Math.round(this.w * 0.55);
    this.coreGen = genBossCore(this.level);
    this.fit = fitTransform(this.coreGen, this.w, this.h, BOSS_VIEW, 0.88);
    this.coreBeams = { ang: 0.6, activeAt: world.time + 900 };
    this.lastShot = world.time;
    audio.playSynth('laser_charge', this.x);
  }

  updateDeathSeq(world) {
    const t = world.time - this.deathSeq.start;
    this.x += 0.25 * world.k; // listing hull drifts back
    if (world.time - this.deathSeq.last > 150) {
      this.deathSeq.last = world.time;
      const ex = this.x + (Math.random() - 0.5) * this.w * 0.7;
      const ey = this.y + (Math.random() - 0.5) * this.h * 0.55;
      world.explode(ex, ey, true, 0.6 + Math.random() * 0.5);
      for (let i = 0; i < 4; i++) world.effects.push(new Spark(ex, ey, world.time, Math.PI));
    }
    if (t > 1700) {
      this.dead = true;
      world.explode(this.x, this.y, true, 2.6);
      world.effects.push(new Shockwave(this.x, this.y, world.time, 380));
      shatterSprite(world, { mesh: this.phase2 ? this.coreGen : this.gen.core, fitScale: this.fit.scale, width: this.w },
        this.x, this.y, this.w, { vis: 1, chunks: 8, vx: 0.4 });
      world.levelUp(this.x, this.y);
    }
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
    } else if (pat === 'rockets') {
      // volley of shootable homing rockets
      const target = this.nearestPlayer(world);
      if (target && world.enemyRockets) {
        audio.play('rocket', 0.5, this.x);
        for (let i = -1; i <= 1; i++) {
          const rk = new Rocket(this.x - this.w / 2, clamp(this.y + i * 44, 30, H - 30),
            this.images.enemy_rocket || this.images.rocket, target, 180);
          rk.speed = 5;
          rk.rotSpeed = 1.25;
          rk.enemyFire = true;
          world.enemyRockets.push(rk);
        }
      }
    } else if (pat === 'wall') {
      // curtain of bolts across the whole height with one safe gap
      const gap = randInt(90, H - 90);
      for (let y = 30; y < H - 20; y += 46) {
        if (Math.abs(y - gap) < 75) continue;
        shots.push({ t: t0 + 250, angle: 180, y });
      }
      audio.playSynth('warning');
    } else if (pat === 'sweep') {
      // slowly rotating beam from the bow
      this.laser2 = { phase: 'telegraph', until: t0 + 1000, ang: this.y > H / 2 ? -0.42 : 0.42, dir: this.y > H / 2 ? 1 : -1 };
      audio.playSynth('laser_charge');
    } else if (pat === 'ram') {
      this.ram = { phase: 'windup', until: t0 + 700, retX: this.x };
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
    // wall shots carry their own spawn height (a curtain, not a fan)
    world.enemyBullets.push(new EnemyBullet(this.x - (shot.y !== undefined ? this.w / 2 : 0), shot.y ?? this.y,
      this.bulletImg, (shot.y !== undefined ? 6 : 8) * Math.cos(rad), (shot.y !== undefined ? 0 : 8 * Math.sin(rad))));
  }

  update(world) {
    if (this.deathSeq) { this.updateDeathSeq(world); return; }
    this.x += this.vx * world.speedMul * world.k;
    if (!this.parked && this.x + this.w / 2 <= W - 150) {
      this.vx = 0;
      this.parked = true;
      this.floatStart = world.time; // sine starts at phase 0 → no teleport on park
      this.floatBase = 0;
    }
    if (this.parked && !this.laser && !this.laser2 && !this.ram) {
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
            world.killPlayer(p, this.x, p.y);
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

    if (!this.laser && !this.laser2 && !this.ram
        && !(world.ionStorm?.phase === 'active')
        && !this.queue.length && world.time - this.lastShot > this.shootDelay) {
      this.lastShot = world.time;
      this.queue = this.buildVolley(world);
    }

    // sweeping beam: rotates slowly, kills players caught along the ray
    if (this.laser2) {
      const L = this.laser2;
      if (L.phase === 'telegraph' && world.time >= L.until) {
        L.phase = 'fire';
        L.until = world.time + 2600;
        audio.playSynth('laser_fire');
      } else if (L.phase === 'fire') {
        L.ang += L.dir * 0.0058 * world.k;
        for (const p of world.players()) {
          if (!p.alive || p.x >= this.x) continue;
          const dx = p.x - this.x, dy = p.y - this.y;
          const along = -dx * Math.cos(L.ang) + dy * Math.sin(L.ang);
          const perp = Math.abs(dx * Math.sin(L.ang) + dy * Math.cos(L.ang));
          if (along > 0 && perp < 20) world.killPlayer(p, this.x, p.y);
        }
        if (world.time >= L.until) {
          this.floatStart = world.time;
          this.floatBase = -Math.asin(clamp((this.y - H / 2) / Math.max(1, Math.min(180, H / 2 - this.h / 2 - 30)), -1, 1)) * 1400;
          this.laser2 = null;
        }
      }
    }

    // ram charge: windup shudder → lunge across → crawl back
    if (this.ram) {
      const Rm = this.ram;
      if (Rm.phase === 'windup') {
        if (world.time >= Rm.until) {
          Rm.phase = 'charge';
          Rm.until = world.time + 1000;
          audio.playSynth('warp');
        }
      } else if (Rm.phase === 'charge') {
        this.x -= 9.5 * world.k;
        if (this.x < W * 0.32 || world.time >= Rm.until) Rm.phase = 'return';
      } else {
        this.x += 3 * world.k;
        if (this.x >= Rm.retX) {
          this.x = Rm.retX;
          this.floatStart = world.time;
          this.floatBase = -Math.asin(clamp((this.y - H / 2) / Math.max(1, Math.min(180, H / 2 - this.h / 2 - 30)), -1, 1)) * 1400;
          this.ram = null;
        }
      }
    }
    while (this.queue.length && this.queue[0].t <= world.time) {
      this.fire(this.queue.shift(), world);
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.07 * world.k);

    // MEGA: at half health the fight changes shape
    if (this.mega && !this.phase2 && this.health <= this.maxHealth / 2) this.startPhase2(world);

    // phase 2: rotating cross-beams + periodic bullet rings
    if (this.phase2) {
      const cb = this.coreBeams;
      if (world.time >= cb.activeAt) {
        cb.ang += 0.0035 * world.k;
        for (const p of world.players()) {
          if (!p.alive) continue;
          const dx = p.x - this.x, dy = p.y - this.y;
          const d = Math.hypot(dx, dy);
          if (d < this.w * 0.4) continue; // inside the dead zone next to the core
          for (const a of [cb.ang, cb.ang + Math.PI / 2]) {
            const perp = Math.abs(dx * Math.sin(a) - dy * Math.cos(a));
            if (perp < 14) { world.killPlayer(p, this.x, this.y); break; }
          }
        }
      }
      if (world.time - this.lastShot > 3800 && !(world.ionStorm?.phase === 'active')) {
        this.lastShot = world.time;
        for (let i = 0; i < 12; i++) {
          const a = (Math.PI * 2 * i) / 12;
          world.enemyBullets.push(new EnemyBullet(this.x, this.y, this.bulletImg, 7 * Math.cos(a), 7 * Math.sin(a)));
        }
      }
      if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.07 * world.k);
      return; // no turrets/volleys/lasers in core form
    }

    // turrets swivel toward the nearest player
    const tgt = this.nearestPlayer(world);
    if (tgt) {
      const want = aimYaw(Math.atan2(tgt.y - this.y, tgt.x - this.x));
      for (const tr of this.gen.turrets) {
        if (tr.dead) continue;
        let d = (want - tr.yaw) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        tr.yaw += clamp(d, -tr.speed * world.k, tr.speed * world.k);
      }
    }
    // modules blow off as health drops (one per step → cascading booms)
    const alive = this.gen.turrets.filter((t2) => !t2.dead);
    const keep = Math.max(0, Math.ceil(this.gen.turrets.length * Math.max(0, this.health) / this.maxHealth));
    if (alive.length > keep) {
      const tr = alive[alive.length - 1];
      tr.dead = true;
      const p = projectPoint(BOSS_VIEW, this.fit, tr.pivot);
      const px = this.x - this.w / 2 + p.x, py = this.y - this.h / 2 + p.y;
      world.effects.push(new Shockwave(px, py, world.time, 110));
      for (let i = 0; i < 10; i++) world.effects.push(new Spark(px, py, world.time, Math.PI));
      for (let i = 0; i < 4; i++) world.effects.push(new SmokeParticle(px, py, world.time));
      audio.play('explosion', 0.5);
    }
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

    // sweeping beam: dashed aim line, then a rotating gradient blade
    if (this.laser2) {
      const L = this.laser2;
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      g.save();
      g.translate(this.x, this.y);
      g.rotate(Math.PI - L.ang);
      if (L.phase === 'telegraph') {
        g.globalAlpha = 0.35 + 0.3 * Math.sin(t / 60);
        g.strokeStyle = 'rgb(255,60,60)';
        g.lineWidth = 2;
        g.setLineDash([10, 8]);
        g.beginPath();
        g.moveTo(this.w * 0.35, 0);
        g.lineTo(W + H, 0);
        g.stroke();
        g.setLineDash([]);
      } else {
        const flick = 0.8 + 0.2 * Math.sin(t / 25);
        g.globalAlpha = 0.9 * flick;
        const grad = g.createLinearGradient(0, -16, 0, 16);
        grad.addColorStop(0, 'rgba(255,60,60,0)');
        grad.addColorStop(0.5, 'rgba(255,180,160,0.95)');
        grad.addColorStop(1, 'rgba(255,60,60,0)');
        g.fillStyle = grad;
        g.fillRect(this.w * 0.3, -16, W + H, 32);
        g.globalAlpha = 0.9;
        g.fillStyle = '#fff';
        g.fillRect(this.w * 0.3, -3, W + H, 6);
      }
      g.restore();
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }

    // live modular render: engine flames → hull → turrets → hit-flash pass
    // (a dying hull shudders)
    const shudder = (this.deathSeq || this.ram?.phase === 'windup') && !world?.over;
    const jx = shudder ? (Math.random() - 0.5) * 5 : 0;
    const jy = shudder ? (Math.random() - 0.5) * 5 : 0;
    const bx = this.x - this.w / 2 + jx, by = this.y - this.h / 2 + jy;
    // phase-2 rotating cross-beams (under the core)
    if (this.phase2 && this.coreBeams && !world?.over) {
      const cb = this.coreBeams;
      const tele = t < cb.activeAt;
      const prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'lighter';
      for (const a of [cb.ang, cb.ang + Math.PI / 2]) {
        g.save();
        g.translate(this.x + jx, this.y + jy);
        g.rotate(-a);
        if (tele) {
          g.globalAlpha = 0.35 + 0.3 * Math.sin(t / 55);
          g.strokeStyle = 'rgb(255,60,60)';
          g.lineWidth = 2;
          g.setLineDash([10, 8]);
          g.beginPath();
          g.moveTo(-(W + H), 0);
          g.lineTo(W + H, 0);
          g.stroke();
          g.setLineDash([]);
        } else {
          const flick = 0.8 + 0.2 * Math.sin(t / 25 + a);
          g.globalAlpha = 0.85 * flick;
          const grad = g.createLinearGradient(0, -13, 0, 13);
          grad.addColorStop(0, 'rgba(255,60,60,0)');
          grad.addColorStop(0.5, 'rgba(255,180,160,0.95)');
          grad.addColorStop(1, 'rgba(255,60,60,0)');
          g.fillStyle = grad;
          g.fillRect(-(W + H), -13, (W + H) * 2, 26);
          g.globalAlpha = 0.85;
          g.fillStyle = '#fff';
          g.fillRect(-(W + H), -2.5, (W + H) * 2, 5);
        }
        g.restore();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = prev;
    }
    const thr = this.thrusters[(t / 55 | 0) % this.thrusters.length];
    if (!this.phase2) {
      g.save();
      g.translate(this.x, this.y);
      drawFlames(g, this.flameImg, thr, this.w, this.h, { flip: true });
      g.restore();
    }
    const pulse = this.phase2 ? 1 + 0.045 * Math.sin(t / 160) : 1;
    const body = this.phase2 ? this.coreGen : this.gen.core;
    const base = { ...BOSS_VIEW, scale: this.fit.scale * pulse, x: bx + this.fit.x, y: by + this.fit.y, ry: BOSS_VIEW.ry + (this.phase2 ? t / 900 : 0) };
    renderMesh(g, body, base);
    if (!this.phase2) {
      for (const tr of this.gen.turrets) {
        if (tr.dead) continue;
        const p = projectPoint(BOSS_VIEW, this.fit, tr.pivot);
        renderMesh(g, tr.mesh, { rx: BOSS_VIEW.rx, ry: tr.yaw, scale: this.fit.scale, x: bx + p.x, y: by + p.y });
      }
    }
    if (this.flash > 0.05) {
      g.globalAlpha = this.flash * 0.6;
      renderMesh(g, body, { ...base, flat: [255, 255, 255] });
      g.globalAlpha = 1;
    }

    // hex shield bubble while invulnerable (ripples where bullets splash)
    if (this.shieldUntil > t) {
      const rip = this.shieldRipple ? { a: this.shieldRipple.a, p: (t - this.shieldRipple.start) / 450 } : null;
      drawShieldBubble(g, this.x, this.y, this.w / 2 + 14, t, 'rgb(90,220,255)', rip && rip.p < 1 ? rip : null);
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
    this.volcanic = !!img.volcanic; // magma rock: blast wave when cracked
    this.size = size;
    this.angle = 0;
    if (size === 'large') {
      this.huge = rand(0, 1) < 0.16; // occasional slow monster rock
      this.rotSpeed = this.huge ? rand(0.25, 0.55) : rand(0.5, 1);
      const s = this.huge ? randInt(165, 235) : randInt(80, 150); this.w = s; this.h = s;
      this.vx = this.huge ? rand(0.8, 1.4) : rand(1, 2);
      this.vy = this.huge ? rand(-0.6, 0.6) : rand(-1, 1);
    } else if (size === 'medium') {
      this.rotSpeed = rand(1, 2);
      const s = randInt(40, 80); this.w = s; this.h = s;
      this.vx = rand(2, 4); this.vy = rand(-2, 2);
    } else {
      this.rotSpeed = rand(2, 3);
      const s = randInt(20, 40); this.w = s; this.h = s;
      this.vx = rand(4, 6); this.vy = rand(-3, 3);
    }
    this.hp = this.huge ? randInt(3, 4) : 1; // giants soak hits before cracking
    this.x = W + randInt(5, 10) + this.w / 2;
    this.y = randInt(this.h / 2, H - this.h / 2);
    this.trailUntil = 0; // fresh break pieces smoke dust for a moment
    this.dead = false;
  }
  update(world) {
    this.angle += this.rotSpeed * world.speedMul * world.k * 0.33; // pygame rotated every 50ms tick
    this.x -= this.vx * world.speedMul * world.k;
    this.y += this.vy * world.speedMul * world.k;
    if (this.trailUntil > world.time && world.effects && world.time - (this._lastTrail || 0) > 130) {
      this._lastTrail = world.time;
      const d = new RockDust(this.x + rand(-0.25, 0.25) * this.w, this.y + rand(-0.25, 0.25) * this.h,
        world.time, Math.max(0.5, this.w / 110));
      d.vx *= 0.35; d.vy *= 0.35; // lingering wake, not a burst
      world.effects.push(d);
    }
    // right-edge cull too: bounces can send a rock back the way it came
    if (this.x + this.w / 2 < 0 || this.x - this.w / 2 > W + 80 ||
        this.y - this.h / 2 > H || this.y + this.h / 2 < 0) this.dead = true;
  }
  breakApart(now = 0) {
    const next = { large: 'medium', medium: 'small', small: null }[this.size];
    if (!next) return [];
    const count = this.size === 'medium' ? randInt(2, 3) : this.huge ? randInt(3, 4) : 2;
    const pieces = [];
    for (let i = 0; i < count; i++) {
      const a = new Asteroid(this.img, next);
      a.x = this.x; a.y = this.y;
      a.vx = rand(-3, 3);
      a.vy = rand(-3, 3);
      a.trailUntil = now + 1700;
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
    this.w = 80; this.h = 40; // larger pod so the glyph reads at a glance
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
  constructor(x0, y, time, color = 'rgb(120,220,255)', dir = 1, life = 520) {
    this.x0 = x0; this.y = y;
    this.spawn = time;
    this.life = life; // lingering beam so it reads clearly
    this.color = color;
    this.dir = dir; // +1 sweeps right, -1 sweeps left
    this.dead = false;
  }
  update(world) {
    if (world.time - this.spawn > this.life) this.dead = true;
  }
  draw(g, world) {
    const t = (world.time - this.spawn) / this.life;
    // hold near-full brightness while the beam is hot, then fade out
    const a = t < 0.5 ? 1 - t * 0.2 : 0.9 * (1 - (t - 0.5) / 0.5);
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const bx = this.dir > 0 ? this.x0 : 0;
    const bw = this.dir > 0 ? W - this.x0 : this.x0;
    g.globalAlpha = 0.75 * a;
    const grad = g.createLinearGradient(0, this.y - 12, 0, this.y + 12);
    grad.addColorStop(0, 'rgba(120,220,255,0)');
    grad.addColorStop(0.5, this.color);
    grad.addColorStop(1, 'rgba(120,220,255,0)');
    g.fillStyle = grad;
    g.fillRect(bx, this.y - 12 * a, bw, 24 * a);
    g.globalAlpha = 0.95 * a;
    g.fillStyle = '#fff';
    g.fillRect(bx, this.y - 2.5 * a, bw, 5 * a);
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
  constructor(x, y, time, maxR = 320, color = 'rgb(255,200,110)') {
    this.x = x; this.y = y;
    this.spawn = time;
    this.maxR = maxR;
    this.color = color;
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
    g.strokeStyle = this.color;
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
