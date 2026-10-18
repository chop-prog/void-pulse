// Offline support. Network first: online players always run the latest deploy (co-op needs both
// pilots on the same version), revalidating past the browser's HTTP cache; the cache is only the
// offline fallback. Bump VERSION to drop old caches on deploy.
const VERSION = 'void-pulse-v6';
const CORE = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/main.js',
  './src/ui.js',
  './src/storage.js',
  './src/engine/audio.js',
  './src/engine/grid.js',
  './src/engine/input.js',
  './src/engine/loop.js',
  './src/engine/math.js',
  './src/engine/particles.js',
  './src/engine/renderer.js',
  './src/engine/spatial-hash.js',
  './src/game/enemies.js',
  './src/game/fx-record.js',
  './src/game/game.js',
  './src/game/player.js',
  './src/game/upgrades.js',
  './src/game/waves.js',
  './src/net/codec.js',
  './src/net/coop.js',
  './src/net/link.js',
  './src/net/mqtt.js',
  './src/net/relay.js',
  './src/net/signal.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(request, { cache: 'no-cache' });
      if (res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return (await cache.match(request, { ignoreSearch: request.mode === 'navigate' })) ?? Response.error();
    }
  })());
});
