import { existsSync } from "node:fs";
import { copyFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from "electron";

import type { ApplicationController } from "../../app/application-controller.js";
import type { AudioSourceId } from "../../audio/types.js";
import type { TuiSnapshot } from "../../tui/controller.js";
import type {
  DesktopExportKind,
  DesktopExportResult,
  DesktopArchiveRequest,
  DesktopWindowCommand,
} from "../preload/contract.js";
import { dispatchControllerAction } from "./controller-actions.js";
import { resolveRuntimeRoot } from "./runtime-root.js";

const SNAPSHOT_GET_CHANNEL = "live-translating:snapshot:get";
const SNAPSHOT_UPDATED_CHANNEL = "live-translating:snapshot:updated";
const ACTION_CHANNEL = "live-translating:controller:action";
const WINDOW_CHANNEL = "live-translating:window:control";
const EXPORT_CHANNEL = "live-translating:archive:export";
const ARCHIVE_MANAGE_CHANNEL = "live-translating:archive:manage";
const WINDOW_COMMANDS = new Set<DesktopWindowCommand>([
  "open-overlay",
  "open-logs",
  "open-log-folder",
  "expand-overlay",
  "minimize",
  "close",
]);
const EXPORT_KINDS = new Set<DesktopExportKind>(["audio", "transcription", "translation"]);
const ARCHIVE_OPERATIONS = new Set(["open-root", "open", "show-in-folder", "delete"] as const);

type Surface = "main" | "compact" | "logs";

let controller: ApplicationController | undefined;
let mainWindow: BrowserWindow | undefined;
let compactWindow: BrowserWindow | undefined;
let logWindow: BrowserWindow | undefined;
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
  const rootDirectory = resolveRuntimeRoot({
    isPackaged: app.isPackaged,
    cwd: process.cwd(),
    execPath: process.execPath,
    environment: process.env,
  });
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
    title: "LiveTranslating",
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
    title: "LiveTranslating - 字幕",
    ...(icon ? { icon } : {}),
    webPreferences: sharedWebPreferences,
  });

  secureWindow(mainWindow);
  secureWindow(compactWindow);
  positionCompactWindow();

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

  for (const window of managedWindows()) bindSnapshotWindow(window);
}

function bindSnapshotWindow(window: BrowserWindow): void {
  window.webContents.on("did-finish-load", () => {
    if (controller && !window.isDestroyed()) {
      window.webContents.send(SNAPSHOT_UPDATED_CHANNEL, controller.getSnapshot());
    }
  });
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

  ipcMain.handle(EXPORT_CHANNEL, async (event, rawRequest: unknown): Promise<DesktopExportResult> => {
    const senderWindow = assertTrustedSender(event);
    if (senderWindow !== mainWindow) {
      throw new Error("Archive export is available only in the main window");
    }
    if (
      !isRecord(rawRequest)
      || typeof rawRequest.sourceId !== "string"
      || !requireController().getSnapshot().sources[rawRequest.sourceId]
      || typeof rawRequest.kind !== "string"
      || !EXPORT_KINDS.has(rawRequest.kind as DesktopExportKind)
    ) {
      throw new TypeError("Unsupported archive export kind");
    }
    return exportArchive(
      senderWindow,
      rawRequest.sourceId,
      rawRequest.kind as DesktopExportKind,
    );
  });

  ipcMain.handle(ARCHIVE_MANAGE_CHANNEL, (event, rawRequest: unknown) => {
    const senderWindow = assertTrustedSender(event);
    if (senderWindow !== mainWindow) {
      throw new Error("Archive management is available only in the main window");
    }
    return enqueueControllerAction(() => manageArchive(senderWindow, rawRequest));
  });
}

function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(SNAPSHOT_GET_CHANNEL);
  ipcMain.removeHandler(ACTION_CHANNEL);
  ipcMain.removeHandler(WINDOW_CHANNEL);
  ipcMain.removeHandler(EXPORT_CHANNEL);
  ipcMain.removeHandler(ARCHIVE_MANAGE_CHANNEL);
}

async function manageArchive(owner: BrowserWindow, rawRequest: unknown): Promise<TuiSnapshot> {
  if (!isRecord(rawRequest) || typeof rawRequest.operation !== "string"
    || !ARCHIVE_OPERATIONS.has(rawRequest.operation as DesktopArchiveRequest["operation"])) {
    throw new TypeError("Unsupported archive operation");
  }
  const operation = rawRequest.operation as DesktopArchiveRequest["operation"];
  const activeController = requireController();
  if (operation === "open-root") {
    await openExternalPath(activeController.archiveRootDirectory());
    return activeController.getSnapshot();
  }
  if (typeof rawRequest.archiveName !== "string" || !activeController.archiveExists(rawRequest.archiveName)) {
    throw new TypeError("Archive operation requires a known archive name");
  }
  const archiveName = rawRequest.archiveName;
  if (operation === "delete") {
    const confirmation = await dialog.showMessageBox(owner, {
      type: "warning",
      title: "删除归档",
      message: `将“${archiveName}”移到回收站？`,
      detail: "录音、原文稿和双语译稿会作为一组删除，可以从 Windows 回收站恢复。",
      buttons: ["取消", "移到回收站"],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    });
    if (confirmation.response === 1) {
      const results = await Promise.allSettled(
        activeController.archiveArtifactPaths(archiveName).map((artifact) => shell.trashItem(artifact)),
      );
      await activeController.refreshArchives();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason), "Some archive files could not be moved to the recycle bin");
      }
      activeController.notifyArchiveAction(`已将 ${archiveName} 移到回收站`);
    }
    return activeController.getSnapshot();
  }
  const requestedKind = typeof rawRequest.kind === "string" && EXPORT_KINDS.has(rawRequest.kind as DesktopExportKind)
    ? rawRequest.kind as DesktopExportKind
    : undefined;
  const descriptor = requestedKind
    ? activeController.archiveArtifactPath(archiveName, requestedKind)
    : (["audio", "translation", "transcription"] as const)
        .map((kind) => activeController.archiveArtifactPath(archiveName, kind))
        .find((item) => item !== undefined);
  if (!descriptor) throw new Error("Archive file is missing");
  if (operation === "show-in-folder") {
    shell.showItemInFolder(descriptor.path);
  } else {
    await openExternalPath(descriptor.path);
  }
  return activeController.getSnapshot();
}

async function openExternalPath(targetPath: string): Promise<void> {
  const error = await shell.openPath(targetPath);
  if (error) throw new Error(error);
}

async function exportArchive(
  owner: BrowserWindow,
  sourceId: AudioSourceId,
  kind: DesktopExportKind,
): Promise<DesktopExportResult> {
  const descriptor = requireController().archiveExportPath(sourceId, kind);
  if (!descriptor) {
    throw new Error("No completed session is available to export");
  }
  if (kind === "audio") {
    const selection = await dialog.showOpenDialog(owner, {
      title: "选择录音导出位置",
      buttonLabel: "导出录音",
      properties: ["openDirectory", "createDirectory"],
    });
    const parent = selection.filePaths[0];
    if (selection.canceled || !parent) {
      return { canceled: true, kind };
    }
    const destination = availableDirectory(path.join(parent, descriptor.name));
    await cp(descriptor.path, destination, { recursive: true, errorOnExist: true, force: false });
    requireController().notifyExport(destination);
    return { canceled: false, kind, destination };
  }
  const selection = await dialog.showSaveDialog(owner, {
    title: kind === "transcription" ? "导出纯文字稿" : "导出双语翻译稿",
    buttonLabel: "导出 Markdown",
    defaultPath: descriptor.name,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (selection.canceled || !selection.filePath) {
    return { canceled: true, kind };
  }
  await copyFile(descriptor.path, selection.filePath);
  requireController().notifyExport(selection.filePath);
  return { canceled: false, kind, destination: selection.filePath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function availableDirectory(requested: string): string {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? requested : `${requested}_${suffix}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
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
    case "open-logs":
      await openLogs();
      break;
    case "open-log-folder":
      await openExternalPath(requireController().logDirectory());
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

async function openLogs(): Promise<void> {
  if (!logWindow || logWindow.isDestroyed()) {
    const icon = resolveWindowIcon();
    logWindow = new BrowserWindow({
      width: 940,
      height: 660,
      minWidth: 720,
      minHeight: 480,
      show: false,
      frame: true,
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      skipTaskbar: false,
      title: "LiveTranslating - 运行日志",
      ...(icon ? { icon } : {}),
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    secureWindow(logWindow);
    bindSnapshotWindow(logWindow);
    logWindow.on("closed", () => { logWindow = undefined; });
    await loadSurface(logWindow, "logs");
  }
  if (logWindow.isMinimized()) logWindow.restore();
  logWindow.show();
  logWindow.focus();
}

function positionCompactWindow(): void {
  if (!compactWindow || compactWindow.isDestroyed()) return;
  const display = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const [width = 760] = compactWindow.getSize();
  compactWindow.setPosition(
    display.workArea.x + display.workArea.width - width - 16,
    display.workArea.y + 16,
  );
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
  return [mainWindow, compactWindow, logWindow].filter(
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
