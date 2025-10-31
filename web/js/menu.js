(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});

  function createStarfield(scene, canvas) {
    if (!canvas) return () => {};
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};

    const colors = ['#ffffff', '#9ecbff', '#ffe4a3'];
    let stars = [];
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
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      const starCount = Math.max(60, Math.floor((width * height) / 2500));
      stars = Array.from({ length: starCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        depth: Math.random() * 2.2 + 0.6,
        size: Math.random() * 1.1 + 0.5,
        speed: 10 + Math.random() * 20,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.6 + Math.random() * 1.2,
        color: colors[Math.floor(Math.random() * colors.length)],
      }));
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
      stars.forEach((star) => {
        star.x -= star.speed * star.depth * delta;
        if (star.x < -2) {
          star.x = width + Math.random() * 10;
          star.y = Math.random() * height;
        }
        star.twinklePhase += star.twinkleSpeed * delta;
        const alpha = 0.25 + Math.abs(Math.sin(star.twinklePhase)) * 0.75;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = star.color;
        const radius = star.size * star.depth;
        ctx.beginPath();
        ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

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
      stars = [];
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
