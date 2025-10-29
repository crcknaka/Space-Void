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
