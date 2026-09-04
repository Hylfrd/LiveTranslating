import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type { AudioSourceId } from "../audio/types.js";
import type { AppLogger } from "../logging/app-logger.js";
import type { WhisperModelPaths } from "./model-manager.js";

export interface AsrTranscript {
  readonly sourceId: AudioSourceId;
  readonly text: string;
  readonly receivedAt: number;
  readonly speechStartedAt: number;
  readonly speechEndedAt: number;
}

export class FfmpegWhisperSession {
  private process: ChildProcessWithoutNullStreams | undefined;
  private stopPromise: Promise<void> | undefined;
  private srtBuffer = "";
  private stopping = false;
  private streamStartedAt: number | undefined;

  constructor(
    readonly sourceId: AudioSourceId,
    private readonly language: string,
    private readonly models: WhisperModelPaths,
    private readonly logger: AppLogger,
    private readonly onTranscript: (transcript: AsrTranscript) => void,
    private readonly onFailure?: (error: Error) => void,
    private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  ) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    if (this.stopPromise) {
      await this.stopPromise;
    }
    this.srtBuffer = "";
    this.streamStartedAt = undefined;
    const whisper = [
      `whisper=model=${escapeFilterPath(this.models.whisper)}`,
      `language=${this.language}`,
      "queue=2",
      "destination=-",
      "format=srt",
      "max_len=140",
      `vad_model=${escapeFilterPath(this.models.vad)}`,
      "vad_threshold=0.5",
      "vad_min_speech_duration=0.25",
      "vad_min_silence_duration=0.4",
    ].join(":");
    const filter = this.sourceId === "microphone"
      ? `highpass=f=80,lowpass=f=7600,afftdn=nr=12:nf=-40:tn=1,${whisper}`
      : whisper;
    const child = spawn(
      this.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-f",
        "f32le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-af",
        filter,
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true },
    );
    this.process = child;
    this.stopping = false;

    let readySettled = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const readyTimeout = setTimeout(() => {
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(new Error("Whisper initialization timed out"));
      }
    }, 30000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeSrt(chunk));
    child.stdout.on("end", () => this.flushSrt());
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message.includes("Whisper filter initialized") && !readySettled) {
        readySettled = true;
        clearTimeout(readyTimeout);
        resolveReady?.();
      }
      if (/\b(?:error|failed|invalid)\b/iu.test(message)) {
        this.logger.warn(message, `asr:${this.sourceId}`);
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "EOF") {
        this.logger.warn(error.message, `asr:${this.sourceId}`);
      }
    });
    child.on("error", (error) => {
      this.logger.error(error.message, `asr:${this.sourceId}`);
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimeout);
        rejectReady?.(error);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(readyTimeout);
      if (this.process === child) {
        this.process = undefined;
      }
      this.logger.info(`Whisper stopped (${code ?? signal ?? "unknown"})`, `asr:${this.sourceId}`);
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(
          new Error(`Whisper exited before initialization (${code ?? signal ?? "unknown"})`),
        );
      } else if (!this.stopping) {
        this.onFailure?.(
          new Error(`Whisper exited unexpectedly (${code ?? signal ?? "unknown"})`),
        );
      }
    });

    try {
      await ready;
    } catch (error) {
      clearTimeout(readyTimeout);
      this.stopping = true;
      if (this.process === child) {
        this.process = undefined;
      }
      await terminateChild(child, false);
      throw error;
    }
    this.logger.info(
      `Whisper ready (${this.language})`,
      `asr:${this.sourceId}`,
      {
        language: this.language,
        queueSeconds: 2,
        vadThreshold: 0.5,
        vadMinimumSpeechSeconds: 0.25,
        vadMinimumSilenceSeconds: 0.4,
        model: this.models.whisper,
        vadModel: this.models.vad,
      },
      "asr.session.ready",
    );
  }

  write(samples: Float32Array, capturedAt = performance.now()): boolean {
    if (!this.process?.stdin.writable) {
      return false;
    }
    if (this.process.stdin.writableLength > 64_000) {
      return false;
    }
    this.streamStartedAt ??= Date.now() - Math.max(0, performance.now() - capturedAt);
    this.process.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    return true;
  }

  async stop(graceful = true): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const child = this.process;
    this.process = undefined;
    if (!child) {
      return;
    }
    this.stopping = true;
    const operation = terminateChild(child, graceful).finally(() => {
      if (this.stopPromise === operation) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = operation;
    return operation;
  }

  private consumeSrt(chunk: string): void {
    this.srtBuffer += chunk;
    const blocks = this.srtBuffer.split(/\r?\n\r?\n/u);
    this.srtBuffer = blocks.pop() ?? "";
    for (const block of blocks) {
      this.emitSrtBlock(block);
    }
  }

  private flushSrt(): void {
    if (this.srtBuffer.trim()) {
      this.emitSrtBlock(this.srtBuffer);
    }
    this.srtBuffer = "";
  }

  private emitSrtBlock(block: string): void {
    const lines = block.split(/\r?\n/u);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    const timing = timestampIndex >= 0 ? parseSrtTiming(lines[timestampIndex] ?? "") : undefined;
    const text = lines
      .slice(timestampIndex >= 0 ? timestampIndex + 1 : 0)
      .join(" ")
      .trim();
    if (text) {
      const base = this.streamStartedAt ?? Date.now();
      const transcript: AsrTranscript = {
        sourceId: this.sourceId,
        text,
        receivedAt: performance.now(),
        speechStartedAt: base + (timing?.startMs ?? 0),
        speechEndedAt: base + (timing?.endMs ?? timing?.startMs ?? 0),
      };
      this.logger.debug(
        "Whisper transcript emitted",
        `asr:${this.sourceId}`,
        {
          text,
          timing,
          speechDurationMs: transcript.speechEndedAt - transcript.speechStartedAt,
          latencyAfterSpeechMs: Math.max(0, Date.now() - transcript.speechEndedAt),
        },
        "asr.transcript.raw",
      );
      this.onTranscript(transcript);
    }
  }
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  graceful: boolean,
): Promise<void> {
  if (hasClosed(child)) {
    return;
  }

  if (graceful) {
    if (child.stdin.writable) {
      child.stdin.end();
    }
    if (await waitForClose(child, 10000)) {
      return;
    }
  } else {
    child.stdin.destroy();
  }

  if (!hasExited(child) && !child.kill()) {
    throw new Error(`Failed to terminate FFmpeg process ${child.pid ?? "unknown"}`);
  }
  if (!(await waitForClose(child, 5000))) {
    throw new Error(`FFmpeg process ${child.pid ?? "unknown"} did not close`);
  }
}

function parseSrtTiming(line: string): { startMs: number; endMs: number } | undefined {
  const match = line.match(
    /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/u,
  );
  if (!match) {
    return undefined;
  }
  const values = match.slice(1).map(Number);
  const [startHours, startMinutes, startSeconds, startMillis, endHours, endMinutes, endSeconds, endMillis] = values;
  if (
    startHours === undefined || startMinutes === undefined || startSeconds === undefined ||
    startMillis === undefined || endHours === undefined || endMinutes === undefined ||
    endSeconds === undefined || endMillis === undefined
  ) {
    return undefined;
  }
  return {
    startMs: (((startHours * 60) + startMinutes) * 60 + startSeconds) * 1000 + startMillis,
    endMs: (((endHours * 60) + endMinutes) * 60 + endSeconds) * 1000 + endMillis,
  };
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function hasClosed(child: ChildProcessWithoutNullStreams): boolean {
  return hasExited(child) && child.stdout.closed && child.stderr.closed;
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs?: number,
): Promise<boolean> {
  if (hasClosed(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (timer) {
        clearTimeout(timer);
      }
      child.off("close", onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);

    child.once("close", onClose);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs);
    }

    if (hasClosed(child)) {
      finish(true);
    }
  });
}

function escapeFilterPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  const relative = path.relative(process.cwd(), absolute);
  const usable = !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : absolute;
  return usable
    .replace(/\\/g, "/")
    .replace(":", "\\\\:")
    .replace(/'/g, "\\'");
}
