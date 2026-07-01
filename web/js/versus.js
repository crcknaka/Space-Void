// Versus mode — port of versus.py (first to 10 kills)
import { W, H, STEP, randInt, overlap } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Player, Bullet, Explosion, makeStarLayers } from './entities.js';
import { makeNebulaField, updateNebulae, drawNebulae } from './fx.js';

const SCORE_LIMIT = 10;

const P1_CONTROLS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  shoot: 'Space', speed: 'ShiftLeft',
};
const P2_CONTROLS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  shoot: 'Enter', shootAlt: 'NumpadEnter', speed: 'Numpad0', speedAlt: 'ShiftRight',
};

export class VersusState {
  constructor(app) {
    this.app = app;
  }

  enter() {
    const { images } = this.app;
    audio.playMusic('versus_music');

    this.time = 0;
    this.score1 = 0;
    this.score2 = 0;
    this.paused = false;
    this.winner = null;
    this.winMenu = null;
    this.pauseMenu = null;
    this.bgX = 0;
    this.k = 1;
    this.speedMul = 1;

    this.bullets1 = [];
    this.bullets2 = [];
    this.effects = [];
    this.starLayers = makeStarLayers();
    this.nebulae = makeNebulaField(3);

    this.player1 = new Player(images, {
      img: images.player1_ship,
      thrusters: images.thrusters.player1,
      controls: P1_CONTROLS,
      autoShoot: false,      // versus.py auto-fired due to a bug; manual fire is the intended design
      useRockets: false,
      padIndex: 0,
    });
    this.player2 = new Player(images, {
      img: images.player2_ship,
      thrusters: images.thrusters.player2,
      controls: P2_CONTROLS,
      facingLeft: true,
      shipFlipped: true,
      autoShoot: false,
      useRockets: false,
      padIndex: 1,
    });
    this.respawn1 = 0;
    this.respawn2 = 0;
    this.spawn(this.player1, 1);
    this.spawn(this.player2, 2);
  }

  spawn(p, side) {
    p.y = randInt(50, H - 50);
    p.x = side === 1 ? randInt(50, W / 2 - 50) + p.w / 2 : randInt(W / 2 + 50, W - 50) - p.w / 2;
    p.alive = true;
  }

  buildPauseMenu() {
    return new ButtonGroup([
      new Button('RESUME', W / 2, H / 2 - 40, 200, 60, 'rgb(0,255,0)', 'resume'),
      new Button('MAIN MENU', W / 2, H / 2 + 50, 200, 60, 'rgb(255,0,0)', 'main_menu'),
    ]);
  }

  buildWinMenu() {
    return new ButtonGroup([
      new Button('RETRY', W / 2, H / 2 + 60, 200, 60, 'rgb(0,255,0)', 'retry'),
      new Button('MAIN MENU', W / 2, H / 2 + 145, 200, 60, 'rgb(255,0,0)', 'main_menu'),
    ]);
  }

  onResize() {
    this.starLayers = makeStarLayers();
    this.nebulae = makeNebulaField(3);
    if (this.pauseMenu) this.pauseMenu = this.buildPauseMenu();
    if (this.winMenu) this.winMenu = this.buildWinMenu();
  }

  shootFor(p, bullets, controls) {
    if (!p.alive) return;
    const k = input.keys;
    const pad = p.pad();
    const firing = k.has(controls.shoot) || (controls.shootAlt && k.has(controls.shootAlt)) || (pad && pad.fire);
    if (!firing) return;
    if (this.time - p.lastShot <= p.shootDelay) return;
    const vx = p.facingLeft ? -10 : 10;
    const edgeX = p.facingLeft ? p.x - p.w / 2 : p.x + p.w / 2;
    bullets.push(new Bullet(edgeX, p.y, this.app.images.bullet, vx));
    p.lastShot = this.time;
    audio.play('gun', 0.22);
  }

  update(dt) {
    this.k = dt / STEP;
    if (this.winner) {
      const action = this.winMenu.update();
      if (action === 'retry') this.app.setState(new VersusState(this.app));
      else if (action === 'main_menu') this.app.goMenu();
      return;
    }

    if (input.pressed.has('Escape') || input.pressed.has('KeyP')) {
      this.paused = !this.paused;
      audio.play('click', 0.5);
      if (this.paused) this.pauseMenu = this.buildPauseMenu();
    }
    if (this.paused) {
      const action = this.pauseMenu.update();
      if (action === 'resume') this.paused = false;
      else if (action === 'main_menu') this.app.goMenu();
      return;
    }

    this.time += dt;

    const bg = this.app.images.versus_background;
    this.bgW = bg.width * (H / bg.height); // cover height, keep aspect
    this.bgX -= 0.1 * this.k;
    if (this.bgX <= -this.bgW) this.bgX = 0;
    updateNebulae(this.nebulae, this.k);

    this.player1.update(this);
    this.player2.update(this);
    this.shootFor(this.player1, this.bullets1, P1_CONTROLS);
    this.shootFor(this.player2, this.bullets2, P2_CONTROLS);

    for (const b of this.bullets1) b.update(this);
    for (const b of this.bullets2) b.update(this);
    for (const fx of this.effects) fx.update(this);
    for (const layer of this.starLayers) for (const s of layer) s.update(this.k);

    // hits
    if (this.player1.alive) {
      for (const b of this.bullets2) {
        if (!b.dead && overlap(this.player1, b, 0.8)) {
          b.dead = true;
          this.kill(this.player1, 2);
          break;
        }
      }
    }
    if (this.player2.alive) {
      for (const b of this.bullets1) {
        if (!b.dead && overlap(this.player2, b, 0.8)) {
          b.dead = true;
          this.kill(this.player2, 1);
          break;
        }
      }
    }

    // respawns (1 second, like versus.py)
    if (!this.player1.alive && this.respawn1 && this.time > this.respawn1) {
      this.spawn(this.player1, 1);
      this.respawn1 = 0;
    }
    if (!this.player2.alive && this.respawn2 && this.time > this.respawn2) {
      this.spawn(this.player2, 2);
      this.respawn2 = 0;
    }

    this.bullets1 = this.bullets1.filter((b) => !b.dead);
    this.bullets2 = this.bullets2.filter((b) => !b.dead);
    this.effects = this.effects.filter((fx) => !fx.dead);

    // winner check
    if (this.score1 >= SCORE_LIMIT || this.score2 >= SCORE_LIMIT) {
      this.winner = this.score1 >= SCORE_LIMIT ? 'PLAYER 1' : 'PLAYER 2';
      this.winMenu = this.buildWinMenu();
    }
  }

  kill(p, byPlayer) {
    this.effects.push(new Explosion(p.x, p.y, this.app.images.explosion_spritesheet, this.time));
    audio.play('explosion', 0.5);
    audio.play(byPlayer === 1 ? 'player1_kill' : 'player2_kill', 0.7);
    p.alive = false;
    if (byPlayer === 1) { this.score1 += 1; this.respawn2 = this.time + 1000; }
    else { this.score2 += 1; this.respawn1 = this.time + 1000; }
  }

  draw(g) {
    const { images } = this.app;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const bg = images.versus_background;
    const bgW = this.bgW || bg.width * (H / bg.height);
    g.drawImage(bg, this.bgX, 0, bgW, H);
    g.drawImage(bg, this.bgX + bgW, 0, bgW, H);

    drawNebulae(g, this.nebulae);
    for (const layer of this.starLayers) for (const s of layer) s.draw(g);

    for (const b of this.bullets1) b.draw(g);
    for (const b of this.bullets2) b.draw(g);
    for (const fx of this.effects) fx.draw(g, this);
    this.player1.draw(g);
    this.player2.draw(g);

    drawText(g, `P1 Score: ${this.score1}`, 10, 24, 26, '#fff', 'left');
    drawText(g, `P2 Score: ${this.score2}`, W - 10, 24, 26, '#fff', 'right');
    drawText(g, `First to ${SCORE_LIMIT}`, W / 2, 24, 18, 'rgb(160,160,160)');

    if (this.paused) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, 0, W, H);
      drawText(g, 'PAUSED', W / 2, H / 2 - 130, 52, 'rgb(255,60,60)');
      this.pauseMenu.draw(g);
    }

    if (this.winner) {
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(0, 0, W, H);
      drawText(g, `${this.winner} WINS!`, W / 2, H / 2 - 100, 56);
      this.winMenu.draw(g);
    }
  }
}
