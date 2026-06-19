// audio.js — microphone capture and resampling to 16 kHz mono Float32Array
let mediaRecorder = null;
let stream = null;
const chunks = [];

// Trim leading/trailing silence from a 16 kHz PCM Float32Array.
// Uses windowed RMS energy; voiced frames above THRESH are kept, plus PAD on each side.
const WINDOW = 320;   // 20 ms at 16 kHz
const THRESH = 0.01;  // RMS ~-40 dBFS: above mic noise floor, below voiced speech
const PAD    = 3200;  // 200 ms padding kept at each end to avoid clipping first/last phoneme

function trimSilence(pcm) {
  let first = -1, last = -1;
  for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
    let sum = 0;
    for (let j = i; j < i + WINDOW; j++) sum += pcm[j] * pcm[j];
    if (Math.sqrt(sum / WINDOW) >= THRESH) {
      if (first === -1) first = i;
      last = i + WINDOW;
    }
  }
  if (first === -1) return pcm; // all silence — let isNoSpeech() handle it downstream
  return pcm.subarray(Math.max(0, first - PAD), Math.min(pcm.length, last + PAD));
}

export async function startRecording() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  const preferred = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
  ];
  const mimeType = preferred.find(t => MediaRecorder.isTypeSupported(t)) ?? '';

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  chunks.length = 0;

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  });

  mediaRecorder.start(100); // emit chunks every 100 ms
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    mediaRecorder.addEventListener('stop', async () => {
      stream.getTracks().forEach(t => t.stop());
      try {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();

        const audioCtx = new AudioContext();
        const decoded  = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();

        const targetRate = 16000;
        const numFrames  = Math.ceil(decoded.duration * targetRate);
        const offlineCtx = new OfflineAudioContext(1, numFrames, targetRate);
        const source     = offlineCtx.createBufferSource();
        source.buffer    = decoded;
        source.connect(offlineCtx.destination);
        source.start(0);

        const resampled = await offlineCtx.startRendering();
        resolve(trimSilence(resampled.getChannelData(0)));
      } catch (err) {
        reject(err);
      }
    }, { once: true });

    mediaRecorder.stop();
  });
}

// Discard an in-progress recording without transcribing: stop the recorder and
// release the mic. No promise resolves — the captured chunks are dropped.
export function cancelRecording() {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch { /* already stopped */ }
  if (stream) stream.getTracks().forEach(t => t.stop());
  chunks.length = 0;
}
