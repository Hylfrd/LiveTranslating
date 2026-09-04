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
const models: readonly TuiTranslationModel[] = ["hy-mt2-plus", "hy-mt2-pro"];
const previewRecording = new URLSearchParams(window.location.search).get("previewRecording") === "1";

let snapshot: TuiSnapshot = {
  running: previewRecording,
  sessionPhase: previewRecording ? "recording" : "idle",
  transitioning: false,
  sources: {
    system: {
      id: "system",
      label: "System audio",
      enabled: true,
      phase: previewRecording ? "listening" : "disabled",
      level: previewRecording ? 0.64 : 0,
      latencyMs: 2810,
      droppedFrames: 0,
      deviceLabel: "Default Windows output",
    },
    microphone: {
      id: "microphone",
      label: "Microphone",
      enabled: true,
      phase: "disabled",
      level: 0,
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
  sourceLanguage: "auto",
  targetLanguage: "zh",
  model: "hy-mt2-plus",
  recording: previewRecording,
  sessions: {
    system: {
      phase: previewRecording ? "recording" : "idle",
      recording: previewRecording,
      archive: {
        rootDirectory: "C:\\LiveTranslating\\archives",
        currentName: "LiveTranslating_2026-9-4_13-38",
        lastSaved: {
          sourceId: "system",
          name: "LiveTranslating_2026-9-4_12-52",
          savedAt: "2026-09-04T04:58:00.000Z",
          audioDirectory: "C:\\LiveTranslating\\archives\\audio\\LiveTranslating_2026-9-4_12-52",
          transcriptionPath: "C:\\LiveTranslating\\archives\\transcription\\LiveTranslating_2026-9-4_12-52.md",
          translationPath: "C:\\LiveTranslating\\archives\\translation\\LiveTranslating_2026-9-4_12-52.md",
        },
      },
    },
    microphone: {
      phase: "idle",
      recording: false,
      archive: {
        rootDirectory: "C:\\LiveTranslating\\archives",
        currentName: "LiveTranslating_2026-9-4_13-38",
        lastSaved: {
          sourceId: "microphone",
          name: "LiveTranslating_2026-9-4_11-20",
          savedAt: "2026-09-04T03:29:00.000Z",
          audioDirectory: "C:\\LiveTranslating\\archives\\audio\\LiveTranslating_2026-9-4_11-20",
          transcriptionPath: "C:\\LiveTranslating\\archives\\transcription\\LiveTranslating_2026-9-4_11-20.md",
          translationPath: "C:\\LiveTranslating\\archives\\translation\\LiveTranslating_2026-9-4_11-20.md",
        },
      },
    },
  },
  billing: {
    sessionStartedAt: "2026-09-04T05:38:00.000Z",
    models: [
      { model: "hy-mt2-plus", requests: 18, inputTokens: 4620, cachedInputTokens: 0, outputTokens: 1108, estimatedRequests: 0, cost: 0.004526, currency: "CNY", inputPricePerMillion: 0.5, outputPricePerMillion: 2, priceSource: "Tencent TokenHub official pricing", priceVerifiedAt: "2026-09-04" },
      { model: "hy-mt2-pro", requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedRequests: 0, cost: 0, currency: "CNY", inputPricePerMillion: 0.5, outputPricePerMillion: 2, priceSource: "Tencent TokenHub official pricing", priceVerifiedAt: "2026-09-04" },
      { model: "deepseek-v4-flash", requests: 7, inputTokens: 2140, cachedInputTokens: 620, outputTokens: 682, estimatedRequests: 0, cost: 0.001237, currency: "USD", inputPricePerMillion: 0.22, cachedInputPricePerMillion: 0.007, outputPricePerMillion: 0.66, priceTier: "off-peak", priceSource: "DeepSeek official peak/off-peak pricing", priceVerifiedAt: "2026-09-04" },
      { model: "deepseek-v4-pro", requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedRequests: 0, cost: 0, currency: "USD", inputPricePerMillion: 0.66, cachedInputPricePerMillion: 0.022, outputPricePerMillion: 1.98, priceTier: "off-peak", priceSource: "DeepSeek official peak/off-peak pricing", priceVerifiedAt: "2026-09-04" },
    ],
    totalInputTokens: 6760,
    totalCachedInputTokens: 620,
    totalOutputTokens: 1790,
    totalRequests: 25,
    estimatedRequests: 0,
    totals: { CNY: 0.004526, USD: 0.001237 },
    pricingReference: { source: "models.dev", status: "checked", checkedAt: new Date().toISOString(), message: "在线参考仍是旧价，当前继续采用官方峰谷价" },
  },
  notifications: [],
  reviewerEnabled: true,
  secondaryTranslationEnabled: false,
  terminologyReviewEnabled: true,
  terminologyReviewModel: "deepseek-v4-flash",
  reviewQueueSize: 1,
  modelHealth: [
    { model: "hy-mt2-plus", status: "available", latencyMs: 510, checkedAt: new Date().toISOString() },
    { model: "hy-mt2-pro", status: "available", latencyMs: 680, checkedAt: new Date().toISOString() },
    { model: "deepseek-v4-flash", status: "available", latencyMs: 760, checkedAt: new Date().toISOString() },
    { model: "deepseek-v4-pro", status: "available", latencyMs: 980, checkedAt: new Date().toISOString() },
  ],
  subtitles: [
    { id: "1", sourceId: "system", timestamp: "10:24:15", sourceText: "The hypothesis is defined as h theta of x.", translation: "假设函数定义为 hθ(x)。", isFinal: true },
    { id: "2", sourceId: "system", timestamp: "10:24:23", sourceText: "We use gradient descent to minimize the cross-entropy loss.", translation: "我们使用梯度下降最小化交叉熵损失。", isFinal: true },
    { id: "3", sourceId: "microphone", timestamp: "10:24:31", sourceText: "这个例子已经很清楚了，我们继续看下一部分。", translation: "", translationOmitted: true, isFinal: true },
    { id: "4", sourceId: "system", timestamp: "10:24:40", sourceText: "The model is commonly used for binary classification.", translation: "该模型通常用于二分类问题。", isFinal: true },
    { id: "5", sourceId: "system", timestamp: "10:24:48", sourceText: "And what logistic regression does is theta transpose x through the sigmoid function.", translation: "逻辑回归将 θᵀx 输入 Sigmoid 函数，使输出限定在 0 到 1 之间。", revisedTranslation: "逻辑回归把 θᵀx 送入 Sigmoid 函数，将输出约束在 0 到 1 之间。", isFinal: true },
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
    sources: { ...snapshot.sources, system: { ...snapshot.sources.system, phase: "error", error: "电脑声音采集暂时中断，正在等待重新连接。" } },
  };
}

export function createPreviewBridge(): LiveTranslatingBridge {
  const listeners = new Set<(value: TuiSnapshot) => void>();
  const publish = (): void => listeners.forEach((listener) => listener(snapshot));
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
    exportArchive: async (sourceId, kind) => {
      const destination = `C:\\Exports\\${kind}`;
      snapshot = {
        ...snapshot,
        notifications: [
          ...snapshot.notifications,
          { id: `export-${Date.now()}`, kind: "success", message: `${sourceId === "system" ? "电脑声音" : "麦克风"}已导出到 ${destination}` },
        ],
      };
      publish();
      return { canceled: false, kind, destination };
    },
  };
}

function reduceSnapshot(current: TuiSnapshot, name: DesktopActionName, payload?: DesktopActionPayload): TuiSnapshot {
  if (["start-session", "pause-session", "resume-session", "stop-session"].includes(name) && hasSource(payload)) {
    const nextPhase = name === "start-session" || name === "resume-session"
      ? "recording"
      : name === "pause-session" ? "paused" : "idle";
    const sourceId = payload.sourceId;
    const savedNotification = name === "stop-session"
      ? [{ id: `saved-${Date.now()}`, kind: "success" as const, message: `${sourceId === "system" ? "电脑声音" : "麦克风"}已自动保存` }]
      : [];
    return withAggregate({
      ...current,
      sessions: {
        ...current.sessions,
        [sourceId]: {
          ...current.sessions[sourceId],
          phase: nextPhase,
          recording: nextPhase === "recording" || nextPhase === "paused",
        },
      },
      sources: {
        ...current.sources,
        [sourceId]: { ...current.sources[sourceId], phase: nextPhase === "recording" ? "listening" : nextPhase === "paused" ? "paused" : "disabled" },
      },
      notifications: [...current.notifications, ...savedNotification],
    });
  }
  if (name === "set-archive-name" && hasSourceName(payload)) {
    return { ...current, sessions: { ...current.sessions, [payload.sourceId]: { ...current.sessions[payload.sourceId], archive: { ...current.sessions[payload.sourceId].archive, currentName: payload.name } } } };
  }
  if (name === "dismiss-notification" && hasString(payload, "notificationId")) {
    return { ...current, notifications: current.notifications.filter((item) => item.id !== payload.notificationId) };
  }
  if (name === "set-source-enabled" && hasSourceEnabled(payload)) {
    return { ...current, sources: { ...current.sources, [payload.sourceId]: { ...current.sources[payload.sourceId], enabled: payload.enabled } } };
  }
  if (name === "set-reviewer" && hasEnabled(payload)) return { ...current, reviewerEnabled: payload.enabled };
  if (name === "set-secondary-translation" && hasEnabled(payload)) return { ...current, secondaryTranslationEnabled: payload.enabled };
  if (name === "set-terminology-review" && hasEnabled(payload)) return { ...current, terminologyReviewEnabled: payload.enabled };
  if (name === "set-terminology-review-model" && hasString(payload, "reviewModel")) return { ...current, terminologyReviewModel: payload.reviewModel === "deepseek-v4-pro" ? "deepseek-v4-pro" : "deepseek-v4-flash" };
  if (name === "set-microphone" && hasString(payload, "deviceId")) {
    const device = current.microphoneDevices.find((item) => item.id === payload.deviceId);
    return { ...current, sources: { ...current.sources, microphone: { ...current.sources.microphone, deviceId: payload.deviceId, ...(device ? { deviceLabel: device.label } : {}) } } };
  }
  if (name === "set-target-language" && hasString(payload, "language")) return { ...current, targetLanguage: payload.language };
  if (name === "set-model" && hasString(payload, "model")) return { ...current, model: payload.model as TuiTranslationModel };
  if (name === "test-models") return { ...current, modelHealth: current.modelHealth.map((item) => ({ ...item, status: item.status === "not-configured" ? "not-configured" : "available" })) };
  if (name === "toggle-source" && hasSource(payload)) return reduceSnapshot(current, "set-source-enabled", { sourceId: payload.sourceId, enabled: !current.sources[payload.sourceId].enabled });
  if (name === "cycle-model") {
    const index = models.indexOf(current.model);
    return { ...current, model: models[(index + 1) % models.length] ?? "hy-mt2-plus" };
  }
  return current;
}

function withAggregate(value: TuiSnapshot): TuiSnapshot {
  const phases = Object.values(value.sessions).map((session) => session.phase);
  const sessionPhase = phases.includes("saving") ? "saving" : phases.includes("recording") ? "recording" : phases.includes("paused") ? "paused" : "idle";
  return { ...value, running: phases.includes("recording"), recording: phases.some((phase) => phase === "recording" || phase === "paused"), sessionPhase };
}

function previewWindowControl(command: WindowControlCommand): void {
  const params = new URLSearchParams({ surface: command === "open-overlay" ? "compact" : "main", preview: "1" });
  if (command === "open-overlay" || command === "expand-overlay") window.location.assign(`${window.location.pathname}?${params.toString()}`);
}

function hasEnabled(payload: DesktopActionPayload | undefined): payload is { enabled: boolean } {
  return Boolean(payload && "enabled" in payload && typeof payload.enabled === "boolean");
}
function hasSource(payload: DesktopActionPayload | undefined): payload is { sourceId: TuiSourceId } {
  return Boolean(payload && "sourceId" in payload);
}
function hasSourceEnabled(payload: DesktopActionPayload | undefined): payload is { sourceId: TuiSourceId; enabled: boolean } {
  return hasSource(payload) && "enabled" in payload && typeof payload.enabled === "boolean";
}
function hasSourceName(payload: DesktopActionPayload | undefined): payload is { sourceId: TuiSourceId; name: string } {
  return hasSource(payload) && "name" in payload && typeof payload.name === "string";
}
function hasString<K extends "deviceId" | "language" | "model" | "reviewModel" | "notificationId">(
  payload: DesktopActionPayload | undefined,
  key: K,
): payload is DesktopActionPayload & Record<K, string> {
  return Boolean(payload && key in payload && typeof payload[key as keyof typeof payload] === "string");
}
