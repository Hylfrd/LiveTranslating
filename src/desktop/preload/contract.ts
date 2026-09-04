import type {
  TuiSnapshot,
  TuiReviewModel,
  TuiNewSourceInput,
  TuiSourceId,
  TuiTranslationModel,
} from "../../tui/controller.js";

export type DesktopActionName =
  | "toggle-running"
  | "set-running"
  | "start-session"
  | "pause-session"
  | "resume-session"
  | "stop-session"
  | "toggle-source"
  | "set-source-enabled"
  | "cycle-microphone"
  | "cycle-source-language"
  | "cycle-target-language"
  | "cycle-model"
  | "set-microphone"
  | "set-source-language"
  | "set-target-language"
  | "set-model"
  | "toggle-reviewer"
  | "set-reviewer"
  | "set-secondary-translation"
  | "set-terminology-review"
  | "set-terminology-review-model"
  | "test-models"
  | "set-archive-name"
  | "rename-archive"
  | "refresh-pricing"
  | "dismiss-notification"
  | "add-source"
  | "refresh-source-catalog";

export type DesktopActionPayload =
  | { readonly sourceId: TuiSourceId }
  | { readonly sourceId: TuiSourceId; readonly enabled: boolean }
  | { readonly sourceId: TuiSourceId; readonly name: string }
  | { readonly enabled: boolean }
  | { readonly direction?: 1 | -1 }
  | { readonly deviceId: string }
  | { readonly language: string }
  | { readonly model: TuiTranslationModel }
  | { readonly reviewModel: TuiReviewModel }
  | { readonly name: string }
  | { readonly notificationId: string }
  | { readonly archiveName: string; readonly nextName: string }
  | { readonly source: TuiNewSourceInput };

export type DesktopExportKind = "audio" | "transcription" | "translation";

export interface DesktopExportResult {
  readonly canceled: boolean;
  readonly kind: DesktopExportKind;
  readonly destination?: string;
}

export interface DesktopActionRequest {
  readonly name: DesktopActionName;
  readonly payload?: DesktopActionPayload;
}

export type DesktopArchiveOperation = "open-root" | "open" | "show-in-folder" | "delete";

export interface DesktopArchiveRequest {
  readonly operation: DesktopArchiveOperation;
  readonly archiveName?: string;
  readonly kind?: DesktopExportKind;
}

export type DesktopWindowCommand =
  | "open-overlay"
  | "open-logs"
  | "expand-overlay"
  | "minimize"
  | "close";

export interface DesktopBridge {
  getSnapshot(): Promise<TuiSnapshot>;
  onSnapshot(listener: (snapshot: TuiSnapshot) => void): () => void;
  action(name: DesktopActionName, payload?: DesktopActionPayload): Promise<TuiSnapshot>;
  windowControl(command: DesktopWindowCommand): Promise<void>;
  exportArchive(sourceId: TuiSourceId, kind: DesktopExportKind): Promise<DesktopExportResult>;
  manageArchive(request: DesktopArchiveRequest): Promise<TuiSnapshot>;

  /** Compatibility aliases for early renderer prototypes. */
  invoke(request: DesktopActionRequest): Promise<TuiSnapshot>;
  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void;
  window: {
    minimize(): Promise<void>;
    close(): Promise<void>;
    expand(): Promise<void>;
    openCompact(): Promise<void>;
  };
}
