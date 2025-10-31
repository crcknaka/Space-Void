(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});

  function attachSettingsUI(ui) {
    ui.showSettings = ({ settings, onApply, onClose }) => {
      const { overlay } = ui;
      if (typeof ui.resetOverlayState === 'function') {
        ui.resetOverlayState();
      } else {
        if (ui.currentHandler) {
          ui.currentHandler();
          ui.currentHandler = null;
        }
        if (ui.cleanupOverlay) {
          ui.cleanupOverlay();
          ui.cleanupOverlay = null;
        }
      }
      overlay.style.display = 'flex';
      overlay.style.flexDirection = 'column';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.innerHTML = `
        <div class="menu settings glass-panel">
          <h2 class="menu__title">Settings</h2>
          <label class="settings__label">
            <span>Music Volume</span>
            <input type="range" min="0" max="1" step="0.05" value="${settings.musicVolume}" data-setting="music" />
          </label>
          <label class="settings__label">
            <span>Effects Volume</span>
            <input type="range" min="0" max="1" step="0.05" value="${settings.effectsVolume}" data-setting="effects" />
          </label>
          <div class="settings__buttons">
            <button class="menu__button glass-button glass-button--primary" data-action="apply">Apply</button>
            <button class="menu__button glass-button glass-button--secondary" data-action="close">Close</button>
          </div>
        </div>
      `;

      const applySettings = () => {
        const musicInput = overlay.querySelector('input[data-setting="music"]');
        const effectsInput = overlay.querySelector('input[data-setting="effects"]');
        onApply({
          musicVolume: musicInput ? Number(musicInput.value) : settings.musicVolume,
          effectsVolume: effectsInput ? Number(effectsInput.value) : settings.effectsVolume,
        });
        overlay.removeEventListener('click', handler);
        ui.hideOverlay();
      };

      const closeSettings = () => {
        overlay.removeEventListener('click', handler);
        ui.hideOverlay();
        onClose();
      };

      const handler = (event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const action = button.getAttribute('data-action');
        if (action === 'apply') {
          applySettings();
        } else if (action === 'close') {
          closeSettings();
        }
      };

      overlay.addEventListener('click', handler);
      ui.currentHandler = () => overlay.removeEventListener('click', handler);
    };
  }

  SpaceVoid.attachSettingsUI = attachSettingsUI;
})(window);
