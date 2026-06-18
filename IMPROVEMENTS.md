# STT Notes — Improvement Findings

Prioritized review of UI, performance, and codebase. Each item is self-contained
so it can be picked up independently. File:line references are from the state at
review time — re-verify before editing.

Status legend: ☐ open · ☑ done

---

## High priority — correctness & architecture

### ☑ 1. "Fully offline" is not backed by the service worker — DONE
The SW (`sw.js:42`) returns early for cross-origin requests:
```js
if (new URL(e.request.url).origin !== location.origin) return;
```
The three heaviest dependencies are all cross-origin and **not** in the `SHELL`
precache list:
- Transformers.js library — jsDelivr (`worker.js:3`)
- `ort-wasm-*.wasm` ONNX runtime — jsDelivr
- Whisper model weights — HuggingFace CDN

They fall through to the browser HTTP cache, which can be evicted. After eviction
the worker cannot boot without network, contradicting README claims
(`README.md:59,63`).

**Fixed:** added a runtime cache-first strategy in `sw.js` for the jsDelivr and
HuggingFace origins, using a separate `RUNTIME` bucket (versioned independently of
the shell so a shell bump doesn't evict the multi-MB model). Deps — including the
~39 MB model — are cached on first use, so the app boots offline after the first
successful load even if the browser HTTP cache is evicted. `CACHE` bumped to v13.
Not yet deployed to prod.

### ☐ 3. `foldLine` folds on UTF-16 code units, not UTF-8 octets
`caldav.js:115` (`foldLine`) slices on `.length` (code units). RFC 5545 folding
is defined in octets and must not split a multi-byte character. Consequences for
the app's own supported languages (German, Arabic, Chinese, Japanese):
- Non-Latin text produces folded segments well over the 75-octet limit.
- Emoji / astral chars (surrogate pairs) can be sliced mid-pair, corrupting output.

NextCloud's parser is lenient so real-world breakage is low, but it's a real bug.
**Fix:** encode to UTF-8 bytes and fold on byte boundaries that respect character
boundaries.

---

## Medium priority — UX

### ☐ 4. Entire transcription goes into the VTODO `SUMMARY`
`caldav.js:14` puts the whole note in `SUMMARY`, so a multi-sentence voice note
becomes one enormous task title. The natural CalDAV model is a short `SUMMARY`
plus a `DESCRIPTION` body.
**Fix:** first line/sentence → `SUMMARY`, full text → `DESCRIPTION`. Highest-value
day-to-day UX change. (Self-contained; good to pair with #7.)

### ☑ 5. Per-file progress bar jitter — DONE
`ui.js` (`setProgress`) — each model file (encoder, decoder, configs) reported
0–100% independently, so the bar reset/jumped several times during one download.
**Fixed:** `setProgress` now accumulates per-file byte counts (`loaded`/`total`)
in a `Map` and shows one aggregate `loaded/total` percentage, falling back to the
raw per-event percentage when sizes aren't reported (e.g. cache reads). The map is
cleared on ready. Not yet deployed to prod.

### ☐ 6. Accessibility gaps
- Record button `aria-label` stays "Record voice note" across recording/processing
  states (`index.html:97`).
- Status labels (`record-label`, `progress-label`) aren't in an `aria-live`
  region, so screen readers don't announce state changes.

Cheap to fix; minor.

---

## Low priority — performance & codebase

### ☐ 2. `mediaRecorder.start(100)` emits needless chunks
`audio.js:24` emits a `dataavailable` event every 100 ms, producing dozens of tiny
Blobs that are only consumed once at `stop`. Calling `start()` with no timeslice
yields a single chunk at the end. Trivial perf.

### ☑ 7. DRY the Basic-auth header construction — DONE
Was hand-built in three places (`caldav.js` `createTodo`, `discoverTaskLists`,
`testConnection`). Extracted to an `authHeader(username, password)` helper; the
`credentials: 'omit'` rationale now lives once in the helper's doc comment. Pure
refactor, no behavioral change. Not yet deployed to prod.

---

## Notes (things that are good — don't "fix")
- No XSS sinks: all user/transcription text goes through `.value` / `.textContent`,
  never `innerHTML` with data.
- No-build-step ES-module setup is a sound simplicity choice for this project.
- The cache-busting `<If>` .htaccess rules and SW `cache: 'reload'` install are
  correct and well-commented.

## Deployment reminder
Prod path: `jamel@rp4:/root/nextcloud/nextcloud/stt-notes/` (inside the
`nextcloud_nextcloud_1` Docker container's webroot, served by Apache).
After changing any shell file, bump `CACHE` in `sw.js` so browsers pick up the
new files. Deploy via `scp` to `/tmp/stt-update/` then `sudo cp` into the webroot.
