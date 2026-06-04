# Parachute Pebble

Capture from your wrist straight into your Parachute vault.

Press the app → pick a canned quick-log, or dictate a ~15-second voice note → it
lands in your vault as a `#capture/text` / `#capture/voice` note, in the same
inbox everything else flows into. The watch has no internet; the phone-side
PebbleKit JS does the HTTP. Captures made offline are queued and flushed when
your vault is reachable again.

This is the **training-wheels** version — deliberately small, deliberately
short-form. See [Roadmap](#roadmap) for where it goes.

## The honest constraints (read these first)

- **~15 seconds per voice note, hard.** A single Pebble `DictationSession` is
  capped at 15s by firmware (`DICTATION_TIMEOUT` in
  [PebbleOS](https://github.com/coredevices/PebbleOS)), independent of which
  speech backend you use. This app
  is built for short, atomic captures ("idea: …", "remember to …"). Long-form
  voice belongs on the **Index 01 ring** (~5 min, on-device Parakeet, fork-free
  webhook) or on a forked firmware that raises that constant.
- **Transcript only — no audio.** A watchapp can never access raw mic audio
  (the only mic API, `DictationSession`, returns text). So Pebble voice captures
  carry the transcript but not a `.webm` attachment, unlike phone memos.
- **Voice depends on your watch's dictation working.** On Pebble Time 2, early
  firmware had a known "Dictation is not available" bug. The **canned quick-logs
  need no microphone** and always work — that's why they're the headline path
  until you've confirmed dictation on your watch.

## What it writes

```
POST <hub>/vault/<vault>/api/notes
Authorization: Bearer <token>
Content-Type: application/json

{
  "content": "Drank water",
  "path": "Notes/2026/06-02/14-31-07",      // voice -> Memos/…
  "tags": ["capture", "capture/text"],       // voice -> capture/voice
  "metadata": { "source": "pebble", "device": "pebble-time-2", "captured_at": "…" }
}
```

This is the exact capture contract `notes-ui` uses, so wrist captures are
first-class citizens in your inbox. The `default` vault auto-provisions the
`capture` / `capture/text` / `capture/voice` tag schema, so nothing else is
required server-side.

## Setup

### 0. Install the SDK (one-time)

```sh
uv tool install pebble-tool --python 3.13
pebble sdk install latest
```

### 1. Point it at your vault

For v0, edit the constants at the top of [`src/pkjs/index.js`](src/pkjs/index.js):

```js
var DEFAULT_HUB   = "https://your-tunnel.example.com"; // phone-reachable hub origin
var DEFAULT_VAULT = "default";
var DEFAULT_TOKEN = "eyJ...";                            // see below
```

Mint a write token on your machine:

```sh
parachute auth mint-token --scope vault:default:write
```

> The hub origin must be reachable **from your phone** — i.e. your Cloudflare
> tunnel URL, not `localhost`. The watch → phone → internet → your hub.

**Or skip the constants entirely:** tap the gear on the app in the Pebble phone
app and fill in the hub, token, and your quick-logs right there — a config page
is built in and opens with **no hosting needed**. (If your phone's Pebble app
won't open the built-in `data:` page, host [`config/index.html`](config/index.html)
and set `CONFIG_URL` in `index.js`.)

### 2. Build & install

```sh
pebble build

# try it in the emulator (no real dictation, but the menu + flow work)
pebble install --emulator emery

# install to your Pebble Time 2:
#   in the Pebble phone app: Devices → ⋯ → Enable Dev Connect → sign in with GitHub
pebble install --phone <phone-ip>
```

## Your quick-logs (configurable from the phone)

The menu's quick-logs — tap a label to save a fixed `#capture/text` note — are
edited on the **config page** (gear icon → Quick-logs), one `Label | note text`
per line. The phone pushes the list to the watch over AppMessage (`QUICK_LOGS`)
and the menu **rebuilds live** — no rebuild, no reinstall. The
`DEFAULT_QUICK_LOGS` in [`src/c/parachute_pebble.c`](src/c/parachute_pebble.c)
are only the fallback shown until your list arrives. Leave the list empty for a
voice-only app.

## Roadmap

1. **v0 (here):** 15s voice dictation + **phone-configurable quick-logs** →
   `POST /api/notes`; offline queue, SEQ dedupe, JS_READY handshake, ACK watchdog.
2. **Config via OAuth:** the config page (a real browser) runs the hub's
   OAuth 2.1 + PKCE via `surface-client` instead of a pasted token; pkjs
   refreshes over XHR.
3. **Index 01 ingest:** a small vault-side webhook receiver turns the ring's
   webhook payload (audio + Parakeet transcript) into a full-fidelity
   `#capture/voice` note — the long-form companion to the watch's short-form.
4. **Own the voice pipeline (Parakeet):** point the watch's dictation backend at
   a self-hosted ASR endpoint wrapping `scribe` (a ~150-line NMSP/Speex shim;
   on the Rebble path it's an account-config setting, not a fork).
5. **Long watch dictation:** fork PebbleOS to raise the 15s `DICTATION_TIMEOUT`.

## Layout

```
package.json                 # Pebble manifest (uuid, messageKeys, capabilities)
src/c/parachute_pebble.c      # watch app: menu + dictation + AppMessage + result UI
src/pkjs/index.js             # phone side: AppMessage -> vault POST + offline queue
config/index.html             # optional hosted config page (hub + vault + token)
```

Part of the [Parachute](https://parachute.computer) ecosystem — exploration tier. AGPL-3.0.
