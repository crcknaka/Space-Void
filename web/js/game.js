(function () {
  const SpaceVoid = (window.SpaceVoid = window.SpaceVoid || {});
  const shared = SpaceVoid.shared;
  if (!shared) {
    throw new Error('Shared module must be loaded before game bootstrap.');
  }

  const { WIDTH, HEIGHT, FRAME_TIME, GAME_STATE } = shared;
  const {
    createSinglePlayerWorld,
    createBulletHellWorld,
    createCoopWorld,
    createVersusWorld,
    attachMenuUI,
    attachSettingsUI,
  } = SpaceVoid;
  if (
    !createSinglePlayerWorld ||
    !createBulletHellWorld ||
    !createCoopWorld ||
    !createVersusWorld ||
    !attachMenuUI ||
    !attachSettingsUI
  ) {
    throw new Error('Game modules failed to load.');
  }

  const canvas = document.getElementById('game-canvas');
const ctx = canvas?.getContext('2d');
const overlay = document.getElementById('overlay');
const container = document.getElementById('game-container');
const touchControls = document.getElementById('touch-controls');
const primaryJoystick = document.getElementById('touch-move');
const secondaryJoystick = document.getElementById('touch-move-2');
const menuButton = document.getElementById('menu-button');
const shootButton = document.getElementById('touch-shoot');
const rocketButton = document.getElementById('touch-rocket');
const rocketButton2 = document.getElementById('touch-rocket-2');
const touchButtonsContainer = touchControls?.querySelector('.touch-buttons') ?? null;

if (!canvas || !ctx || !overlay || !container) {
  throw new Error('Game canvas or UI elements are missing.');
}

function setMenuButtonVisible(visible) {
  if (!menuButton) return;
  menuButton.classList.toggle('is-hidden', !visible);
  menuButton.setAttribute('aria-hidden', String(!visible));
}

setMenuButtonVisible(false);

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
  constructor(touchElements = null) {
    this.keys = new Set();
    this.listeners = new Map();
    this.touchJoysticks = [];
    this.touchButtons = [];
    this.touchElements = null;
    this.isTouchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.updateTouchAxes = this.updateTouchAxes.bind(this);
    this.rafId = null;

    window.addEventListener('keydown', (event) => this.handleKey(event, true));
    window.addEventListener('keyup', (event) => this.handleKey(event, false));

    if (touchElements) {
      this.attachTouchElements(touchElements);
    }
  }

  attachTouchElements({ container, primaryJoystick, secondaryJoystick, buttonsContainer, buttons = {} }) {
    this.touchElements = {
      container,
      primaryJoystick,
      secondaryJoystick,
      buttonsContainer,
      buttons,
    };

    if (!this.isTouchCapable && container) {
      container.style.display = 'none';
    }

    if (this.isTouchCapable && this.rafId === null) {
      this.rafId = window.requestAnimationFrame(this.updateTouchAxes);
    }
  }

  handleKey(event, pressed) {
    if (event.repeat) return;
    this.updateKeyState(event.code, pressed);
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
    if (!code) return;
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

  configureTouchControls({ joysticks = [], buttons = [] } = {}) {
    if (!this.touchElements) return;

    this.clearTouchBindings();

    const { container, primaryJoystick, secondaryJoystick, buttonsContainer, buttons: buttonElements } = this.touchElements;

    const allJoysticks = [primaryJoystick, secondaryJoystick];
    allJoysticks.forEach((element) => this.toggleElement(element, false));

    if (buttonsContainer) {
      this.toggleElement(buttonsContainer, false);
    }
    if (buttonElements) {
      Object.values(buttonElements).forEach((element) => this.toggleElement(element, false));
    }

    if (!this.isTouchCapable || (!joysticks.length && !buttons.length)) {
      this.setTouchContainerVisible(false);
      return;
    }

    this.setTouchContainerVisible(true);

    const activeJoysticks = [];
    joysticks.forEach((config) => {
      if (!config || !config.element || !config.bindings) return;
      const joystick = this.registerJoystick(config);
      if (joystick) {
        activeJoysticks.push(joystick);
      }
    });
    this.touchJoysticks = activeJoysticks;

    const activeButtons = [];
    buttons.forEach((config) => {
      if (!config || !config.element || !config.code) return;
      const binding = this.bindButton(config.element, config.code);
      if (binding) {
        activeButtons.push(binding);
      }
    });
    this.touchButtons = activeButtons;

    if (buttonsContainer) {
      this.toggleElement(buttonsContainer, activeButtons.length > 0);
    }
  }

  clearTouchBindings() {
    this.touchJoysticks.forEach((joystick) => {
      if (joystick.cleanup) {
        joystick.cleanup();
      }
    });
    this.touchJoysticks = [];

    this.touchButtons.forEach((binding) => {
      if (binding.cleanup) {
        binding.cleanup();
      }
    });
    this.touchButtons = [];
  }

  registerJoystick({ element, bindings }) {
    const joystick = {
      element,
      bindings,
      pointerId: null,
      origin: { x: 0, y: 0 },
      axis: {
        current: { x: 0, y: 0 },
        target: { x: 0, y: 0 },
      },
      keyState: { up: false, down: false, left: false, right: false },
      thumb: element.querySelector('.touch-thumb'),
    };

    this.toggleElement(element, true);

    const start = (event) => {
      if (joystick.pointerId !== null) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      joystick.pointerId = touch.identifier;
      joystick.origin.x = touch.clientX;
      joystick.origin.y = touch.clientY;
      joystick.axis.target.x = 0;
      joystick.axis.target.y = 0;
      event.preventDefault();
    };

    const move = (event) => {
      if (joystick.pointerId === null) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === joystick.pointerId);
      if (!touch) return;
      const rect = element.getBoundingClientRect();
      const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
      const dx = touch.clientX - joystick.origin.x;
      const dy = touch.clientY - joystick.origin.y;
      const clampedX = Math.max(-radius, Math.min(radius, dx));
      const clampedY = Math.max(-radius, Math.min(radius, dy));
      let nx = clampedX / radius;
      let ny = clampedY / radius;
      const length = Math.sqrt(nx * nx + ny * ny);
      if (length > 1) {
        nx /= length;
        ny /= length;
      }
      joystick.axis.target.x = nx;
      joystick.axis.target.y = ny;
      event.preventDefault();
    };

    const end = (event) => {
      if (joystick.pointerId === null) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === joystick.pointerId);
      if (!touch) return;
      joystick.pointerId = null;
      joystick.axis.target.x = 0;
      joystick.axis.target.y = 0;
      event.preventDefault();
    };

    element.addEventListener('touchstart', start, { passive: false });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end, { passive: false });
    element.addEventListener('touchcancel', end, { passive: false });

    joystick.cleanup = () => {
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', end);
      joystick.pointerId = null;
      joystick.axis.target.x = 0;
      joystick.axis.target.y = 0;
      joystick.axis.current.x = 0;
      joystick.axis.current.y = 0;
      this.releaseJoystickKeys(joystick);
      this.updateThumbPosition(joystick);
    };

    return joystick;
  }

  bindButton(element, code) {
    this.toggleElement(element, true);
    const press = (event) => {
      event.preventDefault();
      this.setVirtualKey(code, true);
    };
    const release = (event) => {
      event.preventDefault();
      this.setVirtualKey(code, false);
    };
    element.addEventListener('touchstart', press, { passive: false });
    element.addEventListener('touchend', release, { passive: false });
    element.addEventListener('touchcancel', release, { passive: false });

    return {
      element,
      code,
      cleanup: () => {
        element.removeEventListener('touchstart', press);
        element.removeEventListener('touchend', release);
        element.removeEventListener('touchcancel', release);
        this.setVirtualKey(code, false);
        this.toggleElement(element, false);
      },
    };
  }

  updateTouchAxes() {
    this.touchJoysticks.forEach((joystick) => {
      const { axis } = joystick;
      axis.current.x += (axis.target.x - axis.current.x) * 0.2;
      axis.current.y += (axis.target.y - axis.current.y) * 0.2;

      if (Math.abs(axis.current.x) < 0.01) axis.current.x = 0;
      if (Math.abs(axis.current.y) < 0.01) axis.current.y = 0;

      this.updateJoystickKeys(joystick);
      this.updateThumbPosition(joystick);
    });

    this.rafId = window.requestAnimationFrame(this.updateTouchAxes);
  }

  updateThumbPosition(joystick) {
    const { element, thumb, axis } = joystick;
    if (!element || !thumb) return;
    const rect = element.getBoundingClientRect();
    const halfWidth = Math.max(0, rect.width / 2 - thumb.offsetWidth / 2);
    const halfHeight = Math.max(0, rect.height / 2 - thumb.offsetHeight / 2);
    thumb.style.setProperty('--offset-x', `${axis.current.x * halfWidth}px`);
    thumb.style.setProperty('--offset-y', `${axis.current.y * halfHeight}px`);
  }

  updateJoystickKeys(joystick) {
    const threshold = 0.35;
    const { axis, bindings, keyState } = joystick;
    this.applyDirectionalState(bindings.left, axis.current.x <= -threshold, keyState, 'left');
    this.applyDirectionalState(bindings.right, axis.current.x >= threshold, keyState, 'right');
    this.applyDirectionalState(bindings.up, axis.current.y <= -threshold, keyState, 'up');
    this.applyDirectionalState(bindings.down, axis.current.y >= threshold, keyState, 'down');
  }

  applyDirectionalState(code, pressed, keyState, key) {
    if (!code) return;
    if (keyState[key] === pressed) return;
    keyState[key] = pressed;
    this.setVirtualKey(code, pressed);
  }

  releaseJoystickKeys(joystick) {
    const { bindings, keyState } = joystick;
    ['up', 'down', 'left', 'right'].forEach((key) => {
      if (keyState[key]) {
        this.setVirtualKey(bindings[key], false);
        keyState[key] = false;
      }
    });
  }

  toggleElement(element, visible) {
    if (!element) return;
    element.classList.toggle('is-hidden', !visible);
  }

  setTouchContainerVisible(visible) {
    const container = this.touchElements?.container;
    if (!container) return;
    if (!visible) {
      container.style.display = 'none';
      container.classList.add('is-hidden');
    } else {
      container.style.display = 'block';
      container.classList.remove('is-hidden');
    }
  }

  getAnalogMovement(controls) {
    for (const joystick of this.touchJoysticks) {
      const bindings = joystick.bindings;
      if (
        bindings.up === controls.up &&
        bindings.down === controls.down &&
        bindings.left === controls.left &&
        bindings.right === controls.right
      ) {
        return { x: joystick.axis.current.x, y: joystick.axis.current.y };
      }
    }
    return { x: 0, y: 0 };
  }
}


class UIManager {
  constructor(overlayElement) {
    this.overlay = overlayElement;
    this.currentHandler = null;
    this.cleanupOverlay = null;
  }

  clear() {
    this.resetOverlayState();
    this.overlay.innerHTML = '';
    this.overlay.style.display = 'none';
  }

  showLoading(progress) {
    this.resetOverlayState();
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

  showTotalStats({ totals, onClose } = {}) {
    this.resetOverlayState();
    const sanitizeValue = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.floor(number));
    };
    const defaultTotals = {
      enemiesDestroyed: 0,
      asteroidsSmashed: 0,
      bossesKilled: 0,
      deathCount: 0,
      playtimeSeconds: 0,
    };
    const sanitizeTotals = (value) => {
      if (!value || typeof value !== 'object') {
        return { ...defaultTotals };
      }
      return {
        enemiesDestroyed: sanitizeValue(value.enemiesDestroyed),
        asteroidsSmashed: sanitizeValue(value.asteroidsSmashed),
        bossesKilled: sanitizeValue(value.bossesKilled),
        deathCount: sanitizeValue(value.deathCount),
        playtimeSeconds: sanitizeValue(value.playtimeSeconds),
      };
    };

    let resolvedTotals = totals && typeof totals === 'object' ? sanitizeTotals(totals) : null;
    if (!resolvedTotals) {
      if (SpaceVoid.stats && typeof SpaceVoid.stats.getTotals === 'function') {
        resolvedTotals = sanitizeTotals(SpaceVoid.stats.getTotals());
      } else if (SpaceVoid.stats && SpaceVoid.stats.DEFAULT_TOTALS) {
        resolvedTotals = sanitizeTotals(SpaceVoid.stats.DEFAULT_TOTALS);
      } else {
        resolvedTotals = { ...defaultTotals };
      }
    }

    const formatPlaytime =
      SpaceVoid.stats && typeof SpaceVoid.stats.formatPlaytime === 'function'
        ? SpaceVoid.stats.formatPlaytime
        : (seconds) => {
            const safeSeconds = sanitizeValue(seconds);
            const mins = Math.floor(safeSeconds / 60);
            const secs = safeSeconds % 60;
            return `${mins}m ${secs}s`;
          };

    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu menu--modal menu--compact glass-panel" role="dialog" aria-labelledby="stats-title">
        <div class="menu__header">
          <h1 class="menu__title" id="stats-title">Stats</h1>
          <p class="menu__subtitle menu__subtitle--muted">Lifetime performance across all missions.</p>
        </div>
        <div class="menu__stats menu__stats--wide">
          <div class="menu__stat">
            <span class="menu__stat-label">Total Enemies Destroyed</span>
            <span class="menu__stat-value">${resolvedTotals.enemiesDestroyed}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Total Asteroids Smashed</span>
            <span class="menu__stat-value">${resolvedTotals.asteroidsSmashed}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Total Bosses Defeated</span>
            <span class="menu__stat-value">${resolvedTotals.bossesKilled}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Total Deaths</span>
            <span class="menu__stat-value">${resolvedTotals.deathCount}</span>
          </div>
          <div class="menu__stat menu__stat--full">
            <span class="menu__stat-label">Total Playtime</span>
            <span class="menu__stat-value">${formatPlaytime(resolvedTotals.playtimeSeconds)}</span>
          </div>
        </div>
        <div class="menu__actions menu__actions--modal">
          <button class="menu__button glass-button glass-button--secondary" data-action="close" data-ui-sound="button">${
            onClose ? 'Back' : 'Close'
          }</button>
        </div>
      </div>
    `;

    const buttons = Array.from(this.overlay.querySelectorAll('button[data-action]'));
    let focusedIndex = buttons.length ? 0 : -1;

    const focusListeners = buttons.map((button, index) => {
      const listener = () => {
        focusedIndex = index;
      };
      button.addEventListener('focus', listener);
      return listener;
    });

    const focusButton = (index) => {
      if (!buttons.length) return;
      const safeIndex = (index + buttons.length) % buttons.length;
      const target = buttons[safeIndex];
      if (!target) return;
      focusedIndex = safeIndex;
      target.focus({ preventScroll: true });
    };

    if (buttons.length) {
      window.requestAnimationFrame(() => {
        focusButton(focusedIndex);
      });
    }

    const keyHandler = (event) => {
      if (!buttons.length) return;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        focusButton(focusedIndex + (key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1));
      } else if (key === 'Home') {
        event.preventDefault();
        focusButton(0);
      } else if (key === 'End') {
        event.preventDefault();
        focusButton(buttons.length - 1);
      } else if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && buttons.includes(activeElement)) {
          event.preventDefault();
          activeElement.click();
        }
      }
    };

    this.overlay.addEventListener('keydown', keyHandler);

    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const button = event.target.closest('button[data-action="close"]');
      if (!button) return;
      if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
        SpaceVoid.uiAudio.play('cancel');
      }
      cleanup();
      if (typeof onClose === 'function') {
        onClose();
      } else if (typeof this.hideOverlay === 'function') {
        this.hideOverlay();
      } else {
        this.overlay.style.display = 'none';
      }
    };

    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
      this.overlay.removeEventListener('keydown', keyHandler);
      buttons.forEach((button, index) => {
        button.removeEventListener('focus', focusListeners[index]);
      });
    };

    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }
  showGameOver({ score, level, stats = {}, totals = null, onRetry, onMenu }) {
    this.resetOverlayState();
    const sanitizeValue = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return 0;
      return Math.max(0, Math.floor(number));
    };
    const sanitizedStats = {
      enemiesDestroyed: sanitizeValue(stats.enemiesDestroyed),
      asteroidsSmashed: sanitizeValue(stats.asteroidsSmashed),
      bossesKilled: sanitizeValue(stats.bossesKilled),
      deaths: sanitizeValue(stats.deaths),
      playtimeSeconds: sanitizeValue(stats.playtimeSeconds),
    };
    const baseTotals = {
      enemiesDestroyed: 0,
      asteroidsSmashed: 0,
      bossesKilled: 0,
      deathCount: 0,
      playtimeSeconds: 0,
    };
    const sanitizeTotals = (value) => {
      if (!value || typeof value !== 'object') return null;
      return {
        enemiesDestroyed: sanitizeValue(value.enemiesDestroyed),
        asteroidsSmashed: sanitizeValue(value.asteroidsSmashed),
        bossesKilled: sanitizeValue(value.bossesKilled),
        deathCount: sanitizeValue(value.deathCount),
        playtimeSeconds: sanitizeValue(value.playtimeSeconds),
      };
    };
    const totalsFromArgs = sanitizeTotals(totals);
    const getTotalsForView = () => {
      if (totalsFromArgs) {
        return { ...baseTotals, ...totalsFromArgs };
      }
      if (SpaceVoid.stats && typeof SpaceVoid.stats.getTotals === 'function') {
        const loaded = sanitizeTotals(SpaceVoid.stats.getTotals());
        if (loaded) {
          return { ...baseTotals, ...loaded };
        }
      }
      if (SpaceVoid.stats && SpaceVoid.stats.DEFAULT_TOTALS) {
        return { ...baseTotals, ...SpaceVoid.stats.DEFAULT_TOTALS };
      }
      return { ...baseTotals };
    };

    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu menu--modal menu--compact glass-panel" role="dialog" aria-labelledby="game-over-title">
        <div class="menu__header">
          <h1 class="menu__title" id="game-over-title">Game Over</h1>
          <p class="menu__subtitle menu__subtitle--muted">Mission failed, but data was recovered.</p>
        </div>
        <div class="menu__stats">
          <div class="menu__stat">
            <span class="menu__stat-label">Score</span>
            <span class="menu__stat-value">${score}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Level</span>
            <span class="menu__stat-value">${level}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Enemies Destroyed</span>
            <span class="menu__stat-value">${sanitizedStats.enemiesDestroyed}</span>
          </div>
          <div class="menu__stat">
            <span class="menu__stat-label">Asteroids Smashed</span>
            <span class="menu__stat-value">${sanitizedStats.asteroidsSmashed}</span>
          </div>
        </div>
        <div class="menu__actions menu__actions--modal">
          <button class="menu__button glass-button glass-button--primary" data-action="retry" data-ui-sound="button">Retry Mission</button>
          <button class="menu__button glass-button glass-button--secondary" data-action="menu" data-ui-sound="button">Main Menu</button>
          <button class="menu__button glass-button glass-button--secondary" data-action="totals" data-ui-sound="button">Stats</button>
        </div>
      </div>
    `;
    const buttons = Array.from(
      this.overlay.querySelectorAll('button[data-action]')
    );
    let focusedIndex = buttons.length ? 0 : -1;

    const focusListeners = buttons.map((button, index) => {
      const listener = () => {
        focusedIndex = index;
      };
      button.addEventListener('focus', listener);
      return listener;
    });

    const focusButton = (index) => {
      if (!buttons.length) return;
      const safeIndex = (index + buttons.length) % buttons.length;
      const target = buttons[safeIndex];
      if (!target) return;
      focusedIndex = safeIndex;
      target.focus({ preventScroll: true });
    };

    if (buttons.length) {
      window.requestAnimationFrame(() => {
        focusButton(focusedIndex);
      });
    }

    const keyHandler = (event) => {
      if (!buttons.length) return;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        focusButton(focusedIndex + 1);
      } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        focusButton(focusedIndex - 1);
      } else if (key === 'Home') {
        event.preventDefault();
        focusButton(0);
      } else if (key === 'End') {
        event.preventDefault();
        focusButton(buttons.length - 1);
      } else if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && buttons.includes(activeElement)) {
          event.preventDefault();
          activeElement.click();
        }
      }
    };

    this.overlay.addEventListener('keydown', keyHandler);

    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'totals') {
        if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
          SpaceVoid.uiAudio.play('button');
        }
        const totalsForView = getTotalsForView();
        this.showTotalStats({
          totals: totalsForView,
          onClose: () => {
            this.showGameOver({
              score,
              level,
              stats: sanitizedStats,
              totals: totalsForView,
              onRetry,
              onMenu,
            });
          },
        });
        return;
      }
      if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
        if (action === 'menu') {
          SpaceVoid.uiAudio.play('cancel');
        }
      }
      cleanup();
      if (action === 'retry') {
        onRetry();
      } else if (action === 'menu') {
        onMenu();
      }
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
      this.overlay.removeEventListener('keydown', keyHandler);
      buttons.forEach((button, index) => {
        button.removeEventListener('focus', focusListeners[index]);
      });
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showVersusGameOver({ winner, scores, onRematch, onMenu }) {
    this.resetOverlayState();
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu menu--modal glass-panel" role="dialog" aria-labelledby="versus-complete-title">
        <div class="menu__header">
          <h1 class="menu__title" id="versus-complete-title">Versus Complete</h1>
          <p class="menu__subtitle menu__subtitle--muted">Battle report ready.</p>
        </div>
        <div class="menu__stats menu__stats--wide">
          <div class="menu__stat">
            <span class="menu__stat-label">Winner</span>
            <span class="menu__stat-value">Player ${winner}</span>
          </div>
          <div class="menu__stat menu__stat--full">
            <span class="menu__stat-label">Final Score</span>
            <span class="menu__stat-value">P1 ${scores[0]} — P2 ${scores[1]}</span>
          </div>
        </div>
        <div class="menu__actions menu__actions--modal">
          <button class="menu__button glass-button glass-button--accent" data-action="rematch" data-ui-sound="button">Rematch</button>
          <button class="menu__button glass-button glass-button--secondary" data-action="menu" data-ui-sound="button">Main Menu</button>
        </div>
      </div>
    `;
    const buttons = Array.from(
      this.overlay.querySelectorAll('button[data-action]')
    );
    let focusedIndex = buttons.length ? 0 : -1;

    const focusListeners = buttons.map((button, index) => {
      const listener = () => {
        focusedIndex = index;
      };
      button.addEventListener('focus', listener);
      return listener;
    });

    const focusButton = (index) => {
      if (!buttons.length) return;
      const safeIndex = (index + buttons.length) % buttons.length;
      const target = buttons[safeIndex];
      if (!target) return;
      focusedIndex = safeIndex;
      target.focus({ preventScroll: true });
    };

    if (buttons.length) {
      window.requestAnimationFrame(() => {
        focusButton(focusedIndex);
      });
    }

    const keyHandler = (event) => {
      if (!buttons.length) return;
      const { key } = event;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        focusButton(focusedIndex + 1);
      } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        focusButton(focusedIndex - 1);
      } else if (key === 'Home') {
        event.preventDefault();
        focusButton(0);
      } else if (key === 'End') {
        event.preventDefault();
        focusButton(buttons.length - 1);
      } else if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && buttons.includes(activeElement)) {
          event.preventDefault();
          activeElement.click();
        }
      }
    };

    this.overlay.addEventListener('keydown', keyHandler);

    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
        if (action === 'menu') {
          SpaceVoid.uiAudio.play('cancel');
        }
      }
      cleanup();
      if (action === 'rematch') onRematch();
      if (action === 'menu') onMenu();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
      this.overlay.removeEventListener('keydown', keyHandler);
      buttons.forEach((button, index) => {
        button.removeEventListener('focus', focusListeners[index]);
      });
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  resetOverlayState() {
    if (this.currentHandler) {
      this.currentHandler();
      this.currentHandler = null;
    }
    if (this.cleanupOverlay) {
      this.cleanupOverlay();
      this.cleanupOverlay = null;
    }
    this.overlay.style.flexDirection = '';
    this.overlay.style.alignItems = '';
    this.overlay.style.justifyContent = '';
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

const input = new InputManager({
  container: touchControls,
  primaryJoystick,
  secondaryJoystick,
  buttonsContainer: touchButtonsContainer,
  buttons: {
    shoot: shootButton,
    rocket: rocketButton,
    rocket2: rocketButton2,
  },
});
const ui = new UIManager(overlay);
attachMenuUI(ui);
attachSettingsUI(ui);

configureTouchForMode(null);


let assets = null;
let currentWorld = null;
let currentMode = null;
let currentState = GAME_STATE.LOADING;
let lastTimestamp = 0;
let accumulator = 0;
let musicVolume = 0.5;
let soundVolume = 0.7;
let lastResumeHandler = null;

if (menuButton) {
  menuButton.addEventListener('click', () => {
    if (currentWorld && (currentState === GAME_STATE.GAME || currentState === GAME_STATE.PAUSED)) {
      showMainMenu({ fromGame: true });
    } else {
      showMainMenu();
    }
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
  if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.setVolume === 'function') {
    SpaceVoid.uiAudio.setVolume(soundVolume);
  }
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

function configureTouchForMode(mode) {
  if (typeof input.configureTouchControls !== 'function') return;

  const joysticks = [];
  const buttons = [];

  if (touchControls) {
    touchControls.classList.remove('touch-controls--single', 'touch-controls--coop', 'touch-controls--versus');
    const visualMode = mode === 'bulletHell' ? 'single' : mode;
    if (visualMode) {
      touchControls.classList.add(`touch-controls--${visualMode}`);
    }
  }

  const playerOneBindings = {
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
  };

  const playerTwoBindings = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };

  const addJoystick = (element, bindings) => {
    if (!element) return;
    joysticks.push({ element, bindings });
  };

  const addButton = (element, code) => {
    if (!element) return;
    buttons.push({ element, code });
  };

  switch (mode) {
    case 'single':
    case 'bulletHell':
      addJoystick(primaryJoystick, playerOneBindings);
      addButton(rocketButton, 'Space');
      break;
    case 'coop':
      addJoystick(primaryJoystick, playerOneBindings);
      addJoystick(secondaryJoystick, playerTwoBindings);
      addButton(rocketButton, 'Space');
      addButton(rocketButton2, 'Numpad0');
      break;
    case 'versus':
      addJoystick(primaryJoystick, playerOneBindings);
      addJoystick(secondaryJoystick, playerTwoBindings);
      break;
    default:
      break;
  }

  input.configureTouchControls({ joysticks, buttons });
}

function startGame(mode) {
  if (!assets) return;
  if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
    SpaceVoid.uiAudio.play('confirm');
  }
  stopAllMusic();
  ui.clear();
  setMenuButtonVisible(true);
  lastResumeHandler = null;
  currentMode = mode;

  if (currentWorld) {
    if (currentWorld.music && typeof currentWorld.music.pause === 'function') {
      try {
        currentWorld.music.pause();
      } catch (error) {
        console.warn('Failed to pause current world music before starting a new game.', error);
      }
    }
    currentWorld = null;
  }

  configureTouchForMode(mode);

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
    const factory =
      mode === 'coop'
        ? createCoopWorld
        : mode === 'bulletHell'
          ? createBulletHellWorld
          : createSinglePlayerWorld;
    currentWorld = factory({
      assets,
      input,
      onGameOver: ({ score, level, stats, totals }) => {
        currentState = GAME_STATE.GAME_OVER;
        ui.showGameOver({
          score: Math.floor(score),
          level,
          stats,
          totals,
          onRetry: () => startGame(mode),
          onMenu: showMainMenu,
        });
      },
    });
  }

  applyVolumeSettings();
  currentState = GAME_STATE.GAME;
}

function showMainMenu(options = {}) {
  const { fromGame = false } = options;
  if (fromGame && SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
    SpaceVoid.uiAudio.play('cancel');
  }
  const canResume =
    Boolean(currentWorld) && fromGame && (currentState === GAME_STATE.GAME || currentState === GAME_STATE.PAUSED);

  setMenuButtonVisible(false);
  lastResumeHandler = null;

  if (canResume) {
    currentWorld.paused = true;
    if (currentWorld.music && typeof currentWorld.music.pause === 'function') {
      try {
        currentWorld.music.pause();
      } catch (error) {
        console.warn('Failed to pause current world music while opening the menu.', error);
      }
    }
    if (typeof input.setTouchContainerVisible === 'function') {
      input.setTouchContainerVisible(false);
    }
    currentState = GAME_STATE.PAUSED;
  } else {
    if (currentWorld) {
      stopAllMusic();
      currentWorld = null;
    }
    configureTouchForMode(null);
    currentMode = null;
    currentState = GAME_STATE.MENU;
  }

  let resumeHandler = null;
  if (canResume) {
    resumeHandler = () => {
      if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
        SpaceVoid.uiAudio.play('confirm');
      }
      ui.hideOverlay();
      if (currentWorld) {
        currentWorld.paused = false;
        currentState = GAME_STATE.GAME;
        if (currentWorld.music && typeof currentWorld.music.play === 'function') {
          currentWorld.music.play().catch(() => {});
        }
      }
      if (currentMode) {
        configureTouchForMode(currentMode);
      } else {
        configureTouchForMode(null);
      }
      setMenuButtonVisible(true);
      lastResumeHandler = null;
    };
  }
  lastResumeHandler = resumeHandler;

  ui.showMenu({
    onStartSingle: () => startGame('single'),
    onStartBulletHell: () => startGame('bulletHell'),
    onStartCoop: () => startGame('coop'),
    onStartVersus: () => startGame('versus'),
    onSettings: showSettings,
    onResume: resumeHandler,
  });
}

function showSettings() {
  ui.showSettings({
    settings: {
      musicVolume,
      effectsVolume: soundVolume,
    },
    onApply: ({ musicVolume: newMusicVolume, effectsVolume: newEffectsVolume }) => {
      musicVolume = newMusicVolume;
      soundVolume = newEffectsVolume;
      applyVolumeSettings();
      setTimeout(showMainMenu, 0);
    },
    onClose: () => {
      setTimeout(showMainMenu, 0);
    },
  });
}

input.onKey('Escape', (pressed) => {
  if (!pressed) return;
  if (currentState === GAME_STATE.PAUSED && typeof lastResumeHandler === 'function') {
    lastResumeHandler();
    return;
  }
  if (currentWorld) {
    showMainMenu({ fromGame: true });
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
})();
