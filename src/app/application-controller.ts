import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { FfmpegWhisperSession, type AsrTranscript } from "../asr/ffmpeg-whisper.js";
import { AsrModelManager, type AsrModelProgress } from "../asr/model-manager.js";
import { TranscriptAssembler, cleanAsrText } from "../asr/transcript-assembler.js";
import type {
  AudioSourceDefinition,
  AudioSourceId,
} from "../audio/types.js";
import { BillingTracker } from "../billing/billing-tracker.js";
import { config } from "../config.js";
import { AppLogger } from "../logging/app-logger.js";
import {
  createDefaultArchiveName,
  type ArchiveExportKind,
  RecordingManager,
} from "../recording/recording-manager.js";
import { NativeAudioManager, type AudioManagerEvent } from "../sources/native-audio-manager.js";
import {
  listSystemAudioApplications,
  type SystemAudioApplication,
} from "../sources/audio-source-catalog.js";
import { RemoteSourceServer } from "../sources/remote-source-server.js";
import { SourceStore } from "../sources/source-store.js";
import type {
  TuiAudioDevice,
  TuiController,
  TuiLanguage,
  TuiModelHealth,
  TuiNewSourceInput,
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
import { OpenAICompatibleTranslationProvider, type TranslationProviderTelemetry } from "../translation/provider.js";
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
  definition: AudioSourceDefinition;
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
  private readonly remoteSources: RemoteSourceServer;
  private readonly sourceStore: SourceStore;
  private readonly asrModels: AsrModelManager;
  private readonly translator = new OpenAICompatibleTranslationProvider(config.translation);
  private readonly asrSessions = new Map<AudioSourceId, FfmpegWhisperSession>();
  private readonly transcriptAssemblers = new Map<AudioSourceId, TranscriptAssembler>();
  private readonly translationTasks = new Set<Promise<void>>();
  private readonly translationTasksBySource = new Map<AudioSourceId, Set<Promise<void>>>();
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
  private systemAudioApplications: SystemAudioApplication[] = [];
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
  private readonly sourceOrder: AudioSourceId[] = ["system", "microphone"];
  private notifications: TuiNotification[] = [];
  private sourceLanguage = "auto";
  private targetLanguage = "zh";
  private model: TuiTranslationModel = "hy-mt2-plus";
  private reviewerEnabled = false;
  private secondaryTranslationEnabled = false;
  private terminologyReviewEnabled = true;
  private terminologyReviewModel: TuiReviewModel = "deepseek-v4-flash";
  private reviewQueueSize = 0;
  private lastTranslationFailureNoticeAt = 0;
  private modelHealth: TuiModelHealth[] = ([
    "hy-mt2-plus",
    "hy-mt2-pro",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ] as const).map((model) => ({ model, status: "idle" }));
  private readonly sources: Record<AudioSourceId, MutableSourceState> = {
    system: {
      definition: {
        id: "system",
        name: "电脑声音",
        icon: "monitor",
        capture: { kind: "system", allSystemAudio: true, processes: [] },
        builtIn: true,
      },
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
      definition: {
        id: "microphone",
        name: "麦克风",
        icon: "microphone",
        capture: { kind: "microphone", deviceIds: [] },
        builtIn: true,
      },
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
    this.remoteSources = new RemoteSourceServer(this.audio, this.logger, 47321, rootDirectory);
    this.sourceStore = new SourceStore(rootDirectory);
    this.asrModels = new AsrModelManager(
      this.logger,
      rootDirectory,
      (progress) => this.handleAsrModelProgress(progress),
    );
    this.translator.registry.subscribeTelemetry((event) => this.handleTranslationTelemetry(event));
    this.logger.info(
      "Runtime paths and provider configuration resolved",
      "app",
      {
        rootDirectory,
        logDirectory: this.logger.directory,
        modelDirectory: path.join(rootDirectory, "models"),
        configuredModels: this.translator.registry.configuredModels(),
      },
      "app.runtime.resolved",
    );
    this.audio.subscribe((event) => this.handleAudioEvent(event));
    this.logger.subscribe(() => this.emit());
  }

  async initialize(): Promise<void> {
    await this.recording.initialize();
    const devices = this.audio.listMicrophones();
    const defaultId = this.audio.defaultMicrophoneId();
    const microphone = this.sourceState("microphone");
    microphone.deviceId = defaultId ?? devices[0]?.id;
    microphone.deviceLabel = devices.find(
      (device) => device.id === microphone.deviceId,
    )?.name;
    microphone.definition = {
      ...microphone.definition,
      capture: {
        kind: "microphone",
        deviceIds: microphone.deviceId ? [microphone.deviceId] : [],
      },
    };
    this.systemAudioApplications = await listSystemAudioApplications(this.logger);
    const savedSources = await this.sourceStore.load().catch((error) => {
      this.logger.warn(`Saved sources could not be loaded: ${String(error)}`, "sources");
      return [];
    });
    for (const definition of savedSources) {
      if (!this.sources[definition.id] && !definition.builtIn) {
        await this.registerSourceDefinition(definition);
      }
    }
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
      sources: Object.fromEntries(
        this.sourceOrder.map((sourceId) => [sourceId, this.sourceSnapshot(sourceId)]),
      ),
      sourceOrder: this.sourceOrder,
      microphoneDevices: this.microphones,
      systemAudioApplications: this.systemAudioApplications,
      sourceLanguages: SOURCE_LANGUAGES,
      targetLanguages: TARGET_LANGUAGES,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      model: this.model,
      recording: this.recording.active(),
      sessions: Object.fromEntries(
        this.sourceOrder.map((sourceId) => [sourceId, this.sourceSessionSnapshot(sourceId)]),
      ),
      archives: this.recording.archives(),
      billing: this.billing.getSnapshot(),
      notifications: this.notifications,
      reviewerEnabled: this.reviewerEnabled,
      secondaryTranslationEnabled: this.secondaryTranslationEnabled,
      terminologyReviewEnabled: this.terminologyReviewEnabled,
      terminologyReviewModel: this.terminologyReviewModel,
      reviewQueueSize: this.reviewQueueSize,
      modelHealth: this.modelHealth,
      subtitles: this.subtitles,
      paragraphs: Object.fromEntries(
        this.sourceOrder.map((sourceId) => [sourceId, groupSubtitleParagraphs(this.subtitles, sourceId)]),
      ),
      logs: this.logger.recent(500),
    };
  }

  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void {
    this.events.on("snapshot", listener);
    return () => this.events.off("snapshot", listener);
  }

  async addSource(input: TuiNewSourceInput): Promise<void> {
    return this.withLifecycle(async () => {
      const name = input.name.trim().slice(0, 64);
      if (!name) throw new Error("Source name cannot be empty");
      if (input.capture.kind === "system" && !input.capture.allSystemAudio && input.capture.processes.length === 0) {
        throw new Error("Select at least one computer application or all system audio");
      }
      if (input.capture.kind === "microphone" && input.capture.deviceIds.length === 0) {
        throw new Error("Select at least one microphone");
      }
      const sourceId = `${input.capture.kind}-${randomUUID()}`;
      const definition: AudioSourceDefinition = input.capture.kind === "remote"
        ? {
            id: sourceId,
            name,
            icon: input.icon,
            capture: { kind: "remote", token: randomUUID().replaceAll("-", "") },
          }
        : { id: sourceId, name, icon: input.icon, capture: input.capture };
      await this.registerSourceDefinition(definition);
      await this.persistCustomSources();
      this.logger.info(`Added ${definition.capture.kind} source: ${name}`, "sources");
      this.emit();
    });
  }

  async refreshSourceCatalog(): Promise<void> {
    const [applications] = await Promise.all([
      listSystemAudioApplications(this.logger),
      Promise.resolve(this.audio.listMicrophones()),
    ]);
    this.systemAudioApplications = applications;
    this.emit();
  }

  async toggleRunning(): Promise<void> {
    const active = this.sourceOrder.filter(
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
      const source = this.sourceState(sourceId);
      if (this.sessionPhases[sourceId] !== "idle") {
        return;
      }
      this.transitioning = true;
      this.emit();
      try {
        const startsNewBillingWindow = !this.hasActiveSession();
        source.enabled = true;
        this.resetForNewSession(sourceId);
        await this.recording.start(sourceId, this.archiveNames[sourceId] ?? createDefaultArchiveName(), {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.model,
          sourceId,
          sourceName: source.definition.name,
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
      for (const sourceId of this.sourceOrder) {
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
        this.sourceState(sourceId).phase = "paused";
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
          this.pushNotification("success", `${this.sourceName(sourceId)}已自动保存：${archive.name}`);
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
      const state = this.sourceState(sourceId);
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
    if (this.sourceState(sourceId).enabled !== enabled) {
      await this.toggleSource(sourceId);
    }
  }

  async cycleMicrophoneDevice(direction: 1 | -1 = 1): Promise<void> {
    return this.withLifecycle(async () => {
      const microphone = this.sourceState("microphone");
      this.audio.listMicrophones();
      if (this.microphones.length === 0) {
        return;
      }
      const current = this.microphones.findIndex(
        (device) => device.id === microphone.deviceId,
      );
      const base = current >= 0 ? current : direction === 1 ? -1 : 0;
      const next = (base + direction + this.microphones.length) % this.microphones.length;
      const device = this.microphones[next];
      if (!device) {
        return;
      }
      microphone.deviceId = device.id;
      microphone.deviceLabel = device.label;
      microphone.definition = {
        ...microphone.definition,
        capture: { kind: "microphone", deviceIds: [device.id] },
      };
      if (this.sessionPhases.microphone === "recording") {
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

  async renameArchive(currentName: string, nextName: string): Promise<void> {
    return this.withLifecycle(async () => {
      const renamed = await this.recording.renameArchive(currentName, nextName);
      this.pushNotification("success", `已重命名为 ${renamed}`);
      this.logger.info(`Renamed archive ${currentName} to ${renamed}`, "recording");
      this.emit();
    });
  }

  async refreshArchives(): Promise<void> {
    await this.recording.refreshArchives();
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

  archiveRootDirectory(): string {
    return this.recording.archiveRoot;
  }

  archiveArtifactPath(
    archiveName: string,
    kind: ArchiveExportKind,
  ): ReturnType<RecordingManager["artifactPath"]> {
    return this.recording.artifactPath(archiveName, kind);
  }

  archiveArtifactPaths(archiveName: string): string[] {
    return (["audio", "transcription", "translation"] as const).flatMap((kind) => {
      const artifact = this.recording.artifactPath(archiveName, kind);
      return artifact ? [artifact.path] : [];
    });
  }

  archiveExists(archiveName: string): boolean {
    return this.recording.archives().some((archive) => archive.name === archiveName);
  }

  notifyExport(destination: string): void {
    this.pushNotification("success", `已导出到 ${destination}`);
  }

  notifyArchiveAction(message: string): void {
    this.pushNotification("success", message);
  }

  logDirectory(): string {
    return this.logger.directory;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.closing = true;
    for (const sourceId of this.sourceOrder) {
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
      this.translationTasks.clear();
      this.translationTasksBySource.clear();
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
      await Promise.allSettled(this.sourceOrder.map(async (sourceId) => {
        await this.recording.stop(sourceId);
        this.sessionPhases[sourceId] = "idle";
      }));
      await this.remoteSources.stop().catch((error) => {
        this.logger.warn(`Remote source server shutdown failed: ${String(error)}`, "remote");
      });
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
      await this.audio.start(this.sourceState(sourceId).definition);
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
    for (const sourceId of this.sourceOrder) {
      this.sourceGenerations.set(sourceId, (this.sourceGenerations.get(sourceId) ?? 0) + 1);
    }
  }

  private async restartAsrSessions(): Promise<void> {
    const active = this.sourceOrder.filter((id) => this.audio.isActive(id));
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
      if (!state) return;
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
      if (!state) return;
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
    this.logger.debug(
      "Transcript committed to the UI",
      `asr:${transcript.sourceId}`,
      {
        text,
        speechStartedAt: new Date(transcript.speechStartedAt).toISOString(),
        speechEndedAt: new Date(transcript.speechEndedAt).toISOString(),
        speechDurationMs: transcript.speechEndedAt - transcript.speechStartedAt,
        latencyAfterSpeechMs: Math.max(0, Date.now() - transcript.speechEndedAt),
      },
      "asr.transcript.committed",
    );
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
    const sourceTasks = this.translationTasksBySource.get(entry.sourceId) ?? new Set<Promise<void>>();
    this.translationTasksBySource.set(entry.sourceId, sourceTasks);
    const task = this.translateEntry(entry, settings)
      .catch((error) => {
        if (!this.closed) {
          this.updateSubtitle(entry.id, { translation: "", translationFailed: true });
          this.logger.error(
            `Translation failed: ${error instanceof Error ? error.message : String(error)}`,
            entry.sourceId,
            { entryId: entry.id, sourceText: entry.sourceText, error },
            "translation.failed",
          );
          const now = Date.now();
          if (now - this.lastTranslationFailureNoticeAt >= 15000) {
            this.lastTranslationFailureNoticeAt = now;
            this.pushNotification("error", "翻译请求失败，原始错误已写入运行日志");
          }
        }
      })
      .finally(() => {
        this.translationTasks.delete(task);
        sourceTasks.delete(task);
        if (sourceTasks.size === 0) {
          this.translationTasksBySource.delete(entry.sourceId);
        }
      });
    this.translationTasks.add(task);
    sourceTasks.add(task);
    void task;
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
        await this.commitInitialTranslation(entry, initial, settings, started);
      }
      const secondary = secondaryTask ? await secondaryTask : undefined;
      if (secondary?.result) {
        this.billing.record(secondary.result.model, secondary.result.usage);
      }
      if (!initial && secondary?.result) {
        initial = secondary.result;
        await this.commitInitialTranslation(entry, initial, settings, started);
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
    started: number,
  ): Promise<void> {
    if (this.closed || settings.revision !== this.settingsRevision) return;
    this.sourceState(entry.sourceId).latencyMs = performance.now() - started;
    this.updateSubtitle(entry.id, { translation: result.text });
    const turn: ContextTurn = { id: entry.id, source: entry.sourceText, translation: result.text };
    this.storeContext(entry.sourceId, turn);
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
              { entryId: entry.id, model, mode, sourceText: entry.sourceText, error },
              "translation.review.failed",
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
    update: Partial<Pick<TuiSubtitleEntry, "translation" | "revisedTranslation" | "translationFailed">>,
  ): void {
    this.subtitles = this.subtitles.map((entry) =>
      entry.id === id ? { ...entry, ...update } : entry,
    );
    this.emit();
  }

  private storeContext(sourceId: AudioSourceId, turn: ContextTurn): void {
    const subtitleOrder = new Map(
      this.subtitles
        .filter((entry) => entry.sourceId === sourceId)
        .map((entry, index) => [entry.id, index] as const),
    );
    const contexts = (this.contexts.get(sourceId) ?? [])
      .filter((entry) => entry.id !== turn.id);
    this.contexts.set(
      sourceId,
      [...contexts, turn]
        .sort((left, right) => (subtitleOrder.get(left.id) ?? 0) - (subtitleOrder.get(right.id) ?? 0))
        .slice(-8),
    );
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
      const state = this.sourceState(sourceId);
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
      const state = this.sourceState(sourceId);
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
    return this.sourceOrder.filter((sourceId) => this.sourceState(sourceId).enabled);
  }

  private resetForNewSession(sourceId: AudioSourceId): void {
    this.subtitles = this.subtitles.filter((entry) => entry.sourceId !== sourceId);
    this.contexts.delete(sourceId);
    this.lastTranscripts.delete(sourceId);
  }

  private async drainProcessing(sourceId?: AudioSourceId): Promise<void> {
    if (sourceId) {
      const translations = this.translationTasksBySource.get(sourceId);
      while (translations && translations.size > 0) {
        await Promise.allSettled([...translations]);
      }
      const reviews = this.reviewTasksBySource.get(sourceId);
      while (reviews && reviews.size > 0) {
        await Promise.allSettled([...reviews]);
      }
      return;
    }
    while (this.translationTasks.size > 0) {
      await Promise.allSettled([...this.translationTasks]);
    }
    while (this.reviewTasks.size > 0) {
      await Promise.allSettled([...this.reviewTasks]);
    }
  }

  private async registerSourceDefinition(definition: AudioSourceDefinition): Promise<void> {
    if (Object.hasOwn(this.sources, definition.id)) {
      throw new Error(`Audio source already exists: ${definition.id}`);
    }

    if (definition.capture.kind === "remote") {
      await this.remoteSources.start();
      this.remoteSources.register(definition.id, definition.capture.token);
    }
    await this.recording.registerSource(definition.id);

    const deviceId = definition.capture.kind === "microphone"
      ? definition.capture.deviceIds[0]
      : undefined;
    this.sources[definition.id] = {
      definition,
      enabled: true,
      phase: "disabled",
      deviceId,
      deviceLabel: this.selectionLabel(definition),
      level: 0,
      latencyMs: undefined,
      droppedFrames: 0,
      error: undefined,
    };
    this.sessionPhases[definition.id] = "idle";
    this.archiveNames[definition.id] = createDefaultArchiveName();
    this.sourceOrder.push(definition.id);
  }

  private async persistCustomSources(): Promise<void> {
    const definitions = this.sourceOrder
      .map((sourceId) => this.sourceState(sourceId).definition)
      .filter((definition) => !definition.builtIn);
    await this.sourceStore.save(definitions);
  }

  private handleAsrModelProgress(progress: AsrModelProgress): void {
    if (this.closed) return;
    const id = `asr-model:${progress.file}`;
    const label = progress.file.includes("silero") ? "语音活动检测模型" : "Whisper 语音模型";
    const ratio = progress.totalBytes > 0
      ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
      : 0;
    const transferred = `${formatMegabytes(progress.downloadedBytes)} / ${formatMegabytes(progress.totalBytes)}`;
    const notification: TuiNotification = progress.phase === "complete"
      ? { id, kind: "success", message: `${label}下载完成`, detail: transferred, progress: 1 }
      : progress.phase === "verifying"
        ? { id, kind: "info", message: `正在校验${label}`, detail: transferred, persistent: true, progress: 1 }
        : progress.phase === "retrying"
          ? { id, kind: "info", message: `${label}镜像失败，正在重试`, detail: progress.error ?? progress.mirror ?? "正在切换下载镜像", persistent: true, progress: ratio }
          : progress.phase === "failed"
            ? { id, kind: "error", message: `${label}下载失败`, detail: progress.error ?? "所有下载镜像均不可用", progress: ratio }
            : {
                id,
                kind: "info",
                message: `正在下载${label} · ${Math.round(ratio * 100)}%`,
                detail: `${transferred}${progress.mirror ? ` · ${progress.mirror}` : ""}`,
                persistent: true,
                progress: ratio,
              };
    const existing = this.notifications.findIndex((item) => item.id === id);
    this.notifications = existing >= 0
      ? this.notifications.map((item, index) => index === existing ? notification : item)
      : [...this.notifications.slice(-7), notification];
    this.emit();
  }

  private handleTranslationTelemetry(event: TranslationProviderTelemetry): void {
    const source = `provider:${event.model}`;
    if (event.type === "request") {
      this.logger.debug(`${event.model} request`, source, event, "provider.request");
    } else if (event.type === "response") {
      this.logger.debug(`${event.model} response in ${Math.round(event.durationMs)} ms`, source, event, "provider.response");
    } else if (event.type === "error") {
      this.logger.error(`${event.model} request failed`, source, event, "provider.error");
    } else {
      this.logger.warn(`${event.model} rate limit retry ${event.attempt}`, source, event, "provider.rate_limit_retry");
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
    return this.sourceOrder.some(
      (sourceId) => this.sessionPhases[sourceId] !== "idle",
    );
  }

  private anyAudioActive(): boolean {
    return this.sourceOrder.some((sourceId) => this.audio.isActive(sourceId));
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
      phase: this.sessionPhases[sourceId] ?? "idle",
      recording: this.recording.active(sourceId),
      archive: {
        rootDirectory: this.recording.archiveRoot,
        currentName: this.archiveNames[sourceId] ?? createDefaultArchiveName(),
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

  private sourceSnapshot(sourceId: AudioSourceId): TuiSourceState {
    const state = this.sourceState(sourceId);
    const remoteEndpoint = state.definition.capture.kind === "remote"
      ? this.remoteSources.endpoint(sourceId, state.definition.capture.token)
      : undefined;
    return {
      id: sourceId,
      label: state.definition.name,
      kind: state.definition.capture.kind,
      icon: state.definition.icon,
      selectionLabel: state.deviceLabel ?? this.selectionLabel(state.definition),
      enabled: state.enabled,
      phase: state.phase,
      level: state.level,
      droppedFrames: state.droppedFrames,
      ...(state.deviceId ? { deviceId: state.deviceId } : {}),
      ...(state.deviceLabel ? { deviceLabel: state.deviceLabel } : {}),
      ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
      ...(state.error ? { error: state.error } : {}),
      ...(remoteEndpoint ? {
        remoteUrls: remoteEndpoint.urls,
        remoteSecure: remoteEndpoint.secure,
        remoteNotice: remoteEndpoint.notice,
      } : {}),
    };
  }

  private sourceState(sourceId: AudioSourceId): MutableSourceState {
    const state = Object.hasOwn(this.sources, sourceId) ? this.sources[sourceId] : undefined;
    if (!state) throw new Error(`Unknown audio source: ${sourceId}`);
    return state;
  }

  private sourceName(sourceId: AudioSourceId): string {
    return this.sourceState(sourceId).definition.name;
  }

  private selectionLabel(definition: AudioSourceDefinition): string {
    if (definition.capture.kind === "system") {
      if (definition.capture.allSystemAudio) return "全部电脑声音";
      const names = [...new Set(definition.capture.processes.map((process) => process.name))];
      return names.length <= 1 ? (names[0] ?? "未选择电脑应用") : `${names[0] ?? "电脑应用"} 等 ${names.length} 个应用`;
    }
    if (definition.capture.kind === "microphone") {
      const names = definition.capture.deviceIds
        .map((id) => this.microphones.find((device) => device.id === id)?.label)
        .filter((name): name is string => Boolean(name));
      return names.length <= 1 ? (names[0] ?? "未选择麦克风") : `${names[0] ?? "麦克风"} 等 ${names.length} 个设备`;
    }
    return "局域网设备";
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

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`;
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
