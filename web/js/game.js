import { WIDTH, HEIGHT, FRAME_TIME, GAME_STATE } from './shared.js';
import { createSinglePlayerWorld } from './single-player.js';
import { createCoopWorld } from './coop.js';
import { createVersusWorld } from './versus.js';
import { attachMenuUI } from './menu.js';
import { attachSettingsUI } from './settings.js';

const canvas = document.getElementById('game-canvas');
const ctx = canvas?.getContext('2d');
const overlay = document.getElementById('overlay');
const container = document.getElementById('game-container');
const menuButton = document.getElementById('menu-button');

if (!canvas || !ctx || !overlay || !container) {
  throw new Error('Game canvas or UI elements are missing.');
}

const IMAGE_PATH = '../assets/images/';
const SOUND_PATH = '../assets/sounds/';

const IMAGE_ASSETS = {
  player1_img: { file: 'player1_ship.png', size: [50, 30] },
  player1_thruster_frames: {
    files: ['player1_thruster_1.png', 'player1_thruster_2.png', 'player1_thruster_3.png', 'player1_thruster_4.png'],
  },
  player2_img: { file: 'player2_ship.png', size: [50, 30] },
  player2_thruster_frames: {
    files: ['player2_thruster_1.png', 'player2_thruster_2.png', 'player2_thruster_3.png', 'player2_thruster_4.png'],
  },
  enemy_img: { file: 'enemy_ship.png', size: [50, 30] },
  enemy_thruster_frames: {
    files: ['enemy_thruster_1.png', 'enemy_thruster_2.png', 'enemy_thruster_3.png', 'enemy_thruster_4.png'],
  },
  boss_img: { file: 'boss.png', size: [150, 150] },
  bullet_img: { file: 'bullet.png', size: [10, 5] },
  enemy_bullet_img: { file: 'enemy_bullet.png', size: [10, 5] },
  powerup_img: { file: 'powerup.png', size: [60, 30] },
  slow_motion_powerup_img: { file: 'slow_motion_powerup.png', size: [60, 30] },
  kill_all_powerup_img: { file: 'kill_all_powerup.png', size: [60, 30] },
  spread_powerup_img: { file: 'spread_powerup.png', size: [60, 30] },
  rocket_powerup_img: { file: 'rocket_powerup.png', size: [60, 30] },
  menu_background: { file: 'menu_background.png' },
  game_background: { file: 'game_background.png' },
  versus_background: { file: 'versus_background.png' },
  explosion_spritesheet: { file: 'explosion_spritesheet.png' },
  asteroid_img: { file: 'asteroid.png' },
  rocket_img: { file: 'rocket.png', size: [20, 10] },
};

const SOUND_ASSETS = {
  explosion_sound: 'explosion.wav',
  gun_sound: 'gun.wav',
  powerup_sound: 'powerup.wav',
  rocket_sound: 'rocket.wav',
  hover_sound: 'hover.wav',
  click_sound: 'click.wav',
  background_music: 'background_music.mp3',
  versus_music: 'versus_music.mp3',
  player1_kill_sound: 'player1_kill.wav',
  player2_kill_sound: 'player2_kill.wav',
};

function loadImage(src, size) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (size) {
        const [width, height] = size;
        const imageCanvas = document.createElement('canvas');
        imageCanvas.width = width;
        imageCanvas.height = height;
        const imageCtx = imageCanvas.getContext('2d');
        imageCtx.drawImage(image, 0, 0, width, height);
        resolve(imageCanvas);
      } else {
        resolve(image);
      }
    };
    image.onerror = reject;
    image.crossOrigin = 'anonymous';
    image.src = `${IMAGE_PATH}${src}`;
  });
}

function loadAudio(src) {
  const audio = new Audio(`${SOUND_PATH}${src}`);
  audio.preload = 'auto';
  return audio;
}

async function loadAssets(updateProgress) {
  const assets = {};
  let loaded = 0;
  const total = Object.keys(IMAGE_ASSETS).length + Object.keys(SOUND_ASSETS).length;

  const increment = () => {
    loaded += 1;
    if (updateProgress) {
      updateProgress(loaded / total);
    }
  };

  const imagePromises = Object.entries(IMAGE_ASSETS).map(async ([key, descriptor]) => {
    if ('files' in descriptor) {
      const frames = await Promise.all(descriptor.files.map((file) => loadImage(file)));
      assets[key] = frames;
    } else {
      assets[key] = await loadImage(descriptor.file, descriptor.size);
    }
    increment();
  });

  await Promise.all(imagePromises);

  Object.entries(SOUND_ASSETS).forEach(([key, file]) => {
    assets[key] = loadAudio(file);
    increment();
  });

  return assets;
}

class InputManager {
  constructor() {
    this.keys = new Set();
    this.listeners = new Map();
    this.moveTouchId = null;
    this.touchStart = { x: 0, y: 0 };
    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));
    this.setupTouchControls();
  }

  handleKey(event, pressed) {
    if (event.repeat) return;
    const key = event.code;
    this.updateKeyState(key, pressed);
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

  updateKeyState(code, pressed) {
    const hasKey = this.keys.has(code);
    if (pressed && !hasKey) {
      this.keys.add(code);
      if (this.listeners.has(code)) {
        this.listeners.get(code).forEach((callback) => callback(true));
      }
    } else if (!pressed && hasKey) {
      this.keys.delete(code);
      if (this.listeners.has(code)) {
        this.listeners.get(code).forEach((callback) => callback(false));
      }
    }
  }

  setVirtualKey(code, pressed) {
    this.updateKeyState(code, pressed);
  }

  setupTouchControls() {
    const moveArea = document.getElementById('touch-move');
            const isTouchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouchCapable) return;

    if (moveArea) {
      const startMove = (event) => {
        if (this.moveTouchId !== null) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        this.moveTouchId = touch.identifier;
        this.touchStart.x = touch.clientX;
        this.touchStart.y = touch.clientY;
        this.updateTouchMovement(0, 0);
      };

      const move = (event) => {
        if (this.moveTouchId === null) return;
        const touch = Array.from(event.changedTouches).find((t) => t.identifier === this.moveTouchId);
        if (!touch) return;
        const dx = touch.clientX - this.touchStart.x;
        const dy = touch.clientY - this.touchStart.y;
        this.updateTouchMovement(dx, dy);
      };

      const endMove = (event) => {
        if (this.moveTouchId === null) return;
        const touch = Array.from(event.changedTouches).find((t) => t.identifier === this.moveTouchId);
        if (!touch) return;
        this.moveTouchId = null;
        this.updateTouchMovement(0, 0);
      };

      moveArea.addEventListener('touchstart', (event) => {
        event.preventDefault();
        startMove(event);
      }, { passive: false });
      moveArea.addEventListener('touchmove', (event) => {
        event.preventDefault();
        move(event);
      }, { passive: false });
      moveArea.addEventListener('touchend', (event) => {
        event.preventDefault();
        endMove(event);
      }, { passive: false });
      moveArea.addEventListener('touchcancel', (event) => {
        event.preventDefault();
        endMove(event);
      }, { passive: false });
    }

    const bindButton = (element, code) => {
      if (!element) return;
      element.addEventListener('touchstart', (event) => {
        event.preventDefault();
        this.setVirtualKey(code, true);
      }, { passive: false });
      const release = (event) => {
        event.preventDefault();
        this.setVirtualKey(code, false);
      };
      element.addEventListener('touchend', release, { passive: false });
      element.addEventListener('touchcancel', release, { passive: false });
    };

    bindButton(shootButton, 'Space');
    bindButton(rocketButton, 'ShiftLeft');
  }

  updateTouchMovement(dx, dy) {
    const threshold = 20;
    this.setVirtualKey('KeyW', dy < -threshold);
    this.setVirtualKey('KeyS', dy > threshold);
    this.setVirtualKey('KeyA', dx < -threshold);
    this.setVirtualKey('KeyD', dx > threshold);
  }
}


class UIManager {
  constructor(overlayElement) {
    this.overlay = overlayElement;
    this.currentHandler = null;
  }

  clear() {
    this.overlay.innerHTML = '';
    this.overlay.style.display = 'none';
    if (this.currentHandler) {
      this.currentHandler();
      this.currentHandler = null;
    }
  }

  showLoading(progress) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div style="text-align:center;">
        <h1>Loading Assets</h1>
        <div style="width:240px;height:20px;border:1px solid #666;border-radius:4px;overflow:hidden;margin-top:16px;">
          <div style="width:${Math.floor(progress * 100)}%;height:100%;background:#00aaff;"></div>
        </div>
        <p style="margin-top:8px;">${Math.floor(progress * 100)}%</p>
      </div>
    `;
  }
  showGameOver({ score, level, onRetry, onMenu }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Game Over</h1>
        <p class="menu__subtitle">Score: ${score}</p>
        <p class="menu__subtitle">Level: ${level}</p>
        <button class="menu__button" data-action="retry">Retry</button>
        <button class="menu__button menu__button--secondary" data-action="menu">Main Menu</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'retry') {
        onRetry();
      } else if (action === 'menu') {
        onMenu();
      }
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showVersusGameOver({ winner, scores, onRematch, onMenu }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Versus Complete</h1>
        <p class="menu__subtitle">Winner: Player ${winner}</p>
        <p class="menu__subtitle">P1 ${scores[0]} - P2 ${scores[1]}</p>
        <button class="menu__button" data-action="rematch">Rematch</button>
        <button class="menu__button menu__button--secondary" data-action="menu">Main Menu</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'rematch') onRematch();
      if (action === 'menu') onMenu();
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }
}


function resizeGameArea() {
  if (!container) return;
  const bodyStyles = window.getComputedStyle(document.body);
  const safeLeft = parseFloat(bodyStyles.paddingLeft) || 0;
  const safeRight = parseFloat(bodyStyles.paddingRight) || 0;
  const safeTop = parseFloat(bodyStyles.paddingTop) || 0;
  const safeBottom = parseFloat(bodyStyles.paddingBottom) || 0;
  const availableWidth = window.innerWidth - safeLeft - safeRight;
  const availableHeight = window.innerHeight - safeTop - safeBottom;
  const scale = Math.min(availableWidth / WIDTH, availableHeight / HEIGHT);
  const scaledWidth = WIDTH * scale;
  const scaledHeight = HEIGHT * scale;
  const offsetX = Math.max((availableWidth - scaledWidth) / 2, 0);
  const offsetY = Math.max((availableHeight - scaledHeight) / 2, 0);

  container.style.transform = `scale(${scale})`;
  container.style.left = `${safeLeft + offsetX}px`;
  container.style.top = `${safeTop + offsetY}px`;
}

window.addEventListener('resize', resizeGameArea);
window.addEventListener('orientationchange', resizeGameArea);
document.addEventListener('fullscreenchange', resizeGameArea);
document.addEventListener('webkitfullscreenchange', resizeGameArea);
document.addEventListener('mozfullscreenchange', resizeGameArea);
document.addEventListener('MSFullscreenChange', resizeGameArea);
resizeGameArea();

const input = new InputManager();
const ui = new UIManager(overlay);
attachMenuUI(ui);
attachSettingsUI(ui);


let assets = null;
let currentWorld = null;
let currentState = GAME_STATE.LOADING;
let lastTimestamp = 0;
let accumulator = 0;
let musicVolume = 0.5;
let soundVolume = 0.7;

if (menuButton) {
  menuButton.addEventListener('click', () => {
    showMainMenu();
  });
}

function stopAllMusic() {
  if (!assets) return;
  ['background_music', 'versus_music'].forEach((key) => {
    const track = assets[key];
    if (track && typeof track.pause === 'function') {
      track.pause();
      track.currentTime = 0;
    }
  });
}

function applyVolumeSettings() {
  if (!assets) return;
  ['background_music', 'versus_music'].forEach((key) => {
    const track = assets[key];
    if (track) {
      track.volume = musicVolume;
    }
  });

  Object.entries(assets).forEach(([key, value]) => {
    if (key.endsWith('_sound') || key === 'gun_sound' || key === 'rocket_sound') {
      if (value) {
        value.volume = soundVolume;
      }
    }
  });
}

function startGame(mode) {
  if (!assets) return;
  stopAllMusic();
  ui.clear();

  if (mode === 'versus') {
    currentWorld = createVersusWorld({
      assets,
      input,
      onGameOver: ({ winner, scores }) => {
        currentState = GAME_STATE.GAME_OVER;
        ui.showVersusGameOver({
          winner,
          scores,
          onRematch: () => startGame('versus'),
          onMenu: showMainMenu,
        });
      },
    });
  } else {
    const factory = mode === 'coop' ? createCoopWorld : createSinglePlayerWorld;
    currentWorld = factory({
      assets,
      input,
      onGameOver: ({ score, level }) => {
        currentState = GAME_STATE.GAME_OVER;
        ui.showGameOver({
          score: Math.floor(score),
          level,
          onRetry: () => startGame(mode),
          onMenu: showMainMenu,
        });
      },
    });
  }

  applyVolumeSettings();
  currentState = GAME_STATE.GAME;
}

function showMainMenu() {
  if (currentWorld) {
    stopAllMusic();
    currentWorld = null;
  }
  currentState = GAME_STATE.MENU;
  ui.showMenu({
    onStartSingle: () => startGame('single'),
    onStartCoop: () => startGame('coop'),
    onStartVersus: () => startGame('versus'),
    onSettings: showSettings,
  });
}

function showSettings() {
  ui.showSettings({
    onBack: showMainMenu,
    initialMusicVolume: musicVolume,
    initialSoundVolume: soundVolume,
    onChangeMusic: (value) => {
      musicVolume = value;
      applyVolumeSettings();
    },
    onChangeSound: (value) => {
      soundVolume = value;
      applyVolumeSettings();
    },
  });
}

input.onKey('Escape', (pressed) => {
  if (!pressed || !currentWorld) return;
  currentWorld.paused = !currentWorld.paused;
  if (currentWorld.paused) {
    currentState = GAME_STATE.PAUSED;
  } else {
    currentState = GAME_STATE.GAME;
  }
});

function loop(timestamp) {
  if (!lastTimestamp) lastTimestamp = timestamp;
  const delta = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  if (currentWorld && !currentWorld.paused) {
    accumulator += delta;
    while (accumulator >= FRAME_TIME) {
      currentWorld.update(FRAME_TIME);
      accumulator -= FRAME_TIME;
    }
  }

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  if (currentWorld) {
    currentWorld.draw(ctx);
  }

  requestAnimationFrame(loop);
}

async function bootstrap() {
  ui.showLoading(0);
  assets = await loadAssets((progress) => ui.showLoading(progress));
  applyVolumeSettings();
  showMainMenu();
  requestAnimationFrame(loop);
}

bootstrap().catch((error) => {
  console.error('Failed to initialize Space Void', error);
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="menu"><h1 class="menu__title">Error</h1><p>${error.message}</p></div>`;
});
