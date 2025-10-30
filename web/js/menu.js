export function attachMenuUI(ui) {
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
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'single') onStartSingle();
      if (action === 'coop') onStartCoop();
      if (action === 'versus') onStartVersus();
      if (action === 'settings') onSettings();
      cleanup();
    };

    const cleanup = () => {
      overlay.removeEventListener('click', handler);
    };

    overlay.addEventListener('click', handler);
    ui.currentHandler = cleanup;
  };
}
