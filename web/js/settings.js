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
            <input type="range" min="0" max="1" step="0.05" value="${settings.musicVolume}" data-setting="music" data-ui-sound="control" />
          </label>
          <label class="settings__label">
            <span>Effects Volume</span>
            <input type="range" min="0" max="1" step="0.05" value="${settings.effectsVolume}" data-setting="effects" data-ui-sound="control" />
          </label>
          <div class="settings__buttons">
            <button class="menu__button glass-button glass-button--primary" data-action="apply" data-ui-sound="button">Apply</button>
            <button class="menu__button glass-button glass-button--secondary" data-action="close" data-ui-sound="button">Close</button>
          </div>
        </div>
      `;

      const focusables = Array.from(
        overlay.querySelectorAll('input[type="range"], button[data-action]')
      );
      let focusedIndex = focusables.length ? 0 : -1;

      const focusListeners = focusables.map((element, index) => {
        const listener = () => {
          focusedIndex = index;
        };
        element.addEventListener('focus', listener);
        return listener;
      });

      const focusElement = (index) => {
        if (!focusables.length) return;
        const safeIndex = (index + focusables.length) % focusables.length;
        const target = focusables[safeIndex];
        if (!target) return;
        focusedIndex = safeIndex;
        target.focus({ preventScroll: true });
      };

      if (focusables.length) {
        window.requestAnimationFrame(() => {
          focusElement(focusedIndex);
        });
      }

      const keyHandler = (event) => {
        if (!focusables.length) return;
        const { key } = event;
        const activeElement = document.activeElement;
        const isRange =
          activeElement instanceof HTMLElement &&
          activeElement.matches('input[type="range"]');

        if (key === 'ArrowDown') {
          event.preventDefault();
          focusElement(focusedIndex + 1);
        } else if (key === 'ArrowUp') {
          event.preventDefault();
          focusElement(focusedIndex - 1);
        } else if (!isRange && (key === 'ArrowRight' || key === 'ArrowLeft')) {
          event.preventDefault();
          focusElement(focusedIndex + (key === 'ArrowRight' ? 1 : -1));
        } else if (!isRange && key === 'Home') {
          event.preventDefault();
          focusElement(0);
        } else if (!isRange && key === 'End') {
          event.preventDefault();
          focusElement(focusables.length - 1);
        } else if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
          if (
            activeElement instanceof HTMLElement &&
            activeElement.matches('button[data-action]')
          ) {
            event.preventDefault();
            activeElement.click();
          }
        }
      };

      overlay.addEventListener('keydown', keyHandler);

      let handler = null;
      const detach = () => {
        if (handler) {
          overlay.removeEventListener('click', handler);
          handler = null;
        }
        overlay.removeEventListener('keydown', keyHandler);
        focusables.forEach((element, index) => {
          element.removeEventListener('focus', focusListeners[index]);
        });
      };

      const applySettings = () => {
        const musicInput = overlay.querySelector('input[data-setting="music"]');
        const effectsInput = overlay.querySelector('input[data-setting="effects"]');
        if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
          SpaceVoid.uiAudio.play('confirm');
        }
        onApply({
          musicVolume: musicInput ? Number(musicInput.value) : settings.musicVolume,
          effectsVolume: effectsInput ? Number(effectsInput.value) : settings.effectsVolume,
        });
        detach();
        ui.hideOverlay();
      };

      const closeSettings = () => {
        if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
          SpaceVoid.uiAudio.play('cancel');
        }
        detach();
        ui.hideOverlay();
        onClose();
      };

      handler = (event) => {
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
      ui.currentHandler = detach;
    };
  }

  SpaceVoid.attachSettingsUI = attachSettingsUI;
})(window);
