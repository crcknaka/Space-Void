(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});
  const shared = SpaceVoid.shared;
  if (!shared) {
    throw new Error('Shared module must be loaded before versus module.');
  }

  const { WIDTH, HEIGHT, GAME_STATE, randomRange, intersects } = shared;
  const { Player, Star, StaticStar, Explosion } = SpaceVoid;
  if (!Player || !Star || !StaticStar || !Explosion) {
    throw new Error('Single-player module must be loaded before versus module.');
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
    return canvas;
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
        autoFire: true,
      });
      player1.reset({ x: 80, y: HEIGHT / 2 - player1.height / 2 });
      player1.rocketCount = 0;
      this.players.push(player1);

      const flippedShip = flipImage(this.assets.player2_img);
      const player2 = new Player({
        image: flippedShip,
        thrusterFrames: this.assets.player2_thruster_frames,
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
        autoFire: true,
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
      this.explosions.forEach((explosion) => explosion.update(dt));
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
            const killSound = this.assets[`player${index + 1}_kill_sound`];
            killSound?.play?.();
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
      if (this.assets.explosion_sound) {
        this.assets.explosion_sound.currentTime = 0;
        this.assets.explosion_sound.play().catch(() => {});
      }
    }

    finishGame(winnerIndex) {
      this.state = GAME_STATE.GAME_OVER;
      if (this.music && typeof this.music.pause === 'function') {
        this.music.pause();
      }
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

    }
  }

  function createVersusWorld(options) {
    return new VersusWorld(options);
  }

  SpaceVoid.VersusWorld = VersusWorld;
  SpaceVoid.createVersusWorld = createVersusWorld;
})(window);
