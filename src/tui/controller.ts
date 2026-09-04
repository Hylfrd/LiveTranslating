export type TuiSourceId = "system" | "microphone";

export type TuiSourcePhase =
  | "disabled"
  | "starting"
  | "listening"
  | "paused"
  | "error";

export interface TuiAudioDevice {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean;
}

export interface TuiSourceState {
  readonly id: TuiSourceId;
  readonly label: string;
  readonly enabled: boolean;
  readonly phase: TuiSourcePhase;
  readonly deviceId?: string;
  readonly deviceLabel?: string;
  readonly level?: number;
  readonly latencyMs?: number;
  readonly droppedFrames?: number;
  readonly error?: string;
}

export interface TuiLanguage {
  readonly code: string;
  readonly label: string;
}

export type TuiTranslationModel = "deepseek-v4-flash" | "hy-mt2-plus" | "hy-mt2-pro";

export interface TuiSubtitleEntry {
  readonly id: string;
  readonly sourceId: TuiSourceId;
  readonly timestamp: string;
  readonly sourceText: string;
  readonly translation: string;
  readonly revisedTranslation?: string;
  readonly isFinal: boolean;
}

export interface TuiSubtitleParagraph {
  readonly id: string;
  readonly sourceId: TuiSourceId;
  readonly timestamp: string;
  readonly sentences: readonly TuiSubtitleEntry[];
}

export type TuiLogLevel = "debug" | "info" | "warn" | "error";

export interface TuiLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly level: TuiLogLevel;
  readonly source?: string;
  readonly message: string;
}

export interface TuiSnapshot {
  readonly running: boolean;
  readonly transitioning?: boolean;
  readonly sources: Readonly<Record<TuiSourceId, TuiSourceState>>;
  readonly microphoneDevices: readonly TuiAudioDevice[];
  readonly sourceLanguages: readonly TuiLanguage[];
  readonly targetLanguages: readonly TuiLanguage[];
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly model: TuiTranslationModel;
  readonly recording: boolean;
  readonly reviewerEnabled: boolean;
  readonly reviewQueueSize?: number;
  readonly subtitles: readonly TuiSubtitleEntry[];
  readonly paragraphs?: Readonly<Record<TuiSourceId, readonly TuiSubtitleParagraph[]>>;
  readonly logs: readonly TuiLogEntry[];
}

export type TuiUnsubscribe = () => void;
export type TuiActionResult = void | Promise<void>;

/**
 * Backend boundary consumed by the terminal UI. Implementations own all state,
 * serialization, logging, and error recovery; the TUI only dispatches intent.
 */
export interface TuiController {
  getSnapshot(): TuiSnapshot;
  subscribe(listener: (snapshot: TuiSnapshot) => void): TuiUnsubscribe;

  toggleRunning(): TuiActionResult;
  toggleSource(sourceId: TuiSourceId): TuiActionResult;
  cycleMicrophoneDevice(direction?: 1 | -1): TuiActionResult;
  cycleSourceLanguage(direction?: 1 | -1): TuiActionResult;
  cycleTargetLanguage(direction?: 1 | -1): TuiActionResult;
  cycleModel(direction?: 1 | -1): TuiActionResult;
  toggleRecording(): TuiActionResult;
  toggleReviewer(): TuiActionResult;
  shutdown(): TuiActionResult;
}

export function getLanguageLabel(
  languages: readonly TuiLanguage[],
  code: string,
): string {
  return languages.find((language) => language.code === code)?.label ?? code;
}
