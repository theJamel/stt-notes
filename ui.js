// ui.js — DOM helpers
export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.style.display = s.id === `screen-${name}` ? 'flex' : 'none';
  });
}

export function setButtonState(state) {
  const btn    = document.getElementById('btn-record');
  const label  = document.getElementById('record-label');
  btn.dataset.state = state;
  btn.disabled      = state === 'processing';
  const labels = { idle: 'Tap to Record', recording: 'Stop Recording', processing: 'Transcribing…' };
  label.textContent = labels[state] ?? '';
}

export function setModelReady(ready) {
  document.getElementById('btn-record').disabled           = !ready;
  document.getElementById('model-progress').style.display = ready ? 'none' : 'flex';
}

export function setProgress(data) {
  if (!data) {
    setModelReady(true);
    return;
  }
  if (data.progress != null) {
    document.getElementById('progress-bar').value  = data.progress;
    const filename = (data.name ?? '').split('/').pop() || 'model';
    document.getElementById('progress-label').textContent =
      `Downloading ${filename} (${Math.round(data.progress)}%)`;
  }
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

export function showToast(message, type = 'info') {
  const toast = Object.assign(document.createElement('div'), {
    className: `toast toast-${type}`,
    textContent: message,
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 3500);
}
