// Keyboard + pointer state shared by all game states
import { W, H } from './const.js';

export const keys = new Set();      // codes currently held
export const pressed = new Set();   // codes pressed since last logic step
export const pointer = { x: -1000, y: -1000, down: false, justDown: false };
export const isTouch = window.matchMedia('(pointer: coarse)').matches;

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);
let cv = null;

export function init(canvas) {
  cv = canvas;
  addEventListener('keydown', (e) => {
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) pressed.add(e.code);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const toCanvas = (e) => {
    const r = cv.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) * W) / r.width;   // game-space coords
    pointer.y = ((e.clientY - r.top) * H) / r.height;
  };
  cv.addEventListener('pointerdown', (e) => {
    toCanvas(e);
    pointer.down = true;
    pointer.justDown = true;
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener('pointermove', toCanvas);
  addEventListener('pointerup', () => { pointer.down = false; });
  addEventListener('pointercancel', () => { pointer.down = false; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function endStep() {
  pressed.clear();
  pointer.justDown = false;
}

export function anyPress() {
  return pressed.size > 0 || pointer.justDown;
}
