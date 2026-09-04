import type { TuiSnapshot, TuiSourceId, TuiTranslationModel } from "../../tui/controller.js";
import type {
  DesktopActionName,
  DesktopActionPayload,
  LiveTranslatingBridge,
  WindowControlCommand,
} from "./types.js";

const sourceLanguages = [
  { code: "auto", label: "Auto detect" },
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
];
const targetLanguages = [
  { code: "zh", label: "Simplified Chinese" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
];
const models: readonly TuiTranslationModel[] = [
  "deepseek-v4-flash",
  "hy-mt2-plus",
  "hy-mt2-pro",
];

let snapshot: TuiSnapshot = {
  running: true,
  transitioning: false,
  sources: {
    system: {
      id: "system",
      label: "System audio",
      enabled: true,
      phase: "listening",
      level: 0.64,
      latencyMs: 2810,
      droppedFrames: 0,
      deviceLabel: "Default Windows output",
    },
    microphone: {
      id: "microphone",
      label: "Microphone",
      enabled: true,
      phase: "listening",
      level: 0.42,
      latencyMs: 3170,
      droppedFrames: 0,
      deviceId: "array",
      deviceLabel: "麦克风阵列（Intel Smart Sound）",
    },
  },
  microphoneDevices: [
    { id: "array", label: "麦克风阵列（Intel Smart Sound）", isDefault: true },
    { id: "headset", label: "HUAWEI USB-C HEADSET" },
  ],
  sourceLanguages,
  targetLanguages,
  sourceLanguage: "en",
  targetLanguage: "zh",
  model: "deepseek-v4-flash",
  recording: true,
  reviewerEnabled: true,
  reviewQueueSize: 1,
  subtitles: [
    {
      id: "1",
      sourceId: "system",
      timestamp: "10:24:15",
      sourceText: "The hypothesis is defined as h theta of x.",
      translation: "假设函数定义为 hθ(x)。",
      isFinal: true,
    },
    {
      id: "2",
      sourceId: "system",
      timestamp: "10:24:23",
      sourceText: "We use gradient descent to minimize the cross-entropy loss.",
      translation: "我们使用梯度下降最小化交叉熵损失。",
      isFinal: true,
    },
    {
      id: "3",
      sourceId: "microphone",
      timestamp: "10:24:31",
      sourceText: "This maps any real-valued score into a probability between zero and one.",
      translation: "它将任意实值分数映射为零到一之间的概率。",
      isFinal: true,
    },
    {
      id: "4",
      sourceId: "system",
      timestamp: "10:24:40",
      sourceText: "The model is commonly used for binary classification.",
      translation: "该模型通常用于二分类问题。",
      isFinal: true,
    },
    {
      id: "5",
      sourceId: "system",
      timestamp: "10:24:48",
      sourceText: "And what logistic regression does is theta transpose x through the sigmoid function.",
      translation: "逻辑回归将 θᵀx 输入 Sigmoid 函数，使输出限定在 0 到 1 之间。",
      revisedTranslation: "逻辑回归把 θᵀx 送入 Sigmoid 函数，将输出约束在 0 到 1 之间。",
      isFinal: true,
    },
  ],
  logs: [
    { id: "l1", timestamp: "10:24:42", level: "info", source: "audio", message: "双路音频采集正常" },
    { id: "l2", timestamp: "10:24:46", level: "info", source: "asr", message: "Whisper queue 4s / no dropped frames" },
    { id: "l3", timestamp: "10:24:49", level: "debug", source: "review", message: "上下文复核修正了 1 条字幕" },
  ],
};

if (new URLSearchParams(window.location.search).get("previewError") === "1") {
  snapshot = {
    ...snapshot,
    sources: {
      ...snapshot.sources,
      system: {
        ...snapshot.sources.system,
        phase: "error",
        error: "电脑声音采集暂时中断，正在等待重新连接。",
      },
    },
  };
}

export function createPreviewBridge(): LiveTranslatingBridge {
  const listeners = new Set<(value: TuiSnapshot) => void>();
  const publish = (): void => {
    for (const listener of listeners) listener(snapshot);
  };
  return {
    getSnapshot: async () => snapshot,
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    action: async (name, payload) => {
      snapshot = reduceSnapshot(snapshot, name, payload);
      publish();
      return snapshot;
    },
    windowControl: async (command) => previewWindowControl(command),
  };
}

function reduceSnapshot(
  current: TuiSnapshot,
  name: DesktopActionName,
  payload?: DesktopActionPayload,
): TuiSnapshot {
  if (name === "set-running" && hasEnabled(payload)) {
    return { ...current, running: payload.enabled };
  }
  if (name === "set-source-enabled" && hasSourceEnabled(payload)) {
    return {
      ...current,
      sources: {
        ...current.sources,
        [payload.sourceId]: {
          ...current.sources[payload.sourceId],
          enabled: payload.enabled,
          phase: payload.enabled ? "listening" : "disabled",
        },
      },
    };
  }
  if (name === "set-recording" && hasEnabled(payload)) {
    return { ...current, recording: payload.enabled };
  }
  if (name === "set-reviewer" && hasEnabled(payload)) {
    return { ...current, reviewerEnabled: payload.enabled };
  }
  if (name === "set-microphone" && hasString(payload, "deviceId")) {
    const device = current.microphoneDevices.find((item) => item.id === payload.deviceId);
    return {
      ...current,
      sources: {
        ...current.sources,
        microphone: {
          ...current.sources.microphone,
          deviceId: payload.deviceId,
          ...(device ? { deviceLabel: device.label } : {}),
        },
      },
    };
  }
  if (name === "set-source-language" && hasString(payload, "language")) {
    return { ...current, sourceLanguage: payload.language };
  }
  if (name === "set-target-language" && hasString(payload, "language")) {
    return { ...current, targetLanguage: payload.language };
  }
  if (name === "set-model" && hasString(payload, "model")) {
    return { ...current, model: payload.model as TuiTranslationModel };
  }
  if (name === "toggle-running") return { ...current, running: !current.running };
  if (name === "toggle-recording") return { ...current, recording: !current.recording };
  if (name === "toggle-reviewer") return { ...current, reviewerEnabled: !current.reviewerEnabled };
  if (name === "toggle-source" && hasSource(payload)) {
    const enabled = !current.sources[payload.sourceId].enabled;
    return reduceSnapshot(current, "set-source-enabled", { sourceId: payload.sourceId, enabled });
  }
  if (name === "cycle-model") {
    const index = models.indexOf(current.model);
    return {
      ...current,
      model: models[(index + 1) % models.length] ?? "deepseek-v4-flash",
    };
  }
  return current;
}

function previewWindowControl(command: WindowControlCommand): void {
  const params = new URLSearchParams({
    surface: command === "open-overlay" ? "compact" : "main",
    preview: "1",
  });
  if (command === "open-overlay" || command === "expand-overlay") {
    window.location.assign(`${window.location.pathname}?${params.toString()}`);
  }
}

function hasEnabled(payload: DesktopActionPayload | undefined): payload is { enabled: boolean } {
  return Boolean(payload && "enabled" in payload && typeof payload.enabled === "boolean");
}

function hasSource(payload: DesktopActionPayload | undefined): payload is { sourceId: TuiSourceId } {
  return Boolean(payload && "sourceId" in payload);
}

function hasSourceEnabled(
  payload: DesktopActionPayload | undefined,
): payload is { sourceId: TuiSourceId; enabled: boolean } {
  return hasSource(payload) && "enabled" in payload && typeof payload.enabled === "boolean";
}

function hasString<K extends "deviceId" | "language" | "model">(
  payload: DesktopActionPayload | undefined,
  key: K,
): payload is DesktopActionPayload & Record<K, string> {
  return Boolean(payload && key in payload && typeof payload[key as keyof typeof payload] === "string");
}
