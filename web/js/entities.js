import { HEIGHT, POWERUP_TYPES, WIDTH } from './constants.js';

export class Star {
  constructor(x, y, speed, size, opacity) {
    this.x = x;
    this.y = y;
    this.speed = speed;
    this.size = size;
    this.opacity = opacity;
  }

  update(dt) {
    this.x -= this.speed * dt * 60;
    if (this.x < 0) {
      this.x = WIDTH;
      this.y = Math.random() * HEIGHT;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.opacity / 255;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class StaticStar {
  constructor(x, y, size, opacity, color) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.opacity = opacity;
    this.maxOpacity = opacity;
    this.fading = Math.random() < 0.5;
    this.fadeSpeed = 0.1 + Math.random() * 0.4;
    this.color = color;
  }

  update(dt) {
    const delta = this.fadeSpeed * dt * 60;
    if (this.fading) {
      this.opacity -= delta;
      if (this.opacity <= 0) {
        this.opacity = 0;
        this.fading = false;
      }
    } else {
      this.opacity += delta;
      if (this.opacity >= this.maxOpacity) {
        this.opacity = this.maxOpacity;
        this.fading = true;
      }
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity / 255));
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class Explosion {
  constructor(center, spritesheet, columns = 5, rows = 1, frameRate = 0.05) {
    this.frames = [];
    this.frameIndex = 0;
    this.elapsed = 0;
    this.frameRate = frameRate;
    const frameWidth = spritesheet.width / columns;
    const frameHeight = spritesheet.height / rows;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        ctx.clearRect(0, 0, frameWidth, frameHeight);
        ctx.drawImage(
          spritesheet,
          col * frameWidth,
          row * frameHeight,
          frameWidth,
          frameHeight,
          0,
          0,
          frameWidth,
          frameHeight,
        );
        const frame = new Image();
        frame.src = canvas.toDataURL();
        this.frames.push(frame);
      }
    }

    this.image = this.frames[0];
    this.x = center.x - this.image.width / 2;
    this.y = center.y - this.image.height / 2;
    this.done = false;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.frameRate) {
      this.elapsed = 0;
      this.frameIndex += 1;
      if (this.frameIndex >= this.frames.length) {
        this.done = true;
        return;
      }
      this.image = this.frames[this.frameIndex];
    }
  }

  draw(ctx) {
    if (!this.image) return;
    ctx.drawImage(this.image, this.x, this.y);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class Bullet {
  constructor(x, y, image, speedx = 10, angle = 0) {
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    if (speedx > 0) {
      this.x = x;
    } else {
      this.x = x - this.width;
    }
    this.y = y - this.height / 2;
    this.speedx = speedx;
    this.angle = angle;
    this.speedy = speedx * Math.tan((angle * Math.PI) / 180);
    this.dead = false;
  }

  update(dt) {
    this.x += this.speedx * dt * 60;
    this.y += this.speedy * dt * 60;
    if (this.x > WIDTH || this.x + this.width < 0 || this.y + this.height < 0 || this.y > HEIGHT) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate((Math.atan2(this.speedy, this.speedx)));
    ctx.drawImage(this.image, -this.width / 2, -this.height / 2);
    ctx.restore();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class EnemyBullet {
  constructor(x, y, image, speedx = -8, speedy = 0) {
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    this.x = x - this.width / 2;
    this.y = y - this.height / 2;
    this.speedx = speedx;
    this.speedy = speedy;
    this.dead = false;
  }

  update(dt, world) {
    const speedMultiplier = world.gameSpeedMultiplier;
    this.x += this.speedx * dt * 60 * speedMultiplier;
    this.y += this.speedy * dt * 60 * speedMultiplier;
    if (this.x + this.width < 0 || this.x > WIDTH || this.y + this.height < 0 || this.y > HEIGHT) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.drawImage(this.image, this.x, this.y);
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class RocketTrailParticle {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = 2 + Math.random() * 2;
    this.alpha = 0.6;
    this.life = 0.5;
    this.elapsed = 0;
    this.speedx = (Math.random() - 0.5) * 2;
    this.speedy = (Math.random() - 0.5) * 2;
    this.dead = false;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.life) {
      this.dead = true;
      return;
    }
    this.x += this.speedx * dt * 60;
    this.y += this.speedy * dt * 60;
    this.alpha = clamp(0, this.alpha - dt * 1.5, 1);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.alpha);
    ctx.fillStyle = '#ffa500';
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class Rocket {
  constructor(x, y, image) {
    this.originalImage = image;
    this.image = image;
    this.x = x - image.width / 2;
    this.y = y - image.height / 2;
    this.width = image.width;
    this.height = image.height;
    this.speed = 8;
    this.rotationSpeed = 2;
    this.angle = 0;
    this.dead = false;
    this.trailTimer = 0;
  }

  update(dt, world) {
    const target = this.findNearestTarget(world);
    if (target) {
      const centerX = this.x + this.width / 2;
      const centerY = this.y + this.height / 2;
      const dx = target.x + target.width / 2 - centerX;
      const dy = target.y + target.height / 2 - centerY;
      const targetAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
      let angleDiff = (targetAngle - this.angle + 360) % 360;
      if (angleDiff > 180) angleDiff -= 360;
      this.angle += Math.max(-this.rotationSpeed, Math.min(this.rotationSpeed, angleDiff));
    }
    const rad = (this.angle * Math.PI) / 180;
    this.x += Math.cos(rad) * this.speed * dt * 60;
    this.y += Math.sin(rad) * this.speed * dt * 60;
    this.trailTimer += dt;
    if (this.trailTimer >= 0.05) {
      this.trailTimer = 0;
      world.particles.push(new RocketTrailParticle(this.x + this.width / 2, this.y + this.height / 2));
    }
    if (this.x + this.width < 0 || this.x > WIDTH || this.y + this.height < 0 || this.y > HEIGHT) {
      this.dead = true;
    }
  }

  findNearestTarget(world) {
    let nearest = null;
    let minDist = Infinity;
    const candidates = [...world.enemies, ...world.asteroids];
    const cx = this.x + this.width / 2;
    const cy = this.y + this.height / 2;
    candidates.forEach((entity) => {
      const dx = entity.x + entity.width / 2 - cx;
      const dy = entity.y + entity.height / 2 - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < minDist) {
        minDist = dist;
        nearest = entity;
      }
    });
    return nearest;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate((this.angle * Math.PI) / 180);
    ctx.drawImage(this.originalImage, -this.width / 2, -this.height / 2);
    ctx.restore();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class Enemy {
  constructor(image, thrusterFrames, level = 1, moveRandomly = false) {
    this.image = image;
    this.originalImage = image;
    this.thrusterFrames = thrusterFrames;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.frameRate = 0.05;
    this.width = image.width + thrusterFrames[0].width;
    this.height = Math.max(image.height, thrusterFrames[0].height);
    this.x = WIDTH + 50 + Math.random() * 100;
    this.y = Math.random() * (HEIGHT - this.height);
    this.speedx = -3 - (level - 1) - Math.random() * 2;
    this.speedy = moveRandomly ? (Math.random() * 4 - 2) : 0;
    this.moveRandomly = moveRandomly;
    this.level = level;
    this.shootDelay = 1.5 - Math.min(1, (level - 1) * 0.1) + Math.random();
    this.shootTimer = 0;
    this.dead = false;
  }

  update(dt, world) {
    const multiplier = world.gameSpeedMultiplier;
    this.x += this.speedx * dt * 60 * multiplier;
    this.y += this.speedy * dt * 60 * multiplier;
    if (this.y < 0 || this.y + this.height > HEIGHT) {
      this.speedy *= -1;
      this.y = clamp(this.y, 0, HEIGHT - this.height);
    }
    if (this.x + this.width < 0) {
      this.dead = true;
      return;
    }
    this.shootTimer += dt;
    if (this.shootTimer >= this.shootDelay) {
      this.shootTimer = 0;
      const bullet = new EnemyBullet(this.x, this.y + this.height / 2, world.assets.enemy_bullet_img);
      world.enemyBullets.push(bullet);
    }
    this.frameTimer += dt;
    if (this.frameTimer >= this.frameRate) {
      this.frameTimer = 0;
      this.frameIndex = (this.frameIndex + 1) % this.thrusterFrames.length;
    }
  }

  draw(ctx) {
    const thruster = this.thrusterFrames[this.frameIndex];
    ctx.drawImage(this.originalImage, this.x, this.y + (this.height - this.originalImage.height) / 2);
    ctx.drawImage(thruster, this.x + this.originalImage.width, this.y + (this.height - thruster.height) / 2);
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class Boss {
  constructor(image, level = 1) {
    this.image = image;
    this.width = image.width;
    this.height = image.height;
    this.x = WIDTH;
    this.y = HEIGHT / 2 - this.height / 2;
    this.speedx = (-1 - (level - 1) * 0.5);
    this.level = level;
    this.shootDelay = Math.max(0.5, 1 - (level - 1) * 0.1);
    this.shootTimer = 0;
    this.health = 5 + (level - 1) * 5;
    this.dead = false;
  }

  update(dt, world) {
    const multiplier = world.gameSpeedMultiplier;
    this.x += this.speedx * dt * 60 * multiplier;
    if (this.x <= WIDTH - 150 - this.width) {
      this.speedx = 0;
    }
    this.shootTimer += dt;
    if (this.shootTimer >= this.shootDelay) {
      this.shootTimer = 0;
      const angles = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
      angles.forEach((angle) => {
        const rad = (angle * Math.PI) / 180;
        const bullet = new EnemyBullet(
          this.x + this.width / 2,
          this.y + this.height / 2,
          world.assets.enemy_bullet_img,
          -8 * Math.cos(rad),
          -8 * Math.sin(rad),
        );
        world.enemyBullets.push(bullet);
      });
    }
    if (this.health <= 0) {
      this.dead = true;
    }
  }

  takeDamage(amount) {
    this.health -= amount;
    if (this.health <= 0) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.drawImage(this.image, this.x, this.y);
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class Asteroid {
  constructor(image, size = 'large') {
    this.baseImage = image;
    this.size = size;
    this.scale = size === 'large' ? 1 : size === 'medium' ? 0.5 : 0.3;
    this.image = this.createScaledImage();
    this.width = this.image.width;
    this.height = this.image.height;
    this.x = WIDTH + Math.random() * 100;
    this.y = Math.random() * (HEIGHT - this.height);
    this.speedx = 2 + Math.random() * 2;
    this.speedy = Math.random() * 4 - 2;
    this.rotation = 0;
    this.rotationSpeed = this.size === 'large' ? Math.random() : this.size === 'medium' ? 1 + Math.random() : 2 + Math.random();
    this.dead = false;
  }

  createScaledImage() {
    const canvas = document.createElement('canvas');
    const width = Math.max(20, this.baseImage.width * this.scale);
    const height = Math.max(20, this.baseImage.height * this.scale);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.baseImage, 0, 0, width, height);
    const image = new Image();
    image.src = canvas.toDataURL();
    return image;
  }

  update(dt, world) {
    const multiplier = world.gameSpeedMultiplier;
    this.rotation += this.rotationSpeed * dt * 60 * multiplier;
    this.x -= this.speedx * dt * 60 * multiplier;
    this.y += this.speedy * dt * 60 * multiplier;
    if (this.x + this.width < 0 || this.y + this.height < 0 || this.y > HEIGHT) {
      this.dead = true;
    }
  }

  breakApart() {
    const mapping = { large: 'medium', medium: 'small', small: null };
    const next = mapping[this.size];
    const pieces = [];
    if (!next) return pieces;
    const count = this.size === 'medium' ? Math.floor(Math.random() * 2) + 2 : this.size === 'large' ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
      const asteroid = new Asteroid(this.baseImage, next);
      asteroid.x = this.x + this.width / 2 - asteroid.width / 2;
      asteroid.y = this.y + this.height / 2 - asteroid.height / 2;
      asteroid.speedx = Math.random() * 6 - 3;
      asteroid.speedy = Math.random() * 6 - 3;
      pieces.push(asteroid);
    }
    return pieces;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.drawImage(this.image, -this.width / 2, -this.height / 2);
    ctx.restore();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class PowerUp {
  constructor(image, type) {
    this.image = image;
    this.type = type;
    this.width = image.width;
    this.height = image.height;
    this.x = WIDTH + 50 + Math.random() * 100;
    this.y = Math.random() * (HEIGHT - this.height);
    this.speedx = 3;
    this.dead = false;
  }

  update(dt) {
    this.x -= this.speedx * dt * 60;
    if (this.x + this.width < 0) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.drawImage(this.image, this.x, this.y);
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

export class Player {
  constructor({
    image,
    thrusterFrames,
    controls,
    facingLeft = false,
    assets,
    autoFire = true,
  }) {
    this.assets = assets;
    this.originalImage = image;
    this.thrusterFrames = thrusterFrames;
    this.controls = controls;
    this.facingLeft = facingLeft;
    this.autoFire = autoFire;
    this.width = image.width + thrusterFrames[0].width;
    this.height = Math.max(image.height, thrusterFrames[0].height);
    this.x = 100;
    this.y = HEIGHT / 2 - this.height / 2;
    this.speed = 5;
    this.fastSpeed = 8;
    this.shootDelay = 0.5;
    this.shootTimer = 0;
    this.manualShotDelay = 0.25;
    this.manualShotTimer = 0;
    this.rocketDelay = 0.7;
    this.rocketTimer = 0;
    this.rocketCount = 3;
    this.poweredUp = false;
    this.powerTimer = 0;
    this.powerDuration = 5;
    this.spreadBulletCount = 1;
    this.alive = true;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.frameRate = 0.05;
  }

  reset(position) {
    this.x = position.x;
    this.y = position.y;
    this.rocketCount = 3;
    this.shootDelay = 0.5;
    this.poweredUp = false;
    this.spreadBulletCount = 1;
    this.alive = true;
    this.powerTimer = 0;
    this.manualShotTimer = 0;
  }

  addRockets(amount) {
    this.rocketCount += amount;
  }

  update(dt, world) {
    if (!this.alive) return;
    const input = world.input;
    const speedKey = input.isPressed(this.controls.speed);
    const currentSpeed = speedKey ? this.fastSpeed : this.speed;
    let velX = 0;
    let velY = 0;
    if (input.isPressed(this.controls.up)) velY -= currentSpeed;
    if (input.isPressed(this.controls.down)) velY += currentSpeed;
    if (input.isPressed(this.controls.left)) velX -= currentSpeed;
    if (input.isPressed(this.controls.right)) velX += currentSpeed;
    this.x += velX * dt * 60;
    this.y += velY * dt * 60;
    this.x = clamp(this.x, 0, WIDTH - this.width);
    this.y = clamp(this.y, 0, HEIGHT - this.height);

    if (this.autoFire) {
      this.shootTimer += dt;
      if (this.shootTimer >= this.shootDelay) {
        this.shootTimer = 0;
        this.shoot(world);
      }
    } else {
      this.manualShotTimer += dt;
      if (this.manualShotTimer >= this.manualShotDelay && world.input.isPressed(this.controls.shoot)) {
        this.manualShotTimer = 0;
        this.shoot(world);
      }
    }

    this.rocketTimer += dt;
    if (input.isPressed(this.controls.rocket) && this.rocketTimer >= this.rocketDelay && this.rocketCount > 0) {
      this.rocketTimer = 0;
      this.rocketCount -= 1;
      const rocket = new Rocket(
        this.x + this.width / 2,
        this.y + this.height / 2,
        this.assets.rocket_img,
      );
      world.rockets.push(rocket);
      world.assets.rocket_sound.currentTime = 0;
      world.assets.rocket_sound.play();
    }

    if (this.poweredUp) {
      this.powerTimer += dt;
      if (this.powerTimer >= this.powerDuration) {
        this.poweredUp = false;
        this.shootDelay = 0.5;
      }
    }

    this.frameTimer += dt;
    if (this.frameTimer >= this.frameRate) {
      this.frameTimer = 0;
      this.frameIndex = (this.frameIndex + 1) % this.thrusterFrames.length;
    }
  }

  shoot(world) {
    const direction = this.facingLeft ? -1 : 1;
    const baseX = this.facingLeft ? this.x : this.x + this.width;
    const centerY = this.y + this.height / 2;
    const spreadAngle = 10;
    const startAngle = -((this.spreadBulletCount - 1) * spreadAngle) / 2;
    for (let i = 0; i < this.spreadBulletCount; i += 1) {
      const angle = startAngle + i * spreadAngle;
      const bulletImage = this.facingLeft ? this.flipImage(world.assets.bullet_img) : world.assets.bullet_img;
      const bullet = new Bullet(baseX, centerY, bulletImage, 10 * direction, angle * direction);
      bullet.owner = this;
      world.bullets.push(bullet);
    }
    world.assets.gun_sound.currentTime = 0;
    world.assets.gun_sound.play();
  }

  flipImage(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(image.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(image, 0, 0);
    const flipped = new Image();
    flipped.src = canvas.toDataURL();
    return flipped;
  }

  draw(ctx) {
    const thruster = this.thrusterFrames[this.frameIndex];
    if (this.facingLeft) {
      ctx.drawImage(this.originalImage, this.x + thruster.width, this.y + (this.height - this.originalImage.height) / 2);
      ctx.drawImage(thruster, this.x, this.y + (this.height - thruster.height) / 2);
    } else {
      ctx.drawImage(thruster, this.x, this.y + (this.height - thruster.height) / 2);
      ctx.drawImage(this.originalImage, this.x + thruster.width, this.y + (this.height - this.originalImage.height) / 2);
    }
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  applyPowerUp(type) {
    switch (type) {
      case POWERUP_TYPES.RAPID_FIRE:
        this.shootDelay = 0.2;
        this.poweredUp = true;
        this.powerTimer = 0;
        break;
      case POWERUP_TYPES.SLOW_MOTION:
        // handled by world
        break;
      case POWERUP_TYPES.KILL_ALL:
        // handled by world
        break;
      case POWERUP_TYPES.SPREAD:
        this.spreadBulletCount += 1;
        break;
      case POWERUP_TYPES.ROCKET:
        this.rocketCount += 1;
        break;
      default:
        break;
    }
  }
}

export function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
