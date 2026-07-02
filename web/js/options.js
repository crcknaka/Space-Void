// SETTINGS screen: music/sfx volume, vibration, fullscreen + achievements list
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup, drawText } from './ui.js';
import { Star } from './entities.js';
import { settings, saveSettings, ACHIEVEMENTS, isUnlocked, unlockedCount } from './settings.js';

const VOLUME_STEPS = [0, 0.3, 0.6, 1];
const pct = (v) => `${Math.round(v * 100)}%`;

export class OptionsState {
  // returnTo: opened from a paused game — BACK restores that state without resetting it
  constructor(app, returnTo = null) {
    this.app = app;
    this.returnTo = returnTo;
  }

  enter() {
    this.layout();
  }

  goBack() {
    if (this.returnTo) this.app.state = this.returnTo; // resume paused game as-is
    else this.app.goMenu();
  }

  layout() {
    this.stars = [];
    for (let i = 0; i < 60; i++) {
      this.stars.push(new Star(randInt(0, W), randInt(0, H), rand(0.1, 0.4), randInt(1, 3), randInt(50, 200)));
    }
    const y0 = 190;
    this.btnMusic = new Button(`MUSIC: ${pct(settings.music)}`, W / 2, y0, 300, 56, 'rgb(0,220,130)', 'music');
    this.btnSfx = new Button(`SOUND FX: ${pct(settings.sfx)}`, W / 2, y0 + 72, 300, 56, 'rgb(0,220,130)', 'sfx');
    this.btnVibro = new Button(`VIBRATION: ${settings.vibro ? 'ON' : 'OFF'}`, W / 2, y0 + 144, 300, 56, 'rgb(0,220,130)', 'vibro');
    this.btnFs = new Button('FULLSCREEN', W / 2, y0 + 216, 300, 56, 'rgb(255,140,0)', 'fullscreen');
    this.menu = new ButtonGroup([
      this.btnMusic, this.btnSfx, this.btnVibro, this.btnFs,
      new Button('BACK', W / 2, H - 90, 200, 56, 'rgb(255,0,0)', 'back'),
    ]);
  }

  onResize() {
    this.layout();
  }

  cycleVolume(key) {
    const i = VOLUME_STEPS.findIndex((v) => Math.abs(v - settings[key]) < 0.01);
    settings[key] = VOLUME_STEPS[(i + 1) % VOLUME_STEPS.length];
    saveSettings();
  }

  update(dt) {
    const k = dt / STEP;
    for (const s of this.stars) s.update(k);

    const action = this.menu.update();
    if (action === 'music') {
      this.cycleVolume('music');
      audio.applyMusicVolume();
      this.btnMusic.text = `MUSIC: ${pct(settings.music)}`;
    } else if (action === 'sfx') {
      this.cycleVolume('sfx');
      audio.play('powerup', 0.6); // preview
      this.btnSfx.text = `SOUND FX: ${pct(settings.sfx)}`;
    } else if (action === 'vibro') {
      settings.vibro = !settings.vibro;
      saveSettings();
      if (settings.vibro) { try { navigator.vibrate?.(60); } catch {} }
      this.btnVibro.text = `VIBRATION: ${settings.vibro ? 'ON' : 'OFF'}`;
    } else if (action === 'fullscreen') {
      if (document.fullscreenEnabled) {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        else document.exitFullscreen().catch(() => {});
      } else {
        this.fsHint = 420;
      }
    } else if (action === 'back' || input.pressed.has('Escape')) {
      this.goBack();
    }
    if (this.fsHint > 0) this.fsHint -= k;
  }

  draw(g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const s of this.stars) s.draw(g);

    drawText(g, 'SETTINGS', W / 2, 100, 40);
    this.menu.draw(g);

    if (this.fsHint > 0) {
      g.globalAlpha = Math.min(1, this.fsHint / 60);
      drawText(g, 'iPhone/iPad: Share → Add to Home Screen for fullscreen', W / 2, 470, 15, 'rgb(255,210,80)');
      g.globalAlpha = 1;
    }

    // achievements
    const ay = 500;
    drawText(g, `ACHIEVEMENTS  ${unlockedCount()}/${ACHIEVEMENTS.length}`, W / 2, ay, 22, 'rgb(255,210,80)');
    ACHIEVEMENTS.forEach((a, i) => {
      const got = isUnlocked(a.id);
      const y = ay + 34 + i * 26;
      if (y > H - 130) return; // keep clear of BACK on short screens
      drawText(g, got ? '🏆' : '·', W / 2 - 180, y, 15, got ? 'rgb(255,210,80)' : 'rgb(90,90,90)', 'left');
      drawText(g, a.title, W / 2 - 150, y, 15, got ? 'rgb(230,230,230)' : 'rgb(110,110,110)', 'left');
    });
  }
}
