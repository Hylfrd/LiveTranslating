import type {
  TuiSnapshot,
  TuiSourceId,
  TuiTranslationModel,
} from "../../tui/controller.js";

export type DesktopSnapshot = TuiSnapshot;

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

export type WindowControlCommand =
  | "open-overlay"
  | "expand-overlay"
  | "minimize"
  | "close";

export interface LiveTranslatingBridge {
  getSnapshot(): Promise<DesktopSnapshot>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
  action(name: DesktopActionName, payload?: DesktopActionPayload): Promise<DesktopSnapshot>;
  windowControl(command: WindowControlCommand): Promise<void>;
}

declare global {
  interface Window {
    readonly liveTranslating?: LiveTranslatingBridge;
  }
}

export {};
