// app.js — main orchestrator
import { startRecording, stopRecording } from './audio.js';
import { initWorker, loadModel, transcribe } from './stt.js';
import { createTodo, testConnection } from './caldav.js';
import { showScreen, setButtonState, setModelReady, setProgress, showToast } from './ui.js';

let settings = null;
let isRecording = false;
let workerInitialized = false;
let currentModel = null;
let installPrompt = null;

function getSettings() {
  try {
    return JSON.parse(localStorage.getItem('stt_settings'));
  } catch {
    return null;
  }
}

function saveSettings(s) {
  localStorage.setItem('stt_settings', JSON.stringify(s));
}

function populateSettingsForm() {
  if (!settings) return;
  document.getElementById('input-url').value      = settings.url      ?? '';
  document.getElementById('input-username').value = settings.username ?? '';
  document.getElementById('input-password').value = settings.password ?? '';
  document.getElementById('input-model').value    = settings.model    ?? 'Xenova/whisper-tiny';
  document.getElementById('input-language').value = settings.language ?? 'auto';
}

function startApp() {
  const model = settings?.model ?? 'Xenova/whisper-tiny';
  if (!workerInitialized) {
    workerInitialized = true;
    setModelReady(false);
    initWorker(
      (progress) => setProgress(progress),
      (err)      => showToast(`Model error: ${err.message}`, 'error')
    );
    loadModel(model);
    currentModel = model;
  } else if (model !== currentModel) {
    setModelReady(false);
    loadModel(model);
    currentModel = model;
  }
}

async function init() {
  // Service worker registration
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    document.getElementById('btn-install').style.display = 'block';
  });
  document.getElementById('btn-install').addEventListener('click', () => {
    installPrompt?.prompt();
    installPrompt = null;
    document.getElementById('btn-install').style.display = 'none';
  });

  settings = getSettings();
  if (settings?.url && settings?.username && settings?.password) {
    showScreen('main');
    startApp();
  } else {
    showScreen('settings');
  }

  // Settings form submit
  document.getElementById('form-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    settings = {
      url:      document.getElementById('input-url').value.trim(),
      username: document.getElementById('input-username').value.trim(),
      password: document.getElementById('input-password').value,
      model:    document.getElementById('input-model').value,
      language: document.getElementById('input-language').value,
    };
    saveSettings(settings);
    showScreen('main');
    startApp();
  });

  // Test connection button
  document.getElementById('btn-test').addEventListener('click', async () => {
    const url      = document.getElementById('input-url').value.trim();
    const username = document.getElementById('input-username').value.trim();
    const password = document.getElementById('input-password').value;
    if (!url || !username || !password) {
      showToast('Fill in all fields first', 'error');
      return;
    }
    try {
      const result = await testConnection({ url, username, password });
      if (result.ok || result.status === 207) {
        showToast('Connection successful!', 'success');
      } else {
        showToast(`Connection failed: ${result.status} ${result.statusText}`, 'error');
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    }
  });

  // Gear icon — return to settings
  document.getElementById('btn-settings').addEventListener('click', () => {
    populateSettingsForm();
    showScreen('settings');
  });

  // Record / stop button
  document.getElementById('btn-record').addEventListener('click', async () => {
    if (isRecording) {
      isRecording = false;
      setButtonState('processing');
      try {
        const audio = await stopRecording();
        const lang  = (settings?.language && settings.language !== 'auto')
          ? settings.language
          : null;
        const text = await transcribe(audio, lang);
        document.getElementById('textarea-review').value = text.trim();
        showScreen('review');
        setButtonState('idle');
      } catch (err) {
        showToast(`Transcription failed: ${err.message}`, 'error');
        setButtonState('idle');
      }
    } else {
      try {
        await startRecording();
        isRecording = true;
        setButtonState('recording');
      } catch (err) {
        const msgs = {
          NotAllowedError: 'Microphone permission denied. Enable it in your browser settings.',
          NotFoundError:   'No microphone found.',
        };
        showToast(msgs[err.name] ?? `Microphone error: ${err.message}`, 'error');
      }
    }
  });

  // Review: save to NextCloud
  document.getElementById('btn-save').addEventListener('click', async () => {
    const text = document.getElementById('textarea-review').value.trim();
    if (!text) { showToast('Nothing to save', 'error'); return; }

    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    try {
      const result = await createTodo(settings, text);
      if (result.ok) {
        showToast('Saved to NextCloud!', 'success');
        showScreen('main');
      } else {
        const msgs = {
          401: 'Authentication failed. Check your credentials in Settings.',
          403: 'Access denied. Check your CalDAV URL or server configuration.',
          404: 'Calendar not found. Check your CalDAV URL in Settings.',
        };
        showToast(msgs[result.status] ?? `Failed: ${result.status} ${result.statusText}`, 'error');
      }
    } catch (err) {
      showToast(`Network error — your note is still in the text box.`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Review: discard
  document.getElementById('btn-discard').addEventListener('click', () => {
    showScreen('main');
  });
}

init();
