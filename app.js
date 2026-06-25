// app.js — main orchestrator
//
// Flow (Ember design): recording and transcribing are decoupled. Stopping a
// recording drops you straight back to the idle screen; Whisper transcribes in
// the background while a banner shows progress, and the review screen surfaces
// only once a transcription completes. You can keep recording in the meantime —
// jobs queue and are processed one at a time.
import { startRecording, stopRecording, cancelRecording } from './audio.js';
import { initWorker, loadModel, transcribe, transcribeRemote, pingRemote } from './stt.js';
import { createTodo, testConnection, discoverTaskLists } from './caldav.js';
import { showScreen, getCurrentScreen, setModelReady, setProgress, showToast,
         setTranscribing, setTranscribeTime, setRecTimer, buildWave,
         populateLists, getSelectedList, setCreatedToday } from './ui.js';

let settings = null;
let workerInitialized = false;
let currentModel = null;
let installPrompt = null;
let taskLists = [];

// Background transcription state
const jobQueue = [];        // [{ id, audio, lang }] waiting to transcribe
const reviewQueue = [];     // [{ id, text, audio, lang }] transcribed, awaiting review
let processing = false;     // a transcribe() is in flight
let currentReview = null;   // the job currently shown on the review screen
let jobSeq = 0;

// Timers
let recSeconds = 0, recTimerId = null;
let bannerSeconds = 0, bannerTimerId = null;

const LANG_LABELS = {
  auto: 'Auto', en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español',
  it: 'Italiano', pt: 'Português', ar: 'العربية', zh: '中文', ja: '日本語',
};

/* ---------------- settings persistence ---------------- */
function getSettings() {
  try { return JSON.parse(localStorage.getItem('stt_settings')); }
  catch { return null; }
}
function saveSettings(s) { localStorage.setItem('stt_settings', JSON.stringify(s)); }

function populateSettingsForm() {
  if (!settings) return;
  document.getElementById('input-url').value             = settings.url      ?? '';
  document.getElementById('input-username').value        = settings.username ?? '';
  document.getElementById('input-password').value        = settings.password ?? '';
  document.getElementById('input-model').value           = settings.model    ?? 'onnx-community/whisper-tiny';
  document.getElementById('input-whisper-server').value  = settings.whisperServer ?? '';
  document.getElementById('input-language').value        = settings.language ?? 'auto';
}

function isRemoteMode() {
  return !!(settings?.whisperServer && settings.whisperServer.trim());
}

function activeLang() {
  return (settings?.language && settings.language !== 'auto') ? settings.language : null;
}

function updateRecordSub() {
  const label = LANG_LABELS[settings?.language ?? 'auto'] ?? 'Auto';
  document.getElementById('record-sub').textContent = `→ NextCloud Tasks · ${label}`;
}

/* ---------------- created-today counter ---------------- */
function todayKey() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD, local

function getCreatedToday() {
  try {
    const rec = JSON.parse(localStorage.getItem('vox_created_today'));
    return (rec && rec.date === todayKey()) ? rec.count : 0;
  } catch { return 0; }
}
function bumpCreatedToday() {
  const count = getCreatedToday() + 1;
  localStorage.setItem('vox_created_today', JSON.stringify({ date: todayKey(), count }));
  return count;
}

/* ---------------- model / lists ---------------- */
async function loadLists() {
  try { taskLists = await discoverTaskLists(settings); }
  catch { taskLists = []; }
  if (!taskLists.length) {
    taskLists = [{ href: settings.url, name: 'Default list' }];
  }
  populateLists(taskLists, localStorage.getItem('stt_last_list') ?? settings.url);
}

function startApp() {
  updateRecordSub();
  setCreatedToday(getCreatedToday());

  if (isRemoteMode()) {
    // Remote mode — no local model download needed.
    setModelReady(true);
    showToast('Ready — remote server', 'success');
    return;
  }

  const model = settings?.model ?? 'onnx-community/whisper-tiny';
  if (!workerInitialized) {
    workerInitialized = true;
    setModelReady(false);
    initWorker(
      (progress) => setProgress(progress),
      (err)      => showToast(`Model error: ${err.message}`, 'error'),
      (backend)  => showToast(backend === 'webgpu' ? 'Ready — GPU accelerated' : 'Ready — CPU mode', 'success'),
    );
    loadModel(model);
    currentModel = model;
  } else if (model !== currentModel) {
    setModelReady(false);
    loadModel(model);
    currentModel = model;
  }
}

/* ---------------- recording ---------------- */
async function beginRecording() {
  // Acquire the mic and start capture BEFORE showing the recording screen.
  // Otherwise the screen — with a working Stop button — is visible while the
  // permission prompt is still pending, and an early Stop captures nothing.
  try {
    await startRecording();
  } catch (err) {
    const mic = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    if (mic) {
      showStatus('mic');
    } else if (err.name === 'NotFoundError') {
      showToast('No microphone found.', 'error');
    } else {
      showToast(`Microphone error: ${err.message}`, 'error');
    }
    return;
  }

  buildWave();
  recSeconds = 0;
  setRecTimer(0);
  clearInterval(recTimerId);
  recTimerId = setInterval(() => setRecTimer(++recSeconds), 1000);
  showScreen('recording');
}

async function stopAndTranscribe() {
  clearInterval(recTimerId);
  showScreen('main');
  try {
    const audio = await stopRecording();
    enqueueTranscription(audio);
  } catch (err) {
    showToast(`Could not process recording: ${err.message}`, 'error');
  }
}

function abortRecording() {
  clearInterval(recTimerId);
  cancelRecording();
  showScreen('main');
}

/* ---------------- background transcription queue ---------------- */
// 16 kHz mono: below ~0.4 s there's no intelligible speech, and feeding such a
// tiny buffer to the Whisper pipeline can make it hang. Treat it as no-speech
// up front instead of queueing a job that may never come back.
const MIN_AUDIO_SAMPLES = 6400; // 0.4 s at 16 kHz

function enqueueTranscription(audio) {
  if (!audio || audio.length < MIN_AUDIO_SAMPLES) {
    onResultEmpty();
    return;
  }
  jobQueue.push({ id: ++jobSeq, audio, lang: activeLang() });
  updateBanner();
  pump();
}

async function pump() {
  if (processing) return;
  processing = true;
  while (jobQueue.length) {
    const job = jobQueue.shift();
    updateBanner();
    try {
      const text = (await (
        isRemoteMode()
          ? transcribeRemote(job.audio, job.lang, settings.whisperServer.trim())
          : transcribe(job.audio, job.lang)
      ) ?? '').trim();
      if (!text || isNoSpeech(text)) {
        onResultEmpty();
      } else {
        reviewQueue.push({ id: job.id, text, audio: job.audio, lang: job.lang });
        maybeShowReview();
      }
    } catch (err) {
      onResultFailed(job, err);
    }
  }
  processing = false;
  updateBanner();
}

// Whisper tends to emit a couple of canned phrases on silence; treat those (and
// empty output) as "no speech".
function isNoSpeech(text) {
  const t = text.toLowerCase().replace(/[\s.!?,]/g, '');
  return t === '' || t === '[blank_audio]' || t === '(silence)' || t === 'youyou';
}

function onResultEmpty() {
  if (getCurrentScreen() === 'main') showStatus('silence');
  else showToast('No speech detected.', 'error');
}

function onResultFailed(job, err) {
  if (getCurrentScreen() === 'main') {
    showStatus('fail', job.audio);
  } else {
    showToast(`Transcription failed: ${err.message}`, 'error');
  }
}

function updateBanner() {
  const active = processing || jobQueue.length > 0;
  setTranscribing(active);
  if (active) {
    if (!bannerTimerId) {
      bannerSeconds = 0;
      setTranscribeTime(0);
      bannerTimerId = setInterval(() => setTranscribeTime(++bannerSeconds), 1000);
    }
  } else {
    clearInterval(bannerTimerId);
    bannerTimerId = null;
  }
}

/* ---------------- review ---------------- */
function maybeShowReview() {
  if (currentReview) return;                 // user is mid-review already
  if (getCurrentScreen() !== 'main') return; // don't yank them out of recording
  const next = reviewQueue.shift();
  if (!next) return;
  currentReview = next;
  document.getElementById('textarea-review').value = next.text;
  showScreen('review');
}

function leaveReview() {
  currentReview = null;
  showScreen('main');
  maybeShowReview(); // surface the next queued transcription, if any
}

/* ---------------- status / error screen ---------------- */
const STATUS_CONFIG = {
  mic: {
    kind: 'mic',
    title: 'Microphone blocked',
    msg: 'voxnote needs access to your microphone to record. Enable it in your browser settings, then try again.',
    primary: 'Try again', secondary: 'Cancel',
  },
  silence: {
    kind: 'silence',
    title: 'No speech detected',
    msg: "We didn't catch anything. Move closer to the mic and try again.",
    primary: 'Record again', secondary: 'Cancel',
  },
  fail: {
    kind: 'fail',
    title: 'Transcription failed',
    msg: "The Whisper model couldn't process the recording. Your recording was kept.",
    primary: 'Try again', secondary: 'Discard recording',
  },
};

function showStatus(type, audio = null) {
  const c = STATUS_CONFIG[type];
  document.getElementById('status-icon').dataset.kind = c.kind;
  document.getElementById('status-title').textContent = c.title;
  document.getElementById('status-msg').textContent = c.msg;

  const primary   = document.getElementById('btn-status-primary');
  const secondary = document.getElementById('btn-status-secondary');
  primary.textContent = c.primary;
  secondary.textContent = c.secondary;

  primary.onclick = () => {
    if (type === 'fail' && audio) { showScreen('main'); enqueueTranscription(audio); }
    else { beginRecording(); }              // mic / silence → record again
  };
  secondary.onclick = () => showScreen('main');

  showScreen('status');
}

/* ---------------- save ---------------- */
async function saveCurrentReview() {
  const text = document.getElementById('textarea-review').value.trim();
  if (!text) { showToast('Nothing to save', 'error'); return; }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  const listUrl = getSelectedList() || settings.url;
  try {
    const result = await createTodo(settings, listUrl, text);
    if (result.ok) {
      localStorage.setItem('stt_last_list', listUrl);
      setCreatedToday(bumpCreatedToday());
      showToast('Saved to NextCloud', 'success', firstLine(text));
      leaveReview();
    } else {
      const msgs = {
        401: 'Authentication failed. Check your credentials in Settings.',
        403: 'Access denied. Check your CalDAV URL or server configuration.',
        404: 'Calendar not found. Check your CalDAV URL in Settings.',
      };
      showToast(msgs[result.status] ?? `Failed: ${result.status} ${result.statusText}`, 'error');
    }
  } catch {
    showToast('Network error — your note is still in the text box.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function firstLine(text) {
  const line = text.split('\n')[0].trim();
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

/* ---------------- storage persistence ---------------- */
// The Whisper weights (~255 MB) live in the Cache API. By default Android Chrome
// treats origin storage as "best-effort" and evicts it under pressure, forcing a
// full re-download on the next launch. Requesting persistence exempts Cache API /
// IndexedDB from automatic eviction. Installed PWAs are *supposed* to be auto-
// granted, but the heuristic is unreliable — so we ask explicitly.
async function ensurePersistentStorage() {
  if (!navigator.storage?.persist) return;
  try {
    const already = await navigator.storage.persisted();
    const granted = already || await navigator.storage.persist();
    const est = await navigator.storage.estimate();
    const mb = (n) => Math.round((n ?? 0) / 1048576);
    console.info(
      `[storage] persisted=${granted} usage=${mb(est.usage)}MB quota=${mb(est.quota)}MB`,
    );
  } catch (err) {
    console.warn('[storage] persistence check failed', err);
  }
}

/* ---------------- init ---------------- */
async function init() {
  ensurePersistentStorage();

  // Service worker registration — auto-reload when a new SW activates
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (newSW) {
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
              location.reload();
            }
          });
        }
      });
    }).catch(console.warn);
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    }
  }

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    document.getElementById('btn-install').hidden = false;
  });
  document.getElementById('btn-install').addEventListener('click', () => {
    installPrompt?.prompt();
    installPrompt = null;
    document.getElementById('btn-install').hidden = true;
  });

  settings = getSettings();
  if (settings?.url && settings?.username && settings?.password) {
    showScreen('main');
    startApp();
    loadLists();
  } else {
    showScreen('settings');
  }

  // Settings form submit
  document.getElementById('form-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    settings = {
      url:           document.getElementById('input-url').value.trim(),
      username:      document.getElementById('input-username').value.trim(),
      password:      document.getElementById('input-password').value,
      model:         document.getElementById('input-model').value,
      whisperServer: document.getElementById('input-whisper-server').value.trim(),
      language:      document.getElementById('input-language').value,
    };
    saveSettings(settings);
    showScreen('main');
    startApp();
    loadLists();
  });

  // Test connection
  document.getElementById('btn-test').addEventListener('click', async () => {
    const url      = document.getElementById('input-url').value.trim();
    const username = document.getElementById('input-username').value.trim();
    const password = document.getElementById('input-password').value;
    if (!url || !username || !password) { showToast('Fill in all fields first', 'error'); return; }
    try {
      const result = await testConnection({ url, username, password });
      if (result.ok || result.status === 207) showToast('Connection successful!', 'success');
      else showToast(`Connection failed: ${result.status} ${result.statusText}`, 'error');
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    }
  });

  // Test Whisper server — sends a short silent clip through the real transcription
  // endpoint to verify the URL is reachable and CORS-enabled.
  document.getElementById('btn-test-whisper').addEventListener('click', async (e) => {
    const url = document.getElementById('input-whisper-server').value.trim();
    if (!url) { showToast('Enter a server URL first', 'error'); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await pingRemote(url);
      showToast('Whisper server reachable', 'success');
    } catch (err) {
      // A blocked CORS/mixed-content request or an unreachable server both surface
      // as a TypeError with no status — point the user at the likely causes.
      const hint = err instanceof TypeError
        ? 'Could not reach server — check it is running, the URL, CORS, and HTTP/HTTPS (mixed content).'
        : err.message;
      showToast(`Server test failed: ${hint}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Gear → settings
  document.getElementById('btn-settings').addEventListener('click', () => {
    populateSettingsForm();
    document.getElementById('btn-back').style.display = '';
    showScreen('settings');
  });
  // Settings back → main (only shown once configured)
  document.getElementById('btn-back').addEventListener('click', () => showScreen('main'));

  // Idle orb → start recording
  document.getElementById('btn-record').addEventListener('click', beginRecording);

  // Recording controls
  document.getElementById('btn-stop').addEventListener('click', stopAndTranscribe);
  document.getElementById('btn-cancel-rec').addEventListener('click', abortRecording);

  // Review controls
  document.getElementById('btn-save').addEventListener('click', saveCurrentReview);
  document.getElementById('btn-discard').addEventListener('click', leaveReview);
  document.getElementById('btn-review-back').addEventListener('click', leaveReview);
  document.getElementById('btn-retranscribe').addEventListener('click', () => {
    if (!currentReview) return;
    const audio = currentReview.audio;
    currentReview = null;
    showScreen('main');
    enqueueTranscription(audio);
  });
}

init();
