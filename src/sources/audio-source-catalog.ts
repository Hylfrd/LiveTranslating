import { createRequire } from "node:module";
import path from "node:path";

import psList from "ps-list";
import type { AudioDevice } from "native-audio-node";

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

export async function listSystemAudioApplications(): Promise<SystemAudioApplication[]> {
  if (process.platform !== "win32" || process.env.CI === "true") {
    return [];
  }
  try {
    const mixerModule = require("native-sound-mixer") as MixerModule;
    const renderDevice = mixerModule.default.getDefaultDevice(mixerModule.DeviceType.RENDER);
    const sessions = renderDevice?.sessions ?? [];
    const processes = await psList();
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
      const processIds = (roots.length > 0 ? roots : matching).map((item) => item.pid);
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
  } catch {
    return [];
  }
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
