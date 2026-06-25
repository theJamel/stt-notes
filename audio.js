// audio.js — microphone capture and resampling to 16 kHz mono Float32Array
//
// Captures raw PCM straight from the Web Audio graph rather than recording a
// compressed Opus/WebM blob and decoding it back. The decode round-trip was
// fragile across browsers — e.g. Firefox records a WebM/Opus container its own
// decodeAudioData() can't read ("unknown content type"), and empty/very-short
// recordings have no decodable header. Raw PCM sidesteps all of that and behaves
// identically on Chrome, Firefox, Safari, and Android WebView.
let stream = null;
let audioCtx = null;
let sourceNode = null;
let processorNode = null;
let pcmChunks = [];     // Float32Array pieces at the AudioContext's native rate
let capturing = false;

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

  audioCtx = new AudioContext();
  // A context can start suspended under autoplay policies — resume so the
  // processor actually receives audio.
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  sourceNode = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally supported (incl. Android
  // WebView); AudioWorklet would need a separate module file, complicating the
  // offline/precache story for no real gain here.
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  pcmChunks = [];
  capturing = true;
  processorNode.addEventListener('audioprocess', (e) => {
    if (!capturing) return;
    // The input buffer is reused each callback — copy out the samples.
    pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  });

  // A ScriptProcessorNode only runs while connected to a destination. Route it
  // through a muted gain so we capture without playing the mic back (no echo).
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  sourceNode.connect(processorNode);
  processorNode.connect(mute);
  mute.connect(audioCtx.destination);
}

async function teardown() {
  capturing = false;
  try { processorNode?.disconnect(); } catch { /* already gone */ }
  try { sourceNode?.disconnect(); } catch { /* already gone */ }
  stream?.getTracks().forEach(t => t.stop());
  if (audioCtx && audioCtx.state !== 'closed') { try { await audioCtx.close(); } catch {} }
  processorNode = sourceNode = stream = null;
}

export async function stopRecording() {
  // Nothing was captured (e.g. Stop pressed before the mic was granted): resolve
  // empty so the caller treats it as no-speech, not an error.
  if (!capturing) { await teardown(); return new Float32Array(0); }

  const nativeRate = audioCtx.sampleRate;
  const total = pcmChunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of pcmChunks) { merged.set(c, offset); offset += c.length; }
  pcmChunks = [];
  await teardown();

  if (total === 0) return new Float32Array(0);

  const targetRate = 16000;
  if (nativeRate === targetRate) return trimSilence(merged);

  // Resample native rate (typically 44.1/48 kHz) → 16 kHz via OfflineAudioContext.
  const numFrames  = Math.ceil(merged.length * targetRate / nativeRate);
  const offlineCtx = new OfflineAudioContext(1, numFrames, targetRate);
  const buffer     = offlineCtx.createBuffer(1, merged.length, nativeRate);
  buffer.copyToChannel(merged, 0);
  const source     = offlineCtx.createBufferSource();
  source.buffer    = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const resampled = await offlineCtx.startRendering();
  return trimSilence(resampled.getChannelData(0));
}

// Discard an in-progress recording without transcribing: stop capture and release
// the mic. No promise resolves — the captured samples are dropped.
export function cancelRecording() {
  pcmChunks = [];
  teardown();
}
