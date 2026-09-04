# LiveTranslating

Windows desktop and terminal application for combining selected computer applications,
microphones, or a LAN browser into independently transcribed and translated audio sources.

Requires Node.js 24 or newer. Runtime scripts enable Node's environment-proxy
support so model downloads also work on proxied networks.

## Pipeline

```text
all Windows audio / selected application sessions / selected microphones / LAN browser
  -> per-source 100 ms mixer -> 16 kHz mono Float32 PCM
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

The desktop app starts with separate computer and microphone pages. Additional
computer, multi-microphone, or LAN sources can be named and assigned an icon;
every source receives its own transcript, transport, archive state, and export history.
Completed sessions are grouped in a recordings manager where audio, source Markdown,
and bilingual Markdown can be filtered, opened, revealed, renamed together, or moved
to the Windows recycle bin. Runtime logs open in a dedicated filterable window. A
settings page and compact subtitle window remain shared surfaces. Browser-only visual previews are
available from the Vite server with `?surface=main&preview=1` or
`?surface=compact&preview=1`; preview data is never enabled in Electron.

On first capture, the app downloads the multilingual Whisper large-v3-turbo Q8
model and Silero VAD to `models/`. Verified mirrors are tried in order. A persistent
Toast reports the current file, mirror, transferred bytes, percentage, verification,
and retries; only the completed or failed state auto-dismisses.

Portable builds use `PORTABLE_EXECUTABLE_DIR` instead of Electron's temporary
extraction directory. When an executable is launched from this repository's
`release/` folder, runtime data and `.env` resolve from the repository root. A
standalone portable executable uses its own directory. Set
`LIVE_TRANSLATING_DATA_DIR` to explicitly choose another persistent root.

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
- Every configured source owns an independent session, name, panel, and set of files.
- The recordings manager treats the three paths with the same session name as one bundle.
- Deletion uses the Windows recycle bin; bundle renaming updates all available artifacts together.
- Same-minute name collisions are reserved atomically and receive `_2`, `_3`, and later suffixes.
- Fifteen-minute WAV segmentation limits damage from interrupted sessions
- Structured application logs: `logs/YYYY-MM-DD.jsonl`

Logs are appended asynchronously as individual JSONL records and the current day's
last 500 records are restored on startup. Provider requests, non-streaming responses,
errors, raw Whisper segments, and committed transcript timing include expandable
structured details in the log window. Authorization headers, API-key fields, bearer
tokens, and `sk-` values are recursively redacted. Source and translation text remain
in local logs because they are required for debugging.

## ASR latency

The desktop pipeline uses a 2-second Whisper queue, 400ms VAD silence boundary, and
shorter sentence-commit limits. Silent real-time tests on the two reference lecture
clips produced zero dropped frames. On 60-second clips, committed-sentence P95 fell
from 3.98s to 2.28s for Yale and from 4.56s to 2.38s for Stanford.

The compact subtitle window keeps up to 160 recent entries in a scrollable newest-first
list. The latest entry stays at the top and receives the strongest translation size.

## LAN sources

Adding an Other source starts a tokenized capture page on port `47321`. The page
lets another device select a microphone and start or stop its stream; received PCM
enters the same per-source recording and ASR pipeline as local inputs. When Tailscale
HTTPS certificates are enabled for the private network, the backend obtains the
machine's `.ts.net` certificate into temporary files, removes the files immediately
after loading them, and advertises an HTTPS/WSS URL that is reachable only inside the
same tailnet. It never enables public Funnel. If certificates are unavailable, the UI
labels the HTTP fallback as unusable for normal remote-browser microphone capture
instead of presenting it as a working secure URL. Service access remains private,
but public-CA certificate issuance records the machine's `.ts.net` domain in public
Certificate Transparency logs.

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
