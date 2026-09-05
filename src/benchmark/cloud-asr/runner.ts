import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { pcm16Frames, pcmDurationMs } from "./audio.js";
import { loadReference } from "./reference.js";
import { sanitizeBenchmarkValue } from "./redaction.js";
import { createReport, renderReportMarkdown } from "./report.js";
import type {
  CloudAsrAdapter,
  CloudAsrBenchmarkConfig,
  TimedCloudAsrEvent,
} from "./types.js";

export async function runCloudAsrBenchmark(
  config: CloudAsrBenchmarkConfig,
  adapter: CloudAsrAdapter,
): Promise<ReturnType<typeof createReport>> {
  assertEnvironment(adapter);
  await mkdir(config.outputDirectory, { recursive: true });
  const reference = await loadReference(config);
  const effectiveConfig: CloudAsrBenchmarkConfig = {
    ...config,
    startSeconds: reference.startSeconds,
    durationSeconds: reference.durationSeconds,
  };
  const rawEventsPath = path.join(config.outputDirectory, "events.jsonl");
  const rawEvents = createWriteStream(rawEventsPath, { flags: "w", encoding: "utf8" });
  const controller = new AbortController();
  const events: TimedCloudAsrEvent[] = [];
  const startedAt = performance.now();
  let audioSentMs = 0;
  const emit = (event: Parameters<CloudAsrAdapter["connect"]>[1] extends (value: infer T) => void ? T : never) => {
    const timed = {
      ...event,
      elapsedWallMs: round(performance.now() - startedAt),
      audioSentMs: round(audioSentMs),
    } satisfies TimedCloudAsrEvent;
    events.push(timed);
    rawEvents.write(`${JSON.stringify(sanitizeBenchmarkValue(timed))}\n`);
  };
  const connectStartedAt = performance.now();
  let session: Awaited<ReturnType<CloudAsrAdapter["connect"]>> | undefined;
  let connectLatencyMs = 0;
  let pendingFrame: Buffer | undefined;
  let failure: Error | undefined;
  const pacingLatenessMs: number[] = [];
  let pacingScheduleShiftMs = 0;

  try {
    session = await adapter.connect({
      sampleRate: 16000,
      frameMs: effectiveConfig.frameMs,
      providerOptions: effectiveConfig.providerOptions,
      signal: controller.signal,
      ...(effectiveConfig.language ? { language: effectiveConfig.language } : {}),
    }, emit);
    connectLatencyMs = performance.now() - connectStartedAt;
    const audioPlaybackStartedAt = performance.now();
    const sendFrame = async (frame: Buffer, final: boolean) => {
      const idealAt = audioPlaybackStartedAt + audioSentMs + pcmDurationMs(frame.length);
      let scheduledAt = idealAt + pacingScheduleShiftMs;
      const overrunMs = performance.now() - scheduledAt;
      if (overrunMs > effectiveConfig.frameMs) {
        pacingScheduleShiftMs += overrunMs;
        scheduledAt += overrunMs;
      }
      const waitMs = scheduledAt - performance.now();
      if (waitMs > 0) await delay(waitMs, controller.signal);
      const sendStartedAt = performance.now();
      pacingLatenessMs.push(Math.max(0, sendStartedAt - idealAt));
      await session!.sendPcm16(frame, final);
      audioSentMs += pcmDurationMs(frame.length);
    };
    for await (const frame of pcm16Frames(
      effectiveConfig.input,
      effectiveConfig.startSeconds,
      effectiveConfig.durationSeconds,
      effectiveConfig.frameMs,
      controller.signal,
    )) {
      if (!pendingFrame) {
        pendingFrame = Buffer.from(frame);
        continue;
      }
      await sendFrame(pendingFrame, false);
      pendingFrame = Buffer.from(frame);
    }
    if (pendingFrame) {
      await sendFrame(pendingFrame, true);
    }
    await session.finish();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    connectLatencyMs ||= performance.now() - connectStartedAt;
    controller.abort(failure);
  } finally {
    await session?.close().catch(() => undefined);
    await closeStream(rawEvents);
  }

  const report = createReport(
    effectiveConfig,
    reference.text,
    events,
    connectLatencyMs,
    performance.now() - startedAt,
    { audioSentMs, latenessMs: pacingLatenessMs, scheduleShiftMs: pacingScheduleShiftMs },
    failure,
  );
  await Promise.all([
    writeFile(path.join(config.outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(path.join(config.outputDirectory, "report.md"), renderReportMarkdown(report), "utf8"),
  ]);
  if (failure) {
    throw new Error(`Cloud ASR benchmark failed; report saved to ${config.outputDirectory}`, { cause: failure });
  }
  return report;
}

function assertEnvironment(adapter: CloudAsrAdapter): void {
  const missing = adapter.requiredEnvironment.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing environment variables for ${adapter.id}: ${missing.join(", ")}`);
  }
}

function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Benchmark aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
