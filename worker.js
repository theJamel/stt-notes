// worker.js — Whisper pipeline running in a Web Worker (module).
// Transformers.js v3: tries WebGPU first, falls back to multi-threaded WASM.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

// Persist model weights in Cache API so a hard reload (which bypasses the SW)
// doesn't force a full re-download. Cache API is only cleared by explicit
// "Clear site data" — not by page reload, not by SW version bumps.
const MODEL_CACHE = 'voxnote-model-v2';
const _fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  let isModel = false;
  try {
    const href = (input instanceof Request) ? input.url : String(input);
    const { hostname } = new URL(href, self.location.href);
    isModel = hostname.endsWith('huggingface.co') || hostname.endsWith('hf.co');
  } catch { /* relative/opaque URL — pass through */ }

  if (!isModel) return _fetch(input, init);

  try {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(input);
    if (hit) return hit;
    const resp = await _fetch(input, init);
    // Only cache complete responses — 206 range replies can't be stored.
    if (resp.ok && resp.status === 200) cache.put(input, resp.clone());
    return resp;
  } catch {
    return _fetch(input, init);  // cache unavailable — fall through to network
  }
};

// Disable local model lookup — all files come from the HuggingFace Hub CDN.
env.allowLocalModels = false;

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
      self.postMessage({ status: 'error', message: 'Model not loaded yet' });
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
      self.postMessage({ status: 'complete', text: result.text });
    } catch (err) {
      self.postMessage({ status: 'error', message: err.message });
    }
  }
});
