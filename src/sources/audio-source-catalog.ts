import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import psList from "ps-list";
import type { AudioDevice } from "native-audio-node";
import type { AppLogger } from "../logging/app-logger.js";

export interface SystemAudioApplication {
  readonly id: string;
  readonly name: string;
  readonly executablePath: string;
  readonly processIds: readonly number[];
  readonly active: boolean;
}

interface MixerSession {
  readonly name: string;
  readonly appName: string;
  readonly state: number;
}

interface MixerDevice {
  readonly type: number;
  readonly sessions: readonly MixerSession[];
}

interface MixerModule {
  readonly AudioSessionState: { readonly ACTIVE: number };
  readonly DeviceType: { readonly RENDER: number };
  readonly default: {
    getDefaultDevice(type: number): MixerDevice | undefined;
  };
}

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

interface WindowsAudioSession {
  readonly processId: number;
  readonly state: number;
  readonly displayName: string;
  readonly processName: string;
  readonly executablePath: string;
  readonly fileDescription: string;
  readonly windowTitle: string;
}

export async function listSystemAudioApplications(logger?: AppLogger): Promise<SystemAudioApplication[]> {
  if (process.platform !== "win32" || process.env.CI === "true") {
    return [];
  }
  try {
    const sessions = await listWindowsAudioSessions();
    logger?.debug(
      `Windows Core Audio returned ${sessions.length} session(s)`,
      "audio",
      { sessions },
      "audio.sessions.enumerated",
    );
    const applications = applicationsFromWindowsSessions(sessions, process.execPath);
    if (applications.length > 0 || sessions.length > 0) {
      return applications;
    }
  } catch (error) {
    logger?.warn(
      `Windows Core Audio session probe failed: ${error instanceof Error ? error.message : String(error)}`,
      "audio",
      { error },
      "audio.sessions.probe_failed",
    );
  }

  try {
    const processes = await psList();
    const ownProcessIds = collectProcessTree(processes, process.pid);
    const mixerModule = require("native-sound-mixer") as MixerModule;
    const renderDevice = mixerModule.default.getDefaultDevice(mixerModule.DeviceType.RENDER);
    const sessions = renderDevice?.sessions ?? [];
    const processNames = new Map<string, typeof processes>();
    for (const processInfo of processes) {
      const key = processInfo.name.toLocaleLowerCase("en");
      processNames.set(key, [...(processNames.get(key) ?? []), processInfo]);
    }
    const applications = new Map<string, SystemAudioApplication>();
    for (const session of sessions) {
      if (!session.appName) continue;
      const executableName = path.basename(session.appName).toLocaleLowerCase("en");
      const matching = processNames.get(executableName) ?? [];
      const matchingIds = new Set(matching.map((item) => item.pid));
      const roots = matching.filter((item) => !matchingIds.has(item.ppid));
      const processIds = (roots.length > 0 ? roots : matching)
        .map((item) => item.pid)
        .filter((pid) => !ownProcessIds.has(pid));
      if (processIds.length === 0) continue;
      const key = session.appName.toLocaleLowerCase("en");
      const existing = applications.get(key);
      applications.set(key, {
        id: key,
        name: session.name || path.basename(session.appName, path.extname(session.appName)),
        executablePath: session.appName,
        processIds: [...new Set([...(existing?.processIds ?? []), ...processIds])],
        active: Boolean(existing?.active || session.state === mixerModule.AudioSessionState.ACTIVE),
      });
    }
    return [...applications.values()].sort((left, right) =>
      Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  } catch (error) {
    logger?.warn(
      `Native sound mixer fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      "audio",
      { error },
      "audio.sessions.fallback_failed",
    );
    return [];
  }
}

async function listWindowsAudioSessions(): Promise<WindowsAudioSession[]> {
  const scriptUrl = new URL("../../assets/windows-audio-sessions.ps1", import.meta.url);
  const script = await readFile(scriptUrl, "utf8");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 8_000, windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.filter(isWindowsAudioSession);
}

function isWindowsAudioSession(value: unknown): value is WindowsAudioSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WindowsAudioSession>;
  return Number.isInteger(candidate.processId)
    && typeof candidate.state === "number"
    && typeof candidate.displayName === "string"
    && typeof candidate.processName === "string"
    && typeof candidate.executablePath === "string"
    && typeof candidate.fileDescription === "string"
    && typeof candidate.windowTitle === "string";
}

function applicationsFromWindowsSessions(
  sessions: readonly WindowsAudioSession[],
  ownExecutablePath: string,
): SystemAudioApplication[] {
  const applications = new Map<string, SystemAudioApplication>();
  const normalizedOwnPath = path.resolve(ownExecutablePath).toLocaleLowerCase("en");
  for (const session of sessions) {
    if (session.processId <= 0 || session.processId === process.pid) continue;
    if (
      session.executablePath
      && path.resolve(session.executablePath).toLocaleLowerCase("en") === normalizedOwnPath
    ) continue;
    const executablePath = session.executablePath || session.processName;
    if (!executablePath) continue;
    const key = executablePath.toLocaleLowerCase("en");
    const existing = applications.get(key);
    const processName = session.processName || path.basename(executablePath);
    applications.set(key, {
      id: key,
      name: session.fileDescription
        || session.windowTitle
        || session.displayName
        || path.basename(processName, path.extname(processName)),
      executablePath,
      processIds: [...new Set([...(existing?.processIds ?? []), session.processId])],
      active: Boolean(existing?.active || session.state === 1),
    });
  }
  return [...applications.values()].sort((left, right) =>
    Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
}

function collectProcessTree(
  processes: readonly { readonly pid: number; readonly ppid: number }[],
  rootPid: number,
): Set<number> {
  const result = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (!result.has(processInfo.pid) && result.has(processInfo.ppid)) {
        result.add(processInfo.pid);
        changed = true;
      }
    }
  }
  return result;
}

export function summarizeMicrophoneDevices(
  devices: readonly AudioDevice[],
  deviceIds: readonly string[],
): string {
  const names = deviceIds
    .map((id) => devices.find((device) => device.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return "未选择麦克风";
  if (names.length === 1) return names[0] ?? "麦克风";
  return `${names[0] ?? "麦克风"} 等 ${names.length} 个设备`;
}
