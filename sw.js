// sw.js — service worker: cache-first for app shell
const CACHE = 'stt-notes-v16';

// Separate bucket for cross-origin runtime deps (Transformers.js, ONNX WASM,
// Whisper weights). These are too big/dynamic to precache in SHELL, and they'd
// otherwise live only in the evictable browser HTTP cache — once evicted the app
// can't boot offline. We cache them on first use so the "fully offline" claim
// actually holds. Versioned independently of the shell so a shell bump doesn't
// force a multi-MB model re-download.
const RUNTIME = 'stt-notes-runtime-v1';

// Hosts whose GETs we cache at runtime: jsDelivr (library + ort-wasm-*.wasm) and
// HuggingFace (model weights — endsWith covers cdn-lfs*.huggingface.co redirects;
// .hf.co covers the newer Xet download hosts).
function isCDNDep(url) {
  const h = url.hostname;
  return h === 'cdn.jsdelivr.net' || h.endsWith('huggingface.co') || h.endsWith('hf.co');
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
