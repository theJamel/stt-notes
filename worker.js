// worker.js — Whisper pipeline running in a Web Worker (module).
// Transformers.js v3: tries WebGPU first, falls back to multi-threaded WASM.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

// Persist model weights in Cache API so a hard reload (which bypasses the SW)
// doesn't force a full re-download. Cache API is only cleared by explicit
// "Clear site data" / eviction — not by page reload, not by SW version bumps.
// This worker fetch override is the SINGLE source of truth for model storage:
// the service worker no longer caches HuggingFace, and Transformers.js's own
// browser cache is disabled below, so the ~255 MB weights are stored exactly once.
const MODEL_CACHE = 'voxnote-model-v2';
const _fetch = globalThis.fetch.bind(globalThis);

// Normalize the cache key to origin + pathname, dropping the query string.
// HuggingFace LFS/Xet downloads carry signed, expiring query params that change
// every session; keying on the full URL would miss on every launch and trigger a
// full re-download. The pathname uniquely identifies each weight file.
function modelCacheKey(href) {
  const u = new URL(href, self.location.href);
  return u.origin + u.pathname;
}

globalThis.fetch = async (input, init) => {
  let href = null;
  try {
    href = (input instanceof Request) ? input.url : String(input);
    const { hostname } = new URL(href, self.location.href);
    if (!(hostname.endsWith('huggingface.co') || hostname.endsWith('hf.co'))) href = null;
  } catch { /* relative/opaque URL — pass through */ }

  if (!href) return _fetch(input, init);

  try {
    const cache = await caches.open(MODEL_CACHE);
    const key = modelCacheKey(href);
    const hit = await cache.match(key);
    if (hit) return hit;
    const resp = await _fetch(input, init);
    // Only cache complete responses — 206 range replies can't be stored.
    if (resp.ok && resp.status === 200) cache.put(key, resp.clone());
    return resp;
  } catch {
    return _fetch(input, init);  // cache unavailable — fall through to network
  }
};

// Disable local model lookup — all files come from the HuggingFace Hub CDN.
env.allowLocalModels = false;
// Disable Transformers.js's own Cache API bucket ("transformers-cache"): our
// fetch override above already persists weights, and letting the library cache
// them too would store a redundant second copy and waste quota.
env.useBrowserCache = false;

// When cross-origin isolated (COOP+COEP set), the WASM fallback can run
// multi-threaded across all cores.
if (self.crossOriginIsolated) {
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;
}

let transcriber = null;

async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function loadModel(model) {
  // v3 models live under onnx-community/*; migrate any saved Xenova/* id.
  model = model.replace(/^Xenova\//, 'onnx-community/');
  const progress_callback = (p) => self.postMessage({ status: 'progress', ...p });

  if (await hasWebGPU()) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        // fp32 encoder + q4 decoder is the standard fast WebGPU Whisper config.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      self.postMessage({ status: 'ready', backend: 'webgpu' });
      return;
    } catch (err) {
      // WebGPU init failed (driver/model issue) — fall through to WASM.
      self.postMessage({ status: 'progress', name: 'WebGPU unavailable — using CPU', progress: 0 });
    }
  }

  transcriber = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q4',
    progress_callback,
  });
  self.postMessage({ status: 'ready', backend: 'wasm' });
}

self.addEventListener('message', async ({ data }) => {
  if (data.type === 'load') {
    try {
      await loadModel(data.model ?? 'onnx-community/whisper-tiny');
    } catch (err) {
      self.postMessage({ status: 'error', message: err.message });
    }
    return;
  }

  if (data.type === 'transcribe') {
    if (!transcriber) {
      self.postMessage({ status: 'error', token: data.token, message: 'Model not loaded yet' });
      return;
    }
    try {
      const result = await transcriber(data.audio, {
        language:        data.language ?? null,
        task:            'transcribe',
        chunk_length_s:  30,
        stride_length_s: 5,
        max_new_tokens:  256,
      });
      self.postMessage({ status: 'complete', token: data.token, text: result.text });
    } catch (err) {
      self.postMessage({ status: 'error', token: data.token, message: err.message });
    }
  }
});
