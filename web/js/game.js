(function(){
"use strict";
// BEGIN constants.js
const WIDTH = 600;
const HEIGHT = 880;
const TARGET_FPS = 60;
const FRAME_TIME = 1 / TARGET_FPS;

const POWERUP_TYPES = {
  RAPID_FIRE: 'rapid_fire',
  SLOW_MOTION: 'slow_motion',
  KILL_ALL: 'kill_all',
  SPREAD: 'spread',
  ROCKET: 'rocket',
};

const GAME_STATE = {
  LOADING: 'loading',
  MENU: 'menu',
  GAME: 'game',
  VERSUS: 'versus',
  GAME_OVER: 'game_over',
  PAUSED: 'paused',
  SETTINGS: 'settings',
};

const PLAYER_CONTROLS = {
  player1: {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    shoot: 'Space',
    rocket: 'ShiftLeft',
    speed: 'ShiftLeft',
  },
  player2: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    shoot: 'Enter',
    rocket: 'Numpad0',
    speed: 'Numpad0',
  },
};

const COLORS = {
  white: '#ffffff',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#00aaff',
  orange: '#ff8c00',
  yellow: '#ffe066',
};
// END constants.js

// BEGIN assets.js
const IMAGE_PATH = '../assets/images/';
const SOUND_PATH = '../assets/sounds/';

const IMAGE_ASSETS = {
  player1_img: { file: 'player1_ship.png', size: [50, 30] },
  player1_thruster_frames: {
    files: ['player1_thruster_1.png', 'player1_thruster_2.png', 'player1_thruster_3.png', 'player1_thruster_4.png'],
  },
  player2_img: { file: 'player2_ship.png', size: [50, 30] },
  player2_thruster_frames: {
    files: ['player2_thruster_1.png', 'player2_thruster_2.png', 'player2_thruster_3.png', 'player2_thruster_4.png'],
  },
  enemy_img: { file: 'enemy_ship.png', size: [50, 30] },
  enemy_thruster_frames: {
    files: ['enemy_thruster_1.png', 'enemy_thruster_2.png', 'enemy_thruster_3.png', 'enemy_thruster_4.png'],
  },
  boss_img: { file: 'boss.png', size: [150, 150] },
  bullet_img: { file: 'bullet.png', size: [10, 5] },
  enemy_bullet_img: { file: 'enemy_bullet.png', size: [10, 5] },
  powerup_img: { file: 'powerup.png', size: [60, 30] },
  slow_motion_powerup_img: { file: 'slow_motion_powerup.png', size: [60, 30] },
  kill_all_powerup_img: { file: 'kill_all_powerup.png', size: [60, 30] },
  spread_powerup_img: { file: 'spread_powerup.png', size: [60, 30] },
  rocket_powerup_img: { file: 'rocket_powerup.png', size: [60, 30] },
  menu_background: { file: 'menu_background.png' },
  game_background: { file: 'game_background.png' },
  versus_background: { file: 'versus_background.png' },
  explosion_spritesheet: { file: 'explosion_spritesheet.png' },
  asteroid_img: { file: 'asteroid.png' },
  rocket_img: { file: 'rocket.png', size: [20, 10] },
};

const SOUND_ASSETS = {
  explosion_sound: 'explosion.wav',
  gun_sound: 'gun.wav',
  powerup_sound: 'powerup.wav',
  rocket_sound: 'rocket.wav',
  hover_sound: 'hover.wav',
  click_sound: 'click.wav',
  background_music: 'background_music.mp3',
  versus_music: 'versus_music.mp3',
  player1_kill_sound: 'player1_kill.wav',
  player2_kill_sound: 'player2_kill.wav',
};

function loadImage(src, size) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (size) {
        const [width, height] = size;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, width, height);
        resolve(canvas);
      } else {
        resolve(image);
      }
    };
    image.onerror = reject;
    image.crossOrigin = 'anonymous';
    image.src = `${IMAGE_PATH}${src}`;
  });
}

function loadAudio(src) {
  const audio = new Audio(`${SOUND_PATH}${src}`);
  audio.preload = 'auto';
  return audio;
}

async function loadAssets(updateProgress) {
  const assets = {};
  let loaded = 0;
  const total = Object.keys(IMAGE_ASSETS).length + Object.keys(SOUND_ASSETS).length;

  const increment = () => {
    loaded += 1;
    if (updateProgress) {
      updateProgress(loaded / total);
    }
  };

  const imagePromises = Object.entries(IMAGE_ASSETS).map(async ([key, descriptor]) => {
    if ('files' in descriptor) {
      const frames = await Promise.all(descriptor.files.map((file) => loadImage(file)));
      assets[key] = frames;
    } else {
      assets[key] = await loadImage(descriptor.file, descriptor.size);
    }
    increment();
  });

  await Promise.all(imagePromises);

  Object.entries(SOUND_ASSETS).forEach(([key, file]) => {
    assets[key] = loadAudio(file);
    increment();
  });

  return assets;
}
// END assets.js

// BEGIN input.js
class InputManager {
  constructor() {
    this.keys = new Set();
    this.listeners = new Map();
    this.moveTouchId = null;
    this.touchStart = { x: 0, y: 0 };
    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));
    this.setupTouchControls();
  }

  handleKey(event, pressed) {
    if (event.repeat) return;
    const key = event.code;
    this.updateKeyState(key, pressed);
  }

  isPressed(code) {
    return this.keys.has(code);
  }

  onKey(code, callback) {
    if (!this.listeners.has(code)) {
      this.listeners.set(code, []);
    }
    this.listeners.get(code).push(callback);
  }

  updateKeyState(code, pressed) {
    const hasKey = this.keys.has(code);
    if (pressed && !hasKey) {
      this.keys.add(code);
      if (this.listeners.has(code)) {
        this.listeners.get(code).forEach((callback) => callback(true));
      }
    } else if (!pressed && hasKey) {
      this.keys.delete(code);
      if (this.listeners.has(code)) {
        this.listeners.get(code).forEach((callback) => callback(false));
      }
    }
  }

  setVirtualKey(code, pressed) {
    this.updateKeyState(code, pressed);
  }

  setupTouchControls() {
    const moveArea = document.getElementById('touch-move');
    const shootButton = document.getElementById('touch-shoot');
    const rocketButton = document.getElementById('touch-rocket');
    const isTouchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchCapable) return;

    if (moveArea) {
      const startMove = (event) => {
        if (this.moveTouchId !== null) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        this.moveTouchId = touch.identifier;
        this.touchStart.x = touch.clientX;
        this.touchStart.y = touch.clientY;
        this.updateTouchMovement(0, 0);
      };

      const move = (event) => {
        if (this.moveTouchId === null) return;
        const touch = Array.from(event.changedTouches).find((t) => t.identifier === this.moveTouchId);
        if (!touch) return;
        const dx = touch.clientX - this.touchStart.x;
        const dy = touch.clientY - this.touchStart.y;
        this.updateTouchMovement(dx, dy);
      };

      const endMove = (event) => {
        if (this.moveTouchId === null) return;
        const touch = Array.from(event.changedTouches).find((t) => t.identifier === this.moveTouchId);
        if (!touch) return;
        this.moveTouchId = null;
        this.updateTouchMovement(0, 0);
      };

      moveArea.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startMove(event);
      }, { passive: false });
      moveArea.addEventListener('touchmove', (event) => {
        event.preventDefault();
        move(event);
      }, { passive: false });
      moveArea.addEventListener('touchend', (event) => {
        event.preventDefault();
        endMove(event);
      }, { passive: false });
      moveArea.addEventListener('touchcancel', (event) => {
        event.preventDefault();
        endMove(event);
      }, { passive: false });
    }

    const bindButton = (element, code) => {
      if (!element) return;
      element.addEventListener('touchstart', (event) => {
        event.preventDefault();
        this.setVirtualKey(code, true);
      }, { passive: false });
      const release = (event) => {
        event.preventDefault();
        this.setVirtualKey(code, false);
      };
      element.addEventListener('touchend', release, { passive: false });
      element.addEventListener('touchcancel', release, { passive: false });
    };

    bindButton(shootButton, 'Space');
    bindButton(rocketButton, 'ShiftLeft');
  }

  updateTouchMovement(dx, dy) {
    const threshold = 20;
    this.setVirtualKey('KeyW', dy < -threshold);
    this.setVirtualKey('KeyS', dy > threshold);
    this.setVirtualKey('KeyA', dx < -threshold);
    this.setVirtualKey('KeyD', dx > threshold);
  }
}
// END input.js

// BEGIN entities.js

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
// END entities.js

// BEGIN gameWorld.js

function randomRange(min, max) {
  return Math.random() * (max - min) + min;
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
    this.asteroids.forEach((asteroid) => {
      if (asteroid.dead) return;
      const bounds = asteroid.getBounds();
      this.bullets.forEach((bullet) => {
        if (bullet.dead) return;
        if (intersects(bounds, bullet.getBounds())) {
          bullet.dead = true;
          asteroid.dead = true;
          this.createExplosion(bounds);
          this.score += 5;
          asteroid.breakApart().forEach((piece) => this.asteroids.push(piece));
        }
      });
    });
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
// END gameWorld.js

// BEGIN versusWorld.js

function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

function createStarLayers(count) {
  const layers = [];
  for (let i = 0; i < count; i += 1) {
    const stars = [];
    for (let j = 0; j < 50; j += 1) {
      stars.push(new Star(
        Math.random() * WIDTH,
        Math.random() * HEIGHT,
        randomRange(0.1 * (i + 1), 1.1 * (i + 1)),
        Math.floor(randomRange(1, 2)),
        Math.floor(randomRange(30, 100)),
      ));
    }
    layers.push(stars);
  }
  return layers;
}

function createStaticStars() {
  const colors = ['#ffffff', '#66aaff', '#aaccff'];
  return Array.from({ length: 100 }, () => new StaticStar(
    Math.random() * WIDTH,
    Math.random() * HEIGHT,
    Math.floor(randomRange(1, 3)),
    Math.floor(randomRange(50, 200)),
    colors[Math.floor(Math.random() * colors.length)],
  ));
}

function flipImage(image) {
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

function flipFrames(frames) {
  return frames.map((frame) => flipImage(frame));
}

class VersusWorld {
  constructor({ assets, input, onGameOver }) {
    this.assets = assets;
    this.input = input;
    this.onGameOver = onGameOver;
    this.players = [];
    this.bullets = [];
    this.rockets = [];
    this.enemies = [];
    this.asteroids = [];
    this.particles = [];
    this.explosions = [];
    this.starLayers = createStarLayers(3);
    this.staticStars = createStaticStars();
    this.background = this.assets.versus_background;
    this.backgroundOffset = 0;
    this.scoreLimit = 10;
    this.scores = [0, 0];
    this.respawnTimers = [0, 0];
    this.paused = false;
    this.state = GAME_STATE.GAME;
    this.music = this.assets.versus_music;
    this.music.loop = true;
    this.music.volume = 0.45;
    this.music.play().catch(() => {});
    this.setupPlayers();
  }

  setupPlayers() {
    const player1 = new Player({
      image: this.assets.player1_img,
      thrusterFrames: this.assets.player1_thruster_frames,
      controls: {
        up: 'KeyW',
        down: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        shoot: 'Space',
        rocket: 'Space',
        speed: 'ShiftLeft',
      },
      facingLeft: false,
      assets: this.assets,
      autoFire: false,
    });
    player1.reset({ x: 80, y: HEIGHT / 2 - player1.height / 2 });
    player1.rocketCount = 0;
    this.players.push(player1);

    const flippedShip = flipImage(this.assets.player2_img);
    const flippedThrusters = flipFrames(this.assets.player2_thruster_frames);
    const player2 = new Player({
      image: flippedShip,
      thrusterFrames: flippedThrusters,
      controls: {
        up: 'ArrowUp',
        down: 'ArrowDown',
        left: 'ArrowLeft',
        right: 'ArrowRight',
        shoot: 'Enter',
        rocket: 'Enter',
        speed: 'Numpad0',
      },
      facingLeft: true,
      assets: this.assets,
      autoFire: false,
    });
    player2.reset({ x: WIDTH - player2.width - 80, y: HEIGHT / 2 - player2.height / 2 });
    player2.rocketCount = 0;
    this.players.push(player2);
  }

  update(dt) {
    if (this.paused || this.state !== GAME_STATE.GAME) return;

    this.backgroundOffset -= dt * 15;
    if (this.backgroundOffset <= -WIDTH) {
      this.backgroundOffset += WIDTH;
    }

    this.starLayers.forEach((layer) => layer.forEach((star) => star.update(dt)));
    this.staticStars.forEach((star) => star.update(dt));

    this.players.forEach((player, index) => {
      if (player.alive) {
        player.update(dt, this);
      } else {
        this.respawnTimers[index] -= dt;
        if (this.respawnTimers[index] <= 0) {
          this.respawn(index);
        }
      }
    });

    this.bullets.forEach((bullet) => bullet.update(dt));
    this.handleCollisions();
    this.cleanup();

    const winnerIndex = this.scores.findIndex((score) => score >= this.scoreLimit);
    if (winnerIndex !== -1) {
      this.finishGame(winnerIndex);
    }
  }

  handleCollisions() {
    this.bullets.forEach((bullet) => {
      if (bullet.dead) return;
      this.players.forEach((player, index) => {
        if (!player.alive || bullet.owner === player) return;
        if (intersects(player.getBounds(), bullet.getBounds())) {
          bullet.dead = true;
          player.alive = false;
          this.scores[(index + 1) % 2] += 1;
          this.createExplosion(player.getBounds());
          this.assets[`player${index + 1}_kill_sound`]?.play?.();
          this.respawnTimers[index] = 2;
        }
      });
    });
  }

  respawn(index) {
    const player = this.players[index];
    const spawnX = index === 0 ? 80 : WIDTH - player.width - 80;
    const spawnY = randomRange(80, HEIGHT - 80 - player.height);
    player.reset({ x: spawnX, y: spawnY });
    player.rocketCount = 0;
    this.respawnTimers[index] = 0;
  }

  cleanup() {
    this.bullets = this.bullets.filter((bullet) => !bullet.dead);
    this.explosions = this.explosions.filter((explosion) => !explosion.done);
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

  finishGame(winnerIndex) {
    this.state = GAME_STATE.GAME_OVER;
    if (this.onGameOver) {
      this.onGameOver({ winner: winnerIndex + 1, scores: this.scores });
    }
  }

  draw(ctx) {
    ctx.drawImage(this.background, this.backgroundOffset, 0);
    ctx.drawImage(this.background, this.backgroundOffset + WIDTH, 0);
    this.starLayers.forEach((layer) => layer.forEach((star) => star.draw(ctx)));
    this.staticStars.forEach((star) => star.draw(ctx));

    this.players.forEach((player) => player.alive && player.draw(ctx));
    this.bullets.forEach((bullet) => bullet.draw(ctx));
    this.explosions.forEach((explosion) => explosion.draw(ctx));

    ctx.fillStyle = '#ffffff';
    ctx.font = '24px Arial';
    ctx.fillText(`P1 Score: ${this.scores[0]}`, 20, 40);
    const text = `P2 Score: ${this.scores[1]}`;
    ctx.fillText(text, WIDTH - ctx.measureText(text).width - 20, 40);

    if (this.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = '#ff4444';
      ctx.font = '48px Arial';
      ctx.fillText('PAUSED', WIDTH / 2 - 80, HEIGHT / 2);
    }
  }
}
// END versusWorld.js

// BEGIN ui.js
class UIManager {
  constructor(overlayElement) {
    this.overlay = overlayElement;
    this.currentHandler = null;
  }

  clear() {
    this.overlay.innerHTML = '';
    this.overlay.style.display = 'none';
    if (this.currentHandler) {
      this.currentHandler();
      this.currentHandler = null;
    }
  }

  showLoading(progress) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div style="text-align:center;">
        <h1>Loading Assets</h1>
        <div style="width:240px;height:20px;border:1px solid #666;border-radius:4px;overflow:hidden;margin-top:16px;">
          <div style="width:${Math.floor(progress * 100)}%;height:100%;background:#00aaff;"></div>
        </div>
        <p style="margin-top:8px;">${Math.floor(progress * 100)}%</p>
      </div>
    `;
  }

  showMenu({ onStartSingle, onStartCoop, onStartVersus, onSettings }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Space Void</h1>
        <p class="menu__subtitle">Arcade Shooter</p>
        <button class="menu__button" data-action="single">Single Player</button>
        <button class="menu__button" data-action="coop">Co-op Mode</button>
        <button class="menu__button" data-action="versus">Versus Mode</button>
        <button class="menu__button menu__button--secondary" data-action="settings">Settings</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'single') onStartSingle();
      if (action === 'coop') onStartCoop();
      if (action === 'versus') onStartVersus();
      if (action === 'settings') onSettings();
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showSettings({ onBack, initialMusicVolume, initialSoundVolume, onChangeMusic, onChangeSound }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h2 class="menu__title">Settings</h2>
        <label class="menu__label">
          Music Volume
          <input type="range" min="0" max="1" step="0.05" value="${initialMusicVolume}" data-setting="music" />
        </label>
        <label class="menu__label">
          Sound Volume
          <input type="range" min="0" max="1" step="0.05" value="${initialSoundVolume}" data-setting="sound" />
        </label>
        <button class="menu__button menu__button--secondary" data-action="back">Back</button>
      </div>
    `;
    const cleanup = () => {
      this.overlay.removeEventListener('input', handler);
      this.overlay.removeEventListener('click', handler);
    };

    const handler = (event) => {
      if (event.type === 'input') {
        if (!(event.target instanceof HTMLInputElement)) return;
        const { setting } = event.target.dataset;
        const numericValue = Number(event.target.value);
        if (setting === 'music') {
          onChangeMusic(numericValue);
        } else if (setting === 'sound') {
          onChangeSound(numericValue);
        }
      } else if (event.type === 'click') {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.dataset.action === 'back') {
          cleanup();
          onBack();
        }
      }
    };

    this.overlay.addEventListener('input', handler);
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showGameOver({ score, level, onRetry, onMenu }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Game Over</h1>
        <p class="menu__subtitle">Score: ${score}</p>
        <p class="menu__subtitle">Level: ${level}</p>
        <button class="menu__button" data-action="retry">Retry</button>
        <button class="menu__button menu__button--secondary" data-action="menu">Main Menu</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'retry') {
        onRetry();
      } else if (action === 'menu') {
        onMenu();
      }
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showVersusGameOver({ winner, scores, onRematch, onMenu }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Versus Complete</h1>
        <p class="menu__subtitle">Winner: Player ${winner}</p>
        <p class="menu__subtitle">P1 ${scores[0]} - P2 ${scores[1]}</p>
        <button class="menu__button" data-action="rematch">Rematch</button>
        <button class="menu__button menu__button--secondary" data-action="menu">Main Menu</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'rematch') onRematch();
      if (action === 'menu') onMenu();
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }
}
// END ui.js

// BEGIN main.js

const container = document.getElementById('game-container');
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const fullscreenButton = document.getElementById('fullscreen-button');
const menuButton = document.getElementById('menu-button');

function isFullscreenActive() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function requestFullscreen(element) {
  if (!element) return Promise.reject(new Error('No element to fullscreen'));
  if (element.requestFullscreen) return element.requestFullscreen();
  if (element.webkitRequestFullscreen) return element.webkitRequestFullscreen();
  if (element.mozRequestFullScreen) return element.mozRequestFullScreen();
  if (element.msRequestFullscreen) return element.msRequestFullscreen();
  return Promise.reject(new Error('Fullscreen API not supported'));
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
  if (document.msExitFullscreen) return document.msExitFullscreen();
  return Promise.reject(new Error('Fullscreen API not supported'));
}

function updateFullscreenButton() {
  if (!fullscreenButton) return;
  const active = Boolean(isFullscreenActive());
  fullscreenButton.textContent = active ? 'EXIT FULL SCREEN' : 'FULL SCREEN';
  fullscreenButton.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function resizeGameArea() {
  if (!container) return;
  const bodyStyles = window.getComputedStyle(document.body);
  const safeLeft = parseFloat(bodyStyles.paddingLeft) || 0;
  const safeRight = parseFloat(bodyStyles.paddingRight) || 0;
  const safeTop = parseFloat(bodyStyles.paddingTop) || 0;
  const safeBottom = parseFloat(bodyStyles.paddingBottom) || 0;
  const availableWidth = window.innerWidth - safeLeft - safeRight;
  const availableHeight = window.innerHeight - safeTop - safeBottom;
  const scale = Math.min(availableWidth / WIDTH, availableHeight / HEIGHT);
  const scaledWidth = WIDTH * scale;
  const scaledHeight = HEIGHT * scale;
  const offsetX = Math.max((availableWidth - scaledWidth) / 2, 0);
  const offsetY = Math.max((availableHeight - scaledHeight) / 2, 0);

  container.style.transform = `scale(${scale})`;
  container.style.left = `${safeLeft + offsetX}px`;
  container.style.top = `${safeTop + offsetY}px`;
}

window.addEventListener('resize', resizeGameArea);
window.addEventListener('orientationchange', resizeGameArea);
document.addEventListener('fullscreenchange', () => {
  updateFullscreenButton();
  resizeGameArea();
});
document.addEventListener('webkitfullscreenchange', () => {
  updateFullscreenButton();
  resizeGameArea();
});
document.addEventListener('mozfullscreenchange', () => {
  updateFullscreenButton();
  resizeGameArea();
});
document.addEventListener('MSFullscreenChange', () => {
  updateFullscreenButton();
  resizeGameArea();
});
resizeGameArea();

const input = new InputManager();
const ui = new UIManager(overlay);

let assets = null;
let currentWorld = null;
let currentState = GAME_STATE.LOADING;
let lastTimestamp = 0;
let accumulator = 0;
let musicVolume = 0.5;
let soundVolume = 0.7;

if (fullscreenButton) {
  fullscreenButton.addEventListener('click', () => {
    const active = Boolean(isFullscreenActive());
    try {
      const action = active ? exitFullscreen() : requestFullscreen(container);
      if (action && typeof action.then === 'function') {
        action.catch(() => {});
      }
    } catch (error) {
      // Ignore unsupported fullscreen errors.
    }
  });
  updateFullscreenButton();
}

if (menuButton) {
  menuButton.addEventListener('click', () => {
    showMainMenu();
  });
}

function stopAllMusic() {
  if (!assets) return;
  ['background_music', 'versus_music'].forEach((key) => {
    const track = assets[key];
    if (track && typeof track.pause === 'function') {
      track.pause();
      track.currentTime = 0;
    }
  });
}

function applyVolumeSettings() {
  if (!assets) return;
  ['background_music', 'versus_music'].forEach((key) => {
    const track = assets[key];
    if (track) {
      track.volume = musicVolume;
    }
  });

  Object.entries(assets).forEach(([key, value]) => {
    if (key.endsWith('_sound') || key === 'gun_sound' || key === 'rocket_sound') {
      if (value) {
        value.volume = soundVolume;
      }
    }
  });
}

function startGame(mode) {
  if (!assets) return;
  stopAllMusic();
  ui.clear();
  if (mode === 'versus') {
    currentWorld = new VersusWorld({
      assets,
      input,
      onGameOver: ({ winner, scores }) => {
        currentState = GAME_STATE.GAME_OVER;
        ui.showVersusGameOver({
          winner,
          scores,
          onRematch: () => startGame('versus'),
          onMenu: showMainMenu,
        });
      },
    });
  } else {
    currentWorld = new GameWorld({
      assets,
      input,
      mode,
      onGameOver: ({ score, level }) => {
        currentState = GAME_STATE.GAME_OVER;
        ui.showGameOver({
          score: Math.floor(score),
          level,
          onRetry: () => startGame(mode),
          onMenu: showMainMenu,
        });
      },
    });
  }
  applyVolumeSettings();
  currentState = GAME_STATE.GAME;
}

function showMainMenu() {
  if (currentWorld) {
    stopAllMusic();
    currentWorld = null;
  }
  currentState = GAME_STATE.MENU;
  ui.showMenu({
    onStartSingle: () => startGame('single'),
    onStartCoop: () => startGame('coop'),
    onStartVersus: () => startGame('versus'),
    onSettings: showSettings,
  });
}

function showSettings() {
  ui.showSettings({
    onBack: showMainMenu,
    initialMusicVolume: musicVolume,
    initialSoundVolume: soundVolume,
    onChangeMusic: (value) => {
      musicVolume = value;
      applyVolumeSettings();
    },
    onChangeSound: (value) => {
      soundVolume = value;
      applyVolumeSettings();
    },
  });
}

input.onKey('Escape', (pressed) => {
  if (!pressed || !currentWorld) return;
  currentWorld.paused = !currentWorld.paused;
  if (currentWorld.paused) {
    currentState = GAME_STATE.PAUSED;
  } else {
    currentState = GAME_STATE.GAME;
  }
});

function loop(timestamp) {
  if (!lastTimestamp) lastTimestamp = timestamp;
  const delta = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  if (currentWorld && !currentWorld.paused) {
    accumulator += delta;
    while (accumulator >= FRAME_TIME) {
      currentWorld.update(FRAME_TIME);
      accumulator -= FRAME_TIME;
    }
  }

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  if (currentWorld) {
    currentWorld.draw(ctx);
  }

  requestAnimationFrame(loop);
}

async function bootstrap() {
  ui.showLoading(0);
  assets = await loadAssets((progress) => ui.showLoading(progress));
  applyVolumeSettings();
  showMainMenu();
  requestAnimationFrame(loop);
}

bootstrap().catch((error) => {
  console.error('Failed to initialize Space Void', error);
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="menu"><h1 class="menu__title">Error</h1><p>${error.message}</p></div>`;
});
// END main.js

})();
