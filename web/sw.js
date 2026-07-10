// Space Void service worker — offline play + instant repeat loads.
// Assets are cache-first (immutable), code/html/fonts are network-first
// with cache fallback, /api is never cached.
const CACHE = 'space-void-v4'; // v4: fully procedural art, zero image downloads

const PRECACHE = [
  '.',
  'index.html',
  'manifest.json',
  'js/main.js', 'js/const.js', 'js/input.js', 'js/audio.js', 'js/assets.js',
  'js/ui.js', 'js/fx.js', 'js/entities.js', 'js/world.js', 'js/game.js',
  'js/versus.js', 'js/menu.js', 'js/scores.js', 'js/options.js',
  'js/lb.js', 'js/settings.js',
  'js/mesh3d.js', 'js/shipgen.js', 'js/procassets.js', 'js/bossgen.js', 'js/bggen.js',
  'assets/images/icon.png', 'assets/images/icon-192.png', 'assets/images/icon-512.png',
  'assets/sounds/click.m4a', 'assets/sounds/hover.m4a', 'assets/sounds/gun.m4a',
  'assets/sounds/explosion.m4a', 'assets/sounds/powerup.m4a', 'assets/sounds/rocket.m4a',
  'assets/sounds/player1_kill.m4a', 'assets/sounds/player2_kill.m4a',
  'assets/sounds/background_music.m4a', 'assets/sounds/versus_music.m4a',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {}) // partial precache is fine, runtime caching fills the gaps
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  const sameOrigin = url.origin === location.origin;
  const isAsset = sameOrigin && url.pathname.startsWith('/assets/');

  if (isAsset) {
    // cache-first: assets are immutable
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
  } else if (sameOrigin || url.hostname.includes('fonts.')) {
    // network-first: html/js/fonts stay fresh, cache is the offline fallback
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone(); // clone before the page consumes the body
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
