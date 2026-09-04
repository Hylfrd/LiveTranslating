import type { ApplicationController } from "../../app/application-controller.js";
import type { TuiReviewModel, TuiSnapshot, TuiTranslationModel } from "../../tui/controller.js";
import type {
  DesktopActionName,
  DesktopActionRequest,
} from "../preload/contract.js";

const ACTION_NAMES = new Set<DesktopActionName>([
  "toggle-running",
  "set-running",
  "start-session",
  "pause-session",
  "resume-session",
  "stop-session",
  "toggle-source",
  "set-source-enabled",
  "cycle-microphone",
  "cycle-source-language",
  "cycle-target-language",
  "cycle-model",
  "set-microphone",
  "set-source-language",
  "set-target-language",
  "set-model",
  "toggle-reviewer",
  "set-reviewer",
  "set-secondary-translation",
  "set-terminology-review",
  "set-terminology-review-model",
  "test-models",
  "set-archive-name",
  "refresh-pricing",
  "dismiss-notification",
]);

const MODELS: readonly TuiTranslationModel[] = [
  "hy-mt2-plus",
  "hy-mt2-pro",
];

export async function dispatchControllerAction(
  controller: ApplicationController,
  rawRequest: unknown,
): Promise<TuiSnapshot> {
  const request = parseRequest(rawRequest);

  switch (request.name) {
    case "toggle-running":
      await controller.toggleRunning();
      break;
    case "set-running":
      await controller.setRunning(readEnabled(request.payload));
      break;
    case "start-session":
      await controller.startSession(readSourceId(request.payload));
      break;
    case "pause-session":
      await controller.pauseSession(readSourceId(request.payload));
      break;
    case "resume-session":
      await controller.resumeSession(readSourceId(request.payload));
      break;
    case "stop-session":
      await controller.stopSession(readSourceId(request.payload));
      break;
    case "toggle-source":
      await controller.toggleSource(readSourceId(request.payload));
      break;
    case "set-source-enabled":
      await controller.setSourceEnabled(
        readSourceId(request.payload),
        readEnabled(request.payload),
      );
      break;
    case "cycle-microphone":
      await controller.cycleMicrophoneDevice(readDirection(request.payload));
      break;
    case "cycle-source-language":
      await controller.cycleSourceLanguage(readDirection(request.payload));
      break;
    case "cycle-target-language":
      controller.cycleTargetLanguage(readDirection(request.payload));
      break;
    case "cycle-model":
      controller.cycleModel(readDirection(request.payload));
      break;
    case "set-microphone":
      await setMicrophone(controller, readString(request.payload, "deviceId"));
      break;
    case "set-source-language":
      await setSourceLanguage(controller, readString(request.payload, "language"));
      break;
    case "set-target-language":
      await setTargetLanguage(controller, readString(request.payload, "language"));
      break;
    case "set-model":
      await setModel(controller, readString(request.payload, "model"));
      break;
    case "toggle-reviewer":
      controller.toggleReviewer();
      break;
    case "set-reviewer":
      controller.setReviewerEnabled(readEnabled(request.payload));
      break;
    case "set-secondary-translation":
      controller.setSecondaryTranslationEnabled(readEnabled(request.payload));
      break;
    case "set-terminology-review":
      controller.setTerminologyReviewEnabled(readEnabled(request.payload));
      break;
    case "set-terminology-review-model":
      controller.setTerminologyReviewModel(readReviewModel(request.payload));
      break;
    case "test-models":
      controller.testModels();
      break;
    case "set-archive-name":
      controller.setArchiveName(
        readSourceId(request.payload),
        readString(request.payload, "name"),
      );
      break;
    case "refresh-pricing":
      await controller.refreshPricing();
      break;
    case "dismiss-notification":
      controller.dismissNotification(readString(request.payload, "notificationId"));
      break;
  }

  return controller.getSnapshot();
}

function parseRequest(value: unknown): DesktopActionRequest {
  if (!isRecord(value) || typeof value.name !== "string" || !ACTION_NAMES.has(value.name as DesktopActionName)) {
    throw new TypeError("Unsupported desktop controller action");
  }
  return value as unknown as DesktopActionRequest;
}

function readSourceId(payload: unknown): "system" | "microphone" {
  if (!isRecord(payload) || (payload.sourceId !== "system" && payload.sourceId !== "microphone")) {
    throw new TypeError("toggle-source requires a valid sourceId");
  }
  return payload.sourceId;
}

function readDirection(payload: unknown): 1 | -1 {
  if (payload === undefined) {
    return 1;
  }
  if (!isRecord(payload) || (payload.direction !== 1 && payload.direction !== -1)) {
    throw new TypeError("Cycle actions require direction 1 or -1");
  }
  return payload.direction;
}

function readEnabled(payload: unknown): boolean {
  if (!isRecord(payload) || typeof payload.enabled !== "boolean") {
    throw new TypeError("Set actions require an enabled boolean");
  }
  return payload.enabled;
}

function readString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== "string" || payload[key].trim() === "") {
    throw new TypeError(`Action requires a non-empty ${key}`);
  }
  return payload[key].trim();
}

function readReviewModel(payload: unknown): TuiReviewModel {
  if (
    !isRecord(payload)
    || (payload.reviewModel !== "deepseek-v4-flash" && payload.reviewModel !== "deepseek-v4-pro")
  ) {
    throw new TypeError("Action requires a valid DeepSeek review model");
  }
  return payload.reviewModel;
}

async function setMicrophone(controller: ApplicationController, deviceId: string): Promise<void> {
  const snapshot = controller.getSnapshot();
  const devices = snapshot.microphoneDevices;
  const targetIndex = devices.findIndex((device) => device.id === deviceId);
  if (targetIndex < 0) {
    throw new RangeError("Requested microphone is not available");
  }
  const currentIndex = Math.max(
    0,
    devices.findIndex((device) => device.id === snapshot.sources.microphone.deviceId),
  );
  await cycleTo(currentIndex, targetIndex, devices.length, (direction) =>
    controller.cycleMicrophoneDevice(direction));
}

async function setSourceLanguage(controller: ApplicationController, code: string): Promise<void> {
  const snapshot = controller.getSnapshot();
  const values = snapshot.sourceLanguages.map((language) => language.code);
  await cycleValueTo(values, snapshot.sourceLanguage, code, (direction) =>
    controller.cycleSourceLanguage(direction));
}

async function setTargetLanguage(controller: ApplicationController, code: string): Promise<void> {
  const snapshot = controller.getSnapshot();
  const values = snapshot.targetLanguages.map((language) => language.code);
  await cycleValueTo(values, snapshot.targetLanguage, code, (direction) => {
    controller.cycleTargetLanguage(direction);
  });
}

async function setModel(controller: ApplicationController, model: string): Promise<void> {
  if (!MODELS.includes(model as TuiTranslationModel)) {
    throw new RangeError("Requested translation model is not available");
  }
  await cycleValueTo(MODELS, controller.getSnapshot().model, model as TuiTranslationModel, (direction) => {
    controller.cycleModel(direction);
  });
}

async function cycleValueTo<T extends string>(
  values: readonly T[],
  current: T,
  target: T,
  cycle: (direction: 1 | -1) => void | Promise<void>,
): Promise<void> {
  const currentIndex = values.indexOf(current);
  const targetIndex = values.indexOf(target);
  if (targetIndex < 0) {
    throw new RangeError(`Requested value is not available: ${target}`);
  }
  await cycleTo(Math.max(0, currentIndex), targetIndex, values.length, cycle);
}

async function cycleTo(
  currentIndex: number,
  targetIndex: number,
  length: number,
  cycle: (direction: 1 | -1) => void | Promise<void>,
): Promise<void> {
  if (length < 1 || currentIndex === targetIndex) {
    return;
  }
  const forward = (targetIndex - currentIndex + length) % length;
  const backward = (currentIndex - targetIndex + length) % length;
  const direction: 1 | -1 = forward <= backward ? 1 : -1;
  const steps = Math.min(forward, backward);
  for (let index = 0; index < steps; index += 1) {
    await cycle(direction);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
