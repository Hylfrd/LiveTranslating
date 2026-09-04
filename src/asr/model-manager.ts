import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AppLogger } from "../logging/app-logger.js";

const FILES = [
  {
    name: "ggml-large-v3-turbo-q8_0.bin",
    urls: [
      "https://modelscope.cn/models/iceCream2025/whisper.cpp/resolve/master/ggml-large-v3-turbo-q8_0.bin",
      "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
    ],
    minimumBytes: 870_000_000,
    expectedBytes: 874_188_075,
    hash: {
      algorithm: "sha256",
      value: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    },
  },
  {
    name: "ggml-silero-v6.2.0.bin",
    urls: [
      "https://modelscope.cn/models/ggml-org/whisper-vad/resolve/master/ggml-silero-v6.2.0.bin",
      "https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
      "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    ],
    minimumBytes: 800_000,
    expectedBytes: 885_098,
    hash: {
      algorithm: "sha256",
      value: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    },
  },
] as const;

export interface WhisperModelPaths {
  readonly whisper: string;
  readonly vad: string;
}

export interface AsrModelProgress {
  readonly file: string;
  readonly phase: "downloading" | "verifying" | "complete" | "retrying" | "failed";
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly mirror?: string;
  readonly attempt?: number;
  readonly error?: string;
}

export class AsrModelManager {
  private inFlight: Promise<WhisperModelPaths> | undefined;
  private verifiedPaths: WhisperModelPaths | undefined;

  constructor(
    private readonly logger: AppLogger,
    private readonly rootDirectory = process.cwd(),
    private readonly onProgress?: (progress: AsrModelProgress) => void,
  ) {}

  ensureModels(signal?: AbortSignal): Promise<WhisperModelPaths> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.verifiedPaths) {
      return Promise.resolve(this.verifiedPaths);
    }
    this.inFlight ??= this.ensureInternal(signal)
      .then((paths) => {
        this.verifiedPaths = paths;
        return paths;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async ensureInternal(signal?: AbortSignal): Promise<WhisperModelPaths> {
    const directory = path.join(this.rootDirectory, "models");
    await mkdir(directory, { recursive: true });
    for (const file of FILES) {
      signal?.throwIfAborted();
      const destination = path.join(directory, file.name);
      if (!(await isUsable(destination, file.expectedBytes, file.hash, signal))) {
        await this.download(
          file.urls,
          destination,
          file.minimumBytes,
          file.expectedBytes,
          file.hash,
          signal,
        );
      }
    }
    return {
      whisper: path.join(directory, FILES[0].name),
      vad: path.join(directory, FILES[1].name),
    };
  }

  private async download(
    urls: readonly string[],
    destination: string,
    minimumBytes: number,
    expectedBytes: number,
    expectedHash: { algorithm: "sha1" | "sha256"; value: string } | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const partPath = `${destination}.part`;
    const file = path.basename(destination);
    this.logger.info(`Downloading ${file}...`, "asr", { file, expectedBytes }, "asr.model.download.started");
    let lastError: unknown;
    for (const [index, url] of urls.entries()) {
      signal?.throwIfAborted();
      const mirror = new URL(url).host;
      try {
        let existingBytes = await fileSize(partPath);
        if (existingBytes > expectedBytes) {
          await rm(partPath, { force: true });
          existingBytes = 0;
        }
        if (existingBytes === expectedBytes) {
          this.emitProgress({ file, phase: "verifying", downloadedBytes: existingBytes, totalBytes: expectedBytes, mirror, attempt: index + 1 });
          if (
            !expectedHash ||
            (await hashFile(partPath, expectedHash.algorithm, signal)) === expectedHash.value
          ) {
            await rename(partPath, destination);
            this.emitProgress({ file, phase: "complete", downloadedBytes: expectedBytes, totalBytes: expectedBytes, mirror, attempt: index + 1 });
            return;
          }
          await rm(partPath, { force: true });
          existingBytes = 0;
        }
        const timeoutSignal = AbortSignal.timeout(20 * 60 * 1000);
        const attemptSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        const response = await fetch(url, {
          redirect: "follow",
          headers: existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {},
          signal: attemptSignal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        const append = existingBytes > 0 && response.status === 206;
        let downloadedBytes = append ? existingBytes : 0;
        let lastProgressAt = 0;
        let lastPercent = -1;
        this.emitProgress({ file, phase: "downloading", downloadedBytes, totalBytes: expectedBytes, mirror, attempt: index + 1 });
        const progressStream = new Transform({
          transform(chunk, _encoding, callback) {
            downloadedBytes += (chunk as Buffer).byteLength;
            const percent = Math.min(100, Math.floor(downloadedBytes / expectedBytes * 100));
            const now = Date.now();
            if (percent !== lastPercent && (now - lastProgressAt >= 250 || percent === 100)) {
              lastPercent = percent;
              lastProgressAt = now;
              onChunkProgress(downloadedBytes);
            }
            callback(null, chunk);
          },
        });
        const onChunkProgress = (currentBytes: number) => this.emitProgress({
          file,
          phase: "downloading",
          downloadedBytes: Math.min(expectedBytes, currentBytes),
          totalBytes: expectedBytes,
          mirror,
          attempt: index + 1,
        });
        await pipeline(
          Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
          progressStream,
          createWriteStream(partPath, {
            flags: append ? "a" : "w",
          }),
          { signal: attemptSignal },
        );
        const info = await stat(partPath);
        if (info.size < minimumBytes) {
          throw new Error(`download is unexpectedly small (${info.size} bytes)`);
        }
        if (info.size !== expectedBytes) {
          throw new Error(`download size mismatch (${info.size} != ${expectedBytes})`);
        }
        this.emitProgress({ file, phase: "verifying", downloadedBytes: info.size, totalBytes: expectedBytes, mirror, attempt: index + 1 });
        if (
          expectedHash &&
          (await hashFile(partPath, expectedHash.algorithm, signal)) !== expectedHash.value
        ) {
          throw new Error(`${expectedHash.algorithm.toUpperCase()} verification failed`);
        }
        await rename(partPath, destination);
        this.emitProgress({ file, phase: "complete", downloadedBytes: info.size, totalBytes: expectedBytes, mirror, attempt: index + 1 });
        this.logger.info(
          `Downloaded ${file} (${Math.round(info.size / 1_000_000)} MB)`,
          "asr",
          { file, bytes: info.size, mirror },
          "asr.model.download.completed",
        );
        return;
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        lastError = error;
        this.emitProgress({
          file,
          phase: "retrying",
          downloadedBytes: await fileSize(partPath),
          totalBytes: expectedBytes,
          mirror,
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        this.logger.warn(
          `Model mirror ${mirror} failed: ${error instanceof Error ? error.message : String(error)}`,
          "asr",
          { file, mirror, attempt: index + 1, error },
          "asr.model.download.retrying",
        );
      }
    }
    this.emitProgress({
      file,
      phase: "failed",
      downloadedBytes: await fileSize(partPath),
      totalBytes: expectedBytes,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw new Error(
      `All model mirrors failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private emitProgress(progress: AsrModelProgress): void {
    this.onProgress?.(progress);
  }
}

async function isUsable(
  filePath: string,
  expectedBytes: number,
  expectedHash: { algorithm: "sha1" | "sha256"; value: string } | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    await access(filePath);
    if ((await stat(filePath)).size !== expectedBytes) {
      return false;
    }
    return (
      !expectedHash ||
      (await hashFile(filePath, expectedHash.algorithm, signal)) === expectedHash.value
    );
  } catch (error) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    return false;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function hashFile(
  filePath: string,
  algorithm: "sha1" | "sha256",
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
