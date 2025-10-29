export class InputManager {
  constructor() {
    this.keys = new Set();
    this.listeners = new Map();
    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));
  }

  handleKey(event, pressed) {
    if (event.repeat) return;
    const key = event.code;
    if (pressed) {
      this.keys.add(key);
    } else {
      this.keys.delete(key);
    }
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach((callback) => callback(pressed));
    }
  }

  isPressed(code) {
    return this.keys.has(code);
  }

  onKey(code, callback) {
    if (!this.listeners.has(code)) {
      this.listeners.set(code, []);
    }
    this.listeners.get(code).push(callback);
  }
}
