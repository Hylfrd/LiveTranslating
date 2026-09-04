import type { BillingSnapshot } from "../billing/types.js";
import type {
  AudioSourceIcon,
  AudioSourceKind,
  SystemProcessSelection,
} from "../audio/types.js";

export type TuiSourceId = string;
export type TuiSessionPhase = "idle" | "recording" | "paused" | "saving";

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
  readonly kind: AudioSourceKind;
  readonly icon: AudioSourceIcon;
  readonly selectionLabel: string;
  readonly enabled: boolean;
  readonly phase: TuiSourcePhase;
  readonly deviceId?: string;
  readonly deviceLabel?: string;
  readonly level?: number;
  readonly latencyMs?: number;
  readonly droppedFrames?: number;
  readonly error?: string;
  readonly remoteUrls?: readonly string[];
  readonly remoteSecure?: boolean;
  readonly remoteNotice?: string;
}

export interface TuiSystemAudioApplication {
  readonly id: string;
  readonly name: string;
  readonly executablePath: string;
  readonly processIds: readonly number[];
  readonly active: boolean;
}

export interface TuiNewSourceInput {
  readonly name: string;
  readonly icon: AudioSourceIcon;
  readonly capture:
    | {
        readonly kind: "system";
        readonly allSystemAudio: boolean;
        readonly processes: readonly SystemProcessSelection[];
      }
    | {
        readonly kind: "microphone";
        readonly deviceIds: readonly string[];
      }
    | { readonly kind: "remote" };
}

export interface TuiLanguage {
  readonly code: string;
  readonly label: string;
}

export type TuiTranslationModel = "hy-mt2-plus" | "hy-mt2-pro";
export type TuiReviewModel = "deepseek-v4-flash" | "deepseek-v4-pro";

export interface TuiSubtitleEntry {
  readonly id: string;
  readonly sourceId: TuiSourceId;
  readonly timestamp: string;
  readonly sourceText: string;
  readonly translation: string;
  readonly revisedTranslation?: string;
  readonly translationOmitted?: boolean;
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

export interface TuiArchivedSession {
  readonly sourceId: TuiSourceId;
  readonly name: string;
  readonly savedAt: string;
  readonly audioDirectory: string;
  readonly transcriptionPath: string;
  readonly translationPath: string;
}

export interface TuiArchivedBundle {
  readonly name: string;
  readonly savedAt: string;
  readonly sourceId?: TuiSourceId;
  readonly sourceName?: string;
  readonly audioAvailable: boolean;
  readonly audioTrackCount: number;
  readonly transcriptionAvailable: boolean;
  readonly translationAvailable: boolean;
}

export interface TuiArchiveState {
  readonly rootDirectory: string;
  readonly currentName: string;
  readonly lastSaved?: TuiArchivedSession;
}

export interface TuiSourceSessionState {
  readonly phase: TuiSessionPhase;
  readonly recording: boolean;
  readonly archive: TuiArchiveState;
}

export interface TuiNotification {
  readonly id: string;
  readonly kind: "success" | "info" | "error";
  readonly message: string;
}

export interface TuiModelHealth {
  readonly model: "hy-mt2-plus" | "hy-mt2-pro" | "deepseek-v4-flash" | "deepseek-v4-pro";
  readonly status: "idle" | "testing" | "available" | "unavailable" | "not-configured";
  readonly latencyMs?: number;
  readonly checkedAt?: string;
  readonly error?: string;
}

export interface TuiSnapshot {
  readonly running: boolean;
  readonly sessionPhase: TuiSessionPhase;
  readonly transitioning?: boolean;
  readonly sources: Readonly<Record<TuiSourceId, TuiSourceState>>;
  readonly sourceOrder: readonly TuiSourceId[];
  readonly microphoneDevices: readonly TuiAudioDevice[];
  readonly systemAudioApplications: readonly TuiSystemAudioApplication[];
  readonly sourceLanguages: readonly TuiLanguage[];
  readonly targetLanguages: readonly TuiLanguage[];
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly model: TuiTranslationModel;
  readonly recording: boolean;
  readonly sessions: Readonly<Record<TuiSourceId, TuiSourceSessionState>>;
  readonly archives: readonly TuiArchivedBundle[];
  readonly billing: BillingSnapshot;
  readonly notifications: readonly TuiNotification[];
  readonly reviewerEnabled: boolean;
  readonly secondaryTranslationEnabled: boolean;
  readonly terminologyReviewEnabled: boolean;
  readonly terminologyReviewModel: TuiReviewModel;
  readonly reviewQueueSize?: number;
  readonly modelHealth: readonly TuiModelHealth[];
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
  startSession(sourceId: TuiSourceId): TuiActionResult;
  pauseSession(sourceId: TuiSourceId): TuiActionResult;
  resumeSession(sourceId: TuiSourceId): TuiActionResult;
  stopSession(sourceId: TuiSourceId): TuiActionResult;
  toggleSource(sourceId: TuiSourceId): TuiActionResult;
  cycleMicrophoneDevice(direction?: 1 | -1): TuiActionResult;
  cycleSourceLanguage(direction?: 1 | -1): TuiActionResult;
  cycleTargetLanguage(direction?: 1 | -1): TuiActionResult;
  cycleModel(direction?: 1 | -1): TuiActionResult;
  toggleReviewer(): TuiActionResult;
  toggleSecondaryTranslation(): TuiActionResult;
  toggleTerminologyReview(): TuiActionResult;
  cycleTerminologyReviewModel(direction?: 1 | -1): TuiActionResult;
  testModels(): TuiActionResult;
  setArchiveName(sourceId: TuiSourceId, name: string): TuiActionResult;
  renameArchive(currentName: string, nextName: string): TuiActionResult;
  refreshArchives(): TuiActionResult;
  refreshPricing(): TuiActionResult;
  dismissNotification(id: string): TuiActionResult;
  addSource(input: TuiNewSourceInput): TuiActionResult;
  refreshSourceCatalog(): TuiActionResult;
  shutdown(): TuiActionResult;
}

export function getLanguageLabel(
  languages: readonly TuiLanguage[],
  code: string,
): string {
  return languages.find((language) => language.code === code)?.label ?? code;
}
