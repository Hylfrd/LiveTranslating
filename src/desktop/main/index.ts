import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";

import type { ApplicationController } from "../../app/application-controller.js";
import type { TuiSnapshot } from "../../tui/controller.js";
import type { DesktopWindowCommand } from "../preload/contract.js";
import { dispatchControllerAction } from "./controller-actions.js";

const SNAPSHOT_GET_CHANNEL = "live-translating:snapshot:get";
const SNAPSHOT_UPDATED_CHANNEL = "live-translating:snapshot:updated";
const ACTION_CHANNEL = "live-translating:controller:action";
const WINDOW_CHANNEL = "live-translating:window:control";
const WINDOW_COMMANDS = new Set<DesktopWindowCommand>([
  "open-overlay",
  "expand-overlay",
  "minimize",
  "close",
]);

type Surface = "main" | "compact";

let controller: ApplicationController | undefined;
let mainWindow: BrowserWindow | undefined;
let compactWindow: BrowserWindow | undefined;
let unsubscribeSnapshots: (() => void) | undefined;
let actionTail: Promise<void> = Promise.resolve();
let pendingSnapshot: TuiSnapshot | undefined;
let snapshotTimer: NodeJS.Timeout | undefined;
let quitPromise: Promise<void> | undefined;
let shutdownRequested = false;
let quitting = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => expandOverlay());
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });
  app.on("activate", () => expandOverlay());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void requestQuit();
    }
  });

  void app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error("LiveTranslating desktop failed to start", error);
    void requestQuit();
  });
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("com.hylfrd.live-translating");
  const rootDirectory = resolveRuntimeRoot();
  loadEnvironment(app.isPackaged ? path.dirname(process.execPath) : rootDirectory);

  const module = await import("../../app/application-controller.js");
  controller = await module.createApplicationController(rootDirectory);

  registerIpcHandlers();
  createWindows();
  unsubscribeSnapshots = controller.subscribe(scheduleSnapshotBroadcast);

  await Promise.all([
    loadSurface(mainWindow as BrowserWindow, "main"),
    loadSurface(compactWindow as BrowserWindow, "compact"),
  ]);
}

function createWindows(): void {
  const preload = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
  const icon = resolveWindowIcon();
  const sharedWebPreferences = {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  } as const;

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: true,
    backgroundColor: "#f7f8fa",
    autoHideMenuBar: true,
    skipTaskbar: false,
    title: "同传席",
    ...(icon ? { icon } : {}),
    webPreferences: sharedWebPreferences,
  });

  compactWindow = new BrowserWindow({
    width: 760,
    height: 320,
    minWidth: 520,
    minHeight: 180,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    skipTaskbar: false,
    title: "同传席 - 字幕",
    ...(icon ? { icon } : {}),
    webPreferences: sharedWebPreferences,
  });

  secureWindow(mainWindow);
  secureWindow(compactWindow);

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  compactWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hideCompactAndKeepTaskbar();
    }
  });
  compactWindow.on("closed", () => {
    compactWindow = undefined;
  });

  for (const window of managedWindows()) {
    window.webContents.on("did-finish-load", () => {
      if (controller && !window.isDestroyed()) {
        window.webContents.send(SNAPSHOT_UPDATED_CHANNEL, controller.getSnapshot());
      }
    });
  }
}

function secureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

async function loadSurface(window: BrowserWindow, surface: Surface): Promise<void> {
  const developmentUrl = process.env.VITE_DEV_SERVER_URL
    ?? process.env.ELECTRON_RENDERER_URL
    ?? process.env.LIVE_TRANSLATING_RENDERER_URL;

  if (developmentUrl) {
    const url = new URL(developmentUrl);
    url.searchParams.set("surface", surface);
    await window.loadURL(url.toString());
    return;
  }

  const rendererEntry = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
  await window.loadFile(rendererEntry, { query: { surface } });
}

function registerIpcHandlers(): void {
  ipcMain.handle(SNAPSHOT_GET_CHANNEL, (event) => {
    assertTrustedSender(event);
    return requireController().getSnapshot();
  });

  ipcMain.handle(ACTION_CHANNEL, (event, request: unknown) => {
    assertTrustedSender(event);
    return enqueueControllerAction(() => dispatchControllerAction(requireController(), request));
  });

  ipcMain.handle(WINDOW_CHANNEL, async (event, rawCommand: unknown) => {
    const senderWindow = assertTrustedSender(event);
    if (typeof rawCommand !== "string" || !WINDOW_COMMANDS.has(rawCommand as DesktopWindowCommand)) {
      throw new TypeError("Unsupported desktop window command");
    }
    await controlWindow(senderWindow, rawCommand as DesktopWindowCommand);
  });
}

function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(SNAPSHOT_GET_CHANNEL);
  ipcMain.removeHandler(ACTION_CHANNEL);
  ipcMain.removeHandler(WINDOW_CHANNEL);
}

function enqueueControllerAction(task: () => Promise<TuiSnapshot>): Promise<TuiSnapshot> {
  const run = (): Promise<TuiSnapshot> => {
    if (shutdownRequested) {
      return Promise.reject(new Error("Application is shutting down"));
    }
    return task();
  };
  const result = actionTail.then(run, run);
  actionTail = result.then(() => undefined, () => undefined);
  return result;
}

async function controlWindow(sender: BrowserWindow, command: DesktopWindowCommand): Promise<void> {
  switch (command) {
    case "open-overlay":
      openOverlay();
      break;
    case "expand-overlay":
      expandOverlay();
      break;
    case "minimize":
      sender.minimize();
      break;
    case "close":
      if (sender === compactWindow) {
        hideCompactAndKeepTaskbar();
      } else {
        await requestQuit();
      }
      break;
  }
}

function openOverlay(): void {
  if (!compactWindow || compactWindow.isDestroyed()) {
    return;
  }
  if (compactWindow.isMinimized()) {
    compactWindow.restore();
  }
  compactWindow.show();
  compactWindow.focus();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    mainWindow.minimize();
  }
}

function expandOverlay(): void {
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.hide();
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function hideCompactAndKeepTaskbar(): void {
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    mainWindow.minimize();
  }
}

function scheduleSnapshotBroadcast(snapshot: TuiSnapshot): void {
  pendingSnapshot = snapshot;
  if (snapshotTimer) {
    return;
  }
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined;
    const latest = pendingSnapshot;
    pendingSnapshot = undefined;
    if (latest) {
      broadcastSnapshot(latest);
    }
  }, 50);
  snapshotTimer.unref();
}

function broadcastSnapshot(snapshot: TuiSnapshot): void {
  for (const window of managedWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(SNAPSHOT_UPDATED_CHANNEL, snapshot);
    }
  }
}

function managedWindows(): BrowserWindow[] {
  return [mainWindow, compactWindow].filter(
    (window): window is BrowserWindow => window !== undefined && !window.isDestroyed(),
  );
}

function assertTrustedSender(event: IpcMainInvokeEvent): BrowserWindow {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || !managedWindows().includes(senderWindow)) {
    throw new Error("Rejected IPC from an unmanaged window");
  }
  return senderWindow;
}

function requireController(): ApplicationController {
  if (!controller) {
    throw new Error("Application controller is not ready");
  }
  return controller;
}

function resolveRuntimeRoot(): string {
  return app.isPackaged ? app.getPath("userData") : process.cwd();
}

function loadEnvironment(rootDirectory: string): void {
  const environmentFile = path.join(rootDirectory, ".env");
  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}

function resolveWindowIcon(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(app.getAppPath(), "assets", "icon.ico"),
    path.join(app.getAppPath(), "build", "icon.ico"),
    ...(resourcesPath ? [path.join(resourcesPath, "icon.ico")] : []),
    path.join(process.cwd(), "assets", "icon.ico"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function requestQuit(): Promise<void> {
  if (quitPromise) {
    return quitPromise;
  }
  shutdownRequested = true;
  quitPromise = (async () => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
      pendingSnapshot = undefined;
    }
    unsubscribeSnapshots?.();
    unsubscribeSnapshots = undefined;
    await controller?.shutdown();
    await actionTail.catch(() => undefined);
  })().catch((error: unknown) => {
    console.error("LiveTranslating desktop shutdown failed", error);
  }).finally(() => {
    unregisterIpcHandlers();
    quitting = true;
    app.quit();
  });
  return quitPromise;
}
