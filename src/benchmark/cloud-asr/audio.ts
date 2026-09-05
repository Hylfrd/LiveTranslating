import { spawn } from "node:child_process";
import path from "node:path";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

export async function* pcm16Frames(
  input: string,
  startSeconds: number,
  durationSeconds: number,
  frameMs: number,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const frameBytes = samplesForMilliseconds(frameMs) * BYTES_PER_SAMPLE;
  if (input === "synthetic:silence") {
    const totalBytes = Math.round(durationSeconds * SAMPLE_RATE) * BYTES_PER_SAMPLE;
    for (let offset = 0; offset < totalBytes; offset += frameBytes) {
      signal.throwIfAborted();
      yield Buffer.alloc(Math.min(frameBytes, totalBytes - offset));
    }
    return;
  }

  const child = spawn(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(startSeconds),
      "-t",
      String(durationSeconds),
      "-i",
      path.resolve(input),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let residual: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });

  try {
    for await (const value of child.stdout) {
      signal.throwIfAborted();
      residual = residual.length > 0
        ? Buffer.concat([residual, value as Buffer])
        : value as Buffer;
      while (residual.length >= frameBytes) {
        yield residual.subarray(0, frameBytes);
        residual = residual.subarray(frameBytes);
      }
    }
    const alignedBytes = residual.length - (residual.length % BYTES_PER_SAMPLE);
    if (alignedBytes > 0) yield residual.subarray(0, alignedBytes);
    const exitCode = await closed;
    if (exitCode !== 0) {
      throw new Error(`FFmpeg PCM decode failed (${exitCode ?? "signal"}): ${stderr.trim()}`);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function pcmDurationMs(byteLength: number): number {
  return byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE) * 1000;
}

function samplesForMilliseconds(milliseconds: number): number {
  return Math.max(1, Math.round(SAMPLE_RATE * milliseconds / 1000));
}
