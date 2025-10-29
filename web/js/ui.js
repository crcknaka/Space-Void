export class UIManager {
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

  showMenu({ onStartSingle, onStartCoop, onStartVersus, onSettings }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h1 class="menu__title">Space Void</h1>
        <p class="menu__subtitle">Arcade Shooter</p>
        <button class="menu__button" data-action="single">Single Player</button>
        <button class="menu__button" data-action="coop">Co-op Mode</button>
        <button class="menu__button" data-action="versus">Versus Mode</button>
        <button class="menu__button menu__button--secondary" data-action="settings">Settings</button>
      </div>
    `;
    const handler = (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'single') onStartSingle();
      if (action === 'coop') onStartCoop();
      if (action === 'versus') onStartVersus();
      if (action === 'settings') onSettings();
      cleanup();
    };
    const cleanup = () => {
      this.overlay.removeEventListener('click', handler);
    };
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
  }

  showSettings({ onBack, initialMusicVolume, initialSoundVolume, onChangeMusic, onChangeSound }) {
    this.overlay.style.display = 'flex';
    this.overlay.style.flexDirection = 'column';
    this.overlay.style.alignItems = 'center';
    this.overlay.style.justifyContent = 'center';
    this.overlay.innerHTML = `
      <div class="menu">
        <h2 class="menu__title">Settings</h2>
        <label class="menu__label">
          Music Volume
          <input type="range" min="0" max="1" step="0.05" value="${initialMusicVolume}" data-setting="music" />
        </label>
        <label class="menu__label">
          Sound Volume
          <input type="range" min="0" max="1" step="0.05" value="${initialSoundVolume}" data-setting="sound" />
        </label>
        <button class="menu__button menu__button--secondary" data-action="back">Back</button>
      </div>
    `;
    const cleanup = () => {
      this.overlay.removeEventListener('input', handler);
      this.overlay.removeEventListener('click', handler);
    };

    const handler = (event) => {
      if (event.type === 'input') {
        if (!(event.target instanceof HTMLInputElement)) return;
        const { setting } = event.target.dataset;
        const numericValue = Number(event.target.value);
        if (setting === 'music') {
          onChangeMusic(numericValue);
        } else if (setting === 'sound') {
          onChangeSound(numericValue);
        }
      } else if (event.type === 'click') {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.dataset.action === 'back') {
          cleanup();
          onBack();
        }
      }
    };

    this.overlay.addEventListener('input', handler);
    this.overlay.addEventListener('click', handler);
    this.currentHandler = cleanup;
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
