// audio.js — microphone capture and resampling to 16 kHz mono Float32Array
let mediaRecorder = null;
let stream = null;
const chunks = [];

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
        resolve(resampled.getChannelData(0));
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
