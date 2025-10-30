export function attachSettingsUI(ui) {
  ui.showSettings = ({ onBack, initialMusicVolume, initialSoundVolume, onChangeMusic, onChangeSound }) => {
    const { overlay } = ui;
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.innerHTML = `
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

    const cleanup = () => {
      overlay.removeEventListener('input', handler);
      overlay.removeEventListener('click', handler);
    };

    overlay.addEventListener('input', handler);
    overlay.addEventListener('click', handler);
    ui.currentHandler = cleanup;
  };
}
