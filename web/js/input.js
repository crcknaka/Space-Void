// Keyboard + multi-touch pointers + gamepads, shared by all game states
import { W, H } from './const.js';

export const keys = new Set();      // codes currently held
export const pressed = new Set();   // codes pressed since last logic step
// Primary pointer — used by menus (hover + click). Mirrors the last active pointer.
export const pointer = { x: -1000, y: -1000, down: false, justDown: false };
// All active pointers by pointerId — used by gameplay touch controls (multi-touch).
export const pointers = new Map();  // id -> {x, y, justDown}
export const isTouch = window.matchMedia('(pointer: coarse)').matches;
// Gamepads polled once per frame: [{x, y, fire, boost}]
export const pads = [];

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);
let cv = null;

export function init(canvas) {
  cv = canvas;
  addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return; // typing in name overlay
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const toXY = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    const p = toXY(e);
    pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, downAt: performance.now(), justDown: true });
    pointer.x = p.x; pointer.y = p.y;
    pointer.down = true;
    pointer.justDown = true;
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', (e) => {
    const p = toXY(e);
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = p.x; pt.y = p.y; }
    pointer.x = p.x; pointer.y = p.y;
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    pointer.down = pointers.size > 0;
  };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function endStep() {
  pressed.clear();
  pointer.justDown = false;
  for (const pt of pointers.values()) pt.justDown = false;
}

export function anyPress() {
  return pressed.size > 0 || pointer.justDown;
}

/* --------------------------------- gamepads --------------------------------- */
// Pad 0 -> Player 1, pad 1 -> Player 2. Stick/D-pad = move, A/RT = fire, B/RB/LT = boost.
// D-pad/stick + A + Start also drive menus (mapped to Arrow/Enter/Escape edges).

const prevPad = [];

export function pollGamepads() {
  pads.length = 0;
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  let slot = 0;
  for (const gp of list) {
    if (!gp || !gp.connected) continue;
    const btn = (i) => !!gp.buttons[i]?.pressed;
    const dz = (v) => (Math.abs(v) > 0.22 ? v : 0);
    let x = dz(gp.axes[0] || 0);
    let y = dz(gp.axes[1] || 0);
    if (btn(14)) x = -1;
    if (btn(15)) x = 1;
    if (btn(12)) y = -1;
    if (btn(13)) y = 1;

    pads[slot] = {
      x, y,
      fire: btn(0) || btn(7),            // A / RT
      boost: btn(1) || btn(5) || btn(6), // B / RB / LT
    };

    // edge-detection for menu navigation & pause
    const now = { u: y < -0.6, d: y > 0.6, a: btn(0), start: btn(9) };
    const prev = prevPad[slot] || {};
    if (now.u && !prev.u) pressed.add('ArrowUp');
    if (now.d && !prev.d) pressed.add('ArrowDown');
    if (now.a && !prev.a) pressed.add('Enter');
    if (now.start && !prev.start) pressed.add('Escape');
    prevPad[slot] = now;
    slot++;
  }
}
