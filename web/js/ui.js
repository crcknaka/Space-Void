// Buttons + keyboard/mouse navigation (mirrors Button classes from menu.py / pause_menu.py)
import * as input from './input.js';
import * as audio from './audio.js';

export const FONT = '"Orbitron", "Trebuchet MS", "Segoe UI", Arial, sans-serif';

export function drawText(g, text, x, y, px, color = '#fff', align = 'center', bold = true) {
  g.font = `${bold ? 'bold ' : ''}${px}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

function roundRect(g, x, y, w, h, r) {
  if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); return; }
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class Button {
  constructor(text, cx, cy, w, h, hoverColor, action) {
    this.text = text;
    this.cx = cx; this.cy = cy;
    this.w = w; this.h = h;
    this.hoverColor = hoverColor;
    this.action = action;
    this.hovered = false;
    this.selected = false;
  }
  contains(x, y) {
    return Math.abs(x - this.cx) <= this.w / 2 && Math.abs(y - this.cy) <= this.h / 2;
  }
  draw(g) {
    const active = this.hovered || this.selected;
    const grow = active ? 1.1 : 1;            // 10% growth like the pygame menus
    const w = this.w * grow, h = this.h * grow;
    g.fillStyle = active ? this.hoverColor : 'rgb(70,70,70)';
    roundRect(g, this.cx - w / 2, this.cy - h / 2, w, h, 6);
    g.fill();
    drawText(g, this.text, this.cx, this.cy + 1, Math.round(24 * (active ? 1.1 : 1)));
  }
}

// A vertical group of buttons with mouse hover + W/S/arrows + Enter navigation.
// update() returns the activated button's action string, or null.
export class ButtonGroup {
  constructor(buttons) {
    this.buttons = buttons;
    this.index = 0;
    buttons[0].selected = true;
  }
  select(i) {
    this.buttons[this.index].selected = false;
    this.index = i;
    this.buttons[this.index].selected = true;
  }
  update() {
    const { pressed, pointer } = input;
    if (pressed.has('ArrowDown') || pressed.has('KeyS')) {
      audio.play('hover', 0.4);
      this.select((this.index + 1) % this.buttons.length);
    }
    if (pressed.has('ArrowUp') || pressed.has('KeyW')) {
      audio.play('hover', 0.4);
      this.select((this.index - 1 + this.buttons.length) % this.buttons.length);
    }
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      const hov = b.contains(pointer.x, pointer.y);
      if (hov && !b.hovered) { audio.play('hover', 0.4); this.select(i); }
      b.hovered = hov;
    }
    if (pressed.has('Enter') || pressed.has('NumpadEnter')) {
      audio.play('click', 0.55);
      return this.buttons[this.index].action;
    }
    if (pointer.justDown) {
      for (const b of this.buttons) {
        if (b.contains(pointer.x, pointer.y)) {
          audio.play('click', 0.55);
          return b.action;
        }
      }
    }
    return null;
  }
  draw(g) {
    for (const b of this.buttons) b.draw(g);
  }
}
