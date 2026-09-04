import type {
  TuiSnapshot,
  TuiSourceId,
  TuiTranslationModel,
} from "../../tui/controller.js";

export type DesktopActionName =
  | "toggle-running"
  | "set-running"
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
  | "toggle-recording"
  | "set-recording"
  | "toggle-reviewer"
  | "set-reviewer";

export type DesktopActionPayload =
  | { readonly sourceId: TuiSourceId }
  | { readonly sourceId: TuiSourceId; readonly enabled: boolean }
  | { readonly enabled: boolean }
  | { readonly direction?: 1 | -1 }
  | { readonly deviceId: string }
  | { readonly language: string }
  | { readonly model: TuiTranslationModel };

export interface DesktopActionRequest {
  readonly name: DesktopActionName;
  readonly payload?: DesktopActionPayload;
}

export type DesktopWindowCommand =
  | "open-overlay"
  | "expand-overlay"
  | "minimize"
  | "close";

export interface DesktopBridge {
  getSnapshot(): Promise<TuiSnapshot>;
  onSnapshot(listener: (snapshot: TuiSnapshot) => void): () => void;
  action(name: DesktopActionName, payload?: DesktopActionPayload): Promise<TuiSnapshot>;
  windowControl(command: DesktopWindowCommand): Promise<void>;

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
