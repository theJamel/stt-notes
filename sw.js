// sw.js — service worker: cache-first for app shell
const CACHE = 'stt-notes-v21';

// Separate bucket for cross-origin runtime deps (Transformers.js library + ONNX
// WASM from jsDelivr). These are too big/dynamic to precache in SHELL, and they'd
// otherwise live only in the evictable browser HTTP cache — once evicted the app
// can't boot offline. We cache them on first use so the "fully offline" claim
// actually holds. Bumped to v2 to flush the old bucket, which redundantly held a
// second copy of the model weights (now owned solely by worker.js).
const RUNTIME = 'stt-notes-runtime-v2';

// Hosts whose GETs we cache at runtime: jsDelivr only (Transformers.js library +
// ort-wasm-*.wasm). The Whisper model weights from HuggingFace are deliberately
// NOT cached here — the Web Worker (worker.js) owns a single, query-normalized
// model cache. Caching them here too would store the same ~255 MB a second time,
// inflating quota usage and making eviction far more likely.
function isCDNDep(url) {
  return url.hostname === 'cdn.jsdelivr.net';
}

async function cacheFirstRuntime(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  // Only persist complete successful responses. 206 (range) throws on cache.put,
  // and opaque/error responses (status 0 / !ok) shouldn't be stored.
  if (resp.ok && resp.status === 200) cache.put(request, resp.clone());
  return resp;
}

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
      Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Same-origin: cache-first against the app-shell bucket.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => cached ?? fetch(e.request))
    );
    return;
  }

  // Cross-origin CDN deps: cache-first on first use so the app boots offline even
  // after the browser HTTP cache is evicted. Everything else (CalDAV, etc.) is
  // left to pass through to the network untouched.
  if (e.request.method === 'GET' && isCDNDep(url)) {
    e.respondWith(cacheFirstRuntime(e.request));
  }
});
