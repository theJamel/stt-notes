// sw.js — service worker: cache-first for app shell
const CACHE = 'stt-notes-v5';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './audio.js',
  './stt.js',
  './caldav.js',
  './ui.js',
  './worker.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  // Fetch with cache: 'reload' so the browser HTTP cache (which NextCloud marks
  // as cacheable for ~6 months on .js files) is bypassed and we always install
  // the freshest shell from the network.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      const resp = await fetch(url, { cache: 'reload' });
      if (resp.ok) await cache.put(url, resp);
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Only intercept same-origin requests; let CDN and CalDAV requests pass through
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request))
  );
});
