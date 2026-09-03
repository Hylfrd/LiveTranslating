import { EventEmitter } from "node:events";
import {
  getDefaultInputDevice,
  listAudioDevices,
  MicrophoneRecorder,
  SystemAudioRecorder,
  type AudioDevice,
  type AudioMetadata,
} from "native-audio-node";

import type { AudioSourceId, PcmFrame } from "../audio/types.js";
import { rms } from "../audio/signal.js";
import type { AppLogger } from "../logging/app-logger.js";
import type { RecordingManager } from "../recording/recording-manager.js";

type NativeRecorder = SystemAudioRecorder | MicrophoneRecorder;

export type AudioManagerEvent =
  | { type: "devices"; devices: AudioDevice[] }
  | { type: "frame"; frame: PcmFrame; level: number }
  | { type: "status"; sourceId: AudioSourceId; phase: "disabled" | "starting" | "listening" | "error"; deviceLabel?: string; error?: string };

export class NativeAudioManager {
  private readonly events = new EventEmitter();
  private readonly recorders = new Map<AudioSourceId, NativeRecorder>();
  private readonly sequences = new Map<AudioSourceId, number>();
  private devices: AudioDevice[] = [];

  constructor(
    private readonly logger: AppLogger,
    private readonly recording: RecordingManager,
  ) {}

  subscribe(listener: (event: AudioManagerEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  listMicrophones(): AudioDevice[] {
    this.devices = listAudioDevices().filter((device) => device.isInput);
    this.events.emit("event", { type: "devices", devices: this.devices } satisfies AudioManagerEvent);
    return this.devices;
  }

  defaultMicrophoneId(): string | undefined {
    return getDefaultInputDevice() ?? undefined;
  }

  isActive(sourceId: AudioSourceId): boolean {
    return this.recorders.get(sourceId)?.isActive() ?? false;
  }

  async start(sourceId: AudioSourceId, deviceId?: string): Promise<void> {
    await this.stop(sourceId);
    this.emitStatus(sourceId, "starting");
    const recorder = sourceId === "system"
      ? new SystemAudioRecorder({ sampleRate: 16000, chunkDurationMs: 100, stereo: false, emitSilence: true })
      : new MicrophoneRecorder({ sampleRate: 16000, chunkDurationMs: 100, stereo: false, emitSilence: true, gain: 1, ...(deviceId ? { deviceId } : {}) });
    this.recorders.set(sourceId, recorder);
    this.sequences.set(sourceId, 0);
    let metadata: AudioMetadata | undefined;
    recorder.on("metadata", (value) => {
      if (this.recorders.get(sourceId) !== recorder) {
        return;
      }
      metadata = value;
      this.logger.info(`${value.sampleRate}Hz ${value.channelsPerFrame}ch ${value.encoding}`, sourceId);
    });
    recorder.on("data", (chunk) => {
      if (this.recorders.get(sourceId) !== recorder) {
        return;
      }
      const format = metadata;
      if (!format || !format.isFloat || format.bitsPerChannel !== 32) {
        return;
      }
      const copy = chunk.data.buffer.slice(
        chunk.data.byteOffset,
        chunk.data.byteOffset + chunk.data.byteLength,
      );
      const samples = new Float32Array(copy);
      const frame: PcmFrame = {
        sourceId,
        sequence: this.sequences.get(sourceId) ?? 0,
        capturedAt: performance.now(),
        sampleRate: format.sampleRate,
        samples,
      };
      this.sequences.set(sourceId, frame.sequence + 1);
      try {
        this.recording.writePcm(sourceId, chunk.data);
      } catch (error) {
        const message = errorMessage(error);
        this.logger.error(message, `recording:${sourceId}`);
        this.emitStatus(sourceId, "listening", undefined, message);
      }
      this.events.emit("event", { type: "frame", frame, level: rms(samples) } satisfies AudioManagerEvent);
    });
    recorder.on("error", (error) => {
      void this.failRecorder(sourceId, recorder, error);
    });
    try {
      await recorder.start();
      const deviceLabel = sourceId === "system"
        ? "Default Windows output"
        : this.devices.find((device) => device.id === (deviceId ?? getDefaultInputDevice()))?.name;
      this.emitStatus(sourceId, "listening", deviceLabel);
    } catch (error) {
      if (this.recorders.get(sourceId) === recorder) {
        this.recorders.delete(sourceId);
        this.sequences.delete(sourceId);
      }
      const cleanupError = await this.cleanupRecorder(recorder);
      if (cleanupError) {
        this.logger.warn(
          `Recorder cleanup after start failure also failed: ${errorMessage(cleanupError)}`,
          sourceId,
        );
      }
      const message = errorMessage(error);
      this.logger.error(message, sourceId);
      this.emitStatus(sourceId, "error", undefined, message);
      throw error;
    }
  }

  async stop(sourceId: AudioSourceId): Promise<void> {
    const recorder = this.recorders.get(sourceId);
    this.recorders.delete(sourceId);
    this.sequences.delete(sourceId);
    if (!recorder) {
      this.emitStatus(sourceId, "disabled");
      return;
    }
    const cleanupError = await this.cleanupRecorder(recorder);
    if (cleanupError) {
      const message = `Recorder cleanup failed: ${errorMessage(cleanupError)}`;
      this.logger.error(message, sourceId);
      this.emitStatus(sourceId, "error", undefined, message);
      throw cleanupError;
    }
    this.emitStatus(sourceId, "disabled");
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      (["system", "microphone"] as const).map((sourceId) => this.stop(sourceId)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      this.logger.error(
        `Audio recorder cleanup completed with ${errors.length} error(s)`,
        "audio",
      );
    }
  }

  private async failRecorder(
    sourceId: AudioSourceId,
    recorder: NativeRecorder,
    error: Error,
  ): Promise<void> {
    const isCurrent = this.recorders.get(sourceId) === recorder;
    if (isCurrent) {
      this.recorders.delete(sourceId);
      this.sequences.delete(sourceId);
    }
    const stopError = await this.cleanupRecorder(recorder);
    if (stopError) {
      this.logger.warn(
        `Recorder cleanup failed: ${errorMessage(stopError)}`,
        sourceId,
      );
    }
    if (!isCurrent) {
      this.logger.warn(`Ignored stale recorder error: ${error.message}`, sourceId);
      return;
    }
    this.logger.error(error.message, sourceId);
    this.emitStatus(sourceId, "error", undefined, error.message);
  }

  private async cleanupRecorder(recorder: NativeRecorder): Promise<unknown | undefined> {
    try {
      if (recorder.isActive()) {
        await recorder.stop();
      }
      return undefined;
    } catch (error) {
      return error;
    }
  }

  private emitStatus(
    sourceId: AudioSourceId,
    phase: "disabled" | "starting" | "listening" | "error",
    deviceLabel?: string,
    error?: string,
  ): void {
    this.events.emit("event", {
      type: "status",
      sourceId,
      phase,
      ...(deviceLabel ? { deviceLabel } : {}),
      ...(error ? { error } : {}),
    } satisfies AudioManagerEvent);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
