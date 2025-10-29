import { FRAME_TIME, GAME_STATE, WIDTH, HEIGHT } from './constants.js';
import { loadAssets } from './assets.js';
import { InputManager } from './input.js';
import { UIManager } from './ui.js';
import { GameWorld } from './gameWorld.js';
import { VersusWorld } from './versusWorld.js';

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');

const input = new InputManager();
const ui = new UIManager(overlay);

let assets = null;
let currentWorld = null;
let currentState = GAME_STATE.LOADING;
let lastTimestamp = 0;
let accumulator = 0;
let musicVolume = 0.5;
let soundVolume = 0.7;

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
    currentWorld = new VersusWorld({
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
    currentWorld = new GameWorld({
      assets,
      input,
      mode,
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
