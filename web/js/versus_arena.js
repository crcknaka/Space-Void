// Shared Versus arena hazards + power-ups (local hotseat and online).
// One side is the spawn authority (local: always; online: the host). Every
// spawn is described as a small event object: the authority applies it and,
// online, mirrors it to the peer, so both screens run the same hazards.
// Collisions stay per-client — each Versus mode still owns its own deaths.
import { W, H, rand, randInt, clamp, overlap } from './const.js';
import * as audio from './audio.js';
import { Asteroid, PowerUp, RockDust } from './entities.js';
import { tinted } from './fx.js';

const POD_TYPES = ['shield', 'spread'];
const POD_LIFE = 12000; // unclaimed pods expire (blink for the last 3s)

// Lethal comet streak: a blinking edge marker for ~0.9s, then a fast dive.
class VsComet {
  constructor(e, time) {
    this.x = e.x; this.y = e.y;
    this.vx = e.vx; this.vy = e.vy;
    this.w = 26; this.h = 26;
    this.warnUntil = time + 900;
    this.hue = e.hot ? '255,225,180' : '200,230,255';
    this.dead = false;
  }
  update(world) {
    if (world.time < this.warnUntil) return;
    this.x += this.vx * world.k;
    this.y += this.vy * world.k;
    if (this.y > H + 80 || this.x < -80 || this.x > W + 80) this.dead = true;
  }
  draw(g, world) {
    if (world.time < this.warnUntil) {
      if (Math.floor(world.time / 130) % 2) return; // blink
      const ex = clamp(this.x, 16, W - 16);
      g.fillStyle = 'rgba(255,210,80,0.9)';
      g.beginPath(); g.moveTo(ex, 28); g.lineTo(ex - 9, 8); g.lineTo(ex + 9, 8); g.closePath(); g.fill();
      return;
    }
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const tx = -this.vx * 14, ty = -this.vy * 14;
    const grad = g.createLinearGradient(this.x, this.y, this.x + tx, this.y + ty);
    grad.addColorStop(0, `rgba(${this.hue},0.95)`);
    grad.addColorStop(1, `rgba(${this.hue},0)`);
    g.strokeStyle = grad;
    g.lineWidth = 5;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(this.x, this.y); g.lineTo(this.x + tx, this.y + ty); g.stroke();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(this.x, this.y, 4.5, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = prev;
  }
}

export class VsArena {
  constructor(images, { authority = true, send = null } = {}) {
    this.images = images;
    this.authority = authority;
    this.send = send;
    this.shieldImg = images.shield_powerup || tinted(images.powerup, 'rgba(0,210,255,0.55)', 'powerup_shield');
    this.rockPool = images.asteroids.filter((r) => !r.volcanic); // volcanic blast is a campaign mechanic
    this.reset(0);
  }

  reset(time) {
    this.rocks = [];
    this.comets = [];
    this.pods = [];
    this.sing = null;
    this.podSeq = 0;
    this.nextRockAt = time + 5000 + randInt(0, 3000);
    this.nextCometAt = time + 9000 + randInt(0, 4000);
    this.nextPodAt = time + 11000 + randInt(0, 4000);
    this.nextSingAt = time + 26000 + randInt(0, 14000);
  }

  emit(world, e) {
    this.apply(world, e);
    if (this.send) this.send(e);
  }

  // Materialize a spawn event (authority-made or received from the peer).
  apply(world, e) {
    if (e.t === 'rock') {
      const a = new Asteroid(this.rockPool[e.i], e.size);
      a.huge = false;
      a.w = a.h = e.s;
      a.rotSpeed = e.rs;
      a.x = e.x; a.y = e.y;
      a.vx = e.vx; a.vy = e.vy;
      a.hp = e.size === 'large' ? 2 : 1;
      this.rocks.push(a);
    } else if (e.t === 'comet') {
      this.comets.push(new VsComet(e, world.time));
    } else if (e.t === 'pod') {
      const pu = new PowerUp(e.type === 'shield' ? this.shieldImg : this.images.spread_powerup, e.type);
      pu.id = e.id;
      pu.x = e.x; pu.baseY = e.y; pu.y = e.y;
      pu.vx = 0;
      pu.bornAt = world.time;
      this.pods.push(pu);
    } else if (e.t === 'sing') {
      this.sing = { x: e.x, y: e.y, start: world.time, dur: e.dur, coreR: 0, env: 0 };
      audio.playSynth('storm');
    }
  }

  // rocks drift vertically through the neutral middle band — fair to both sides
  mkRock() {
    const size = rand(0, 1) < 0.55 ? 'large' : 'medium';
    const s = size === 'large' ? randInt(85, 140) : randInt(45, 75);
    const fromTop = rand(0, 1) < 0.5;
    return {
      t: 'rock', i: randInt(0, this.rockPool.length - 1), size, s,
      x: randInt(Math.round(W * 0.3), Math.round(W * 0.7)),
      y: fromTop ? -s / 2 + 1 : H + s / 2 - 1,
      vx: rand(-0.5, 0.5), // Asteroid.update subtracts vx (leftward positive)
      vy: (fromTop ? 1 : -1) * rand(0.7, 1.4),
      rs: rand(0.5, 1) * (rand(0, 1) < 0.5 ? -1 : 1),
    };
  }

  mkComet() {
    return {
      t: 'comet',
      x: randInt(Math.round(W * 0.15), Math.round(W * 0.85)), y: -20,
      vx: rand(1.2, 2.8) * (rand(0, 1) < 0.5 ? -1 : 1),
      vy: rand(4.2, 5.8),
      hot: rand(0, 1) < 0.5 ? 1 : 0,
    };
  }

  mkPod() {
    return {
      t: 'pod', id: ++this.podSeq,
      type: POD_TYPES[randInt(0, POD_TYPES.length - 1)],
      x: randInt(Math.round(W * 0.4), Math.round(W * 0.6)),
      y: randInt(90, H - 90),
    };
  }

  update(world) {
    const t = world.time;
    if (this.authority) {
      if (t > this.nextRockAt) {
        this.nextRockAt = t + 6500 + randInt(0, 4500);
        if (this.rocks.length < 5) this.emit(world, this.mkRock());
      }
      if (t > this.nextCometAt) {
        this.nextCometAt = t + 8000 + randInt(0, 6000);
        const n = randInt(1, 2);
        for (let i = 0; i < n; i++) this.emit(world, this.mkComet());
      }
      if (t > this.nextPodAt) {
        this.nextPodAt = t + 11000 + randInt(0, 5000);
        if (this.pods.length < 2) this.emit(world, this.mkPod());
      }
      if (!this.sing && t > this.nextSingAt) {
        this.nextSingAt = t + 32000 + randInt(0, 13000);
        this.emit(world, {
          t: 'sing', dur: 9000,
          x: Math.round(W * (0.38 + rand(0, 0.24))),
          y: Math.round(H * (0.3 + rand(0, 0.4))),
        });
      }
    }

    for (const a of this.rocks) a.update(world);
    for (const c of this.comets) c.update(world);
    for (const pu of this.pods) {
      pu.y = pu.baseY + Math.sin(t / 300 + pu.phase) * 6;
      if (t - pu.bornAt > POD_LIFE) pu.dead = true;
    }
    if (this.sing) {
      const s = this.sing;
      const p = (t - s.start) / s.dur;
      if (p >= 1) this.sing = null;
      else {
        s.env = p < 0.15 ? p / 0.15 : p > 0.82 ? (1 - p) / 0.18 : 1; // grow / hold / collapse
        s.coreR = 24 * s.env;
      }
    }

    this.rocks = this.rocks.filter((a) => !a.dead);
    this.comets = this.comets.filter((c) => !c.dead);
    this.pods = this.pods.filter((p) => !p.dead);
  }

  // Gravity well physics (game.js applySingularity, tuned down for one-hit
  // duels): bends bullets, flings rocks, drags pods, tugs ships; lethal core.
  // onCore(pl) decides the death — the caller owns kill/shield rules.
  applyGravity(world, bulletArrays, players, onCore) {
    const s = this.sing;
    if (!s) return;
    const G = 26000 * s.env, MIN = 46, k = world.k;
    const pull = (ox, oy) => {
      const dx = s.x - ox, dy = s.y - oy;
      const d2 = Math.max(MIN * MIN, dx * dx + dy * dy);
      const d = Math.sqrt(d2);
      const f = (G / d2) * k;
      return { fx: (dx / d) * f, fy: (dy / d) * f, d };
    };
    for (const arr of bulletArrays) {
      for (const b of arr) {
        if (b.dead) continue;
        const p = pull(b.x, b.y);
        b.vx += p.fx; b.vy += p.fy;
        if (p.d < s.coreR) b.dead = true;
      }
    }
    for (const a of this.rocks) {
      if (a.dead) continue;
      const p = pull(a.x, a.y);
      a.vx -= p.fx; a.vy += p.fy; // a.vx is leftward speed → subtract to add screen vx
      if (p.d < s.coreR + a.w * 0.3) { a.dead = true; this.rockDust(world, a); }
    }
    for (const pu of this.pods) {
      if (pu.dead) continue;
      const p = pull(pu.x, pu.baseY);
      pu.x += clamp(p.fx, -1.6, 1.6);
      pu.baseY += clamp(p.fy, -1.6, 1.6);
      if (p.d < s.coreR + 8) pu.dead = true;
    }
    for (const pl of players) {
      if (!pl.alive) continue;
      const p = pull(pl.x, pl.y);
      pl.x = clamp(pl.x + clamp(p.fx, -1.7, 1.7), pl.w / 2, W - pl.w / 2);
      pl.y = clamp(pl.y + clamp(p.fy, -1.7, 1.7), pl.h / 2, H - pl.h / 2);
      if (p.d < s.coreR + pl.h * 0.35) onCore(pl);
    }
  }

  // bullets/rockets vs rocks: shot dies, rock soaks hp then bursts into dust
  collideBullets(world, arrays) {
    for (const arr of arrays) {
      for (const b of arr) {
        if (b.dead) continue;
        for (const a of this.rocks) {
          if (a.dead) continue;
          if (overlap(a, b, 0.8)) {
            b.dead = true;
            world.effects.push(new RockDust(b.x, b.y, world.time, 0.5, true)); // impact spark
            if (--a.hp <= 0) { a.dead = true; this.rockDust(world, a); }
            else audio.playSynth('thock', a.x);
            break;
          }
        }
      }
    }
  }

  // lethal hazard touching a ship; returns the hit point (caller kills) or null
  hazardHit(world, p) {
    if (world.time < (p.invulnUntil || 0)) return null;
    for (const a of this.rocks) {
      if (!a.dead && overlap(p, a, 0.75)) {
        a.dead = true;
        this.rockDust(world, a);
        return { x: a.x, y: a.y };
      }
    }
    for (const c of this.comets) {
      if (!c.dead && world.time >= c.warnUntil && overlap(p, c, 0.8)) {
        c.dead = true;
        return { x: c.x, y: c.y };
      }
    }
    return null;
  }

  // pod pickup for one ship; marks it dead and returns it (caller applies)
  tryPickup(world, p) {
    for (const pu of this.pods) {
      if (!pu.dead && overlap(p, pu, 0.9)) { pu.dead = true; return pu; }
    }
    return null;
  }

  removePod(id) {
    for (const pu of this.pods) if (pu.id === id) pu.dead = true;
  }

  rockDust(world, a) {
    audio.playSynth('crack', a.x, Math.min(1.5, 0.6 + a.w / 160));
    const s = Math.max(0.7, a.w / 90);
    const grit = Math.round(8 + a.w * 0.16);
    for (let i = 0; i < grit; i++) world.effects.push(new RockDust(a.x, a.y, world.time, s));
    for (let i = 0; i < 4; i++) world.effects.push(new RockDust(a.x, a.y, world.time, s, true));
  }

  draw(g, world) {
    if (this.sing) this.drawSing(g, world);
    for (const a of this.rocks) a.draw(g);
    for (const pu of this.pods) {
      const left = POD_LIFE - (world.time - pu.bornAt);
      if (left < 3000 && Math.floor(world.time / 130) % 2) g.globalAlpha = 0.35;
      pu.draw(g, world);
      g.globalAlpha = 1;
    }
    for (const c of this.comets) c.draw(g, world);
  }

  // accretion glow + rotating arcs + black event horizon (game.js visual)
  drawSing(g, world) {
    const s = this.sing;
    const R = Math.max(1, s.coreR), t = world.time - s.start;
    const prev = g.globalCompositeOperation;
    g.globalCompositeOperation = 'lighter';
    const glow = g.createRadialGradient(s.x, s.y, R * 0.85, s.x, s.y, R * 3.4);
    glow.addColorStop(0, `rgba(180,120,255,${0.55 * s.env})`);
    glow.addColorStop(0.4, `rgba(90,60,200,${0.22 * s.env})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(s.x, s.y, R * 3.4, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 2; i++) {
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
}

// shield = absorb one hit (drawn by Player.draw); spread = 3-bolt fan for 8s
export function applyVsPod(p, type, time) {
  if (type === 'shield') p.shield = true;
  else if (type === 'spread') p.spreadUntil = time + 8000;
  audio.play('powerup', 0.6, p.x);
}
