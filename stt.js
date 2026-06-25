// stt.js — Web Worker wrapper for Whisper inference
let worker = null;
let onProgressCallback = null;
let onErrorCallback    = null;
let onReadyCallback    = null;
let pendingTranscription = null; // { token, resolve, reject }
let jobToken = 0;                // identifies the in-flight transcription

export function initWorker(onProgress, onError, onReady) {
  onProgressCallback = onProgress;
  onErrorCallback    = onError;
  onReadyCallback    = onReady;

  worker = new Worker('./worker.js', { type: 'module' });

  worker.addEventListener('message', ({ data }) => {
    switch (data.status) {
      case 'progress':
        onProgressCallback?.(data);
        break;
      case 'ready':
        onProgressCallback?.(null);       // null signals model is ready
        onReadyCallback?.(data.backend);  // 'webgpu' | 'wasm'
        break;
      case 'complete':
        // Ignore replies for a job we already gave up on (timed out): the token
        // no longer matches, so a late completion can't resolve a newer job.
        if (data.token === pendingTranscription?.token) {
          pendingTranscription.resolve(data.text);
          pendingTranscription = null;
        }
        break;
      case 'error':
        if (data.token === pendingTranscription?.token) {
          pendingTranscription.reject(new Error(data.message));
          pendingTranscription = null;
        } else if (data.token == null) {
          // Untagged error (e.g. model load failure) — not tied to a job.
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
    // Safety net: the worker only settles this promise via a 'complete'/'error'
    // message. If the Whisper pipeline ever hangs (e.g. degenerate input), that
    // message never arrives and the caller's await would block forever, wedging
    // the transcription queue. Time out so a stuck job surfaces as an error and
    // the queue keeps moving. Generous budget: 60 s floor + 10x audio duration.
    const token = ++jobToken;
    const durationSec = float32Array.length / 16000;
    const timeoutMs = Math.max(60000, durationSec * 10000);
    // settle clears the timer and only fires while this job is still the
    // in-flight one (a timeout may have already moved on to the next job).
    const settle = (fn) => (arg) => {
      clearTimeout(timer);
      if (pendingTranscription?.token === token) {
        pendingTranscription = null;
        fn(arg);
      }
    };
    const onReject = settle(reject);
    const timer = setTimeout(
      () => onReject(new Error('Transcription timed out')),
      timeoutMs
    );
    pendingTranscription = { token, resolve: settle(resolve), reject: onReject };

    // Send a copy and transfer the copy's buffer, leaving the caller's array
    // intact — the app keeps the original audio for re-transcribe / retry.
    const copy = float32Array.slice();
    worker.postMessage(
      { type: 'transcribe', token, audio: copy, language },
      [copy.buffer]
    );
  });
}

/* ---------------- remote Whisper server (OpenAI-compatible) ---------------- */

// Encode a 16 kHz mono Float32Array into a WAV Blob (44-byte header + PCM).
function encodeWav(float32Array) {
  const sampleRate = 16000;
  const numSamples = float32Array.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);        // fmt chunk size
  view.setUint16(20, 1, true);         // PCM format
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Convert float32 [-1, 1] to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function transcribeRemote(float32Array, language, serverUrl) {
  const wav = encodeWav(float32Array);
  const form = new FormData();
  form.append('file', wav, 'audio.wav');
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  if (language && language !== 'auto') form.append('language', language);

  const url = serverUrl.replace(/\/+$/, '') + '/v1/audio/transcriptions';
  const resp = await fetch(url, { method: 'POST', body: form });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Server responded ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.text ?? '';
}

// Verify a server URL by sending 0.5 s of silence through the real transcription
// endpoint — this exercises CORS and the response shape, unlike a server-specific
// health route, so it also works against any OpenAI-compatible server. Resolves
// true if the server replies OK; otherwise the underlying error propagates (a
// failed CORS/network fetch surfaces as a TypeError the caller can explain).
export async function pingRemote(serverUrl) {
  await transcribeRemote(new Float32Array(8000), null, serverUrl);
  return true;
}
