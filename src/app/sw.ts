declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;

const CACHE = `pullups-${__BUILD_ID__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(__PRECACHE__))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pullups-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Cache-first so the app opens instantly with no signal. A deploy changes sw.js
  // (its build id), which the browser re-checks on launch; the new worker precaches
  // the new shell and takes over, so the update lands on the following launch.
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('/index.html').then((hit) => hit ?? fetch(req)));
    return;
  }

  event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
});

export {};
