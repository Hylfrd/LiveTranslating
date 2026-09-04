import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { FfmpegWhisperSession, type AsrTranscript } from "../asr/ffmpeg-whisper.js";
import { AsrModelManager } from "../asr/model-manager.js";
import { TranscriptAssembler, cleanAsrText } from "../asr/transcript-assembler.js";
import type { AudioSourceId } from "../audio/types.js";
import { BillingTracker } from "../billing/billing-tracker.js";
import { config } from "../config.js";
import { AppLogger } from "../logging/app-logger.js";
import {
  createDefaultArchiveName,
  type ArchiveExportKind,
  RecordingManager,
} from "../recording/recording-manager.js";
import { NativeAudioManager, type AudioManagerEvent } from "../sources/native-audio-manager.js";
import type {
  TuiAudioDevice,
  TuiController,
  TuiLanguage,
  TuiModelHealth,
  TuiNotification,
  TuiReviewModel,
  TuiSessionPhase,
  TuiSnapshot,
  TuiSourcePhase,
  TuiSourceState,
  TuiSubtitleEntry,
  TuiSubtitleParagraph,
  TuiTranslationModel,
} from "../tui/controller.js";
import { OpenAICompatibleTranslationProvider } from "../translation/provider.js";
import type { ProviderModelId, TranslationRequest, TranslationResult } from "../translation/schema.js";

const SOURCE_LANGUAGES: readonly TuiLanguage[] = [
  { code: "auto", label: "Auto detect" },
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ar", label: "Arabic" },
];

const TARGET_LANGUAGES: readonly TuiLanguage[] = [
  { code: "zh", label: "Simplified Chinese" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ar", label: "Arabic" },
];

interface MutableSourceState {
  enabled: boolean;
  phase: TuiSourcePhase;
  deviceId: string | undefined;
  deviceLabel: string | undefined;
  level: number;
  latencyMs: number | undefined;
  droppedFrames: number;
  error: string | undefined;
}

interface ContextTurn {
  readonly id: string;
  readonly source: string;
  translation: string;
}

interface TranslationJobSettings {
  readonly revision: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly model: TuiTranslationModel;
  readonly secondaryTranslationEnabled: boolean;
  readonly reviewerEnabled: boolean;
  readonly terminologyReviewEnabled: boolean;
  readonly terminologyReviewModel: TuiReviewModel;
  readonly recordingSessionId?: string;
}

export class ApplicationController implements TuiController {
  private readonly events = new EventEmitter();
  private readonly logger: AppLogger;
  private readonly recording: RecordingManager;
  private readonly billing = new BillingTracker();
  private readonly audio: NativeAudioManager;
  private readonly asrModels: AsrModelManager;
  private readonly translator = new OpenAICompatibleTranslationProvider(config.translation);
  private readonly asrSessions = new Map<AudioSourceId, FfmpegWhisperSession>();
  private readonly transcriptAssemblers = new Map<AudioSourceId, TranscriptAssembler>();
  private readonly translationQueues = new Map<AudioSourceId, Promise<void>>();
  private readonly translationControllers = new Map<string, AbortController>();
  private readonly reviewControllers = new Map<string, AbortController>();
  private readonly reviewTasks = new Set<Promise<void>>();
  private readonly reviewTasksBySource = new Map<AudioSourceId, Set<Promise<void>>>();
  private readonly contexts = new Map<AudioSourceId, ContextTurn[]>();
  private readonly lastTranscripts = new Map<AudioSourceId, { text: string; at: number }>();
  private readonly sourceGenerations = new Map<AudioSourceId, number>();
  private readonly asrResetPending = new Set<AudioSourceId>();
  private readonly modelOperations = new AbortController();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | undefined;
  private closing = false;
  private closed = false;
  private settingsRevision = 0;
  private microphones: TuiAudioDevice[] = [];
  private subtitles: TuiSubtitleEntry[] = [];
  private running = false;
  private readonly sessionPhases: Record<AudioSourceId, TuiSessionPhase> = {
    system: "idle",
    microphone: "idle",
  };
  private transitioning = false;
  private readonly archiveNames: Record<AudioSourceId, string> = {
    system: createDefaultArchiveName(),
    microphone: createDefaultArchiveName(),
  };
  private notifications: TuiNotification[] = [];
  private sourceLanguage = "auto";
  private targetLanguage = "zh";
  private model: TuiTranslationModel = "hy-mt2-plus";
  private reviewerEnabled = false;
  private secondaryTranslationEnabled = false;
  private terminologyReviewEnabled = true;
  private terminologyReviewModel: TuiReviewModel = "deepseek-v4-flash";
  private reviewQueueSize = 0;
  private modelHealth: TuiModelHealth[] = ([
    "hy-mt2-plus",
    "hy-mt2-pro",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ] as const).map((model) => ({ model, status: "idle" }));
  private readonly sources: Record<AudioSourceId, MutableSourceState> = {
    system: {
      enabled: true,
      phase: "disabled",
      deviceId: undefined,
      deviceLabel: "Default Windows output",
      level: 0,
      latencyMs: undefined,
      droppedFrames: 0,
      error: undefined,
    },
    microphone: {
      enabled: true,
      phase: "disabled",
      deviceId: undefined,
      deviceLabel: undefined,
      level: 0,
      latencyMs: undefined,
      droppedFrames: 0,
      error: undefined,
    },
  };

  get translationProvider(): OpenAICompatibleTranslationProvider {
    return this.translator;
  }

  constructor(rootDirectory = process.cwd()) {
    this.logger = new AppLogger(rootDirectory);
    this.recording = new RecordingManager(rootDirectory);
    this.audio = new NativeAudioManager(this.logger, this.recording);
    this.asrModels = new AsrModelManager(this.logger, rootDirectory);
    this.audio.subscribe((event) => this.handleAudioEvent(event));
    this.logger.subscribe(() => this.emit());
  }

  async initialize(): Promise<void> {
    await this.recording.initialize();
    const devices = this.audio.listMicrophones();
    const defaultId = this.audio.defaultMicrophoneId();
    this.sources.microphone.deviceId = defaultId ?? devices[0]?.id;
    this.sources.microphone.deviceLabel = devices.find(
      (device) => device.id === this.sources.microphone.deviceId,
    )?.name;
    this.logger.info(`Found ${devices.length} microphone device(s)`, "audio");
    this.emit();
    void this.refreshPricing().catch((error) => {
      this.logger.warn(
        `Pricing reference refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "billing",
      );
    });
  }

  getSnapshot(): TuiSnapshot {
    return {
      running: this.running,
      sessionPhase: this.aggregateSessionPhase(),
      transitioning: this.transitioning,
      sources: {
        system: this.sourceSnapshot("system", "System audio"),
        microphone: this.sourceSnapshot("microphone", "Microphone"),
      },
      microphoneDevices: this.microphones,
      sourceLanguages: SOURCE_LANGUAGES,
      targetLanguages: TARGET_LANGUAGES,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      model: this.model,
      recording: this.recording.active(),
      sessions: {
        system: this.sourceSessionSnapshot("system"),
        microphone: this.sourceSessionSnapshot("microphone"),
      },
      billing: this.billing.getSnapshot(),
      notifications: this.notifications,
      reviewerEnabled: this.reviewerEnabled,
      secondaryTranslationEnabled: this.secondaryTranslationEnabled,
      terminologyReviewEnabled: this.terminologyReviewEnabled,
      terminologyReviewModel: this.terminologyReviewModel,
      reviewQueueSize: this.reviewQueueSize,
      modelHealth: this.modelHealth,
      subtitles: this.subtitles,
      paragraphs: {
        system: groupSubtitleParagraphs(this.subtitles, "system"),
        microphone: groupSubtitleParagraphs(this.subtitles, "microphone"),
      },
      logs: this.logger.recent(100).map((entry) => ({
        ...entry,
        timestamp: entry.timestamp.slice(11, 19),
      })),
    };
  }

  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void {
    this.events.on("snapshot", listener);
    return () => this.events.off("snapshot", listener);
  }

  async toggleRunning(): Promise<void> {
    const active = (["system", "microphone"] as const).filter(
      (sourceId) => this.sessionPhases[sourceId] !== "idle",
    );
    if (active.length === 0) {
      for (const sourceId of this.enabledSources()) {
        await this.startSession(sourceId);
      }
      return;
    }
    for (const sourceId of active) {
      await this.stopSession(sourceId);
    }
  }

  async startSession(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.sessionPhases[sourceId] !== "idle") {
        return;
      }
      this.transitioning = true;
      this.emit();
      try {
        const startsNewBillingWindow = !this.hasActiveSession();
        this.sources[sourceId].enabled = true;
        this.resetForNewSession(sourceId);
        await this.recording.start(sourceId, this.archiveNames[sourceId], {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.model,
          sourceId,
        });
        if (startsNewBillingWindow) {
          this.billing.startSession();
        }
        await this.startSource(sourceId);
        this.running = this.anyAudioActive();
        if (!this.audio.isActive(sourceId)) {
          await this.recording.abort(sourceId);
          throw new Error(`Audio source ${sourceId} could not be started`);
        }
        this.sessionPhases[sourceId] = "recording";
        this.logger.info(`${sourceId} session started`, "app");
      } catch (error) {
        this.sessionPhases[sourceId] = "idle";
        this.running = this.anyAudioActive();
        throw error;
      } finally {
        this.transitioning = false;
        this.emit();
      }
    });
  }

  async setRunning(enabled: boolean): Promise<void> {
    if (enabled) {
      for (const sourceId of this.enabledSources()) {
        if (this.sessionPhases[sourceId] === "idle") {
          await this.startSession(sourceId);
        } else if (this.sessionPhases[sourceId] === "paused") {
          await this.resumeSession(sourceId);
        }
      }
    } else {
      for (const sourceId of ["system", "microphone"] as const) {
        if (this.sessionPhases[sourceId] === "recording") {
          await this.pauseSession(sourceId);
        }
      }
    }
  }

  async pauseSession(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.sessionPhases[sourceId] !== "recording") {
        return;
      }
      this.transitioning = true;
      this.emit();
      try {
        await this.stopSource(sourceId);
        this.running = this.anyAudioActive();
        this.sessionPhases[sourceId] = "paused";
        this.sources[sourceId].phase = "paused";
        this.logger.info(`${sourceId} session paused`, "app");
      } finally {
        this.transitioning = false;
        this.emit();
      }
    });
  }

  async resumeSession(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.sessionPhases[sourceId] !== "paused") {
        return;
      }
      this.transitioning = true;
      this.emit();
      try {
        await this.startSource(sourceId);
        this.running = this.anyAudioActive();
        if (!this.audio.isActive(sourceId)) {
          throw new Error(`Audio source ${sourceId} could not be resumed`);
        }
        this.sessionPhases[sourceId] = "recording";
        this.logger.info(`${sourceId} session resumed`, "app");
      } finally {
        this.transitioning = false;
        this.emit();
      }
    });
  }

  async stopSession(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.sessionPhases[sourceId] === "idle" || this.sessionPhases[sourceId] === "saving") {
        return;
      }
      this.transitioning = true;
      this.sessionPhases[sourceId] = "saving";
      this.emit();
      try {
        await this.stopSource(sourceId);
        this.running = this.anyAudioActive();
        await this.drainProcessing(sourceId);
        const archive = await this.recording.stop(sourceId);
        if (archive) {
          this.archiveNames[sourceId] = createDefaultArchiveName();
          this.pushNotification("success", `${sourceLabel(sourceId)}已自动保存：${archive.name}`);
          this.logger.info(`Session archived to ${archive.audioDirectory}`, "recording");
        }
      } finally {
        this.sessionPhases[sourceId] = "idle";
        this.transitioning = false;
        this.emit();
      }
    });
  }

  async toggleSource(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      const state = this.sources[sourceId];
      state.enabled = !state.enabled;
      if (this.sessionPhases[sourceId] === "recording") {
        if (state.enabled) {
          await this.startSource(sourceId);
        } else {
          await this.stopSource(sourceId);
        }
        this.running = this.anyAudioActive();
      } else if (this.sessionPhases[sourceId] === "paused") {
        state.phase = state.enabled ? "paused" : "disabled";
      }
      this.emit();
    });
  }

  async setSourceEnabled(sourceId: AudioSourceId, enabled: boolean): Promise<void> {
    if (this.sources[sourceId].enabled !== enabled) {
      await this.toggleSource(sourceId);
    }
  }

  async cycleMicrophoneDevice(direction: 1 | -1 = 1): Promise<void> {
    return this.withLifecycle(async () => {
      this.audio.listMicrophones();
      if (this.microphones.length === 0) {
        return;
      }
      const current = this.microphones.findIndex(
        (device) => device.id === this.sources.microphone.deviceId,
      );
      const base = current >= 0 ? current : direction === 1 ? -1 : 0;
      const next = (base + direction + this.microphones.length) % this.microphones.length;
      const device = this.microphones[next];
      if (!device) {
        return;
      }
      this.sources.microphone.deviceId = device.id;
      this.sources.microphone.deviceLabel = device.label;
      if (this.running && this.sources.microphone.enabled) {
        await this.stopSource("microphone");
        await this.startSource("microphone");
      }
      this.logger.info(`Selected microphone: ${device.label}`, "audio");
      this.emit();
    });
  }

  async cycleSourceLanguage(direction: 1 | -1 = 1): Promise<void> {
    return this.withLifecycle(async () => {
      this.sourceLanguage = cycleValue(SOURCE_LANGUAGES, this.sourceLanguage, direction);
      this.resetLanguageState();
      this.logger.info(`Source language: ${this.sourceLanguage}`, "settings");
      if (this.running) {
        await this.restartAsrSessions();
      }
      this.emit();
    });
  }

  cycleTargetLanguage(direction: 1 | -1 = 1): void {
    this.targetLanguage = cycleValue(TARGET_LANGUAGES, this.targetLanguage, direction);
    this.resetLanguageState();
    this.logger.info(`Target language: ${this.targetLanguage}`, "settings");
    this.emit();
  }

  cycleModel(direction: 1 | -1 = 1): void {
    const models: readonly TuiTranslationModel[] = [
      "hy-mt2-plus",
      "hy-mt2-pro",
    ];
    const index = models.indexOf(this.model);
    this.model = models[(index + direction + models.length) % models.length] ?? "hy-mt2-plus";
    this.logger.info(`Primary translation model: ${this.model}`, "settings");
    this.emit();
  }

  toggleReviewer(): void {
    this.reviewerEnabled = !this.reviewerEnabled;
    this.logger.info(`DeepSeek general review ${this.reviewerEnabled ? "enabled" : "disabled"}`, "review");
    this.emit();
  }

  setReviewerEnabled(enabled: boolean): void {
    if (this.reviewerEnabled !== enabled) {
      this.toggleReviewer();
    }
  }

  toggleSecondaryTranslation(): void {
    this.secondaryTranslationEnabled = !this.secondaryTranslationEnabled;
    this.logger.info(
      `Parallel Hunyuan translation ${this.secondaryTranslationEnabled ? "enabled" : "disabled"}`,
      "translation",
    );
    this.emit();
  }

  setSecondaryTranslationEnabled(enabled: boolean): void {
    if (this.secondaryTranslationEnabled !== enabled) {
      this.toggleSecondaryTranslation();
    }
  }

  toggleTerminologyReview(): void {
    this.terminologyReviewEnabled = !this.terminologyReviewEnabled;
    this.logger.info(
      `DeepSeek terminology review ${this.terminologyReviewEnabled ? "enabled" : "disabled"}`,
      "review",
    );
    this.emit();
  }

  setTerminologyReviewEnabled(enabled: boolean): void {
    if (this.terminologyReviewEnabled !== enabled) {
      this.toggleTerminologyReview();
    }
  }

  cycleTerminologyReviewModel(direction: 1 | -1 = 1): void {
    const models: readonly TuiReviewModel[] = ["deepseek-v4-flash", "deepseek-v4-pro"];
    const index = models.indexOf(this.terminologyReviewModel);
    this.terminologyReviewModel = models[(index + direction + models.length) % models.length]
      ?? "deepseek-v4-flash";
    this.logger.info(`Terminology review model: ${this.terminologyReviewModel}`, "review");
    this.emit();
  }

  setTerminologyReviewModel(model: TuiReviewModel): void {
    if (this.terminologyReviewModel !== model) {
      this.cycleTerminologyReviewModel(1);
    }
  }

  testModels(): void {
    const models = this.modelHealth.map((item) => item.model);
    this.modelHealth = models.map((model) => ({ model, status: "testing" }));
    this.emit();
    void Promise.all(models.map(async (model) => {
      if (!this.translator.registry.isConfigured(model)) {
        this.updateModelHealth(model, { status: "not-configured", checkedAt: new Date().toISOString() });
        return;
      }
      const started = performance.now();
      try {
        const result = await this.translator.registry.testModel(model);
        this.billing.record(result.model, result.usage);
        this.updateModelHealth(model, {
          status: "available",
          latencyMs: performance.now() - started,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        this.updateModelHealth(model, {
          status: "unavailable",
          latencyMs: performance.now() - started,
          checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  setArchiveName(sourceId: AudioSourceId, name: string): void {
    this.archiveNames[sourceId] = this.recording.renameCurrent(sourceId, name);
    this.emit();
  }

  async refreshPricing(): Promise<void> {
    const refresh = this.billing.refreshPricingReference();
    this.emit();
    await refresh;
    this.emit();
  }

  dismissNotification(id: string): void {
    this.notifications = this.notifications.filter((notification) => notification.id !== id);
    this.emit();
  }

  archiveExportPath(
    sourceId: AudioSourceId,
    kind: ArchiveExportKind,
  ): ReturnType<RecordingManager["exportPath"]> {
    return this.recording.exportPath(sourceId, kind);
  }

  notifyExport(destination: string): void {
    this.pushNotification("success", `已导出到 ${destination}`);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.closing = true;
    for (const sourceId of ["system", "microphone"] as const) {
      if (this.sessionPhases[sourceId] !== "idle") {
        this.sessionPhases[sourceId] = "saving";
      }
    }
    this.emit();
    this.modelOperations.abort(new Error("Application shutdown"));
    this.shutdownPromise = this.lifecycleTail.catch(() => undefined).then(async () => {
      await this.stopAllSources().catch((error) => {
        this.logger.error(
          `Audio shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          "app",
        );
      });
      this.running = false;
      await this.drainProcessing();
      this.translationQueues.clear();
      this.closed = true;
      for (const controller of this.reviewControllers.values()) {
        controller.abort();
      }
      this.reviewControllers.clear();
      this.reviewTasksBySource.clear();
      for (const controller of this.translationControllers.values()) {
        controller.abort();
      }
      this.translationControllers.clear();
      await Promise.allSettled((["system", "microphone"] as const).map(async (sourceId) => {
        await this.recording.stop(sourceId);
        this.sessionPhases[sourceId] = "idle";
      }));
      this.logger.info("Application shutdown complete", "app");
      await this.logger.close();
    });
    return this.shutdownPromise;
  }

  private async startSource(sourceId: AudioSourceId): Promise<void> {
    await this.stopSource(sourceId);
    const generation = (this.sourceGenerations.get(sourceId) ?? 0) + 1;
    this.sourceGenerations.set(sourceId, generation);
    const models = await this.asrModels.ensureModels(this.modelOperations.signal);
    const assembler = this.createTranscriptAssembler(sourceId, generation);
    const asr = new FfmpegWhisperSession(
      sourceId,
      this.sourceLanguage,
      models,
      this.logger,
      (transcript) => {
        if (this.sourceGenerations.get(sourceId) === generation) {
          assembler.push(transcript);
        }
      },
      (error) => this.handleAsrFailure(sourceId, generation, error),
    );
    try {
      await asr.start();
    } catch (error) {
      assembler.discard();
      await asr.stop().catch(() => undefined);
      throw error;
    }
    if (this.sourceGenerations.get(sourceId) !== generation) {
      assembler.discard();
      await asr.stop();
      return;
    }
    this.asrSessions.set(sourceId, asr);
    this.transcriptAssemblers.set(sourceId, assembler);
    try {
      await this.audio.start(sourceId, this.sources[sourceId].deviceId);
    } catch (error) {
      this.asrSessions.delete(sourceId);
      this.transcriptAssemblers.delete(sourceId);
      this.sourceGenerations.set(sourceId, generation + 1);
      assembler.discard();
      await asr.stop();
      assembler.discard();
      throw error;
    }
  }

  private async stopSource(sourceId: AudioSourceId): Promise<void> {
    const asr = this.asrSessions.get(sourceId);
    this.asrSessions.delete(sourceId);
    const assembler = this.transcriptAssemblers.get(sourceId);
    this.transcriptAssemblers.delete(sourceId);
    const errors: unknown[] = [];
    try {
      await this.audio.stop(sourceId);
    } catch (error) {
      errors.push(error);
    }
    try {
      await asr?.stop();
    } catch (error) {
      errors.push(error);
    } finally {
      assembler?.flush();
      this.sourceGenerations.set(sourceId, (this.sourceGenerations.get(sourceId) ?? 0) + 1);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to stop ${sourceId} cleanly`);
    }
  }

  private async stopAllSources(): Promise<void> {
    await this.audio.stopAll();
    const sessions = [...this.asrSessions.entries()];
    this.asrSessions.clear();
    const assemblers = [...this.transcriptAssemblers.values()];
    this.transcriptAssemblers.clear();
    await Promise.allSettled(sessions.map(([, session]) => session.stop()));
    for (const assembler of assemblers) {
      assembler.flush();
    }
    for (const sourceId of ["system", "microphone"] as const) {
      this.sourceGenerations.set(sourceId, (this.sourceGenerations.get(sourceId) ?? 0) + 1);
    }
  }

  private async restartAsrSessions(): Promise<void> {
    const active = (["system", "microphone"] as const).filter((id) => this.audio.isActive(id));
    for (const sourceId of active) {
      const generation = (this.sourceGenerations.get(sourceId) ?? 0) + 1;
      this.sourceGenerations.set(sourceId, generation);
      const old = this.asrSessions.get(sourceId);
      this.asrSessions.delete(sourceId);
      const oldAssembler = this.transcriptAssemblers.get(sourceId);
      this.transcriptAssemblers.delete(sourceId);
      oldAssembler?.discard();
      await old?.stop(false);
      const models = await this.asrModels.ensureModels(this.modelOperations.signal);
      const assembler = this.createTranscriptAssembler(sourceId, generation);
      const session = new FfmpegWhisperSession(
        sourceId,
        this.sourceLanguage,
        models,
        this.logger,
        (transcript) => {
          if (this.sourceGenerations.get(sourceId) === generation) {
            assembler.push(transcript);
          }
        },
        (error) => this.handleAsrFailure(sourceId, generation, error),
      );
      try {
        await session.start();
      } catch (error) {
        assembler.discard();
        await session.stop().catch(() => undefined);
        throw error;
      }
      if (this.sourceGenerations.get(sourceId) === generation) {
        this.asrSessions.set(sourceId, session);
        this.transcriptAssemblers.set(sourceId, assembler);
      } else {
        assembler.discard();
        await session.stop();
      }
    }
  }

  private handleAudioEvent(event: AudioManagerEvent): void {
    if (event.type === "devices") {
      this.microphones = event.devices.map((device) => ({
        id: device.id,
        label: device.name,
        isDefault: device.isDefault,
      }));
    } else if (event.type === "status") {
      const state = this.sources[event.sourceId];
      state.phase = event.phase;
      state.error = event.error;
      if (event.deviceLabel) {
        state.deviceLabel = event.deviceLabel;
      }
      if (event.phase === "error") {
        const generation = this.sourceGenerations.get(event.sourceId) ?? 0;
        this.handleAsrFailure(
          event.sourceId,
          generation,
          new Error(event.error ?? "Audio capture failed"),
        );
      }
    } else {
      const state = this.sources[event.frame.sourceId];
      state.level = Math.min(1, event.level * 12);
      const session = this.asrSessions.get(event.frame.sourceId);
      const accepted = session?.write(event.frame.samples, event.frame.capturedAt) ?? false;
      if (!accepted) {
        state.droppedFrames += 1;
        if (state.droppedFrames === 1 || state.droppedFrames % 50 === 0) {
          this.logger.warn(`ASR backpressure dropped ${state.droppedFrames} frame(s)`, event.frame.sourceId);
        }
        if (session && !this.asrResetPending.has(event.frame.sourceId)) {
          const sourceId = event.frame.sourceId;
          this.asrResetPending.add(sourceId);
          void this.withLifecycle(() => this.resetAsrAfterDiscontinuity(sourceId))
            .catch((error) => {
              if (!this.closed) {
                this.logger.error(
                  `ASR discontinuity recovery failed: ${error instanceof Error ? error.message : String(error)}`,
                  sourceId,
                );
              }
            })
            .finally(() => this.asrResetPending.delete(sourceId));
        }
      }
    }
    this.emit();
  }

  private handleTranscript(transcript: AsrTranscript): void {
    const text = cleanAsrText(transcript.text);
    if (!text) {
      return;
    }
    const previous = this.lastTranscripts.get(transcript.sourceId);
    if (previous && previous.text === text && transcript.speechEndedAt - previous.at < 5000) {
      return;
    }
    this.lastTranscripts.set(transcript.sourceId, { text, at: transcript.speechEndedAt });
    const translationOmitted = isPredominantlyTargetLanguage(text, this.targetLanguage);
    const entry: TuiSubtitleEntry = {
      id: randomUUID(),
      sourceId: transcript.sourceId,
      timestamp: formatLocalTime(transcript.speechStartedAt),
      sourceText: text,
      translation: "",
      ...(translationOmitted ? { translationOmitted: true } : {}),
      isFinal: true,
    };
    this.subtitles = [...this.subtitles.slice(-99), entry];
    const recordingSessionId = this.recording.sessionIdForSpeech(
      transcript.sourceId,
      transcript.speechStartedAt,
      transcript.speechEndedAt,
    );
    const settings: TranslationJobSettings = {
      revision: this.settingsRevision,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      model: this.model,
      secondaryTranslationEnabled: this.secondaryTranslationEnabled,
      reviewerEnabled: this.reviewerEnabled,
      terminologyReviewEnabled: this.terminologyReviewEnabled,
      terminologyReviewModel: this.terminologyReviewModel,
      ...(recordingSessionId ? { recordingSessionId } : {}),
    };
    void this.appendRecordingTranscript(entry, recordingSessionId);
    if (translationOmitted) {
      const contexts = this.contexts.get(entry.sourceId) ?? [];
      this.contexts.set(entry.sourceId, [
        ...contexts.slice(-7),
        { id: entry.id, source: entry.sourceText, translation: entry.sourceText },
      ]);
      this.logger.debug("Skipped translation for target-language speech", entry.sourceId);
      this.emit();
      return;
    }
    this.enqueueTranslation(entry, settings);
    this.emit();
  }

  private enqueueTranslation(entry: TuiSubtitleEntry, settings: TranslationJobSettings): void {
    if (this.closed) {
      return;
    }
    const previous = this.translationQueues.get(entry.sourceId) ?? Promise.resolve();
    const current = previous
      .then(() => this.translateEntry(entry, settings))
      .catch((error) => {
        if (!this.closed) this.logger.error(
          `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
          entry.sourceId,
        );
      })
      .finally(() => {
        if (this.translationQueues.get(entry.sourceId) === current) {
          this.translationQueues.delete(entry.sourceId);
        }
      });
    this.translationQueues.set(entry.sourceId, current);
  }

  private async translateEntry(
    entry: TuiSubtitleEntry,
    settings: TranslationJobSettings,
  ): Promise<void> {
    if (this.closed || settings.revision !== this.settingsRevision) {
      return;
    }
    const controller = new AbortController();
    this.translationControllers.set(entry.id, controller);
    const contexts = this.contexts.get(entry.sourceId) ?? [];
    const request: TranslationRequest = {
      text: entry.sourceText,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      context: contexts.slice(-4).map((turn) => ({ source: turn.source, translation: turn.translation })),
      model: settings.model,
    };
    const started = performance.now();
    try {
      const settle = async (model: TuiTranslationModel) => {
        try {
          return { result: await this.translator.translate({ ...request, model }, controller.signal) };
        } catch (error) {
          return { error };
        }
      };
      const primaryTask = settle(settings.model);
      const secondaryTask = settings.secondaryTranslationEnabled
        ? settle(otherTranslationModel(settings.model))
        : undefined;
      const primary = await primaryTask;
      let initial: TranslationResult | undefined;
      if (primary.result) {
        initial = primary.result;
        this.billing.record(initial.model, initial.usage);
        await this.commitInitialTranslation(entry, initial, settings, contexts, started);
      }
      const secondary = secondaryTask ? await secondaryTask : undefined;
      if (secondary?.result) {
        this.billing.record(secondary.result.model, secondary.result.usage);
      }
      if (!initial && secondary?.result) {
        initial = secondary.result;
        await this.commitInitialTranslation(entry, initial, settings, contexts, started);
      }
      if (!initial) {
        throw new AggregateError(
          [primary.error, secondary?.error].filter((error) => error !== undefined),
          "All enabled translation models failed",
        );
      }
      if (this.closed || settings.revision !== this.settingsRevision) return;
      if (settings.reviewerEnabled || settings.terminologyReviewEnabled) {
        this.startReview(entry, initial.text, secondary?.result?.text, settings);
      }
    } finally {
      this.translationControllers.delete(entry.id);
    }
  }

  private async commitInitialTranslation(
    entry: TuiSubtitleEntry,
    result: TranslationResult,
    settings: TranslationJobSettings,
    contexts: readonly ContextTurn[],
    started: number,
  ): Promise<void> {
    if (this.closed || settings.revision !== this.settingsRevision) return;
    this.sources[entry.sourceId].latencyMs = performance.now() - started;
    this.updateSubtitle(entry.id, { translation: result.text });
    const turn: ContextTurn = { id: entry.id, source: entry.sourceText, translation: result.text };
    this.contexts.set(entry.sourceId, [...contexts.slice(-7), turn]);
    await this.appendRecordingTranscript(
      { ...entry, translation: result.text },
      settings.recordingSessionId,
    );
    this.logger.info(`Translated with ${result.model} in ${Math.round(performance.now() - started)} ms`, entry.sourceId);
  }

  private startReview(
    entry: TuiSubtitleEntry,
    originalTranslation: string,
    secondaryTranslation: string | undefined,
    settings: TranslationJobSettings,
  ): void {
    const controller = new AbortController();
    this.reviewControllers.set(entry.id, controller);
    const sourceTasks = this.reviewTasksBySource.get(entry.sourceId) ?? new Set<Promise<void>>();
    this.reviewTasksBySource.set(entry.sourceId, sourceTasks);
    this.reviewQueueSize += 1;
    this.emit();
    const context = (this.contexts.get(entry.sourceId) ?? [])
      .filter((turn) => turn.id !== entry.id)
      .slice(-4)
      .map((turn) => ({ source: turn.source, translation: turn.translation }));
    const task = (async () => {
      let reviewedTranslation = originalTranslation;
      const runReview = async (
        mode: "general" | "terminology",
        model: TuiReviewModel,
        alternate?: string,
      ): Promise<void> => {
        try {
          const review = await this.translator.reviewTranslation({
            sourceText: entry.sourceText,
            originalTranslation: reviewedTranslation,
            sourceLanguage: settings.sourceLanguage,
            targetLanguage: settings.targetLanguage,
            context,
            mode,
            model,
            ...(alternate && alternate !== reviewedTranslation
              ? { secondaryTranslation: alternate }
              : {}),
          }, controller.signal);
          this.billing.record(review.model, review.usage);
          reviewedTranslation = review.reviewedTranslation;
        } catch (error) {
          if (!controller.signal.aborted) {
            this.logger.warn(
              `${model} ${mode} review failed: ${error instanceof Error ? error.message : String(error)}`,
              entry.sourceId,
            );
          }
        }
      };

      if (settings.reviewerEnabled) {
        await runReview("general", "deepseek-v4-flash", secondaryTranslation);
      }
      if (settings.terminologyReviewEnabled) {
        await runReview("terminology", settings.terminologyReviewModel);
      }
      if (
        this.closed
        || settings.revision !== this.settingsRevision
        || reviewedTranslation.trim() === originalTranslation.trim()
      ) {
        return;
      }
      this.updateSubtitle(entry.id, { revisedTranslation: reviewedTranslation });
      const turn = (this.contexts.get(entry.sourceId) ?? []).find((item) => item.id === entry.id);
      if (turn) {
        turn.translation = reviewedTranslation;
      }
      await this.appendRecordingTranscript(
        { ...entry, translation: originalTranslation, revisedTranslation: reviewedTranslation },
        settings.recordingSessionId,
      );
      this.logger.info("DeepSeek review produced one delayed revision", entry.sourceId);
    })()
      .finally(() => {
        this.reviewControllers.delete(entry.id);
        this.reviewTasks.delete(task);
        sourceTasks.delete(task);
        if (sourceTasks.size === 0) {
          this.reviewTasksBySource.delete(entry.sourceId);
        }
        this.reviewQueueSize = Math.max(0, this.reviewQueueSize - 1);
        if (!this.closed) {
          this.emit();
        }
      });
    this.reviewTasks.add(task);
    sourceTasks.add(task);
    void task;
  }

  private updateSubtitle(
    id: string,
    update: Partial<Pick<TuiSubtitleEntry, "translation" | "revisedTranslation">>,
  ): void {
    this.subtitles = this.subtitles.map((entry) =>
      entry.id === id ? { ...entry, ...update } : entry,
    );
    this.emit();
  }

  private async appendRecordingTranscript(
    entry: Parameters<RecordingManager["appendTranscript"]>[0],
    sessionId?: string,
  ): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      await this.recording.appendTranscript(entry, sessionId);
    } catch (error) {
      this.logger.error(
        `Transcript persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        `recording:${entry.sourceId}`,
      );
    }
  }

  private handleAsrFailure(
    sourceId: AudioSourceId,
    generation: number,
    error: Error,
  ): void {
    void this.withLifecycle(async () => {
      if (this.sourceGenerations.get(sourceId) !== generation) {
        return;
      }
      this.sourceGenerations.set(sourceId, generation + 1);
      const session = this.asrSessions.get(sourceId);
      this.asrSessions.delete(sourceId);
      const assembler = this.transcriptAssemblers.get(sourceId);
      this.transcriptAssemblers.delete(sourceId);
      assembler?.discard();
      await Promise.allSettled([
        this.audio.stop(sourceId),
        ...(session ? [session.stop()] : []),
      ]);
      const state = this.sources[sourceId];
      state.phase = "error";
      state.error = error.message;
      this.running = this.anyAudioActive();
      this.logger.error(error.message, `asr:${sourceId}`);
      this.emit();
    }).catch(() => undefined);
  }

  private async resetAsrAfterDiscontinuity(sourceId: AudioSourceId): Promise<void> {
    const old = this.asrSessions.get(sourceId);
    if (!old || !this.audio.isActive(sourceId)) {
      return;
    }
    const generation = (this.sourceGenerations.get(sourceId) ?? 0) + 1;
    this.sourceGenerations.set(sourceId, generation);
    this.asrSessions.delete(sourceId);
    const oldAssembler = this.transcriptAssemblers.get(sourceId);
    this.transcriptAssemblers.delete(sourceId);
    oldAssembler?.discard();
    await old.stop(false);
    if (!this.audio.isActive(sourceId) || this.closed) {
      return;
    }
    this.logger.warn("Resetting Whisper after an audio discontinuity", `asr:${sourceId}`);
    const models = await this.asrModels.ensureModels(this.modelOperations.signal);
    const assembler = this.createTranscriptAssembler(sourceId, generation);
    const session = new FfmpegWhisperSession(
      sourceId,
      this.sourceLanguage,
      models,
      this.logger,
      (transcript) => {
        if (this.sourceGenerations.get(sourceId) === generation) {
          assembler.push(transcript);
        }
      },
      (error) => this.handleAsrFailure(sourceId, generation, error),
    );
    try {
      await session.start();
      if (this.sourceGenerations.get(sourceId) === generation && this.audio.isActive(sourceId)) {
        this.asrSessions.set(sourceId, session);
        this.transcriptAssemblers.set(sourceId, assembler);
      } else {
        assembler.discard();
        await session.stop();
      }
    } catch (error) {
      assembler.discard();
      await session.stop().catch(() => undefined);
      await this.audio.stop(sourceId).catch(() => undefined);
      const state = this.sources[sourceId];
      state.phase = "error";
      state.error = error instanceof Error ? error.message : String(error);
      this.running = this.anyAudioActive();
      throw error;
    }
  }

  private createTranscriptAssembler(
    sourceId: AudioSourceId,
    generation: number,
  ): TranscriptAssembler {
    return new TranscriptAssembler((transcript) => {
      if (this.sourceGenerations.get(sourceId) === generation) {
        this.handleTranscript(transcript);
      }
    });
  }

  private enabledSources(): AudioSourceId[] {
    return (["system", "microphone"] as const).filter((sourceId) => this.sources[sourceId].enabled);
  }

  private resetForNewSession(sourceId: AudioSourceId): void {
    this.subtitles = this.subtitles.filter((entry) => entry.sourceId !== sourceId);
    this.contexts.delete(sourceId);
    this.lastTranscripts.delete(sourceId);
  }

  private async drainProcessing(sourceId?: AudioSourceId): Promise<void> {
    if (sourceId) {
      while (this.translationQueues.has(sourceId)) {
        const task = this.translationQueues.get(sourceId);
        if (task) await Promise.allSettled([task]);
      }
      const reviews = this.reviewTasksBySource.get(sourceId);
      while (reviews && reviews.size > 0) {
        await Promise.allSettled([...reviews]);
      }
      return;
    }
    while (this.translationQueues.size > 0) {
      await Promise.allSettled([...this.translationQueues.values()]);
    }
    while (this.reviewTasks.size > 0) {
      await Promise.allSettled([...this.reviewTasks]);
    }
  }

  private pushNotification(kind: TuiNotification["kind"], message: string): void {
    this.notifications = [
      ...this.notifications.slice(-7),
      { id: randomUUID(), kind, message },
    ];
    this.emit();
  }

  private updateModelHealth(
    model: ProviderModelId,
    update: Omit<TuiModelHealth, "model">,
  ): void {
    this.modelHealth = this.modelHealth.map((item) =>
      item.model === model ? { model, ...update } : item);
    this.emit();
  }

  private hasActiveSession(): boolean {
    return (["system", "microphone"] as const).some(
      (sourceId) => this.sessionPhases[sourceId] !== "idle",
    );
  }

  private anyAudioActive(): boolean {
    return (["system", "microphone"] as const).some((sourceId) => this.audio.isActive(sourceId));
  }

  private aggregateSessionPhase(): TuiSessionPhase {
    const phases = Object.values(this.sessionPhases);
    if (phases.includes("saving")) return "saving";
    if (phases.includes("recording")) return "recording";
    if (phases.includes("paused")) return "paused";
    return "idle";
  }

  private sourceSessionSnapshot(sourceId: AudioSourceId): TuiSnapshot["sessions"][AudioSourceId] {
    const lastSaved = this.recording.lastSaved(sourceId);
    return {
      phase: this.sessionPhases[sourceId],
      recording: this.recording.active(sourceId),
      archive: {
        rootDirectory: this.recording.archiveRoot,
        currentName: this.archiveNames[sourceId],
        ...(lastSaved ? { lastSaved } : {}),
      },
    };
  }

  private resetLanguageState(): void {
    this.settingsRevision += 1;
    this.contexts.clear();
    this.lastTranscripts.clear();
    for (const controller of this.translationControllers.values()) {
      controller.abort();
    }
    for (const controller of this.reviewControllers.values()) {
      controller.abort();
    }
  }

  private withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("Application is shutting down"));
    }
    const run = this.lifecycleTail.then(operation);
    this.lifecycleTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private sourceSnapshot(sourceId: AudioSourceId, label: string): TuiSourceState {
    const state = this.sources[sourceId];
    return {
      id: sourceId,
      label,
      enabled: state.enabled,
      phase: state.phase,
      level: state.level,
      droppedFrames: state.droppedFrames,
      ...(state.deviceId ? { deviceId: state.deviceId } : {}),
      ...(state.deviceLabel ? { deviceLabel: state.deviceLabel } : {}),
      ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  private emit(): void {
    this.events.emit("snapshot", this.getSnapshot());
  }
}

export async function createApplicationController(
  rootDirectory = process.cwd(),
): Promise<ApplicationController> {
  const controller = new ApplicationController(rootDirectory);
  await controller.initialize();
  return controller;
}

function cycleValue(
  values: readonly TuiLanguage[],
  current: string,
  direction: 1 | -1,
): string {
  const index = Math.max(0, values.findIndex((item) => item.code === current));
  return values[(index + direction + values.length) % values.length]?.code ?? current;
}

function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function groupSubtitleParagraphs(
  entries: readonly TuiSubtitleEntry[],
  sourceId: AudioSourceId,
): TuiSubtitleParagraph[] {
  const sourceEntries = entries.filter((entry) => entry.sourceId === sourceId);
  const paragraphs: TuiSubtitleParagraph[] = [];
  let current: TuiSubtitleEntry[] = [];
  let currentCharacters = 0;
  let previousTime: number | undefined;

  const commit = (): void => {
    const first = current[0];
    if (!first) return;
    paragraphs.push({
      id: first.id,
      sourceId,
      timestamp: first.timestamp,
      sentences: current,
    });
    current = [];
    currentCharacters = 0;
  };

  for (const entry of sourceEntries) {
    const entryTime = timeOfDaySeconds(entry.timestamp);
    const gapSeconds = previousTime === undefined ? 0 : Math.max(0, entryTime - previousTime);
    const entryCharacters = entry.sourceText.length + entry.translation.length;
    if (
      current.length > 0 &&
      (gapSeconds > 12 || current.length >= 4 || currentCharacters + entryCharacters > 720)
    ) {
      commit();
    }
    current.push(entry);
    currentCharacters += entryCharacters;
    previousTime = entryTime;
  }
  commit();
  return paragraphs;
}

function timeOfDaySeconds(timestamp: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = timestamp.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function otherTranslationModel(model: TuiTranslationModel): TuiTranslationModel {
  return model === "hy-mt2-plus" ? "hy-mt2-pro" : "hy-mt2-plus";
}

function sourceLabel(sourceId: AudioSourceId): string {
  return sourceId === "system" ? "电脑声音" : "麦克风";
}

function isPredominantlyTargetLanguage(text: string, targetLanguage: string): boolean {
  const compact = text.replace(/[\s\p{P}\p{S}\d]+/gu, "");
  if (compact.length < 8) {
    return false;
  }
  const patterns: Readonly<Record<string, RegExp>> = {
    zh: /\p{Script=Han}/gu,
    ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
    ko: /\p{Script=Hangul}/gu,
    en: /[A-Za-z]/gu,
  };
  const language = targetLanguage.toLowerCase().split("-")[0] ?? targetLanguage;
  const matching = compact.match(patterns[language] ?? /$a/gu)?.length ?? 0;
  return matching >= 8 && matching / compact.length >= 0.65;
}
