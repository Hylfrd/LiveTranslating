import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AppLogger } from "../logging/app-logger.js";

const FILES = [
  {
    name: "ggml-large-v3-turbo-q8_0.bin",
    urls: [
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

export class AsrModelManager {
  private inFlight: Promise<WhisperModelPaths> | undefined;
  private verifiedPaths: WhisperModelPaths | undefined;

  constructor(
    private readonly logger: AppLogger,
    private readonly rootDirectory = process.cwd(),
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
    this.logger.info(`Downloading ${path.basename(destination)}...`, "asr");
    let lastError: unknown;
    for (const url of urls) {
      signal?.throwIfAborted();
      try {
        let existingBytes = await fileSize(partPath);
        if (existingBytes > expectedBytes) {
          await rm(partPath, { force: true });
          existingBytes = 0;
        }
        if (existingBytes === expectedBytes) {
          if (
            !expectedHash ||
            (await hashFile(partPath, expectedHash.algorithm, signal)) === expectedHash.value
          ) {
            await rename(partPath, destination);
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
        await pipeline(
          Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
          createWriteStream(partPath, {
            flags: existingBytes > 0 && response.status === 206 ? "a" : "w",
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
        if (
          expectedHash &&
          (await hashFile(partPath, expectedHash.algorithm, signal)) !== expectedHash.value
        ) {
          throw new Error(`${expectedHash.algorithm.toUpperCase()} verification failed`);
        }
        await rename(partPath, destination);
        this.logger.info(
          `Downloaded ${path.basename(destination)} (${Math.round(info.size / 1_000_000)} MB)`,
          "asr",
        );
        return;
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        lastError = error;
        this.logger.warn(
          `Model mirror ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`,
          "asr",
        );
      }
    }
    throw new Error(
      `All model mirrors failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
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
