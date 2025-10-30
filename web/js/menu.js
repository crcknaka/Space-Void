(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});

  function attachMenuUI(ui) {
    ui.showMenu = ({ onStartSingle, onStartCoop, onStartVersus, onSettings }) => {
      const { overlay } = ui;
      overlay.style.display = 'flex';
      overlay.style.flexDirection = 'column';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.innerHTML = `
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

        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const action = button.getAttribute('data-action');
        switch (action) {
          case 'single':
            onStartSingle();
            break;
          case 'coop':
            onStartCoop();
            break;
          case 'versus':
            onStartVersus();
            break;
          case 'settings':
            onSettings();
            break;
          default:
            break;
        }
      };

      overlay.addEventListener('click', handler, { once: true });
      ui.currentHandler = () => overlay.removeEventListener('click', handler);
    };

    ui.hideOverlay = () => {
      ui.overlay.style.display = 'none';
      ui.overlay.innerHTML = '';
      ui.currentHandler = null;
    };
  }

  SpaceVoid.attachMenuUI = attachMenuUI;
})(window);
