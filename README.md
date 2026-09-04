# LiveTranslating

Windows terminal application for capturing system audio and microphone audio,
transcribing each source independently, and translating committed speech.

Requires Node.js 24 or newer. Runtime scripts enable Node's environment-proxy
support so model downloads also work on proxied networks.

## Pipeline

```text
WASAPI system audio / selected microphone
  -> 16 kHz mono Float32 PCM
  -> FFmpeg Whisper large-v3-turbo Q8 + Silero VAD
  -> sentence aggregation with bounded latency
  -> DeepSeek V4 Flash by default, or Hy-MT2 Plus/Pro
  -> optional delayed DeepSeek V4 Flash review
  -> TUI, logs, and optional per-source WAV recordings
```

The Node.js backend owns capture state, source isolation, translation queues,
short-lived per-source context, recording sessions, logs, retries, cancellation, and the
HTTP API. Native code is limited to the prebuilt Windows WASAPI binding and
FFmpeg's Whisper inference filter; the interface is rendered directly in the terminal.

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
| `l` | Cycle selected source/target language |
| `r` | Start or stop per-source recording |
| `v` | Toggle delayed DeepSeek review |
| `q` | Stop and exit |

## Delayed review

DeepSeek V4 Flash reviews terminology in each initial translation against the
original text and the same source's recent context. It changes only
well-supported terminology errors and does not maintain a glossary or persist
inferred terminology rules. Reference terminology in the lecture benchmark is
used only for scoring and is never sent to the models.

## Recordings and logs

- Recordings: `recordings/<session timestamp>/`
- Separate `system-*.wav` and `microphone-*.wav` tracks
- `session.json`, `completed.json`, `transcript.jsonl`, and `transcript.md`
- Fifteen-minute WAV segmentation limits damage from interrupted sessions
- Structured application logs: `logs/YYYY-MM-DD.jsonl`

## HTTP API

- `GET /health`
- `GET /v1/models`
- `POST /v1/translations`
- `POST /v1/translations/validated-stream` (SSE replay after validation)
- `POST /v1/translations/review`

The API binds to `127.0.0.1:3978` by default. Keys stay in `.env`, which is
excluded from Git.
