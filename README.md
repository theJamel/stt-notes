# STT Notes

A Progressive Web App that records a voice note, transcribes it **entirely offline** using Whisper (WebAssembly — no cloud, no API key), and creates a task in your NextCloud via CalDAV.

tasks.org syncs the task automatically via CalDAV.

## How it works

1. **Record** — tap the microphone button
2. **Transcribe** — Whisper runs in your browser; nothing leaves your device
3. **Review** — edit the transcription if needed
4. **Save** — creates a NextCloud task; tasks.org picks it up on the next sync

## Deploy on your NextCloud server

Hosting the app on the same server as NextCloud avoids all CORS issues.

**1. Clone into your NextCloud webroot:**
```bash
cd /var/www/nextcloud        # adjust to your path
git clone https://github.com/thejamel/stt-notes.git
```

**2. Add a location block to your NextCloud nginx config:**
```nginx
location /stt-notes/ {
    alias /var/www/nextcloud/stt-notes/;
    index index.html;
    try_files $uri $uri/ /stt-notes/index.html;
    add_header Cache-Control "no-cache" always;
}
```

**3. Reload nginx:**
```bash
nginx -s reload
```

**4. Open** `https://your-nextcloud.com/stt-notes/` in Chrome on your phone.

**5. Add to home screen** — Chrome shows an "Add to Home Screen" banner, or use the browser menu → "Install app". The app will open fullscreen with no browser chrome.

## First-run settings

| Field | What to enter |
|-------|---------------|
| CalDAV Tasks URL | `https://cloud.example.com/remote.php/dav/calendars/USERNAME/tasks/` |
| Username | Your NextCloud username |
| App Password | NextCloud → Settings → Security → App passwords |
| Model | Whisper Tiny (39 MB) is recommended for speed |
| Language | Set your language for better accuracy |

To find your CalDAV base URL: NextCloud → top-right avatar → Settings → scroll down to see "Primary CalDAV address". Append your tasks calendar slug (usually `tasks/`).

Tap **Test Connection** to verify credentials before saving.

## Model download

The Whisper model downloads once (~39 MB for Tiny) from HuggingFace's CDN and is cached by the browser. All subsequent transcriptions work fully offline.

## Privacy

- Audio is processed on-device via WebAssembly — no speech leaves your phone
- The Whisper model downloads from HuggingFace's CDN on first use only
- Your NextCloud credentials are stored in the browser's `localStorage`, scoped to this origin
- Use a NextCloud **App Password**, not your main password — you can revoke it independently

## Updating

```bash
cd /var/www/nextcloud/stt-notes
git pull
```

After pulling, increment the `CACHE` version in `sw.js` (e.g. `stt-notes-v1` → `stt-notes-v2`) so browsers pick up the new files on next load.
