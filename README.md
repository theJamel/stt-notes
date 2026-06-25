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
| Whisper Server URL | *(optional)* leave empty to transcribe on-device; set it to use a remote server — see below |
| Language | Set your language for better accuracy |

To find your CalDAV base URL: NextCloud → top-right avatar → Settings → scroll down to see "Primary CalDAV address". Append your tasks calendar slug (usually `tasks/`).

Tap **Test Connection** to verify credentials before saving.

## Model download

The Whisper model downloads once (~39 MB for Tiny) from HuggingFace's CDN and is cached by the browser. All subsequent transcriptions work fully offline.

## Remote transcription server

If you'd rather not transcribe on-device (e.g. on a low-powered phone) or you
already run a Whisper server, set **Whisper Server URL** in Settings. The app
then sends each recording (16 kHz mono WAV) to `POST <url>/v1/audio/transcriptions`
— the OpenAI audio-transcription API — instead of loading the in-browser model.
Any OpenAI-compatible server works. Tap **TEST** next to the field to verify the
URL is reachable before saving.

Two requirements for the server:

- **CORS** — it must send `Access-Control-Allow-Origin` for the app's origin,
  since the request is cross-origin.
- **No mixed content** — a PWA served over **HTTPS** cannot call a plain
  `http://` server. Either serve the Whisper server over HTTPS (reverse proxy or
  tunnel), or test on the same machine over `http://localhost`.

### Running the local test server

A ready-to-run [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server
(CORS enabled, OpenAI-compatible endpoint) lives in `test/`:

```bash
python -m pip install -r test/requirements.txt
python test/whisper_server.py                 # tiny model on CPU, port 8080
python test/whisper_server.py --model base --port 9000
```

The model downloads automatically on first run. Bigger models are far more
accurate (especially for non-English): `tiny` → `base` → `small` → `medium` →
`large-v3`. Defaults to CPU (`int8`), which works everywhere.

Then serve the app locally and point Settings → Whisper Server URL at
`http://localhost:8080`:

```bash
python -m http.server 8000                    # from the project root
# open http://localhost:8000
```

**NVIDIA GPU (optional, much faster + lets you run larger models):** install the
CUDA libraries CTranslate2 needs as wheels, then pass `--device cuda`:

```bash
python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
python test/whisper_server.py --model medium --device cuda --compute-type float16
```

The server adds those wheels' DLLs to the search path automatically on Windows,
so no manual `PATH` editing is required. (cuDNN 9 + CUDA 12 match CTranslate2 4.x.)

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
