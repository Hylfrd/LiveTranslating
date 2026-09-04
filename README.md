# LiveTranslating

Windows desktop and terminal application for capturing system audio and microphone audio,
transcribing each source independently, and translating committed speech.

Requires Node.js 24 or newer. Runtime scripts enable Node's environment-proxy
support so model downloads also work on proxied networks.

## Pipeline

```text
WASAPI system audio / selected microphone
  -> 16 kHz mono Float32 PCM
  -> FFmpeg Whisper large-v3-turbo Q8 + Silero VAD
  -> multilingual sentence aggregation with target-language duplicate suppression
  -> Hy-MT2 Plus or Pro, with optional parallel fallback candidate
  -> optional DeepSeek V4 Flash general review
  -> optional DeepSeek V4 Flash/Pro terminology review
  -> desktop UI, TUI, logs, billing estimates, and per-source archives
```

The Node.js backend owns capture state, source isolation, translation queues,
short-lived per-source context, recording sessions, logs, retries, cancellation, and the
HTTP API. Native code is limited to the prebuilt Windows WASAPI binding and
FFmpeg's Whisper inference filter; interfaces are rendered with Electron/React and Ink.

## Run

```powershell
npm install
npm run tui
```

The terminal UI remains available. To run the Windows desktop interface:

```powershell
npm run desktop
```

For renderer development with browser preview and Electron hot reload support:

```powershell
npm run dev:desktop
```

The desktop app provides separate System audio and Microphone transcript pages,
a settings page, and a compact subtitle window. Browser-only visual previews are
available from the Vite server with `?surface=main&preview=1` or
`?surface=compact&preview=1`; preview data is never enabled in Electron.

On first capture, the app downloads the multilingual Whisper large-v3-turbo Q8
model and Silero VAD to `models/`. Verified mirrors are tried in order.

## TUI keys

| Key | Action |
| --- | --- |
| `Up/Down`, `j/k` | Select setting |
| `Space` | Toggle selected setting/source |
| `Enter` | Start or stop capture |
| `d` | Select next microphone |
| `m` | Switch Hy-MT2 Plus/Pro |
| `l` | Cycle target language |
| `p` | Pause or resume active sources |
| `x` | Toggle the parallel Hy-MT2 candidate |
| `v` | Toggle DeepSeek general review |
| `t` | Toggle terminology review |
| `q` | Stop and exit |

## Delayed review

DeepSeek V4 Flash can review general translation quality against the source, an
optional parallel Hy-MT2 candidate, and recent same-source context. Terminology
review is a separate pass using V4 Flash or V4 Pro; it changes only
well-supported terminology errors and never persists inferred rules.

## Recordings and logs

- Audio: `archives/audio/<session name>/*.wav`
- Source-only Markdown: `archives/transcription/<session name>.md`
- Bilingual Markdown: `archives/translation/<session name>.md`
- System audio and microphone own independent sessions, names, panels, and files.
- Same-minute name collisions are reserved atomically and receive `_2`, `_3`, and later suffixes.
- Fifteen-minute WAV segmentation limits damage from interrupted sessions
- Structured application logs: `logs/YYYY-MM-DD.jsonl`

## Usage and pricing

Token totals prefer the providers' returned usage. If usage is missing, the
Apache-2.0 `@huggingface/tokenizers` package estimates against the matching model
tokenizer. Cost estimates use manually verified direct-provider prices and check
the open-source `models.dev` catalog as a non-authoritative online reference.

## HTTP API

- `GET /health`
- `GET /v1/models`
- `POST /v1/translations`
- `POST /v1/translations/validated-stream` (SSE replay after validation)
- `POST /v1/translations/review`

The API binds to `127.0.0.1:3978` by default. Keys stay in `.env`, which is
excluded from Git.
