// stt.js — Web Worker wrapper for Whisper inference
let worker = null;
let onProgressCallback = null;
let onErrorCallback    = null;
let pendingTranscription = null; // { resolve, reject }

export function initWorker(onProgress, onError) {
  onProgressCallback = onProgress;
  onErrorCallback    = onError;

  worker = new Worker('./worker.js', { type: 'module' });

  worker.addEventListener('message', ({ data }) => {
    switch (data.status) {
      case 'progress':
        onProgressCallback?.(data);
        break;
      case 'ready':
        onProgressCallback?.(null); // null signals model is ready
        break;
      case 'complete':
        pendingTranscription?.resolve(data.text);
        pendingTranscription = null;
        break;
      case 'error':
        if (pendingTranscription) {
          pendingTranscription.reject(new Error(data.message));
          pendingTranscription = null;
        } else {
          onErrorCallback?.(new Error(data.message));
        }
        break;
    }
  });

  worker.addEventListener('error', (err) => {
    const error = new Error(err.message ?? 'Worker error');
    if (pendingTranscription) {
      pendingTranscription.reject(error);
      pendingTranscription = null;
    } else {
      onErrorCallback?.(error);
    }
  });
}

export function loadModel(model, quantized = true) {
  worker?.postMessage({ type: 'load', model, quantized });
}

export function transcribe(float32Array, language) {
  return new Promise((resolve, reject) => {
    pendingTranscription = { resolve, reject };
    const buffer = float32Array.buffer;
    worker.postMessage(
      { type: 'transcribe', audio: float32Array, language },
      [buffer]
    );
  });
}
