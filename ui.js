// ui.js — DOM helpers
let currentScreen = 'main';

export function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach(s => {
    s.style.display = s.id === `screen-${name}` ? 'flex' : 'none';
  });
}

export function getCurrentScreen() {
  return currentScreen;
}

// Toggle the idle record orb / model-download progress. While the model loads the
// orb is disabled and the progress bar shows; once ready the orb is tappable.
export function setModelReady(ready) {
  document.getElementById('btn-record').disabled = !ready;
  document.getElementById('model-progress').classList.toggle('show', !ready);
  document.getElementById('record-label').textContent = ready ? 'Tap to record' : 'Preparing…';
}

// Per-file download byte counts, keyed by file. The model is several files
// (config, tokenizer, encoder, decoder) that each report 0–100% independently;
// tracking bytes lets us show one aggregate bar instead of one that resets and
// jumps each time a new file starts.
const progressFiles = new Map();

export function setProgress(data) {
  if (!data) {
    progressFiles.clear();
    setModelReady(true);
    return;
  }

  if (data.total) {
    const key = data.file ?? data.name ?? 'model';
    progressFiles.set(key, { loaded: data.loaded ?? 0, total: data.total });
  }

  let loaded = 0, total = 0;
  for (const f of progressFiles.values()) { loaded += f.loaded; total += f.total; }

  const pct = total > 0
    ? Math.round((loaded / total) * 100)
    : (data.progress != null ? Math.round(data.progress) : null);
  if (pct == null) return;

  document.getElementById('progress-bar').value = pct;
  document.getElementById('progress-label').textContent = `Downloading model… ${pct}%`;
}

// Background-transcription banner on the idle screen.
export function setTranscribing(active) {
  document.getElementById('transcribe-banner').hidden = !active;
}

export function setTranscribeTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById('banner-time').textContent = `${m}:${s}`;
}

export function setRecTimer(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  document.getElementById('rec-timer').textContent = `${m}:${s}`;
}

// Static decorative waveform: 22 bars with staggered wave animation. Built once.
const BAR_HEIGHTS = [14,30,46,22,38,52,18,34,48,26,42,30,20,44,36,24,50,32,16,40,28,46];

export function buildWave() {
  const wave = document.getElementById('rec-wave');
  if (wave.childElementCount) return;
  BAR_HEIGHTS.forEach((h, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${h}px`;
    bar.style.animationDelay = `${(i * 0.07).toFixed(2)}s`;
    wave.appendChild(bar);
  });
}

export function populateLists(lists, selectedHref) {
  const sel = document.getElementById('select-list');
  sel.innerHTML = '';
  for (const l of lists) {
    const opt = document.createElement('option');
    opt.value = l.href;
    opt.textContent = l.name;
    if (l.href === selectedHref) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function getSelectedList() {
  return document.getElementById('select-list').value;
}

export function setCreatedToday(count) {
  document.getElementById('count-today').textContent =
    `${count} ${count === 1 ? 'task' : 'tasks'}`;
}

// Toast. For success saves, pass a `sub` (the task title) to render the richer
// check + subtitle card from the design; otherwise a plain single-line toast.
export function showToast(message, type = 'info', sub = null) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  if (sub != null || type === 'success') {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '!' : '✓';
    const text = document.createElement('div');
    text.className = 'toast-text';
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = message;
    text.appendChild(title);
    if (sub != null) {
      const subEl = document.createElement('div');
      subEl.className = 'toast-sub';
      subEl.textContent = sub;
      text.appendChild(subEl);
    }
    toast.append(icon, text);
  } else {
    toast.textContent = message;
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}
