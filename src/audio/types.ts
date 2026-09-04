export type AudioSourceId = string;
export type AudioSourceKind = "system" | "microphone" | "remote";
export type AudioSourceIcon = "monitor" | "microphone" | "headphones" | "radio" | "globe" | "video";

export interface SystemProcessSelection {
  readonly pid: number;
  readonly name: string;
  readonly executablePath?: string;
}

export type AudioCaptureSelection =
  | {
      readonly kind: "system";
      readonly allSystemAudio: boolean;
      readonly processes: readonly SystemProcessSelection[];
    }
  | {
      readonly kind: "microphone";
      readonly deviceIds: readonly string[];
    }
  | {
      readonly kind: "remote";
      readonly token: string;
    };

export interface AudioSourceDefinition {
  readonly id: AudioSourceId;
  readonly name: string;
  readonly icon: AudioSourceIcon;
  readonly capture: AudioCaptureSelection;
  readonly builtIn?: boolean;
}

export interface PcmFrame {
  readonly sourceId: AudioSourceId;
  readonly sequence: number;
  readonly capturedAt: number;
  readonly sampleRate: number;
  readonly samples: Float32Array;
}
