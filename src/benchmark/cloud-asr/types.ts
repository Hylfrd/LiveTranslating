export const CLOUD_ASR_PROVIDER_IDS = [
  "alibaba-qwen-audio",
  "alibaba-qwen3",
  "tencent",
  "volcengine",
  "mock",
] as const;

export type CloudAsrProviderId = (typeof CLOUD_ASR_PROVIDER_IDS)[number];

export type CloudAsrEventType =
  | "raw"
  | "session-ready"
  | "speech-start"
  | "speech-stop"
  | "partial"
  | "final"
  | "provider-error"
  | "session-finished";

export interface CloudAsrEvent {
  readonly type: CloudAsrEventType;
  readonly provider: CloudAsrProviderId;
  readonly receivedAtMs: number;
  readonly utteranceId?: string;
  readonly revision?: number;
  readonly stableText?: string;
  readonly unstableText?: string;
  readonly text?: string;
  readonly language?: string;
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
  readonly error?: string;
  readonly raw: unknown;
}

export interface TimedCloudAsrEvent extends CloudAsrEvent {
  readonly elapsedWallMs: number;
  readonly audioSentMs: number;
}

export interface CloudAsrConnectOptions {
  readonly sampleRate: 16000;
  readonly language?: string;
  readonly frameMs: number;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface CloudAsrSession {
  sendPcm16(frame: Buffer, final: boolean): Promise<void>;
  finish(): Promise<void>;
  close(): Promise<void>;
}

export interface CloudAsrAdapter {
  readonly id: CloudAsrProviderId;
  readonly requiredEnvironment: readonly string[];
  readonly recommendedFrameMs: readonly number[];
  connect(
    options: CloudAsrConnectOptions,
    emit: (event: CloudAsrEvent) => void,
  ): Promise<CloudAsrSession>;
}

export interface CloudAsrBenchmarkConfig {
  readonly name: string;
  readonly provider: CloudAsrProviderId;
  readonly input: string;
  readonly reference?: string;
  readonly referenceText?: string;
  readonly outputDirectory: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly frameMs: number;
  readonly language?: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
}
