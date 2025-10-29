import {
  Boss,
  Enemy,
  Star,
  StaticStar,
  Asteroid,
  EnemyBullet,
  Explosion,
  PowerUp,
  Rocket,
  Player,
  intersects,
} from './entities.js';
import { GAME_STATE, HEIGHT, POWERUP_TYPES, WIDTH } from './constants.js';

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

export class GameWorld {
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
