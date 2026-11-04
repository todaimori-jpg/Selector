# Selector · Compact 3

A two-deck radio mixer that runs entirely in the browser. No build step, no server, no dependencies —
it is a folder of static files you can publish straight to GitHub Pages and use offline as a PWA.

It is built for **radio-style mixing**, not club beatmatching: blending tracks across genres, sitting a
field recording under a spoken word, holding a 40-second ambient crossfade. That means long fades,
loudness matching, a running order, and a session log — not four-on-the-floor quantised loops.

## Run it

```sh
npm start            # http://127.0.0.1:8131/
npm run start:subpath  # same app under /selector/ to emulate a Pages project site
```

`serve.mjs` is a ~60-line static server with no dependencies; any static host works. Opening
`index.html` from disk also works, though a real origin is better for IndexedDB and the service worker.

## Publish to GitHub Pages

1. Push this folder to a repo.
2. Settings → Pages → Source: *Deploy from a branch* → `/ (root)` and your branch.
3. Open the site URL. Manifest, icons and the service worker all use relative paths, so a project
   site under `/<repo>/` needs no configuration.

## What it does

**Decks.** Load any unprotected audio file from disk. Files over about ten minutes stream through an
`<audio>` element instead of being decoded into memory, so a 45-minute field recording cannot exhaust
the tab; shorter ones are buffered for sample-accurate cueing. The deck badge tells you which mode is
live. Tempo is a live `playbackRate` change, so the source never restarts and the audio does not stutter
while you ride it.

**Waveforms.** Peak envelopes are extracted from a deliberately low-quality mono 8 kHz decode — about
twelve times less memory than a full-rate one — at 300 buckets per second. Anything past 90 minutes
falls back to a timeline view rather than pretending to have detail. Drag the main view sideways to move
beat 1, vertically to bend BPM; drag the overview to scrub.

Above each grid sits the whole track as a static map: time ruler, the played part in full colour, the
next thirty seconds shaded so you can see what is coming, the cue marked, and a box showing exactly what
the zoomed view underneath is looking at. Drag anywhere on it to jump.

**Fades.** 2, 5, 10, 20, 40 or 80 seconds, scheduled on the audio thread as short linear segments. A fade
started before you lock the phone still finishes; the screen dimming does not leave a channel stuck half
open. The default taper is constant-power (`sin`), so a two-channel crossfade sums flat instead of dipping
in the middle.

**Level.** One tap trims a deck toward −18 dBFS RMS, which is what the meter calls zero. This is what makes
a quiet field recording and a loud studio master sit together without riding the fader.

**Library, queue, takes.** Everything persists in IndexedDB on the device. The queue is a running order you
can reorder, and `Next → A` / `Next → B` walks it. Every load, play, fade, level, marker and take is written
to a session log you can read or export as a running-order text file.

**Recording.** Captures the master bus through `MediaRecorder`, so a take is exactly what the speakers heard,
with the same fades and EQ you performed. Takes live in IndexedDB, download as files, and can sync to GitHub.
**＋ Music** and **● Record** sit in the top bar rather than inside one view, so a take can be started from
Decks, Mixer or Tracks without hunting for it.

**Touch.** Pointer capture with coalesced event recovery, `touch-action: none` on every control, no
double-tap zoom, no edge-swipe theft, 44 px hit targets, safe-area insets. Knobs use absolute angle with a
relative pickup: grabbing a knob whose indicator is nowhere near your finger does not make the sound jump —
the first movement becomes an offset instead. That single change removes most of the "I touched an EQ knob
and ruined the mix" problem on a phone.

## GitHub sync (optional)

Settings → GitHub sync. Publishes takes plus their running order into a path in one repo, so the same
recordings appear on another device. Use a **fine-grained** personal access token limited to that single
repository with **Contents: read & write** only.

- The token is stored in IndexedDB on your device and is never sent anywhere except `api.github.com`.
- Anything running in that browser tab can read it. Do not use an account-wide token, and do not use one
  that can touch other repos.
- The Contents API cannot write files larger than 1 MB, so this path suits short takes, not whole sets.
  Everything always stays on-device regardless; sync only happens when you press it.
- The service worker never intercepts cross-origin requests, so the API is never cached.

## Spotify clips (optional)

Settings → Spotify clips. This imports the **30-second preview** Spotify publishes per track as an ordinary
audio file, which then goes through exactly the same pipeline as anything from disk: peaks, cue point,
loudness trim, loop, EQ, session log.

Setup:

1. Create an app at <https://developer.spotify.com/dashboard>.
2. Add the exact Redirect URI the Settings panel shows you (it is the page URL, e.g.
   `https://you.github.io/selector/`).
3. Paste the Client ID into Settings, press Connect, sign in.

There is **no client secret**, and none is needed: the flow is PKCE for a public client, which is the only
honest option for a static site — a secret in a GitHub Pages bundle is not a secret, it is a published file.

Read the limits plainly:

- Full-length Spotify audio is not reachable from any web page. The Web Playback SDK requires Premium and
  plays through Spotify's own client, and that stream may not be recorded. This app does not attempt either.
- Previews are 30 seconds and only exist for licensed tracks; results without one say so.
- Preview hosts are not always CORS-clean. If a download is blocked, the clip still opens in Spotify.
- Treat a preview as a sample to fold into a blend, not as a bed to mix on.

## Storage

Audio never leaves the device unless you press Sync. Browsers evict ordinary site storage when disk runs
low, so Settings has **Protect from eviction**, which requests persistent storage. The panel shows the real
usage estimate.

## Notes and known limits

- `navigator.vibrate` is unsupported on iOS Safari. Knob detent haptics are a genuine benefit on Android
  and a silent no-op on iPhone — nothing else changes.
- Only unprotected music files can be decoded. DRM files will not load.
- The waveform is drawn from a mono 8 kHz analysis pass; it is an envelope, not a studio meter.
- iPhone-as-wireless-remote is deliberately absent: it needs a signalling server, which static hosting
  cannot provide.

## Layout

```
index.html            app shell
css/app.css           layout, touch hardening
js/main.js            boot + service worker
js/audio/             engine graph, deck transport, sources, peak analysis, recorder
js/ui/                controls, canvas rendering, panel builders, app wiring
js/lib/               dom helpers, IndexedDB, library, session log, GitHub, Spotify
tools/make-icons.mjs  regenerates icons/icon-192.png and icon-512.png (npm run icons)
serve.mjs             zero-dependency static server
```
