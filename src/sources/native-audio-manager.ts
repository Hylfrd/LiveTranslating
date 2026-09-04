import { EventEmitter } from "node:events";
import {
  getDefaultInputDevice,
  listAudioDevices,
  MicrophoneRecorder,
  SystemAudioRecorder,
  type AudioDevice,
  type AudioMetadata,
} from "native-audio-node";

import type { AudioSourceDefinition, AudioSourceId, PcmFrame } from "../audio/types.js";
import { rms } from "../audio/signal.js";
import type { AppLogger } from "../logging/app-logger.js";
import type { RecordingManager } from "../recording/recording-manager.js";
import { summarizeMicrophoneDevices } from "./audio-source-catalog.js";

type NativeRecorder = SystemAudioRecorder | MicrophoneRecorder;

interface CaptureGroup {
  readonly definition: AudioSourceDefinition;
  readonly recorders: Map<string, NativeRecorder>;
  readonly queues: Map<string, Float32Array[]>;
  sequence: number;
  timer: NodeJS.Timeout | undefined;
  remoteConnected: boolean;
}

export type AudioManagerEvent =
  | { type: "devices"; devices: AudioDevice[] }
  | { type: "frame"; frame: PcmFrame; level: number }
  | { type: "status"; sourceId: AudioSourceId; phase: "disabled" | "starting" | "listening" | "error"; deviceLabel?: string; error?: string };

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = SAMPLE_RATE / 10;

export class NativeAudioManager {
  private readonly events = new EventEmitter();
  private readonly groups = new Map<AudioSourceId, CaptureGroup>();
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
    return this.groups.has(sourceId);
  }

  async start(definition: AudioSourceDefinition): Promise<void> {
    await this.stop(definition.id);
    this.emitStatus(definition.id, "starting");
    const group: CaptureGroup = {
      definition,
      recorders: new Map(),
      queues: new Map(),
      sequence: 0,
      timer: undefined,
      remoteConnected: false,
    };
    this.groups.set(definition.id, group);
    if (definition.capture.kind === "remote") {
      this.emitStatus(definition.id, "starting", "等待局域网设备连接");
      return;
    }

    const recorderEntries = this.createRecorders(definition);
    const starts = await Promise.allSettled(recorderEntries.map(async ([key, recorder]) => {
      this.attachRecorder(group, key, recorder);
      try {
        await recorder.start();
        group.recorders.set(key, recorder);
      } catch (error) {
        await this.cleanupRecorder(recorder).catch(() => undefined);
        throw error;
      }
    }));
    const failures = starts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (group.recorders.size === 0) {
      await this.stop(definition.id);
      const reason = failures[0]?.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "No capture stream started");
      this.emitStatus(definition.id, "error", undefined, message);
      throw new Error(message);
    }
    for (const failure of failures) {
      this.logger.warn(`One capture stream failed: ${errorMessage(failure.reason)}`, definition.id);
    }
    this.startMixer(group);
    this.emitStatus(definition.id, "listening", this.selectionLabel(definition));
  }

  pushRemoteFrame(sourceId: AudioSourceId, samples: Float32Array): boolean {
    const group = this.groups.get(sourceId);
    if (!group || group.definition.capture.kind !== "remote") return false;
    this.enqueue(group, "remote", samples);
    if (!group.remoteConnected) {
      group.remoteConnected = true;
      this.startMixer(group);
      this.emitStatus(sourceId, "listening", "局域网设备已连接");
    }
    return true;
  }

  disconnectRemote(sourceId: AudioSourceId): void {
    const group = this.groups.get(sourceId);
    if (!group || group.definition.capture.kind !== "remote") return;
    group.remoteConnected = false;
    group.queues.clear();
    this.emitStatus(sourceId, "starting", "等待局域网设备连接");
  }

  async stop(sourceId: AudioSourceId): Promise<void> {
    const group = this.groups.get(sourceId);
    this.groups.delete(sourceId);
    if (!group) {
      this.emitStatus(sourceId, "disabled");
      return;
    }
    if (group.timer) {
      clearInterval(group.timer);
      group.timer = undefined;
    }
    const results = await Promise.allSettled(
      [...group.recorders.values()].map((recorder) => this.cleanupRecorder(recorder)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const message = `Recorder cleanup failed for ${failures.length} stream(s)`;
      this.emitStatus(sourceId, "error", undefined, message);
      throw new AggregateError(failures.map((result) => result.reason), message);
    }
    this.emitStatus(sourceId, "disabled");
  }

  async stopAll(): Promise<void> {
    const sourceIds = [...this.groups.keys()];
    const results = await Promise.allSettled(sourceIds.map((sourceId) => this.stop(sourceId)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      this.logger.error(`Audio recorder cleanup completed with ${failures.length} error(s)`, "audio");
    }
  }

  private createRecorders(definition: AudioSourceDefinition): Array<[string, NativeRecorder]> {
    if (definition.capture.kind === "system") {
      if (definition.capture.allSystemAudio) {
        return [["system:all", new SystemAudioRecorder(captureOptions())]];
      }
      const processIds = [...new Set(definition.capture.processes.map((process) => process.pid))];
      return processIds.map((pid) => [
        `process:${pid}`,
        new SystemAudioRecorder({ ...captureOptions(), includeProcesses: [pid] }),
      ]);
    }
    if (definition.capture.kind === "remote") return [];
    const ids = definition.capture.deviceIds.length > 0
      ? definition.capture.deviceIds
      : [getDefaultInputDevice()].filter((id): id is string => Boolean(id));
    return [...new Set(ids)].map((deviceId) => [
      `microphone:${deviceId}`,
      new MicrophoneRecorder({ ...captureOptions(), deviceId, gain: 1 }),
    ]);
  }

  private attachRecorder(group: CaptureGroup, key: string, recorder: NativeRecorder): void {
    let metadata: AudioMetadata | undefined;
    recorder.on("metadata", (value) => {
      if (this.groups.get(group.definition.id) !== group) return;
      metadata = value;
      this.logger.info(`${value.sampleRate}Hz ${value.channelsPerFrame}ch ${value.encoding}`, group.definition.id);
    });
    recorder.on("data", (chunk) => {
      if (this.groups.get(group.definition.id) !== group) return;
      if (!metadata?.isFloat || metadata.bitsPerChannel !== 32) return;
      const copy = chunk.data.buffer.slice(
        chunk.data.byteOffset,
        chunk.data.byteOffset + chunk.data.byteLength,
      );
      this.enqueue(group, key, new Float32Array(copy));
    });
    recorder.on("error", (error) => void this.failRecorder(group, key, recorder, error));
  }

  private enqueue(group: CaptureGroup, key: string, input: Float32Array): void {
    const queue = group.queues.get(key) ?? [];
    queue.push(normalizeFrame(input));
    if (queue.length > 8) queue.splice(0, queue.length - 8);
    group.queues.set(key, queue);
  }

  private startMixer(group: CaptureGroup): void {
    if (group.timer) return;
    group.timer = setInterval(() => this.flushMixedFrame(group), 100);
    group.timer.unref();
  }

  private flushMixedFrame(group: CaptureGroup): void {
    if (this.groups.get(group.definition.id) !== group) return;
    const frames = [...group.queues.values()]
      .map((queue) => queue.shift())
      .filter((frame): frame is Float32Array => frame !== undefined);
    if (frames.length === 0) return;
    const mixed = new Float32Array(FRAME_SAMPLES);
    for (const frame of frames) {
      for (let index = 0; index < FRAME_SAMPLES; index += 1) {
        mixed[index] = Math.max(-1, Math.min(1, (mixed[index] ?? 0) + (frame[index] ?? 0)));
      }
    }
    const frame: PcmFrame = {
      sourceId: group.definition.id,
      sequence: group.sequence,
      capturedAt: performance.now(),
      sampleRate: SAMPLE_RATE,
      samples: mixed,
    };
    group.sequence += 1;
    try {
      this.recording.writePcm(
        group.definition.id,
        Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength),
      );
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(message, `recording:${group.definition.id}`);
      this.emitStatus(group.definition.id, "listening", undefined, message);
    }
    this.events.emit("event", { type: "frame", frame, level: rms(mixed) } satisfies AudioManagerEvent);
  }

  private async failRecorder(
    group: CaptureGroup,
    key: string,
    recorder: NativeRecorder,
    error: Error,
  ): Promise<void> {
    if (this.groups.get(group.definition.id) !== group || group.recorders.get(key) !== recorder) return;
    group.recorders.delete(key);
    group.queues.delete(key);
    await this.cleanupRecorder(recorder).catch(() => undefined);
    this.logger.error(error.message, group.definition.id);
    if (group.recorders.size === 0) {
      this.groups.delete(group.definition.id);
      if (group.timer) clearInterval(group.timer);
      this.emitStatus(group.definition.id, "error", undefined, error.message);
    }
  }

  private async cleanupRecorder(recorder: NativeRecorder): Promise<void> {
    if (recorder.isActive()) await recorder.stop();
  }

  private selectionLabel(definition: AudioSourceDefinition): string {
    if (definition.capture.kind === "system") {
      if (definition.capture.allSystemAudio) return "全部电脑声音";
      const names = definition.capture.processes.map((process) => process.name);
      return names.length <= 1 ? (names[0] ?? "电脑应用") : `${names[0] ?? "电脑应用"} 等 ${names.length} 个应用`;
    }
    if (definition.capture.kind === "microphone") {
      return summarizeMicrophoneDevices(this.devices, definition.capture.deviceIds);
    }
    return "局域网设备";
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

function captureOptions() {
  return {
    sampleRate: SAMPLE_RATE,
    chunkDurationMs: 100,
    stereo: false,
    emitSilence: true,
  } as const;
}

function normalizeFrame(input: Float32Array): Float32Array {
  if (input.length === FRAME_SAMPLES) return input;
  const output = new Float32Array(FRAME_SAMPLES);
  output.set(input.subarray(0, FRAME_SAMPLES));
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
