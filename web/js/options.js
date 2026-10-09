// SETTINGS screen: music/sfx volume, vibration, fullscreen + achievements list
import { W, H, STEP, randInt, rand } from './const.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { Button, ButtonGroup } from './ui.js';
import * as ui from './ui.js';
import { Star } from './entities.js';
import { settings, saveSettings, ACHIEVEMENTS, isUnlocked, unlockedCount } from './settings.js';
import { savedName, askPlayerName } from './lb.js';

const { C, rgba } = ui;
const VOLUME_STEPS = [0, 0.3, 0.6, 1];
const pct = (v) => `${Math.round(v * 100)}%`;

export class OptionsState {
  // returnTo: opened from a paused game — BACK restores that state without resetting it
  constructor(app, returnTo = null) {
    this.app = app;
    this.returnTo = returnTo;
    this.anim = new ui.Anim();
    this.time = 0;
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
    // wide: settings panel at the left margin, achievements beside it;
    // narrow / portrait: one column, achievements underneath
    const wide = ui.isWide(), mx = ui.gutter();
    const rw = wide ? 460 : Math.min(460, W - 2 * mx);
    const cx = wide ? mx + rw / 2 : W / 2;
    const slack = Math.max(0, H - 786); // tall phones: taller touch rows
    const dy = wide ? 62 : 52 + Math.min(14, slack * 0.05), rh = wide ? 50 : dy - 6;
    const y0 = wide ? 172 : 148;
    this.btnName = new Button(`NAME: ${savedName() || '—'}`, cx, y0, rw, rh, 'rgb(0,200,255)', 'name');
    this.btnMusic = new Button(`MUSIC: ${pct(settings.music)}`, cx, y0 + dy, rw, rh, 'rgb(0,220,130)', 'music');
    this.btnSfx = new Button(`SOUND FX: ${pct(settings.sfx)}`, cx, y0 + dy * 2, rw, rh, 'rgb(0,220,130)', 'sfx');
    this.btnVibro = new Button(`VIBRATION: ${settings.vibro ? 'ON' : 'OFF'}`, cx, y0 + dy * 3, rw, rh, 'rgb(0,220,130)', 'vibro');
    this.btnMotion = new Button(`MOTION: ${settings.motionFx ? 'ON' : 'OFF'}`, cx, y0 + dy * 4, rw, rh, 'rgb(0,220,130)', 'motion');
    this.btnGfx = new Button(`GRAPHICS: ${settings.gfx3d ? '3D' : 'CLASSIC'}`, cx, y0 + dy * 5, rw, rh, 'rgb(120,220,255)', 'gfx');
    this.btnFs = new Button('FULLSCREEN', cx, y0 + dy * 6, rw, rh, 'rgb(255,140,0)', 'fullscreen');
    const back = wide
      ? new Button('BACK', mx + 90, H - 62, 180, 50, 'rgb(255,0,0)', 'back')
      : new Button('BACK', W / 2, H - 90, 200, 56, 'rgb(255,0,0)', 'back');
    const top = y0 - rh / 2 - 14, bottom = y0 + dy * 6 + rh / 2 + 14; // settings panel
    this.L = { wide, mx, rw, x: cx - rw / 2, top, bottom };
    // achievements: beside the settings (wide) or in the gap above BACK
    this.L.ach = wide
      ? { x: mx + rw + 24, y: top, w: Math.min(460, W - (mx + rw + 24) - mx), h: bottom - top }
      : { x: cx - rw / 2, y: bottom + 14, w: rw, h: back.cy - back.h / 2 - 14 - (bottom + 14) };
    this.menu = new ButtonGroup([
      this.btnName, this.btnMusic, this.btnSfx, this.btnVibro, this.btnMotion, this.btnGfx, this.btnFs,
      back,
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
    this.time += dt;
    this.anim.tick(dt);
    for (const s of this.stars) s.update(k);

    const action = this.menu.update();
    if (action === 'name') {
      askPlayerName().then(() => { this.btnName.text = `NAME: ${savedName() || '—'}`; });
    } else if (action === 'music') {
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
    } else if (action === 'motion') {
      settings.motionFx = !settings.motionFx;
      saveSettings();
      this.btnMotion.text = `MOTION: ${settings.motionFx ? 'ON' : 'OFF'}`;
    } else if (action === 'gfx') {
      this.app.view3d?.setEnabled(!settings.gfx3d);
      this.btnGfx.text = `GRAPHICS: ${settings.gfx3d ? '3D' : 'CLASSIC'}`;
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

  // the control at the right end of a settings row
  drawControl(g, action, xr, cy, sel) {
    const a = this.anim;
    const state = (on) => {
      ui.text(g, on ? 'ON' : 'OFF', xr - 50, cy + 0.5, { size: 11, weight: 700, track: 0.16, align: 'right', color: rgba(on ? C.hi : C.low) });
      ui.toggle(g, xr, cy, a.to(`t_${action}`, on ? 1 : 0, 90));
    };
    if (action === 'name') {
      const w = ui.text(g, '›', xr, cy - 1, { size: 20, weight: 300, align: 'right', color: rgba(sel > 0.5 ? C.cyan : C.low) });
      ui.text(g, savedName() || 'NOT SET', xr - w - 10, cy + 0.5, {
        size: 14, weight: 600, track: 0.12, align: 'right', maxW: this.L.rw * 0.5,
        color: rgba(savedName() ? C.hi : C.low),
      });
    } else if (action === 'music' || action === 'sfx') {
      const v = settings[action];
      ui.text(g, pct(v), xr, cy + 0.5, { size: 13, weight: 700, track: 0.06, align: 'right', color: rgba(v > 0 ? C.hi : C.low) });
      const sw = Math.min(150, this.L.rw * 0.3);
      ui.slider(g, xr - 54 - sw, cy, sw, a.to(`v_${action}`, v, 90), { ticks: VOLUME_STEPS });
    } else if (action === 'vibro') state(settings.vibro);
    else if (action === 'motion') state(settings.motionFx);
    else if (action === 'gfx') ui.segmented(g, xr, cy, ['CLASSIC', '3D'], a.to('gfx', settings.gfx3d ? 1 : 0, 90));
    else if (action === 'fullscreen') state(!!document.fullscreenElement);
  }

  drawAchievements(g) {
    const A = this.L.ach;
    if (A.h < 70 || A.w < 200) return;
    const n = ACHIEVEMENTS.length, got = unlockedCount();
    ui.panel(g, A.x, A.y, A.w, A.h, { accent: C.gold, title: 'ACHIEVEMENTS' });
    ui.text(g, `${got} / ${n}`, A.x + A.w - 22, A.y + 24, { size: 12, weight: 700, track: 0.1, align: 'right', color: rgba(C.gold) });
    // progress hairline on the header rule
    g.fillStyle = rgba(C.gold, 0.9);
    g.fillRect(A.x + 22, A.y + 41, (A.w - 44) * this.anim.to('ach', got / n, 260, 0), 2);
    const y0 = A.y + 54, avail = A.h - 64;
    // one column when there is room, two when squeezed (portrait above BACK)
    const cols = avail / n >= 22 ? 1 : 2;
    const per = Math.ceil(n / cols), rh = Math.min(42, avail / per), cw = (A.w - 44) / cols;
    const small = rh < 26 || cols === 2;
    ACHIEVEMENTS.forEach((ach, i) => {
      const done = isUnlocked(ach.id);
      const x = A.x + 22 + Math.floor(i / per) * cw, y = y0 + (i % per) * rh + rh / 2;
      const k = this.anim.reveal(i, null, 30, 360);
      g.globalAlpha = k;
      g.beginPath();
      g.moveTo(x + 5, y - 5); g.lineTo(x + 10, y); g.lineTo(x + 5, y + 5); g.lineTo(x, y); g.closePath();
      if (done) { g.fillStyle = rgba(C.gold); g.fill(); }
      else { g.strokeStyle = rgba(C.low, 0.6); g.lineWidth = ui.hair(); g.stroke(); }
      ui.text(g, ach.title, x + 22, y + 0.5, {
        size: small ? 11 : 12.5, weight: 600, track: small ? 0.04 : 0.1, maxW: cw - 30,
        color: done ? rgba(C.hi) : rgba(C.low, 0.85),
      });
      if (cols === 1 && i < n - 1) { g.fillStyle = rgba(C.mid, 0.07); g.fillRect(x, y + rh / 2, cw, ui.hair()); }
    });
    g.globalAlpha = 1;
  }

  draw(g) {
    // (opened from a paused run: leave its 3D scene alone — the backdrop would tear it down)
    const in3D = !this.returnTo && this.app.view3d?.backdrop(g);
    ui.begin(g);
    if (in3D) ui.scrim(g, 'all', 0, 0.42);
    else {
      ui.spaceBackdrop(g);
      for (const s of this.stars) s.draw(g);
    }
    ui.scrim(g, 'top', 170, 0.7);
    ui.scrim(g, 'bottom', 170, 0.6);

    const L = this.L, a = this.anim;
    ui.title(g, L.wide ? L.mx : L.x, L.wide ? 62 : 56, 'SETTINGS', {
      size: L.wide ? 34 : 28, sub: this.returnTo ? 'GAME PAUSED' : null, width: L.wide ? L.rw : 0,
    });

    ui.panel(g, L.x, L.top, L.rw, L.bottom - L.top);
    const labels = { name: 'PILOT NAME', music: 'MUSIC', sfx: 'SOUND FX', vibro: 'VIBRATION', motion: 'MOTION FX', gfx: 'GRAPHICS', fullscreen: 'FULLSCREEN' };
    const buttons = this.menu.buttons;
    buttons.forEach((b, i) => {
      if (b.action === 'back') return;
      const sel = a.to(`row_${b.action}`, b.selected || b.hovered ? 1 : 0, 80);
      const k = a.reveal(i, null, 35, 360);
      g.globalAlpha = k;
      const x = b.cx - b.w / 2, y = b.cy - b.h / 2;
      ui.listRow(g, x + 1, y, b.w - 2, b.h, { a: sel, divider: false });
      if (i < buttons.length - 2) { g.fillStyle = rgba(C.mid, 0.09); g.fillRect(x + 20, (y + b.h + buttons[i + 1].cy - buttons[i + 1].h / 2) / 2, b.w - 40, ui.hair()); }
      ui.text(g, labels[b.action], x + 22 + 4 * sel, b.cy + 0.5, {
        size: 13, weight: 600, track: 0.18, color: rgba(sel > 0.4 ? C.hi : C.mid, sel > 0.4 ? 1 : 0.85), maxW: b.w * 0.42,
      });
      this.drawControl(g, b.action, x + b.w - 22, b.cy, sel);
    });
    g.globalAlpha = 1;

    this.drawAchievements(g);

    const back = buttons[buttons.length - 1];
    ui.button(g, back.cx - back.w / 2, back.cy - back.h / 2, back.w, back.h, back.text, {
      a: a.to('row_back', back.selected || back.hovered ? 1 : 0, 80), size: 14,
    });
    if (L.wide && !input.isTouch) {
      ui.keyHints(g, back.cx + back.w / 2 + 28, back.cy, [['W S', 'NAVIGATE'], ['ENTER', 'CHANGE'], ['ESC', 'BACK']]);
    }

    if (this.fsHint > 0) {
      ui.text(g, 'iPhone / iPad: Share → Add to Home Screen for fullscreen', L.wide ? L.x + 22 : W / 2, L.wide ? L.bottom + 26 : back.cy - back.h / 2 - 14, {
        size: 13, weight: 600, align: L.wide ? 'left' : 'center', color: rgba(C.gold), alpha: Math.min(1, this.fsHint / 60), maxW: W - 2 * L.mx,
      });
    }
  }
}
