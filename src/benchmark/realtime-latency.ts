import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FfmpegWhisperSession, type AsrTranscript } from "../asr/ffmpeg-whisper.js";
import { AsrModelManager } from "../asr/model-manager.js";
import { TranscriptAssembler } from "../asr/transcript-assembler.js";
import { config } from "../config.js";
import { AppLogger } from "../logging/app-logger.js";
import { OpenAICompatibleTranslationProvider } from "../translation/provider.js";
import type { TranslationModelId } from "../translation/schema.js";
import { percentile } from "./metrics.js";

const SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = 100;
const FRAME_BYTES = SAMPLE_RATE * (FRAME_DURATION_MS / 1000) * Float32Array.BYTES_PER_ELEMENT;

interface LatencyConfig {
  readonly video: string;
  readonly name: string;
  readonly outputDirectory: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly translationModel?: TranslationModelId;
}

interface StageRecord {
  readonly index: number;
  readonly sourceText: string;
  readonly speechEndedAt: number;
  readonly emittedAt: number;
  queueStartedAt?: number;
  translatedAt?: number;
  reviewedAt?: number;
  translation?: string;
  revisedTranslation?: string;
  translationError?: string;
  reviewError?: string;
}

const configPath = process.argv[process.argv.indexOf("--config") + 1];
if (!configPath) {
  throw new Error("Usage: benchmark:latency -- --config <benchmark JSON>");
}
const input = JSON.parse(await readFile(path.resolve(configPath), "utf8")) as LatencyConfig;
const outputDirectory = path.resolve(`${input.outputDirectory}-latency`);
await mkdir(outputDirectory, { recursive: true });

const logger = new AppLogger(outputDirectory);
const provider = new OpenAICompatibleTranslationProvider(config.translation);
const telemetry: Array<{ model: string; type: string }> = [];
const unsubscribe = provider.registry.subscribeTelemetry((event) => telemetry.push(event));

try {
  const pcm = decodePcm(input);
  const models = await new AsrModelManager(logger, process.cwd()).ensureModels();
  const rawLatencies: number[] = [];
  const records: StageRecord[] = [];
  const translationJobs: Promise<void>[] = [];
  const reviewJobs: Promise<void>[] = [];
  const contexts: Array<{ source: string; translation: string }> = [];
  let asrFailure: Error | undefined;
  let droppedFrames = 0;

  const assembler = new TranscriptAssembler((transcript) => {
    const record: StageRecord = {
      index: records.length,
      sourceText: transcript.text,
      speechEndedAt: transcript.speechEndedAt,
      emittedAt: Date.now(),
    };
    records.push(record);
    const job = (async () => {
      record.queueStartedAt = Date.now();
      try {
        const result = await provider.translate({
          text: record.sourceText,
          sourceLanguage: "en",
          targetLanguage: "zh",
          context: contexts.slice(-4),
          model: input.translationModel ?? "hy-mt2-plus",
        });
        record.translation = result.text;
        record.translatedAt = Date.now();
        contexts.push({ source: record.sourceText, translation: result.text });
        const reviewContext = contexts.slice(-5, -1);
        const review = provider
          .reviewTranslation({
            sourceText: record.sourceText,
            originalTranslation: result.text,
            sourceLanguage: "en",
            targetLanguage: "zh",
            mode: "general",
            model: "deepseek-v4-flash",
            context: reviewContext,
          })
          .then((reviewResult) => {
            record.revisedTranslation = reviewResult.reviewedTranslation;
            record.reviewedAt = Date.now();
          })
          .catch((error: unknown) => {
            record.reviewError = errorMessage(error);
          });
        reviewJobs.push(review);
      } catch (error) {
        record.translationError = errorMessage(error);
      }
    })();
    translationJobs.push(job);
  });

  const session = new FfmpegWhisperSession(
    "system",
    "en",
    models,
    logger,
    (transcript: AsrTranscript) => {
      rawLatencies.push(Date.now() - transcript.speechEndedAt);
      assembler.push(transcript);
    },
    (error) => {
      asrFailure = error;
    },
  );

  const initializationStartedAt = performance.now();
  await session.start();
  const whisperInitializationMs = performance.now() - initializationStartedAt;
  const pacingStartedAt = performance.now();
  const frameCount = Math.ceil(pcm.length / FRAME_BYTES);

  try {
    for (let index = 0; index < frameCount; index += 1) {
      const targetElapsed = index * FRAME_DURATION_MS;
      const remaining = targetElapsed - (performance.now() - pacingStartedAt);
      if (remaining > 0) {
        await delay(remaining);
      }
      const start = index * FRAME_BYTES;
      const end = Math.min(pcm.length, start + FRAME_BYTES);
      const frame = pcm.subarray(start, end);
      if (frame.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
        continue;
      }
      const samples = new Float32Array(frame.buffer, frame.byteOffset, frame.length / 4);
      if (!session.write(samples, performance.now())) {
        droppedFrames += 1;
      }
    }
    await session.stop(true);
    assembler.flush();
  } catch (error) {
    assembler.discard();
    await session.stop(false).catch(() => undefined);
    throw error;
  }
  if (asrFailure) {
    throw asrFailure;
  }
  await Promise.allSettled(translationJobs);
  await Promise.allSettled(reviewJobs);

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    input: {
      name: input.name,
      video: path.resolve(input.video),
      startSeconds: input.startSeconds,
      durationSeconds: input.durationSeconds,
      frameDurationMs: FRAME_DURATION_MS,
      translationModel: input.translationModel ?? "hy-mt2-plus",
    },
    silent: true,
    whisperInitializationMs: round(whisperInitializationMs),
    rawAsr: summarize(rawLatencies),
    sentenceCommit: summarize(records.map((record) => record.emittedAt - record.speechEndedAt)),
    translationQueueWait: summarize(
      records.flatMap((record) =>
        record.queueStartedAt === undefined ? [] : [record.queueStartedAt - record.emittedAt],
      ),
    ),
    initialTranslation: summarize(
      records.flatMap((record) =>
        record.translatedAt === undefined ? [] : [record.translatedAt - record.speechEndedAt],
      ),
    ),
    delayedReview: summarize(
      records.flatMap((record) =>
        record.reviewedAt === undefined ? [] : [record.reviewedAt - record.speechEndedAt],
      ),
    ),
    counts: {
      sentences: records.length,
      translations: records.filter((record) => record.translatedAt !== undefined).length,
      reviews: records.filter((record) => record.reviewedAt !== undefined).length,
      translationErrors: records.filter((record) => record.translationError).length,
      reviewErrors: records.filter((record) => record.reviewError).length,
      rateLimitRetries: telemetry.filter((event) => event.type === "rate_limit_retry").length,
      droppedFrames,
    },
  };
  await Promise.all([
    writeFile(path.join(outputDirectory, "latency-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(outputDirectory, "latency-records.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    ),
  ]);
  console.log(JSON.stringify({ outputDirectory, report }, null, 2));
} finally {
  unsubscribe();
  await logger.close();
}

function decodePcm(input: LatencyConfig): Buffer {
  const result = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(input.startSeconds),
      "-t",
      String(input.durationSeconds),
      "-i",
      path.resolve(input.video),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { windowsHide: true, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`PCM decode failed: ${result.stderr?.toString("utf8").trim() ?? "unknown"}`);
  }
  return result.stdout;
}

function summarize(values: readonly number[]): Record<string, number | undefined> {
  return {
    count: values.length,
    meanMs: values.length > 0
      ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : undefined,
    p50Ms: round(percentile(values, 0.5) ?? 0),
    p95Ms: round(percentile(values, 0.95) ?? 0),
    maxMs: round(Math.max(0, ...values)),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
