declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;

const CACHE_NAME = `pullups-${__BUILD_ID__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(__PRECACHE__))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => Promise.all(cacheNames.filter((cacheName) => cacheName.startsWith('pullups-') && cacheName !== CACHE_NAME).map((cacheName) => caches.delete(cacheName))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Cache-first so the app opens instantly with no signal. A deploy changes sw.js
  // (its build id), which the browser re-checks on launch; the new worker precaches
  // the new shell and takes over, so the update lands on the following launch.
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('/index.html').then((cached) => cached ?? fetch(request)));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});

export {};
