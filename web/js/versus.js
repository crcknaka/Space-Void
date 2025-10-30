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
        id: 1,
        x: WIDTH * 0.25,
        y: HEIGHT / 2,
        controls: shared.PLAYER_CONTROLS.player1,
        assets: this.assets,
      });
      const player2 = new Player({
        id: 2,
        x: WIDTH * 0.75,
        y: HEIGHT / 2,
        controls: shared.PLAYER_CONTROLS.player2,
        assets: this.assets,
      });

      player1.flipImages();
      player2.setCustomImages({
        ship: flipImage(this.assets.player2_img),
        thrusters: flipFrames(this.assets.player2_thruster_frames),
      });

      player1.onKill = () => {
        this.scores[0] += 1;
        this.checkVictory();
      };
      player2.onKill = () => {
        this.scores[1] += 1;
        this.checkVictory();
      };

      this.players = [player1, player2];
    }

    reset() {
      this.players.forEach((player, index) => {
        player.respawn(index === 0 ? WIDTH * 0.25 : WIDTH * 0.75, HEIGHT / 2);
      });
      this.bullets = [];
      this.rockets = [];
      this.enemies = [];
      this.asteroids = [];
      this.particles = [];
      this.explosions = [];
      this.starLayers = createStarLayers(3);
      this.staticStars = createStaticStars();
      this.backgroundOffset = 0;
      this.scores = [0, 0];
      this.respawnTimers = [0, 0];
      this.state = GAME_STATE.GAME;
    }

    checkVictory() {
      if (this.scores.some((score) => score >= this.scoreLimit)) {
        this.finishGame();
      }
    }

    finishGame() {
      this.state = GAME_STATE.GAME_OVER;
      this.music.pause();
      if (this.onGameOver) {
        this.onGameOver({ scores: [...this.scores] });
      }
    }

    update(dt) {
      if (this.state !== GAME_STATE.GAME) return;

      this.backgroundOffset -= 40 * dt;
      if (this.backgroundOffset <= -WIDTH) {
        this.backgroundOffset += WIDTH;
      }

      this.starLayers.forEach((layer, index) => {
        const speed = 20 * (index + 1);
        layer.forEach((star) => {
          star.x -= speed * dt;
          if (star.x < 0) {
            star.x = WIDTH;
            star.y = Math.random() * HEIGHT;
          }
        });
      });

      this.staticStars.forEach((star) => star.update(dt));

      this.players.forEach((player, index) => {
        player.update(dt, {
          bullets: this.bullets,
          rockets: this.rockets,
          assets: this.assets,
          onFire: () => this.assets.gun_sound.play().catch(() => {}),
          onRocket: () => this.assets.rocket_sound.play().catch(() => {}),
        });

        if (!player.alive) {
          this.respawnTimers[index] += dt;
          if (this.respawnTimers[index] >= 3) {
            this.respawnPlayer(index);
          }
        }
      });

      this.updateProjectiles(dt);
      this.handleCollisions();
      this.cleanup();
    }

    respawnPlayer(index) {
      const player = this.players[index];
      player.respawn(index === 0 ? WIDTH * 0.25 : WIDTH * 0.75, HEIGHT / 2);
      this.respawnTimers[index] = 0;
    }

    updateProjectiles(dt) {
      this.bullets.forEach((bullet) => bullet.update(dt));
      this.rockets.forEach((rocket) => rocket.update(dt));

      this.bullets = this.bullets.filter((bullet) => !bullet.dead);
      this.rockets = this.rockets.filter((rocket) => !rocket.dead);
    }

    handleCollisions() {
      for (let i = 0; i < this.players.length; i += 1) {
        const player = this.players[i];
        if (!player.alive) continue;

        for (let j = 0; j < this.bullets.length; j += 1) {
          const bullet = this.bullets[j];
          if (bullet.owner === player.id) continue;
          if (intersects(player.getBounds(), bullet.getBounds())) {
            player.kill();
            bullet.dead = true;
            this.handleKill(player.id === 1 ? 2 : 1);
            break;
          }
        }

        for (let j = 0; j < this.rockets.length; j += 1) {
          const rocket = this.rockets[j];
          if (rocket.owner === player.id) continue;
          if (intersects(player.getBounds(), rocket.getBounds())) {
            player.kill();
            rocket.dead = true;
            this.handleKill(player.id === 1 ? 2 : 1);
            break;
          }
        }
      }
    }

    handleKill(killerId) {
      const killer = this.players.find((player) => player.id === killerId);
      if (!killer) return;

      if (killerId === 1) {
        this.assets.player1_kill_sound.play().catch(() => {});
      } else {
        this.assets.player2_kill_sound.play().catch(() => {});
      }

      this.assets.explosion_sound.play().catch(() => {});
      this.explosions.push(new Explosion({
        x: killer.x,
        y: killer.y,
        frames: this.assets.explosion_spritesheet,
      }));
    }

    draw(ctx) {
      ctx.drawImage(this.background, this.backgroundOffset, 0);
      ctx.drawImage(this.background, this.backgroundOffset + WIDTH, 0);

      this.starLayers.forEach((layer) => layer.forEach((star) => star.draw(ctx)));
      this.staticStars.forEach((star) => star.draw(ctx));

      this.players.forEach((player) => player.draw(ctx));
      this.bullets.forEach((bullet) => bullet.draw(ctx));
      this.rockets.forEach((rocket) => rocket.draw(ctx));
      this.explosions.forEach((explosion) => explosion.draw(ctx));

      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Arial';
      ctx.fillText(`Player 1: ${this.scores[0]}`, 20, 30);
      ctx.fillText(`Player 2: ${this.scores[1]}`, WIDTH - 160, 30);

      if (this.state === GAME_STATE.GAME_OVER) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.fillStyle = '#ffffff';
        ctx.font = '36px Arial';
        const winner = this.scores[0] > this.scores[1] ? 'Player 1 Wins!' : 'Player 2 Wins!';
        ctx.fillText(winner, WIDTH / 2 - 140, HEIGHT / 2);
      }
    }

    cleanup() {
      this.bullets = this.bullets.filter((bullet) => !bullet.dead);
      this.rockets = this.rockets.filter((rocket) => !rocket.dead);
      this.explosions = this.explosions.filter((explosion) => !explosion.done);
    }
  }

  function createVersusWorld(options) {
    return new VersusWorld(options);
  }

  SpaceVoid.VersusWorld = VersusWorld;
  SpaceVoid.createVersusWorld = createVersusWorld;
})(window);
