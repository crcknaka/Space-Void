export const WIDTH = 600;
export const HEIGHT = 880;
export const TARGET_FPS = 60;
export const FRAME_TIME = 1 / TARGET_FPS;

export const POWERUP_TYPES = {
  RAPID_FIRE: 'rapid_fire',
  SLOW_MOTION: 'slow_motion',
  KILL_ALL: 'kill_all',
  SPREAD: 'spread',
  ROCKET: 'rocket',
};

export const GAME_STATE = {
  LOADING: 'loading',
  MENU: 'menu',
  GAME: 'game',
  VERSUS: 'versus',
  GAME_OVER: 'game_over',
  PAUSED: 'paused',
  SETTINGS: 'settings',
};

export const PLAYER_CONTROLS = {
  player1: {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    shoot: 'Space',
    rocket: 'ShiftLeft',
    speed: 'ShiftLeft',
  },
  player2: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    shoot: 'Enter',
    rocket: 'Numpad0',
    speed: 'Numpad0',
  },
};

export const COLORS = {
  white: '#ffffff',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#00aaff',
  orange: '#ff8c00',
  yellow: '#ffe066',
};

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

export function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function segmentCircleIntersects(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(x1 - cx, y1 - cy) <= radius;
  }

  const fx = x1 - cx;
  const fy = y1 - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  let discriminant = b * b - 4 * a * c;

  if (discriminant < 0) {
    return false;
  }

  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

export function bulletAsteroidHit(bullet, asteroid) {
  const start = bullet.getPreviousCenter();
  const end = bullet.getCenter();
  const centerX = asteroid.x + asteroid.width / 2;
  const centerY = asteroid.y + asteroid.height / 2;
  const radius = asteroid.radius || Math.max(asteroid.width, asteroid.height) / 2;
  const startDistance = Math.hypot(start.x - centerX, start.y - centerY);
  const endDistance = Math.hypot(end.x - centerX, end.y - centerY);
  if (startDistance <= radius || endDistance <= radius) {
    return true;
  }
  return segmentCircleIntersects(start.x, start.y, end.x, end.y, centerX, centerY, radius);
}
