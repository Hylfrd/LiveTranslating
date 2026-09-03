export type AudioSourceId = "system" | "microphone";

export interface PcmFrame {
  readonly sourceId: AudioSourceId;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly sampleRate: number;
  readonly samples: Float32Array;
}
