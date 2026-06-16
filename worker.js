// worker.js — Whisper pipeline running in a Web Worker (module).
// Transformers.js v3: tries WebGPU first, falls back to multi-threaded WASM.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

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
    dtype: 'q8',
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
      });
      self.postMessage({ status: 'complete', text: result.text });
    } catch (err) {
      self.postMessage({ status: 'error', message: err.message });
    }
  }
});
