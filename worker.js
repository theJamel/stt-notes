// worker.js — Whisper pipeline running in a Web Worker (module)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Disable local model lookup — all files come from HuggingFace Hub CDN
env.allowLocalModels = false;

let transcriber = null;

self.addEventListener('message', async ({ data }) => {
  if (data.type === 'load') {
    try {
      transcriber = await pipeline(
        'automatic-speech-recognition',
        data.model ?? 'Xenova/whisper-tiny',
        {
          quantized: data.quantized ?? true,
          progress_callback: (progress) => {
            self.postMessage({ status: 'progress', ...progress });
          },
        }
      );
      self.postMessage({ status: 'ready' });
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
        language:       data.language ?? null,
        task:           'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ status: 'complete', text: result.text });
    } catch (err) {
      self.postMessage({ status: 'error', message: err.message });
    }
  }
});
