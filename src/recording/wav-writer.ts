import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

const WAV_HEADER_BYTES = 44;
const FLOAT32_BYTES = 4;
const PCM16_BYTES = 2;

export class Pcm16WavWriter {
  private readonly handle: number;
  private bytesWritten = 0;
  private bytesSinceCheckpoint = 0;
  private closed = false;

  constructor(
    readonly partPath: string,
    readonly finalPath: string,
    private readonly sampleRate = 16000,
    private readonly channels = 1,
  ) {
    this.handle = openSync(partPath, "w");
    try {
      writeAllSync(
        this.handle,
        createHeader(0, this.sampleRate, this.channels),
        0,
      );
    } catch (error) {
      try {
        closeSync(this.handle);
      } catch {
        // Preserve the original initialization error.
      }
      throw error;
    }
  }

  writeFloat32(chunk: Buffer): void {
    if (this.closed) {
      throw new Error("Cannot write to a closed WAV file");
    }
    if (chunk.length % FLOAT32_BYTES !== 0) {
      throw new Error(`Invalid Float32 PCM byte length: ${chunk.length}`);
    }

    const pcm16 = float32ToPcm16(chunk);
    writeAllSync(this.handle, pcm16, WAV_HEADER_BYTES + this.bytesWritten);
    this.bytesWritten += pcm16.length;
    this.bytesSinceCheckpoint += pcm16.length;
    if (this.bytesSinceCheckpoint >= this.sampleRate * this.channels * PCM16_BYTES * 5) {
      this.checkpoint();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors: unknown[] = [];
    try {
      writeAllSync(
        this.handle,
        createHeader(this.bytesWritten, this.sampleRate, this.channels),
        0,
      );
      fsyncSync(this.handle);
    } catch (error) {
      errors.push(error);
    }
    try {
      closeSync(this.handle);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        renameSync(this.partPath, this.finalPath);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to finalize WAV file ${this.partPath}`);
    }
  }

  private checkpoint(): void {
    writeAllSync(
      this.handle,
      createHeader(this.bytesWritten, this.sampleRate, this.channels),
      0,
    );
    fsyncSync(this.handle);
    this.bytesSinceCheckpoint = 0;
  }
}

function createHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // Linear PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function float32ToPcm16(chunk: Buffer): Buffer {
  const sampleCount = chunk.length / FLOAT32_BYTES;
  const output = Buffer.allocUnsafe(sampleCount * PCM16_BYTES);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = chunk.readFloatLE(index * FLOAT32_BYTES);
    const finiteValue = Number.isFinite(value) ? value : 0;
    const clamped = Math.max(-1, Math.min(1, finiteValue));
    const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    output.writeInt16LE(Math.round(scaled), index * PCM16_BYTES);
  }
  return output;
}

function writeAllSync(handle: number, data: Buffer, position: number): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(
      handle,
      data,
      offset,
      data.length - offset,
      position + offset,
    );
    if (written <= 0) {
      throw new Error("File write made no progress");
    }
    offset += written;
  }
}
