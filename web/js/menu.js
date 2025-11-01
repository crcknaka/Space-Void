(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});
  const shared = SpaceVoid.shared || {};
  const { WIDTH = 600, HEIGHT = 880 } = shared;
  const createLayers = SpaceVoid.createStarLayers;
  const createStatics = SpaceVoid.createStaticStars;

  function createStarfield(scene, canvas) {
    if (!canvas) return () => {};
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};

    if (typeof createLayers !== 'function' || typeof createStatics !== 'function') {
      return () => {};
    }

    let starLayers = [];
    let staticStars = [];
    let width = 0;
    let height = 0;
    let rafId = null;
    let lastTime = 0;

    const configure = () => {
      const rect = scene.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      if (width === 0 || height === 0) {
        canvas.width = 0;
        canvas.height = 0;
        starLayers = [];
        staticStars = [];
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      const baseArea = WIDTH * HEIGHT;
      const area = width * height;
      const densityScale = baseArea > 0 ? Math.max(0.8, area / baseArea) : 1;
      const perLayer = Math.max(30, Math.round(50 * densityScale));
      const staticCount = Math.max(60, Math.round(100 * densityScale));
      starLayers = createLayers(3, width, height, { perLayer });
      staticStars = createStatics(width, height, { count: staticCount });
    };

    const draw = (timestamp) => {
      if (!width || !height) {
        rafId = window.requestAnimationFrame(draw);
        return;
      }

      if (!lastTime) {
        lastTime = timestamp;
      }
      const delta = Math.min((timestamp - lastTime) / 1000, 0.05);
      lastTime = timestamp;

      ctx.clearRect(0, 0, width, height);
      starLayers.forEach((layer) => {
        layer.forEach((star) => {
          star.update(delta);
          star.draw(ctx);
        });
      });
      staticStars.forEach((star) => {
        star.update(delta);
        star.draw(ctx);
      });

      rafId = window.requestAnimationFrame(draw);
    };

    const handleResize = () => {
      configure();
    };

    configure();
    window.addEventListener('resize', handleResize);
    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      starLayers = [];
      staticStars = [];
      lastTime = 0;
    };
  }

  function setupMenuScene(scene) {
    const starsCanvas = scene.querySelector('#menu-stars');
    const cleanupStars = createStarfield(scene, starsCanvas);

    const updateParallax = (x, y) => {
      scene.style.setProperty('--parallax-x', `${x}px`);
      scene.style.setProperty('--parallax-y', `${y}px`);
    };

    const handlePointerMove = (event) => {
      const rect = scene.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const normalizedX = (event.clientX - rect.left) / rect.width - 0.5;
      const normalizedY = (event.clientY - rect.top) / rect.height - 0.5;
      const offsetX = normalizedX * 80;
      const offsetY = normalizedY * 60;
      updateParallax(offsetX, offsetY);
    };

    const handlePointerLeave = () => {
      updateParallax(0, 0);
    };

    scene.addEventListener('pointermove', handlePointerMove);
    scene.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      scene.removeEventListener('pointermove', handlePointerMove);
      scene.removeEventListener('pointerleave', handlePointerLeave);
      updateParallax(0, 0);
      cleanupStars();
    };
  }

  function attachMenuUI(ui) {
    ui.showMenu = ({
      onStartSingle,
      onStartBulletHell,
      onStartCoop,
      onStartVersus,
      onSettings,
      onResume,
    }) => {
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
      const resumeButton =
        typeof onResume === 'function'
          ? `
            <div class="menu__resume">
              <button class="menu__button glass-button glass-button--accent menu__button--resume" data-action="resume" data-ui-sound="button">Resume</button>
            </div>
          `
          : '';

      overlay.innerHTML = `
        <div class="menu-scene" role="dialog" aria-labelledby="menu-title">
          <div class="menu-scene__background" aria-hidden="true"></div>
          <canvas class="menu-scene__stars" id="menu-stars" aria-hidden="true"></canvas>
          <div class="menu menu--main glass-panel">
            <div class="menu__header">
              <h1 class="menu__title" id="menu-title">Space Void</h1>
              <p class="menu__subtitle">Arcade Shooter</p>
              <p class="menu__tagline">Command your starfighter solo, with a wingmate, or face off head-to-head.</p>
            </div>
            ${resumeButton}
            <div class="menu__actions">
              <button class="menu__button glass-button glass-button--primary menu__button--stacked" data-action="single" data-ui-sound="button">
                <span class="menu__button-title">SINGLE PLAYER</span>
                <span class="menu__button-meta">Solo arcade campaign</span>
              </button>
              <button class="menu__button glass-button glass-button--primary menu__button--stacked" data-action="bullet-hell" data-ui-sound="button">
                <span class="menu__button-title">BULLET HELL</span>
                <span class="menu__button-meta">Intense solo gauntlet</span>
              </button>
              <button class="menu__button glass-button glass-button--primary menu__button--stacked" data-action="coop" data-ui-sound="button">
                <span class="menu__button-title">CO-OP MODE</span>
                <span class="menu__button-meta">Team up on one screen</span>
              </button>
              <button class="menu__button glass-button glass-button--primary menu__button--stacked" data-action="versus" data-ui-sound="button">
                <span class="menu__button-title">VS MODE</span>
                <span class="menu__button-meta">Duel for galactic glory</span>
              </button>
            </div>
            <div class="menu__footer">
              <button class="menu__button glass-button glass-button--secondary" data-action="settings" data-ui-sound="button">Settings</button>
              <button class="menu__button glass-button glass-button--secondary" data-action="totals" data-ui-sound="button">Stats</button>
            </div>
          </div>
        </div>
      `;

      const scene = overlay.querySelector('.menu-scene');
      let cleanupScene = null;
      if (scene) {
        scene.style.setProperty('--parallax-x', '0px');
        scene.style.setProperty('--parallax-y', '0px');
        cleanupScene = setupMenuScene(scene);
        window.requestAnimationFrame(() => {
          scene.classList.add('menu-scene--visible');
        });
      }

      ui.cleanupOverlay = () => {
        if (cleanupScene) {
          cleanupScene();
          cleanupScene = null;
        }
        if (scene) {
          scene.classList.remove('menu-scene--visible');
        }
      };

      const buttons = Array.from(overlay.querySelectorAll('button[data-action]'));
      let focusedIndex = buttons.findIndex((button) => button.getAttribute('data-action') === 'resume');
      if (focusedIndex < 0) {
        focusedIndex = 0;
      }

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
          if (activeElement && buttons.includes(activeElement)) {
            event.preventDefault();
            activeElement.click();
          }
        }
      };

      overlay.addEventListener('keydown', keyHandler);

      const reopenMenu = () => {
        ui.showMenu({
          onStartSingle,
          onStartBulletHell,
          onStartCoop,
          onStartVersus,
          onSettings,
          onResume,
        });
      };

      const handler = (event) => {
        if (!(event.target instanceof HTMLElement)) return;

        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const action = button.getAttribute('data-action');
        switch (action) {
          case 'single':
            onStartSingle();
            break;
          case 'bullet-hell':
            if (typeof onStartBulletHell === 'function') {
              onStartBulletHell();
            }
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
          case 'totals':
            if (SpaceVoid.uiAudio && typeof SpaceVoid.uiAudio.play === 'function') {
              SpaceVoid.uiAudio.play('button');
            }
            ui.showTotalStats({ onClose: reopenMenu });
            break;
          case 'resume':
            if (onResume) {
              onResume();
            }
            break;
          default:
            break;
        }
      };

      overlay.addEventListener('click', handler);
      ui.currentHandler = () => {
        overlay.removeEventListener('click', handler);
        overlay.removeEventListener('keydown', keyHandler);
        buttons.forEach((button, index) => {
          button.removeEventListener('focus', focusListeners[index]);
        });
      };
    };

    ui.hideOverlay = () => {
      if (ui.currentHandler) {
        ui.currentHandler();
        ui.currentHandler = null;
      }
      if (ui.cleanupOverlay) {
        ui.cleanupOverlay();
        ui.cleanupOverlay = null;
      }
      ui.overlay.style.display = 'none';
      ui.overlay.innerHTML = '';
    };
  }

  SpaceVoid.attachMenuUI = attachMenuUI;
})(window);
