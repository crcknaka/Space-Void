(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});
  const shared = SpaceVoid.shared;
  if (!shared) {
    throw new Error('Shared module must be loaded before single-player module.');
  }

  const {
    WIDTH,
    HEIGHT,
    POWERUP_TYPES,
    GAME_STATE,
    clamp,
    randomRange,
    intersects,
    bulletAsteroidHit,
  } = shared;

class Star {
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

class StaticStar {
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

class Explosion {
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

class Bullet {
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
    this.prevX = this.x;
    this.prevY = this.y;
    this.speedx = speedx;
    this.angle = angle;
    this.speedy = speedx * Math.tan((angle * Math.PI) / 180);
    this.dead = false;
  }

  update(dt) {
    this.prevX = this.x;
    this.prevY = this.y;
    this.x += this.speedx * dt * 60;
    this.y += this.speedy * dt * 60;
    if (this.x > WIDTH || this.x + this.width < 0 || this.y + this.height < 0 || this.y > HEIGHT) {
      this.dead = true;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate(Math.atan2(this.speedy, this.speedx));
    ctx.drawImage(this.image, -this.width / 2, -this.height / 2);
    ctx.restore();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  getCenter() {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }

  getPreviousCenter() {
    return { x: this.prevX + this.width / 2, y: this.prevY + this.height / 2 };
  }
}

class EnemyBullet {
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

class RocketTrailParticle {
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

class Rocket {
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

class Enemy {
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
    const thrusterX = this.x + this.originalImage.width;
    const thrusterY = this.y + (this.height - thruster.height) / 2;
    ctx.save();
    ctx.translate(thrusterX + thruster.width / 2, thrusterY + thruster.height / 2);
    ctx.rotate(Math.PI);
    ctx.drawImage(thruster, -thruster.width / 2, -thruster.height / 2);
    ctx.restore();
  }

  getBounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }
}

class Boss {
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

class Asteroid {
  constructor(image, size = 'large') {
    this.baseImage = image;
    this.size = size;
    this.scale = size === 'large' ? 1 : size === 'medium' ? 0.5 : 0.3;
    this.image = this.createScaledImage();
    this.width = this.image.width;
    this.height = this.image.height;
    this.radius = Math.max(this.width, this.height) / 2;
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
    return canvas;
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

class PowerUp {
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

class Player {
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
    return canvas;
  }

  draw(ctx) {
    const thruster = this.thrusterFrames[this.frameIndex];
    const shipY = this.y + (this.height - this.originalImage.height) / 2;
    const thrusterY = this.y + (this.height - thruster.height) / 2;
    if (this.facingLeft) {
      const shipX = this.x;
      const thrusterX = shipX + this.originalImage.width;
      ctx.drawImage(this.originalImage, shipX, shipY);
      ctx.save();
      ctx.translate(thrusterX + thruster.width / 2, thrusterY + thruster.height / 2);
      ctx.rotate(Math.PI);
      ctx.drawImage(thruster, -thruster.width / 2, -thruster.height / 2);
      ctx.restore();
    } else {
      ctx.drawImage(thruster, this.x, thrusterY);
      ctx.drawImage(this.originalImage, this.x + thruster.width, shipY);
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

function createStarLayers(count, width, height) {
  const layers = [];
  for (let layerIndex = 0; layerIndex < count; layerIndex += 1) {
    const stars = [];
    for (let i = 0; i < 50; i += 1) {
      stars.push(
        new Star(
          Math.random() * width,
          Math.random() * height,
          randomRange(0.1 * (layerIndex + 1), 1.1 * (layerIndex + 1)),
          Math.floor(randomRange(1, 3)),
          Math.floor(randomRange(30, 100)),
        ),
      );
    }
    layers.push(stars);
  }
  return layers;
}

function createStaticStars(width, height) {
  const colors = ['#ffffff', '#66aaff', '#aaccff'];
  return Array.from({ length: 100 }, () => new StaticStar(
    Math.random() * width,
    Math.random() * height,
    Math.floor(randomRange(1, 4)),
    Math.floor(randomRange(50, 200)),
    colors[Math.floor(Math.random() * colors.length)],
  ));
}

class GameWorld {
  constructor({ assets, input, mode = 'single', onGameOver }) {
    this.assets = assets;
    this.input = input;
    this.mode = mode;
    this.onGameOver = onGameOver;
    this.players = [];
    this.bullets = [];
    this.enemyBullets = [];
    this.rockets = [];
    this.enemies = [];
    this.asteroids = [];
    this.powerups = [];
    this.explosions = [];
    this.particles = [];
    this.boss = null;
    this.score = 0;
    this.level = 1;
    this.nextBossScore = 100;
    this.enemySpawnTimer = 0;
    this.enemySpawnInterval = 2;
    this.powerupSpawnTimer = 0;
    this.powerupSpawnInterval = 10;
    this.asteroidSpawnTimer = 0;
    this.asteroidSpawnInterval = 5;
    this.gameSpeedMultiplier = 1;
    this.slowMotionTimer = 0;
    this.backgroundOffset = 0;
    this.background = this.assets.game_background;
    this.starLayers = createStarLayers(3, WIDTH, HEIGHT);
    this.staticStars = createStaticStars(WIDTH, HEIGHT);
    this.cooperative = mode === 'coop';
    this.paused = false;
    this.state = GAME_STATE.GAME;
    this.music = this.assets.background_music;
    this.music.loop = true;
    this.music.volume = 0.4;
    this.music.play().catch(() => {});
    this.setupPlayers();
  }

  setupPlayers() {
    const player1 = new Player({
      image: this.assets.player1_img,
      thrusterFrames: this.assets.player1_thruster_frames,
      controls: this.mode === 'versus' ? {
        up: 'KeyW',
        down: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        shoot: 'Space',
        rocket: 'Space',
        speed: 'ShiftLeft',
      } : {
        up: 'KeyW',
        down: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        shoot: 'Space',
        rocket: 'ShiftLeft',
        speed: 'ShiftLeft',
      },
      facingLeft: false,
      assets: this.assets,
    });
    player1.reset({ x: 100, y: HEIGHT / 2 - player1.height / 2 });
    this.players.push(player1);

    if (this.cooperative) {
      const player2 = new Player({
        image: this.assets.player2_img,
        thrusterFrames: this.assets.player2_thruster_frames,
        controls: {
          up: 'ArrowUp',
          down: 'ArrowDown',
          left: 'ArrowLeft',
          right: 'ArrowRight',
          shoot: 'Enter',
          rocket: 'Numpad0',
          speed: 'Numpad0',
        },
        facingLeft: false,
        assets: this.assets,
      });
      player2.reset({ x: 100, y: HEIGHT / 3 - player2.height / 2 });
      this.players.push(player2);
    }
  }

  spawnEnemy() {
    const moveRandomly = Math.random() < Math.min(0.1 + (this.level - 1) * 0.05, 0.75);
    this.enemies.push(new Enemy(
      this.assets.enemy_img,
      this.assets.enemy_thruster_frames,
      this.level,
      moveRandomly,
    ));
  }

  spawnPowerUp() {
    const types = [
      POWERUP_TYPES.RAPID_FIRE,
      POWERUP_TYPES.SLOW_MOTION,
      POWERUP_TYPES.KILL_ALL,
      POWERUP_TYPES.ROCKET,
      POWERUP_TYPES.SPREAD,
    ];
    const type = types[Math.floor(Math.random() * types.length)];
    let image = this.assets.powerup_img;
    if (type === POWERUP_TYPES.SLOW_MOTION) image = this.assets.slow_motion_powerup_img;
    if (type === POWERUP_TYPES.KILL_ALL) image = this.assets.kill_all_powerup_img;
    if (type === POWERUP_TYPES.ROCKET) image = this.assets.rocket_powerup_img;
    if (type === POWERUP_TYPES.SPREAD) image = this.assets.spread_powerup_img;
    this.powerups.push(new PowerUp(image, type));
  }

  spawnAsteroid() {
    this.asteroids.push(new Asteroid(this.assets.asteroid_img, 'large'));
  }

  spawnBoss() {
    this.boss = new Boss(this.assets.boss_img, this.level);
    this.enemies.push(this.boss);
    this.players.forEach((player) => player.addRockets(3));
  }

  update(dt) {
    if (this.paused || this.state !== GAME_STATE.GAME) return;

    this.backgroundOffset -= dt * 10 * this.gameSpeedMultiplier;
    if (this.backgroundOffset <= -WIDTH) {
      this.backgroundOffset += WIDTH;
    }

    this.starLayers.forEach((layer) => layer.forEach((star) => star.update(dt)));
    this.staticStars.forEach((star) => star.update(dt));

    this.players.forEach((player) => player.update(dt, this));

    this.enemySpawnTimer += dt;
    if (this.enemySpawnTimer >= this.enemySpawnInterval) {
      this.enemySpawnTimer = 0;
      this.spawnEnemy();
    }

    this.powerupSpawnTimer += dt;
    if (this.powerupSpawnTimer >= this.powerupSpawnInterval) {
      this.powerupSpawnTimer = 0;
      this.spawnPowerUp();
    }

    this.asteroidSpawnTimer += dt;
    if (this.asteroidSpawnTimer >= this.asteroidSpawnInterval) {
      this.asteroidSpawnTimer = 0;
      this.spawnAsteroid();
    }

    if (!this.boss && this.score >= this.nextBossScore) {
      this.spawnBoss();
    }

    this.updateEntities(dt);
    this.handleCollisions();
    this.updateSlowMotion(dt);
    this.cleanup();

    if (this.players.every((player) => !player.alive)) {
      this.finishGame();
    }
  }

  updateEntities(dt) {
    this.bullets.forEach((bullet) => bullet.update(dt));
    this.enemyBullets.forEach((bullet) => bullet.update(dt, this));
    this.rockets.forEach((rocket) => rocket.update(dt, this));
    this.enemies.forEach((enemy) => enemy.update(dt, this));
    this.asteroids.forEach((asteroid) => asteroid.update(dt, this));
    this.powerups.forEach((powerup) => powerup.update(dt, this));
    this.explosions.forEach((explosion) => explosion.update(dt));
    this.particles.forEach((particle) => particle.update(dt));
  }

  handleCollisions() {
    this.handleBulletEnemyCollisions();
    this.handleBulletAsteroidCollisions();
    this.handleRocketCollisions();
    this.handleEnemyBulletPlayerCollisions();
    this.handleEnemyPlayerCollisions();
    this.handleAsteroidPlayerCollisions();
    this.handlePowerUpCollisions();
  }

  handleBulletEnemyCollisions() {
    this.enemies.forEach((enemy) => {
      if (enemy.dead) return;
      const enemyBounds = enemy.getBounds();
      this.bullets.forEach((bullet) => {
        if (bullet.dead) return;
        if (intersects(enemyBounds, bullet.getBounds())) {
          bullet.dead = true;
          if (enemy instanceof Boss) {
            enemy.takeDamage(1);
            if (enemy.dead) {
              this.defeatBoss(enemy);
            }
          } else {
            enemy.dead = true;
            this.createExplosion(enemyBounds);
            this.score += 10;
          }
        }
      });
    });
  }

  handleBulletAsteroidCollisions() {
    for (const asteroid of this.asteroids) {
      if (asteroid.dead) continue;
      const bounds = asteroid.getBounds();
      for (const bullet of this.bullets) {
        if (bullet.dead) continue;
        const collided = intersects(bounds, bullet.getBounds()) || bulletAsteroidHit(bullet, asteroid);
        if (!collided) continue;
        bullet.dead = true;
        asteroid.dead = true;
        this.createExplosion(bounds);
        this.score += 5;
        asteroid.breakApart().forEach((piece) => this.asteroids.push(piece));
        break;
      }
    }
  }

  handleRocketCollisions() {
    this.rockets.forEach((rocket) => {
      if (rocket.dead) return;
      const rocketBounds = rocket.getBounds();
      this.enemies.forEach((enemy) => {
        if (enemy.dead) return;
        if (intersects(rocketBounds, enemy.getBounds())) {
          rocket.dead = true;
          if (enemy instanceof Boss) {
            enemy.takeDamage(4);
            if (enemy.dead) {
              this.defeatBoss(enemy);
            }
          } else {
            enemy.dead = true;
            this.createExplosion(enemy.getBounds());
            this.score += 20;
          }
        }
      });
      this.asteroids.forEach((asteroid) => {
        if (asteroid.dead) return;
        if (intersects(rocketBounds, asteroid.getBounds())) {
          rocket.dead = true;
          asteroid.dead = true;
          this.createExplosion(asteroid.getBounds());
          this.score += 10;
        }
      });
    });
  }

  handleEnemyBulletPlayerCollisions() {
    this.players.forEach((player) => {
      if (!player.alive) return;
      const bounds = player.getBounds();
      this.enemyBullets.forEach((bullet) => {
        if (bullet.dead) return;
        if (intersects(bounds, bullet.getBounds())) {
          bullet.dead = true;
          player.alive = false;
          this.createExplosion(bounds);
          this.assets.explosion_sound.currentTime = 0;
          this.assets.explosion_sound.play();
        }
      });
    });
  }

  handleEnemyPlayerCollisions() {
    this.players.forEach((player) => {
      if (!player.alive) return;
      const bounds = player.getBounds();
      this.enemies.forEach((enemy) => {
        if (enemy.dead) return;
        if (intersects(bounds, enemy.getBounds())) {
          if (enemy instanceof Boss) {
            this.defeatBoss(enemy);
          } else {
            enemy.dead = true;
          }
          player.alive = false;
          this.createExplosion(bounds);
          this.assets.explosion_sound.currentTime = 0;
          this.assets.explosion_sound.play();
        }
      });
    });
  }

  handleAsteroidPlayerCollisions() {
    this.players.forEach((player) => {
      if (!player.alive) return;
      const bounds = player.getBounds();
      this.asteroids.forEach((asteroid) => {
        if (asteroid.dead) return;
        if (intersects(bounds, asteroid.getBounds())) {
          asteroid.dead = true;
          player.alive = false;
          this.createExplosion(bounds);
          this.assets.explosion_sound.currentTime = 0;
          this.assets.explosion_sound.play();
        }
      });
    });
  }

  handlePowerUpCollisions() {
    this.players.forEach((player) => {
      if (!player.alive) return;
      const bounds = player.getBounds();
      this.powerups.forEach((powerup) => {
        if (powerup.dead) return;
        if (intersects(bounds, powerup.getBounds())) {
          powerup.dead = true;
          this.applyPowerUp(powerup.type, player);
        }
      });
    });
  }

  applyPowerUp(type, player) {
    this.assets.powerup_sound.currentTime = 0;
    this.assets.powerup_sound.play();
    if (type === POWERUP_TYPES.SLOW_MOTION) {
      this.gameSpeedMultiplier = 0.5;
      this.slowMotionTimer = 10;
    } else if (type === POWERUP_TYPES.KILL_ALL) {
      this.enemies.forEach((enemy) => {
        if (enemy instanceof Boss) return;
        if (!enemy.dead) {
          enemy.dead = true;
          this.createExplosion(enemy.getBounds());
        }
      });
      this.asteroids.forEach((asteroid) => {
        if (!asteroid.dead) {
          asteroid.dead = true;
          this.createExplosion(asteroid.getBounds());
        }
      });
      this.assets.explosion_sound.currentTime = 0;
      this.assets.explosion_sound.play();
    } else if (type === POWERUP_TYPES.RAPID_FIRE) {
      player.applyPowerUp(type);
    } else if (type === POWERUP_TYPES.ROCKET) {
      player.applyPowerUp(type);
    } else if (type === POWERUP_TYPES.SPREAD) {
      player.applyPowerUp(type);
    }
  }

  updateSlowMotion(dt) {
    if (this.slowMotionTimer > 0) {
      this.slowMotionTimer -= dt;
      if (this.slowMotionTimer <= 0) {
        this.gameSpeedMultiplier = 1;
        this.slowMotionTimer = 0;
      }
    }
  }

  createExplosion(bounds) {
    const explosion = new Explosion({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }, this.assets.explosion_spritesheet);
    this.explosions.push(explosion);
    this.assets.explosion_sound.currentTime = 0;
    this.assets.explosion_sound.play();
  }

  defeatBoss(boss) {
    boss.dead = true;
    this.createExplosion(boss.getBounds());
    this.score += 50;
    this.level += 1;
    this.nextBossScore += this.level * 100;
    this.enemySpawnInterval = Math.max(0.5, this.enemySpawnInterval - 0.2);
    this.asteroidSpawnInterval = Math.max(2, this.asteroidSpawnInterval - 0.5);
    this.players.forEach((player) => { player.rocketCount += 3; });
    this.boss = null;
  }

  cleanup() {
    this.bullets = this.bullets.filter((bullet) => !bullet.dead);
    this.enemyBullets = this.enemyBullets.filter((bullet) => !bullet.dead);
    this.rockets = this.rockets.filter((rocket) => !rocket.dead);
    this.enemies = this.enemies.filter((enemy) => !enemy.dead);
    this.asteroids = this.asteroids.filter((asteroid) => !asteroid.dead);
    this.powerups = this.powerups.filter((powerup) => !powerup.dead);
    this.explosions = this.explosions.filter((explosion) => !explosion.done);
    this.particles = this.particles.filter((particle) => !particle.dead);
  }

  finishGame() {
    this.state = GAME_STATE.GAME_OVER;
    if (this.onGameOver) {
      this.onGameOver({ score: this.score, level: this.level });
    }
  }

  draw(ctx) {
    ctx.drawImage(this.background, this.backgroundOffset, 0);
    ctx.drawImage(this.background, this.backgroundOffset + WIDTH, 0);
    this.starLayers.forEach((layer) => layer.forEach((star) => star.draw(ctx)));
    this.staticStars.forEach((star) => star.draw(ctx));

    this.players.forEach((player) => player.alive && player.draw(ctx));
    this.enemies.forEach((enemy) => enemy.draw(ctx));
    this.asteroids.forEach((asteroid) => asteroid.draw(ctx));
    this.powerups.forEach((powerup) => powerup.draw(ctx));
    this.bullets.forEach((bullet) => bullet.draw(ctx));
    this.enemyBullets.forEach((bullet) => bullet.draw(ctx));
    this.rockets.forEach((rocket) => rocket.draw(ctx));
    this.particles.forEach((particle) => particle.draw(ctx));
    this.explosions.forEach((explosion) => explosion.draw(ctx));

    ctx.fillStyle = '#ffffff';
    ctx.font = '20px Arial';
    ctx.fillText(`Score: ${Math.floor(this.score)}`, 10, 30);
    ctx.fillText(`Level: ${this.level}`, WIDTH - 120, 30);
    this.players.forEach((player, index) => {
      ctx.fillText(`P${index + 1} Rockets: ${player.rocketCount}`, 10, 60 + index * 30);
    });

    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = '#ff4444';
      ctx.font = '48px Arial';
      ctx.fillText('PAUSED', WIDTH / 2 - 80, HEIGHT / 2);
    }
  }
}

SpaceVoid.Star = Star;
SpaceVoid.StaticStar = StaticStar;
SpaceVoid.Explosion = Explosion;
SpaceVoid.Player = Player;
SpaceVoid.GameWorld = GameWorld;

function createSinglePlayerWorld(options) {
  return new GameWorld({ ...options, mode: 'single' });
}

SpaceVoid.createSinglePlayerWorld = createSinglePlayerWorld;
})(window);
