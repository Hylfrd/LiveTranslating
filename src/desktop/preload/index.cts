import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopActionName,
  DesktopActionPayload,
  DesktopActionRequest,
  DesktopBridge,
  DesktopWindowCommand,
} from "./contract.js";
import type { TuiSnapshot } from "../../tui/controller.js";

const SNAPSHOT_GET_CHANNEL = "live-translating:snapshot:get";
const SNAPSHOT_UPDATED_CHANNEL = "live-translating:snapshot:updated";
const ACTION_CHANNEL = "live-translating:controller:action";
const WINDOW_CHANNEL = "live-translating:window:control";

const getSnapshot = (): Promise<TuiSnapshot> => ipcRenderer.invoke(SNAPSHOT_GET_CHANNEL);

const onSnapshot = (listener: (snapshot: TuiSnapshot) => void): (() => void) => {
  if (typeof listener !== "function") {
    throw new TypeError("Snapshot listener must be a function");
  }
  const handler = (_event: Electron.IpcRendererEvent, snapshot: TuiSnapshot): void => {
    listener(snapshot);
  };
  ipcRenderer.on(SNAPSHOT_UPDATED_CHANNEL, handler);
  return () => ipcRenderer.removeListener(SNAPSHOT_UPDATED_CHANNEL, handler);
};

const action = (
  name: DesktopActionName,
  payload?: DesktopActionPayload,
): Promise<TuiSnapshot> => ipcRenderer.invoke(
  ACTION_CHANNEL,
  payload === undefined ? { name } : { name, payload },
);

const windowControl = (command: DesktopWindowCommand): Promise<void> =>
  ipcRenderer.invoke(WINDOW_CHANNEL, command);

const bridge: DesktopBridge = Object.freeze({
  getSnapshot,
  onSnapshot,
  action,
  windowControl,
  invoke: (request: DesktopActionRequest) => action(request.name, request.payload),
  subscribe: onSnapshot,
  window: Object.freeze({
    minimize: () => windowControl("minimize"),
    close: () => windowControl("close"),
    expand: () => windowControl("expand-overlay"),
    openCompact: () => windowControl("open-overlay"),
  }),
});

contextBridge.exposeInMainWorld("liveTranslating", bridge);
