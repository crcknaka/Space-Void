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
      const offsetX = normalizedX * 40;
      const offsetY = normalizedY * 30;
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
              <button class="menu__button menu__button--resume" data-action="resume">Resume</button>
            </div>
          `
          : '';

      overlay.innerHTML = `
        <div class="menu-scene" role="dialog" aria-labelledby="menu-title">
          <div class="menu-scene__background" aria-hidden="true"></div>
          <canvas class="menu-scene__stars" id="menu-stars" aria-hidden="true"></canvas>
          <div class="menu menu--main">
            <div class="menu__header">
              <h1 class="menu__title" id="menu-title">Space Void</h1>
              <p class="menu__subtitle">Arcade Shooter</p>
              <p class="menu__tagline">Command your starfighter solo, with a wingmate, or face off head-to-head.</p>
            </div>
            ${resumeButton}
            <div class="menu__actions">
              <button class="menu__button menu__button--primary menu__button--stacked" data-action="single">
                <span class="menu__button-title">Single Player</span>
                <span class="menu__button-meta">Solo arcade campaign</span>
              </button>
              <button class="menu__button menu__button--primary menu__button--stacked" data-action="coop">
                <span class="menu__button-title">Co-op Mode</span>
                <span class="menu__button-meta">Team up on one screen</span>
              </button>
              <button class="menu__button menu__button--primary menu__button--stacked" data-action="versus">
                <span class="menu__button-title">Versus Mode</span>
                <span class="menu__button-meta">Duel for galactic glory</span>
              </button>
            </div>
            <div class="menu__footer">
              <button class="menu__button menu__button--secondary" data-action="settings">Settings</button>
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
          case 'resume':
            if (onResume) {
              onResume();
            }
            break;
          default:
            break;
        }
      };

      overlay.addEventListener('click', handler, { once: true });
      ui.currentHandler = () => overlay.removeEventListener('click', handler);
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
