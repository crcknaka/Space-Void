// Buttons + keyboard/mouse navigation (mirrors Button classes from menu.py / pause_menu.py)
import * as input from './input.js';
import * as audio from './audio.js';
import { W, H } from './const.js';

// System UI stack — no web font, so the game looks the same offline.
export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const FONT = UI_FONT;

// Legacy one-liner kept for its many callers; it now sets type through the
// kit (tracked system face, big headings go light) and never overflows the
// screen. New code should call text() directly.
export function drawText(g, str, x, y, px, color = '#fff', align = 'center', bold = true) {
  const big = px >= 30;
  text(g, str, x, y, {
    size: big ? px * 0.82 : px, weight: big ? 300 : bold ? 600 : 400, track: big ? 0.22 : px >= 16 ? 0.1 : 0.06,
    color, align, maxW: align === 'center' ? W - 24 : W - 20,
  });
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
  // kit look (the old flat grey / neon-fill boxes are gone); `accent` buttons
  // are the solid primary style
  draw(g) {
    this.glow = (this.glow || 0) + ((this.hovered || this.selected ? 1 : 0) - (this.glow || 0)) * 0.25;
    button(g, this.cx - this.w / 2, this.cy - this.h / 2 + 3, this.w, this.h - 6, this.text, {
      a: this.glow, style: this.style || (this.accent ? 'solid' : 'ghost'), color: this.color || C.cyan, size: Math.min(15, this.h * 0.3),
    });
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

/* ============================================================================
 * Modern UI kit — shared by the menu, hangar, settings and score screens.
 * Thin lines, translucent chamfered panels, tracked system type, one accent
 * (cyan) plus gold for anything premium. Everything is plain Canvas 2D in
 * world units; glows and fades are cached sprites (no shadowBlur, no
 * per-frame gradients), so it stays cheap on phones.
 * The legacy Button / ButtonGroup / drawText above are untouched: the kit only
 * draws, hit testing and navigation still go through Button + ButtonGroup.
 * ========================================================================== */

// palette as "r,g,b" so any alpha can be applied with rgba()
export const C = {
  cyan: '104,214,255',
  blue: '84,150,255',
  gold: '255,200,98',
  ok: '96,240,178',
  danger: '255,116,116',
  hi: '246,250,255',
  mid: '188,208,230',
  low: '132,158,190',
  ink: '6,12,22',
  white: '255,255,255',
};
export const rgba = (c, a = 1) => `rgba(${c},${a})`;
export const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/* ------------------------------- frame state ------------------------------- */

const F = { s: 1, lw: 1 };
// Call once at the top of a screen's draw: reads the canvas scale so hairlines
// stay ~1 device pixel at every resolution.
export function begin(g) {
  const s = g.getTransform ? g.getTransform().a || 1 : 1;
  F.s = s;
  F.lw = Math.max(0.6, 1.2 / s);
  return F;
}
export const hair = () => F.lw;
const sn = (v) => Math.round(v * F.s) / F.s; // snap to the device pixel grid

// left/right page margin; content is left-anchored on wide screens
export const isWide = () => W >= 1000;
export const gutter = () => (W >= 1000 ? Math.min(110, Math.round(W * 0.07)) : Math.max(18, Math.round(W * 0.04)));

/* --------------------------------- easing ---------------------------------- */

const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const ease = {
  linear: (t) => cl01(t),
  out: (t) => 1 - (1 - cl01(t)) ** 3,
  inOut: (t) => { t = cl01(t); return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2; },
  outBack: (t) => { t = cl01(t) - 1; return 1 + 2.4 * t * t * t + 1.4 * t * t; },
};

// Tiny tween store. A screen owns one, calls tick(dt) from update() and reads
// eased values by key in draw(): to() glides towards a target (hover and
// selection glows, counters, bars), reveal() is a staggered entrance, mark()
// / since() time one-off transitions.
export class Anim {
  constructor() { this.t = 0; this.dt = 16.7; this.v = new Map(); this.m = new Map(); }
  tick(dt) { this.t += dt; this.dt = dt; }
  to(key, target, ms = 110, from = target) {
    let cur = this.v.get(key);
    if (cur === undefined) cur = from;
    cur += (target - cur) * (1 - Math.exp(-this.dt / ms));
    if (Math.abs(target - cur) < 0.002 * Math.max(1, Math.abs(target))) cur = target;
    this.v.set(key, cur);
    return cur;
  }
  set(key, v) { this.v.set(key, v); }
  mark(key) { this.m.set(key, this.t); }
  since(key) { return this.t - (this.m.get(key) ?? 0); }
  // 0..1 eased entrance for item i of a staggered group started at mark `key`
  reveal(i = 0, key = null, step = 45, dur = 420) {
    return ease.out((this.since(key) - i * step) / dur);
  }
}

/* ---------------------------------- text ----------------------------------- */

const HAS_LS = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;
const fontOf = (size, weight) => `${weight} ${Math.round(size * 100) / 100}px ${UI_FONT}`;
const mCache = new Map();

// width of a tracked string (track is in em), without the trailing gap
export function measure(g, str, o = {}) {
  const size = o.size ?? 16, weight = o.weight ?? 500, track = o.track ?? 0;
  const key = `${weight}|${size}|${str}`;
  let w = mCache.get(key);
  if (w === undefined) {
    if (mCache.size > 1500) mCache.clear();
    g.font = fontOf(size, weight);
    w = g.measureText(str).width;
    mCache.set(key, w);
  }
  return w + track * size * Math.max(0, str.length - 1);
}

// text(g, 'HANGAR', x, y, { size, weight, color, align, track, alpha, maxW })
// maxW shrinks the type to fit instead of overflowing. Returns the drawn width.
export function text(g, str, x, y, o = {}) {
  str = String(str);
  let size = o.size ?? 16;
  const weight = o.weight ?? 500, track = o.track ?? 0, align = o.align || 'left';
  let w = measure(g, str, { size, weight, track });
  if (o.maxW && w > o.maxW) {
    const k = Math.max(0.5, o.maxW / w);
    size *= k; w *= k;
  }
  const sp = track * size;
  const prev = g.globalAlpha;
  if (o.alpha != null) g.globalAlpha = prev * o.alpha;
  g.font = fontOf(size, weight);
  g.fillStyle = o.color || rgba(C.hi);
  g.textBaseline = o.baseline || 'middle';
  if (!sp) {
    g.textAlign = align;
    g.fillText(str, x, y);
  } else if (HAS_LS) {
    // the browser adds the gap after the last glyph too — compensate so
    // centred / right-aligned strings sit optically true
    g.letterSpacing = `${sp}px`;
    g.textAlign = align;
    g.fillText(str, align === 'center' ? x + sp / 2 : align === 'right' ? x + sp : x, y);
    g.letterSpacing = '0px';
  } else {
    g.textAlign = 'left';
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    for (const ch of str) {
      g.fillText(ch, cx, y);
      cx += measure(g, ch, { size, weight }) + sp;
    }
  }
  g.globalAlpha = prev;
  return w;
}

const wCache = new Map();
// greedy word wrap -> array of lines (cached)
export function wrap(g, str, maxW, o = {}) {
  const key = `${o.size}|${o.weight}|${o.track}|${Math.round(maxW)}|${str}`;
  let lines = wCache.get(key);
  if (lines) return lines;
  if (wCache.size > 300) wCache.clear();
  lines = [];
  let line = '';
  for (const word of String(str).split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(g, next, o) > maxW) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  wCache.set(key, lines);
  return lines;
}

/* ----------------------------- cached sprites ------------------------------ */

const sprites = new Map();
function sprite(key, w, h, paint) {
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement('canvas');
    s.width = w; s.height = h;
    paint(s.getContext('2d'), w, h);
    sprites.set(key, s);
  }
  return s;
}

// soft elliptical glow (stands in for shadowBlur)
export function glow(g, c, cx, cy, rx, ry, a = 1) {
  if (a <= 0.004) return;
  const s = sprite(`g|${c}`, 64, 64, (x) => {
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(c, 1)); gr.addColorStop(0.35, rgba(c, 0.42)); gr.addColorStop(1, rgba(c, 0));
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  });
  const prev = g.globalAlpha;
  g.globalAlpha = prev * Math.min(1, a);
  g.drawImage(s, cx - rx, cy - ry, rx * 2, ry * 2);
  g.globalAlpha = prev;
}

// linear fade of colour c, opaque at the origin edge and running out towards
// dir: 'r' (left→right), 'l', 'd' (top→bottom), 'u'
export function fade(g, c, dir, x, y, w, h, a = 1) {
  if (a <= 0.004 || w <= 0 || h <= 0) return;
  const horiz = dir === 'r' || dir === 'l';
  const s = sprite(`f|${c}|${dir}`, horiz ? 128 : 1, horiz ? 1 : 128, (x2, sw, sh) => {
    const gr = horiz ? x2.createLinearGradient(0, 0, sw, 0) : x2.createLinearGradient(0, 0, 0, sh);
    const from = dir === 'r' || dir === 'd' ? 1 : 0;
    // eased falloff reads softer than a straight ramp
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, v = from ? (1 - t) ** 1.6 : t ** 1.6;
      gr.addColorStop(t, rgba(c, v));
    }
    x2.fillStyle = gr; x2.fillRect(0, 0, sw, sh);
  });
  const prev = g.globalAlpha;
  g.globalAlpha = prev * Math.min(1, a);
  g.drawImage(s, x, y, w, h);
  g.globalAlpha = prev;
}

// Screen scrims that keep type readable over a bright planet / sun.
// side: 'left' | 'top' | 'bottom' | 'all'
export function scrim(g, side, size, a) {
  if (side === 'all') { g.fillStyle = rgba('2,5,10', a); g.fillRect(0, 0, W, H); }
  else if (side === 'left') fade(g, '2,5,10', 'r', 0, 0, size, H, a);
  else if (side === 'top') fade(g, '2,5,10', 'd', 0, 0, W, size, a);
  else fade(g, '2,5,10', 'u', 0, H - size, W, size, a);
}

let bdCache = null;
// Fallback backdrop for screens without the live 3D sky: deep navy with two
// faint nebula glows, baked once per world size at half resolution.
export function spaceBackdrop(g) {
  const w = Math.max(2, Math.round(W / 2)), h = Math.max(2, Math.round(H / 2));
  if (!bdCache || bdCache.width !== w || bdCache.height !== h) {
    bdCache = document.createElement('canvas');
    bdCache.width = w; bdCache.height = h;
    const x = bdCache.getContext('2d');
    const lg = x.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, '#040912'); lg.addColorStop(0.55, '#050b18'); lg.addColorStop(1, '#02040a');
    x.fillStyle = lg; x.fillRect(0, 0, w, h);
    const blob = (cx, cy, r, c, a) => {
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, rgba(c, a)); rg.addColorStop(1, rgba(c, 0));
      x.fillStyle = rg; x.fillRect(0, 0, w, h);
    };
    blob(w * 0.78, h * 0.3, Math.max(w, h) * 0.55, '40,110,190', 0.2);
    blob(w * 0.18, h * 0.95, Math.max(w, h) * 0.5, '90,60,170', 0.13);
    blob(w * 0.62, h * 0.62, Math.max(w, h) * 0.28, '60,190,220', 0.06);
  }
  g.drawImage(bdCache, 0, 0, W, H);
}

/* -------------------------------- primitives ------------------------------- */

// rectangle with the top-left and bottom-right corners cut — the kit's shape
function chamfer(g, x, y, w, h, c) {
  c = Math.min(c, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + c, y); g.lineTo(x + w, y); g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h); g.lineTo(x, y + h); g.lineTo(x, y + c);
  g.closePath();
}

export function line(g, x1, y1, x2, y2, color, lw = F.lw) {
  g.strokeStyle = color; g.lineWidth = lw;
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
}

function diamond(g, cx, cy, r) {
  g.beginPath();
  g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy);
  g.closePath();
}

// Glass panel. o: { fill, cut, accent, title, a }
export function panel(g, x, y, w, h, o = {}) {
  const { fill = 0.7, cut = 14, accent = C.cyan, title = null, a = 1 } = o;
  x = sn(x); y = sn(y); w = sn(w); h = sn(h);
  const prev = g.globalAlpha;
  g.globalAlpha = prev * a;
  chamfer(g, x, y, w, h, cut);
  g.fillStyle = rgba(C.ink, fill); g.fill();
  fade(g, C.cyan, 'd', x + cut, y, w - cut, Math.min(h, 90), 0.045); // top sheen
  chamfer(g, x, y, w, h, cut);
  g.strokeStyle = rgba(C.mid, 0.2); g.lineWidth = F.lw; g.stroke();
  // accent: the cut corner + a short run along the top edge, mirrored bottom-right
  g.strokeStyle = rgba(accent, 0.9); g.lineWidth = F.lw * 1.6;
  g.beginPath();
  g.moveTo(x, y + cut + 16); g.lineTo(x, y + cut); g.lineTo(x + cut, y); g.lineTo(x + cut + 30, y);
  g.moveTo(x + w, y + h - cut - 16); g.lineTo(x + w, y + h - cut); g.lineTo(x + w - cut, y + h); g.lineTo(x + w - cut - 30, y + h);
  g.stroke();
  if (title) {
    text(g, title, x + 22, y + 24, { size: 11, weight: 600, track: 0.24, color: rgba(accent, 0.95), maxW: w - 44 });
    line(g, x + 22, sn(y + 42), x + w - 22, sn(y + 42), rgba(C.mid, 0.14));
  }
  g.globalAlpha = prev;
}

// Button. x,y = top-left. o: { a: hover/selection 0..1, style: 'ghost' | 'solid'
// | 'quiet', color, disabled, size }
export function button(g, x, y, w, h, label, o = {}) {
  const { a = 0, style = 'ghost', color = C.cyan, disabled = false, size = 15 } = o;
  x = sn(x); y = sn(y);
  const cut = 9, cx = x + w / 2, cy = y + h / 2;
  if (style === 'solid' && !disabled) {
    glow(g, color, cx, cy + h * 0.2, w * 0.62, h * 1.25, 0.2 + 0.2 * a);
    chamfer(g, x, y, w, h, cut);
    g.fillStyle = rgba(color, 0.88 + 0.12 * a); g.fill();
    fade(g, C.white, 'd', x + cut, y, w - cut, h * 0.55, 0.2 + 0.16 * a);
    text(g, label, cx, cy + 0.5, { size, weight: 700, track: 0.16, align: 'center', color: rgba(C.ink, 0.96), maxW: w - 28 });
    return;
  }
  if (a > 0.01 && !disabled) glow(g, color, cx, cy, w * 0.6, h * 1.1, 0.16 * a);
  chamfer(g, x, y, w, h, cut);
  g.fillStyle = rgba(C.ink, style === 'quiet' ? 0.3 : 0.55); g.fill();
  if (!disabled) fade(g, color, 'u', x, y, w, h, 0.05 + 0.2 * a);
  chamfer(g, x, y, w, h, cut);
  g.strokeStyle = disabled ? rgba(C.low, 0.28) : rgba(color, (style === 'quiet' ? 0.22 : 0.42) + 0.5 * a);
  g.lineWidth = F.lw * (1 + 0.5 * a); g.stroke();
  text(g, label, cx, cy + 0.5, {
    size, weight: 600, track: 0.16, align: 'center', maxW: w - 24,
    color: disabled ? rgba(C.low, 0.75) : a > 0.5 ? rgba(C.hi) : rgba(C.mid, 0.92),
  });
}

// Main-menu style list entry. o: { a, color, index, tag, tagColor }
export function menuRow(g, x, y, w, h, label, o = {}) {
  const { a = 0, color = C.cyan, index = null, tag = null, tagColor = color } = o;
  const cy = y + h / 2;
  if (a > 0.01) {
    fade(g, color, 'r', x, y, w, h, 0.24 * a);
    fade(g, color, 'r', x, sn(y), w, F.lw, 0.75 * a);
    fade(g, color, 'r', x, sn(y + h) - F.lw, w, F.lw, 0.75 * a);
    glow(g, color, x + 4, cy, 46, h * 0.9, 0.5 * a);
  }
  // rail: a quiet tick that grows into the accent bar
  const bh = 10 + (h - 18) * a;
  g.fillStyle = rgba(a > 0.01 ? color : C.low, 0.35 + 0.65 * a);
  g.fillRect(sn(x), cy - bh / 2, Math.max(F.lw, 1 + 2 * a), bh);
  let tx = x + 20 + 8 * a;
  if (index != null) {
    text(g, index, tx, cy + 0.5, { size: 11, weight: 600, track: 0.1, color: rgba(a > 0.4 ? color : C.low, 0.55 + 0.4 * a) });
    tx += 34;
  }
  const lw = text(g, label, tx, cy + 0.5, {
    size: 20, weight: a > 0.5 ? 600 : 500, track: 0.2,
    color: a > 0.4 ? rgba(C.hi) : rgba(C.mid, 0.95), maxW: w - (tx - x) - 30,
  });
  if (tag) chip(g, Math.min(tx + lw + 16, x + w - 30), cy, tag, { color: tagColor, a: 0.75 + 0.25 * a, maxW: x + w - 34 - (tx + lw + 16) });
  if (a > 0.05) text(g, '›', x + w - 16 + 4 * a, cy - 1, { size: 22, weight: 300, align: 'center', color: rgba(color, a) });
}

// Underline tab. o: { a: hover 0..1, on: active 0..1, color }
export function tab(g, x, y, w, h, label, o = {}) {
  const { a = 0, on = 0, color = C.cyan } = o;
  x = sn(x); y = sn(y);
  const k = Math.max(on, a * 0.45);
  g.fillStyle = rgba(C.ink, 0.5); g.fillRect(x, y, w, h); // backing: stays legible over a sun
  fade(g, color, 'u', x, y, w, h, 0.22 * k);
  g.fillStyle = rgba(C.mid, 0.2);
  g.fillRect(x, sn(y + h) - F.lw, w, F.lw);
  if (on > 0.01) {
    const uw = w * (0.3 + 0.7 * on);
    g.fillStyle = rgba(color, on);
    g.fillRect(x + (w - uw) / 2, sn(y + h) - 2, uw, 2);
    glow(g, color, x + w / 2, y + h, w * 0.5, 12, 0.5 * on);
  }
  text(g, label, x + w / 2, y + h / 2, {
    size: 13, weight: 600, track: 0.2, align: 'center', maxW: w - 12,
    color: on > 0.5 ? rgba(C.hi) : rgba(C.mid, 0.78 + 0.22 * a),
  });
}

// Selectable list row background (label/value are drawn by the caller).
// o: { a: selection 0..1, color, divider }
export function listRow(g, x, y, w, h, o = {}) {
  const { a = 0, color = C.cyan, divider = true } = o;
  if (divider) { g.fillStyle = rgba(C.mid, 0.1); g.fillRect(x, sn(y + h) - F.lw, w, F.lw); }
  if (a > 0.01) {
    fade(g, color, 'r', x, y, w, h, 0.2 * a);
    g.fillStyle = rgba(color, a);
    g.fillRect(sn(x), y + 6, 2.5, h - 12);
    glow(g, color, x + 2, y + h / 2, 34, h * 0.8, 0.4 * a);
  }
}

// Small outlined tag. x is the left / centre / right edge per o.align, y the
// centre. Returns its width.
export function chip(g, x, y, label, o = {}) {
  const { color = C.cyan, align = 'left', size = 10.5, filled = false, h = 20, a = 1, maxW = 0 } = o;
  const pad = 8;
  let tw = measure(g, label, { size, weight: 700, track: 0.14 });
  if (maxW && tw + pad * 2 > maxW) { if (maxW < 40) return 0; tw = maxW - pad * 2; }
  const w = tw + pad * 2;
  const x0 = sn(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x), y0 = sn(y - h / 2);
  const prev = g.globalAlpha;
  g.globalAlpha = prev * a;
  chamfer(g, x0, y0, w, h, 5);
  g.fillStyle = filled ? rgba(color, 0.92) : rgba(color, 0.12); g.fill();
  if (!filled) { g.strokeStyle = rgba(color, 0.55); g.lineWidth = F.lw; g.stroke(); }
  text(g, label, x0 + w / 2, y0 + h / 2 + 0.5, { size, weight: 700, track: 0.14, align: 'center', color: filled ? rgba(C.ink) : rgba(color), maxW: tw + 1 });
  g.globalAlpha = prev;
  return w;
}

// Keyboard hint row: [[key, label], ...]. align 'left' | 'center' | 'right'
// around x; returns the row width. Pass draw:false to only measure.
export function keyHints(g, x, y, items, o = {}) {
  const { align = 'left', size = 11, gap = 20, draw = true } = o;
  const kw = (k) => Math.max(22, measure(g, k, { size, weight: 700, track: 0.06 }) + 12);
  const lw = (l) => (l ? measure(g, l, { size, weight: 500, track: 0.14 }) + 7 : 0);
  let total = 0;
  for (const [k, l] of items) total += kw(k) + lw(l) + gap;
  total -= gap;
  if (!draw) return total;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  for (const [k, l] of items) {
    const w = kw(k), x0 = sn(cx), y0 = sn(y - 10);
    g.beginPath();
    if (g.roundRect) g.roundRect(x0, y0, w, 20, 4); else g.rect(x0, y0, w, 20);
    g.fillStyle = rgba(C.ink, 0.6); g.fill();
    g.strokeStyle = rgba(C.mid, 0.45); g.lineWidth = F.lw; g.stroke();
    text(g, k, x0 + w / 2, y0 + 10.5, { size, weight: 700, track: 0.06, align: 'center', color: rgba(C.hi, 0.92) });
    if (l) text(g, l, x0 + w + 7, y0 + 10.5, { size, weight: 500, track: 0.14, color: rgba(C.low, 0.95) });
    cx += w + lw(l) + gap;
  }
  return total;
}

// Screen title: light tracked caps over a rule with an accent segment.
// o: { size, sub, subColor, align: 'left' | 'center', a, width }
export function title(g, x, y, str, o = {}) {
  const { size = 34, sub = null, subColor = rgba(C.low), align = 'left', a = 1, width = 0 } = o;
  const prev = g.globalAlpha;
  g.globalAlpha = prev * a;
  const tw = text(g, str, x, y, { size, weight: 300, track: 0.26, align, color: '#fff', maxW: W - 2 * gutter() });
  const rw = Math.max(tw, width), x0 = align === 'center' ? x - rw / 2 : x, ry = sn(y + size * 0.78);
  g.fillStyle = rgba(C.mid, 0.2); g.fillRect(x0, ry, rw, F.lw);
  g.fillStyle = rgba(C.cyan); g.fillRect(align === 'center' ? x - 18 : x0, ry - 1, 36, 2);
  if (sub) text(g, sub, x, ry + 16, { size: 11, weight: 600, track: 0.22, align, color: subColor, maxW: W - 2 * gutter() });
  g.globalAlpha = prev;
  return rw;
}

// Credits readout, right-aligned at xr. Returns its width.
export function wallet(g, xr, y, amount) {
  const num = fmt(amount);
  const nw = measure(g, num, { size: 16, weight: 600, track: 0.06 });
  const w = nw + 66, x = sn(xr - w), y0 = sn(y - 16);
  chamfer(g, x, y0, w, 32, 7);
  g.fillStyle = rgba(C.ink, 0.6); g.fill();
  g.strokeStyle = rgba(C.gold, 0.4); g.lineWidth = F.lw; g.stroke();
  diamond(g, x + 17, y0 + 16, 5); g.fillStyle = rgba(C.gold); g.fill();
  text(g, num, x + 30, y0 + 16.5, { size: 16, weight: 600, track: 0.06 });
  text(g, 'CR', x + w - 11, y0 + 17, { size: 10.5, weight: 700, track: 0.12, align: 'right', color: rgba(C.gold, 0.9) });
  return w;
}

// Labelled segmented stat bar. v 0..1. o: { labelW, color, segs, h }
export function statBar(g, x, y, w, label, v, o = {}) {
  const { labelW = 96, color = C.cyan, segs = 14, h = 6 } = o;
  text(g, label, x, y + 0.5, { size: 11, weight: 600, track: 0.16, color: rgba(C.low), maxW: labelW - 8 });
  const bx = x + labelW, bw = w - labelW, gap = 2, sw = (bw - gap * (segs - 1)) / segs;
  v = cl01(v);
  for (let i = 0; i < segs; i++) {
    const sx = bx + i * (sw + gap), f = cl01(v * segs - i);
    g.fillStyle = rgba(C.mid, 0.14); g.fillRect(sx, y - h / 2, sw, h);
    if (f > 0) { g.fillStyle = rgba(color, 0.95); g.fillRect(sx, y - h / 2, sw * f, h); }
  }
}

// Row of level pips (filled / empty). x per align, y centre. Returns width.
export function pips(g, x, y, n, max, o = {}) {
  const { color = C.cyan, w = 14, h = 5, gap = 4, align = 'left' } = o;
  const total = max * w + (max - 1) * gap;
  let x0 = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  for (let i = 0; i < max; i++) {
    g.fillStyle = i < n ? rgba(color) : rgba(C.mid, 0.2);
    g.fillRect(x0, y - h / 2, w, h);
    x0 += w + gap;
  }
  return total;
}

// On/off switch, right-aligned at xr. on is 0..1 (animate it).
export function toggle(g, xr, y, on, o = {}) {
  const { color = C.cyan } = o;
  const w = 38, h = 18, x = xr - w, y0 = y - h / 2;
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y0, w, h, h / 2); else g.rect(x, y0, w, h);
  g.fillStyle = rgba(C.ink, 0.6); g.fill();
  g.fillStyle = rgba(color, 0.3 * on); g.fill();
  g.strokeStyle = on > 0.5 ? rgba(color, 0.9) : rgba(C.low, 0.6); g.lineWidth = F.lw; g.stroke();
  const kx = x + h / 2 + (w - h) * on;
  if (on > 0.05) glow(g, color, kx, y, 16, 16, 0.5 * on);
  g.beginPath(); g.arc(kx, y, h / 2 - 3.5, 0, Math.PI * 2);
  g.fillStyle = on > 0.5 ? rgba(C.hi) : rgba(C.low, 0.9); g.fill();
}

// Slider track with a diamond knob. v 0..1; o.ticks = stop positions 0..1.
export function slider(g, x, y, w, v, o = {}) {
  const { color = C.cyan, ticks = null } = o;
  v = cl01(v);
  g.fillStyle = rgba(C.mid, 0.2); g.fillRect(x, y - 1, w, 2);
  g.fillStyle = rgba(color, 0.95); g.fillRect(x, y - 1, w * v, 2);
  if (ticks) for (const t of ticks) {
    g.fillStyle = t <= v + 0.001 ? rgba(color, 0.9) : rgba(C.mid, 0.35);
    g.fillRect(x + w * t - 0.75, y - 4, 1.5, 8);
  }
  glow(g, color, x + w * v, y, 14, 14, 0.55);
  diamond(g, x + w * v, y, 5.5); g.fillStyle = rgba(C.hi); g.fill();
}

// Two-or-more option pill, right-aligned at xr. idx may be fractional (animated).
export function segmented(g, xr, y, options, idx, o = {}) {
  const { color = C.cyan, h = 24, size = 10.5 } = o;
  const ws = options.map((s) => measure(g, s, { size, weight: 700, track: 0.14 }) + 20);
  const total = ws.reduce((a, b) => a + b, 0);
  const x = sn(xr - total), y0 = sn(y - h / 2);
  chamfer(g, x, y0, total, h, 6);
  g.fillStyle = rgba(C.ink, 0.6); g.fill();
  g.strokeStyle = rgba(C.low, 0.5); g.lineWidth = F.lw; g.stroke();
  // sliding highlight between the two nearest options
  const i0 = Math.floor(idx), i1 = Math.min(options.length - 1, i0 + 1), f = idx - i0;
  const xs = []; let acc = x;
  for (const w of ws) { xs.push(acc); acc += w; }
  const hx = xs[i0] + (xs[i1] - xs[i0]) * f, hw = ws[i0] + (ws[i1] - ws[i0]) * f;
  chamfer(g, hx + 2, y0 + 2, hw - 4, h - 4, 4);
  g.fillStyle = rgba(color, 0.9); g.fill();
  options.forEach((s, i) => {
    const on = Math.abs(idx - i) < 0.5;
    text(g, s, xs[i] + ws[i] / 2, y0 + h / 2 + 0.5, { size, weight: 700, track: 0.14, align: 'center', color: on ? rgba(C.ink) : rgba(C.low) });
  });
  return total;
}

// Kit-styled drop-in for Button (same constructor, hit test and ButtonGroup
// behaviour) for screens that have not moved to the kit yet:
//   new UIButton('BACK', cx, cy, w, h, C.cyan, 'back', 'ghost')
export class UIButton extends Button {
  constructor(label, cx, cy, w, h, color, action, style = 'ghost') {
    super(label, cx, cy, w, h, rgba(color), action);
    this.color = color; this.style = style;
  }
}

/* ------------------------------ in-game HUD kit ----------------------------- */
// Same language as the menus, tuned for play: lighter plates, no animation
// state, nothing allocated per call. All coordinates are world units.

// Translucent plate behind a HUD cluster.
// o: { alpha = 0.42, accent = C.cyan, cut = 8, edge: 'left' | 'right' | 'top' | 'none' }
export function hudPanel(g, x, y, w, h, o = {}) {
  const { alpha = 0.42, accent = C.cyan, cut = 8, edge = 'left' } = o;
  chamfer(g, x, y, w, h, cut);
  g.fillStyle = rgba(C.ink, alpha); g.fill();
  g.strokeStyle = rgba(C.mid, 0.16); g.lineWidth = F.lw; g.stroke();
  g.fillStyle = rgba(accent, 0.9);
  if (edge === 'left') g.fillRect(x, y + cut, 2, h - cut);
  else if (edge === 'right') g.fillRect(x + w - 2, y, 2, h - cut);
  else if (edge === 'top') g.fillRect(x + cut, y, w - cut, 2);
}

// Meter. v 0..1. o: { color = C.cyan, segs = 0 (0 = continuous), back = 0.16,
// glow = false, ghost = null (0..1 trailing "recent damage" level), align: 'left' | 'right' }
export function hudBar(g, x, y, w, h, v, o = {}) {
  const { color = C.cyan, segs = 0, back = 0.16, glow: lit = false, ghost = null, align = 'left' } = o;
  v = cl01(v);
  if (lit && v > 0) glow(g, color, x + w / 2, y + h / 2, w * 0.6, h * 2.6, 0.22);
  if (!segs) {
    g.fillStyle = rgba(C.mid, back); g.fillRect(x, y, w, h);
    if (ghost != null && ghost > v) {
      g.fillStyle = rgba(C.hi, 0.55);
      g.fillRect(align === 'right' ? x + w * (1 - cl01(ghost)) : x, y, w * cl01(ghost), h);
    }
    g.fillStyle = rgba(color);
    g.fillRect(align === 'right' ? x + w * (1 - v) : x, y, w * v, h);
    return;
  }
  const gap = 2, sw = (w - gap * (segs - 1)) / segs;
  for (let i = 0; i < segs; i++) {
    const k = align === 'right' ? segs - 1 - i : i, f = cl01(v * segs - k), sx = x + i * (sw + gap);
    g.fillStyle = rgba(C.mid, back); g.fillRect(sx, y, sw, h);
    if (f > 0) { g.fillStyle = rgba(color); g.fillRect(align === 'right' ? sx + sw * (1 - f) : sx, y, sw * f, h); }
  }
}

// Tracked HUD caption / readout with a 1px drop shade for contrast over the
// playfield. o: { size = 11, color, align = 'left', track = 0.16, weight = 600,
// shade = true, maxW }. Returns the drawn width.
export function hudLabel(g, str, x, y, o = {}) {
  const { size = 11, color = rgba(C.mid), align = 'left', track = 0.16, weight = 600, shade = true, maxW = 0 } = o;
  if (shade) text(g, str, x + 1, y + 1, { size, weight, track, align, maxW, color: 'rgba(0,0,0,0.6)' });
  return text(g, str, x, y, { size, weight, track, align, maxW, color });
}

// Counter drawn as icons (lives, rockets, charges). y is the centre line.
// o: { icon: 'diamond' | 'bar' | 'dot' | 'chevron', size = 9, gap = 5,
// color = C.cyan, align: 'left' | 'right' | 'center' }. Returns the row width.
export function hudIconPips(g, x, y, count, max, o = {}) {
  const { icon = 'diamond', size = 9, gap = 5, color = C.cyan, align = 'left' } = o;
  const n = Math.max(max, count), iw = icon === 'bar' ? size * 0.45 : size;
  const total = n * iw + (n - 1) * gap;
  let cx = (align === 'right' ? x - total : align === 'center' ? x - total / 2 : x) + iw / 2;
  const r = size / 2;
  for (let i = 0; i < n; i++) {
    const on = i < count;
    g.beginPath();
    if (icon === 'bar') g.rect(cx - iw / 2, y - r, iw, size);
    else if (icon === 'dot') g.arc(cx, y, r * 0.8, 0, Math.PI * 2);
    else if (icon === 'chevron') {
      g.moveTo(cx - r, y + r * 0.7); g.lineTo(cx, y - r * 0.7); g.lineTo(cx + r, y + r * 0.7);
      g.lineTo(cx + r * 0.45, y + r * 0.7); g.lineTo(cx, y - r * 0.05); g.lineTo(cx - r * 0.45, y + r * 0.7);
      g.closePath();
    } else { g.moveTo(cx, y - r); g.lineTo(cx + r, y); g.lineTo(cx, y + r); g.lineTo(cx - r, y); g.closePath(); }
    if (on) { g.fillStyle = rgba(color); g.fill(); }
    else { g.strokeStyle = rgba(C.mid, 0.4); g.lineWidth = F.lw; g.stroke(); }
    cx += iw + gap;
  }
  return total;
}

// HUD glyphs centred on (x, y); s = overall height. kind: 'rocket' | 'bolt'
export function hudGlyph(g, kind, x, y, s, color) {
  g.fillStyle = color;
  g.beginPath();
  if (kind === 'rocket') {
    g.moveTo(x - s * 0.6, y - s * 0.5); g.lineTo(x - s * 0.3, y - s * 0.2); g.lineTo(x + s * 0.25, y - s * 0.2);
    g.lineTo(x + s * 0.7, y); g.lineTo(x + s * 0.25, y + s * 0.2); g.lineTo(x - s * 0.3, y + s * 0.2);
    g.lineTo(x - s * 0.6, y + s * 0.5); g.lineTo(x - s * 0.45, y);
  } else {
    g.moveTo(x + s * 0.15, y - s * 0.6); g.lineTo(x - s * 0.35, y + s * 0.08); g.lineTo(x - s * 0.02, y + s * 0.08);
    g.lineTo(x - s * 0.15, y + s * 0.6); g.lineTo(x + s * 0.35, y - s * 0.08); g.lineTo(x + s * 0.02, y - s * 0.08);
  }
  g.closePath(); g.fill();
}

// Rocket + beam counters as glyph/number pairs starting at x (left edge).
export function hudAmmo(g, x, y, rockets, lasers) {
  const rc = rgba(rockets > 0 ? C.hi : C.low), lc = rgba(lasers > 0 ? C.cyan : C.low);
  hudGlyph(g, 'rocket', x + 7, y, 11, rc);
  text(g, String(rockets), x + 20, y + 0.5, { size: 14, weight: 700, color: rc });
  hudGlyph(g, 'bolt', x + 54, y, 13, lc);
  text(g, String(lasers), x + 64, y + 0.5, { size: 14, weight: 700, color: lc });
}

// Versus score plate in a top corner. side: 'left' | 'right'.
// o: { name, score, color (css), rockets, lasers } — ammo row only when given.
export function hudScorePlate(g, side, o) {
  const w = 176, h = o.rockets != null ? 78 : 52, x = side === 'left' ? 8 : W - 8 - w;
  const tx = side === 'left' ? x + 14 : x + w - 14;
  hudPanel(g, x, 8, w, h, { alpha: 0.5, edge: side });
  text(g, o.name, tx, 21, { size: 9.5, weight: 700, track: 0.24, align: side, color: o.color || rgba(C.low), maxW: w - 28 });
  text(g, String(o.score), tx, 43, { size: 24, weight: 600, align: side, color: '#fff' });
  if (o.rockets != null) {
    g.fillStyle = rgba(C.mid, 0.14); g.fillRect(x + 14, 60, w - 28, F.lw);
    hudAmmo(g, side === 'left' ? x + 14 : x + w - 14 - 76, 73, o.rockets, o.lasers);
  }
}

// Glass disc for touch controls (dark fill holds up over a bright scene).
export function touchDisc(g, x, y, r, color = C.mid, ring = 0.7) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = rgba(C.ink, 0.5); g.fill();
  g.strokeStyle = rgba(color, ring); g.lineWidth = 1.5; g.stroke();
  g.beginPath(); g.arc(x, y, r - 5, 0, Math.PI * 2);
  g.strokeStyle = rgba(color, 0.16); g.lineWidth = 1; g.stroke();
}

// Full-screen notice over a dimmed scene (disconnects, countdowns, results).
// o: { sub, color = C.hi, dim = 0.6, y = H / 2, size = 34 }
export function notice(g, str, o = {}) {
  const { sub = null, color = C.hi, dim = 0.6, y = H / 2, size = 34 } = o;
  if (dim) { g.fillStyle = rgba('2,5,10', dim); g.fillRect(0, 0, W, H); }
  const bw = Math.min(W * 0.48, 460), h = size * 1.3 + (sub ? 30 : 8), top = y - size * 0.75;
  for (const [dir, x] of [['l', W / 2 - bw], ['r', W / 2]]) {
    fade(g, '2,5,10', dir, x, top, bw, h, 0.6);
    fade(g, color, dir, x, top, bw, F.lw * 1.5, 0.9);
    fade(g, color, dir, x, top + h - F.lw * 1.5, bw, F.lw * 1.5, 0.9);
  }
  text(g, str, W / 2, y, { size, weight: 300, track: 0.3, align: 'center', color: rgba(color), maxW: W - 40 });
  if (sub) text(g, sub, W / 2, y + size * 0.62 + 10, { size: 11, weight: 700, track: 0.28, align: 'center', color: rgba(C.mid, 0.95), maxW: W - 40 });
}
