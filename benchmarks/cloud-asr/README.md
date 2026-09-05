# Cloud ASR benchmark

This branch-only harness replays the same PCM audio to one cloud ASR provider at wall-clock speed. It does not touch the desktop runtime.

## Providers

| ID | Default model | Audio transport | Recommended frame |
| --- | --- | --- | --- |
| `alibaba-qwen-audio` | `qwen-audio-3.0-asr-flash-streaming` | Binary PCM | 100 ms |
| `alibaba-qwen3` | `qwen3-asr-flash-realtime` | JSON Base64 PCM | 100 ms |
| `tencent` | `16k_zh_en_2.0` | Binary PCM | 40 or 200 ms (official sources differ) |
| `volcengine` | Seed-ASR 2.0 async | Gzip binary protocol | 200 ms |
| `mock` | deterministic self-test | in-process | 100 ms |

The harness writes `events.jsonl`, `report.json`, and `report.md` under a provider-specific output directory. Raw provider events are saved, but authentication headers and signed URLs are never included.

When the reference is VTT, the requested clip is expanded to the first and last overlapping cue boundaries so accuracy scoring never compares unplayed caption text. Consecutive rolling-caption overlap is removed before WER/CER/MER calculation.

## Credentials

Fill only the provider being tested in `.env`:

```dotenv
DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=

TENCENTCLOUD_APP_ID=
TENCENTCLOUD_SECRET_ID=
TENCENTCLOUD_SECRET_KEY=
TENCENTCLOUD_SESSION_TOKEN=

VOLCENGINE_ASR_API_KEY=
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

## Run

```powershell
npm run benchmark:cloud-asr:selftest
npm run benchmark:cloud-asr -- --config benchmarks/cloud-asr/example.json --preflight
npm run benchmark:cloud-asr -- --config benchmarks/cloud-asr/example.json --provider alibaba-qwen-audio
```

Use the provider-specific example files for scored runs. `--provider` is useful for quick protocol checks, but it does not silently change `frameMs`; preflight reports a warning when the configured cadence differs from the provider's documented recommendation.

Use a separate run for every provider. Do not enable hotwords, context injection, diarization, translation, or review in the baseline round.

The self-test uses local WebSocket simulators for all four protocol adapters and does not prove that a cloud account, regional key, quota, or remote service is available. A failed real run still writes its raw events and an `outcome.ok=false` report before the command exits non-zero.

## Metrics

- Connection, first partial, first final, and provider finalization latency.
- Partial revision erasure and duplicate finals.
- WER for space-delimited language, CER for character-level comparison, and MER using individual Han characters plus non-Han words.
- Complete raw server events for protocol debugging.

Official protocol references:

- Alibaba Qwen-Audio: https://help.aliyun.com/en/model-studio/fun-asr-realtime-websocket-api
- Alibaba Qwen3: https://help.aliyun.com/en/model-studio/qwen-asr-realtime-interaction-process
- Tencent V2: https://cloud.tencent.com/document/product/1093/131127
- Volcengine Seed-ASR: https://www.volcengine.com/docs/6561/1354869?lang=zh
