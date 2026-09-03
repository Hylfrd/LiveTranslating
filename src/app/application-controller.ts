import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { FfmpegWhisperSession, type AsrTranscript } from "../asr/ffmpeg-whisper.js";
import { AsrModelManager } from "../asr/model-manager.js";
import { TranscriptAssembler, cleanAsrText } from "../asr/transcript-assembler.js";
import type { AudioSourceId } from "../audio/types.js";
import { config } from "../config.js";
import { GlossaryStore } from "../glossary/glossary-store.js";
import { AppLogger } from "../logging/app-logger.js";
import { RecordingManager } from "../recording/recording-manager.js";
import { NativeAudioManager, type AudioManagerEvent } from "../sources/native-audio-manager.js";
import type {
  TuiAudioDevice,
  TuiController,
  TuiLanguage,
  TuiSnapshot,
  TuiSourcePhase,
  TuiSourceState,
  TuiSubtitleEntry,
  TuiTranslationModel,
} from "../tui/controller.js";
import { OpenAICompatibleTranslationProvider } from "../translation/provider.js";
import type { TranslationRequest } from "../translation/schema.js";

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
  readonly glossary: Array<{ source: string; target: string }>;
  readonly recordingSessionId?: string;
}

export class ApplicationController implements TuiController {
  private readonly events = new EventEmitter();
  private readonly logger: AppLogger;
  private readonly recording: RecordingManager;
  private readonly glossary: GlossaryStore;
  private readonly audio: NativeAudioManager;
  private readonly asrModels: AsrModelManager;
  private readonly translator = new OpenAICompatibleTranslationProvider(config.translation);
  private readonly asrSessions = new Map<AudioSourceId, FfmpegWhisperSession>();
  private readonly transcriptAssemblers = new Map<AudioSourceId, TranscriptAssembler>();
  private readonly translationQueues = new Map<AudioSourceId, Promise<void>>();
  private readonly translationControllers = new Map<string, AbortController>();
  private readonly reviewControllers = new Map<string, AbortController>();
  private readonly reviewTasks = new Set<Promise<void>>();
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
  private transitioning = false;
  private sourceLanguage = "en";
  private targetLanguage = "zh";
  private model: TuiTranslationModel = "deepseek-v4-flash";
  private reviewerEnabled = true;
  private reviewQueueSize = 0;
  private readonly sources: Record<AudioSourceId, MutableSourceState> = {
    system: {
      enabled: false,
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
    this.glossary = new GlossaryStore(rootDirectory);
    this.audio = new NativeAudioManager(this.logger, this.recording);
    this.asrModels = new AsrModelManager(this.logger, rootDirectory);
    this.audio.subscribe((event) => this.handleAudioEvent(event));
    this.logger.subscribe(() => this.emit());
  }

  async initialize(): Promise<void> {
    const count = await this.glossary.load();
    this.logger.info(`Loaded ${count} glossary terms from ${this.glossary.filePath}`, "glossary");
    const devices = this.audio.listMicrophones();
    const defaultId = this.audio.defaultMicrophoneId();
    this.sources.microphone.deviceId = defaultId ?? devices[0]?.id;
    this.sources.microphone.deviceLabel = devices.find(
      (device) => device.id === this.sources.microphone.deviceId,
    )?.name;
    this.logger.info(`Found ${devices.length} microphone device(s)`, "audio");
    this.emit();
  }

  getSnapshot(): TuiSnapshot {
    return {
      running: this.running,
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
      recording: this.recording.active,
      reviewerEnabled: this.reviewerEnabled,
      reviewQueueSize: this.reviewQueueSize,
      glossaryCount: this.glossary.count,
      ...(this.glossary.lastUpdatedAt
        ? { glossaryUpdatedAt: this.glossary.lastUpdatedAt.toISOString() }
        : {}),
      subtitles: this.subtitles,
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
    return this.withLifecycle(async () => {
      this.transitioning = true;
      this.emit();
      try {
        if (this.running) {
          await this.stopAllSources();
          this.running = false;
          this.logger.info("Capture stopped", "app");
        } else {
          const enabled = (["system", "microphone"] as const).filter(
            (sourceId) => this.sources[sourceId].enabled,
          );
          if (enabled.length === 0) {
            throw new Error("Enable at least one audio source");
          }
          await this.asrModels.ensureModels(this.modelOperations.signal);
          const starts = await Promise.allSettled(
            enabled.map((sourceId) => this.startSource(sourceId)),
          );
          for (const result of starts) {
            if (result.status === "rejected") {
              this.logger.error(
                `Source failed to start: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
                "audio",
              );
            }
          }
          this.running = enabled.some((sourceId) => this.audio.isActive(sourceId));
          if (!this.running) {
            throw new Error("No selected audio source could be started");
          }
          this.logger.info(`Capture started with ${enabled.join(", ")}`, "app");
        }
      } finally {
        this.transitioning = false;
        this.emit();
      }
    });
  }

  async toggleSource(sourceId: AudioSourceId): Promise<void> {
    return this.withLifecycle(async () => {
      const state = this.sources[sourceId];
      state.enabled = !state.enabled;
      if (this.running) {
        if (state.enabled) {
          await this.startSource(sourceId);
        } else {
          await this.stopSource(sourceId);
        }
        this.running = (["system", "microphone"] as const).some((id) => this.audio.isActive(id));
      }
      this.emit();
    });
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
      "deepseek-v4-flash",
      "hy-mt2-pro",
    ];
    const index = models.indexOf(this.model);
    this.model = models[(index + direction + models.length) % models.length] ?? "deepseek-v4-flash";
    this.logger.info(`Primary translation model: ${this.model}`, "settings");
    this.emit();
  }

  async toggleRecording(): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.recording.active) {
        const directory = this.recording.directory;
        await this.recording.stop();
        this.logger.info(`Recording saved to ${directory ?? "recordings"}`, "recording");
      } else {
        const directory = await this.recording.start({
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.model,
          sources: (["system", "microphone"] as const).filter((id) => this.sources[id].enabled),
        });
        this.logger.info(`Recording started: ${directory}`, "recording");
      }
      this.emit();
    });
  }

  toggleReviewer(): void {
    this.reviewerEnabled = !this.reviewerEnabled;
    if (!this.reviewerEnabled) {
      for (const controller of this.reviewControllers.values()) {
        controller.abort();
      }
    }
    this.logger.info(`DeepSeek review ${this.reviewerEnabled ? "enabled" : "disabled"}`, "review");
    this.emit();
  }

  async reloadGlossary(): Promise<void> {
    return this.withLifecycle(async () => {
      const count = await this.glossary.load();
      this.logger.info(`Reloaded ${count} glossary terms`, "glossary");
      this.emit();
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.closing = true;
    this.modelOperations.abort(new Error("Application shutdown"));
    this.shutdownPromise = this.lifecycleTail.catch(() => undefined).then(async () => {
      await this.stopAllSources().catch((error) => {
        this.logger.error(
          `Audio shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          "app",
        );
      });
      this.running = false;
      await Promise.allSettled([...this.translationQueues.values()]);
      this.translationQueues.clear();
      await Promise.allSettled([...this.reviewTasks]);
      this.closed = true;
      for (const controller of this.reviewControllers.values()) {
        controller.abort();
      }
      this.reviewControllers.clear();
      for (const controller of this.translationControllers.values()) {
        controller.abort();
      }
      this.translationControllers.clear();
      await this.recording.stop().catch((error) => {
        this.logger.error(
          `Recording shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          "recording",
        );
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
    const entry: TuiSubtitleEntry = {
      id: randomUUID(),
      sourceId: transcript.sourceId,
      timestamp: formatLocalTime(transcript.speechStartedAt),
      sourceText: text,
      translation: "",
      isFinal: true,
    };
    this.subtitles = [...this.subtitles.slice(-99), entry];
    const recordingSessionId = this.recording.sessionIdForSpeech(
      transcript.speechStartedAt,
      transcript.speechEndedAt,
    );
    const settings: TranslationJobSettings = {
      revision: this.settingsRevision,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      model: this.model,
      glossary: this.glossary
        .matching(entry.sourceText)
        .map(({ source, target }) => ({ source, target })),
      ...(recordingSessionId ? { recordingSessionId } : {}),
    };
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
      glossary: settings.glossary,
      model: settings.model,
    };
    const started = performance.now();
    try {
      const result = await this.translator.translate(request, controller.signal);
      if (this.closed || settings.revision !== this.settingsRevision) {
        return;
      }
      this.sources[entry.sourceId].latencyMs = performance.now() - started;
      this.updateSubtitle(entry.id, { translation: result.text });
      const turn: ContextTurn = { id: entry.id, source: entry.sourceText, translation: result.text };
      this.contexts.set(entry.sourceId, [...contexts.slice(-7), turn]);
      await this.appendRecordingTranscript(
        { ...entry, translation: result.text },
        settings.recordingSessionId,
      );
      this.logger.info(`Translated with ${settings.model} in ${Math.round(performance.now() - started)} ms`, entry.sourceId);
      if (this.reviewerEnabled) {
        this.startReview(entry, result.text, settings);
      }
    } finally {
      this.translationControllers.delete(entry.id);
    }
  }

  private startReview(
    entry: TuiSubtitleEntry,
    originalTranslation: string,
    settings: TranslationJobSettings,
  ): void {
    const controller = new AbortController();
    this.reviewControllers.set(entry.id, controller);
    this.reviewQueueSize += 1;
    this.emit();
    const context = (this.contexts.get(entry.sourceId) ?? [])
      .filter((turn) => turn.id !== entry.id)
      .slice(-4)
      .map((turn) => ({ source: turn.source, translation: turn.translation }));
    const task = this.translator
      .reviewTranslation(
        {
          sourceText: entry.sourceText,
          originalTranslation,
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage,
          context,
          glossary: settings.glossary,
        },
        controller.signal,
      )
      .then(async (review) => {
        if (this.closed || settings.revision !== this.settingsRevision) {
          return;
        }
        if (!review.corrected) {
          this.logger.debug("DeepSeek review accepted original translation", entry.sourceId);
          return;
        }
        this.updateSubtitle(entry.id, { revisedTranslation: review.reviewedTranslation });
        const turn = (this.contexts.get(entry.sourceId) ?? []).find((item) => item.id === entry.id);
        if (turn) {
          turn.translation = review.reviewedTranslation;
        }
        await this.appendRecordingTranscript(
          {
            ...entry,
            translation: originalTranslation,
            revisedTranslation: review.reviewedTranslation,
          },
          settings.recordingSessionId,
        );
        this.logger.info("DeepSeek review produced one delayed revision", entry.sourceId);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.logger.warn(
            `DeepSeek review failed: ${error instanceof Error ? error.message : String(error)}`,
            entry.sourceId,
          );
        }
      })
      .finally(() => {
        this.reviewControllers.delete(entry.id);
        this.reviewTasks.delete(task);
        this.reviewQueueSize = Math.max(0, this.reviewQueueSize - 1);
        if (!this.closed) {
          this.emit();
        }
      });
    this.reviewTasks.add(task);
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
      this.running = (["system", "microphone"] as const).some((id) => this.audio.isActive(id));
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
      this.running = (["system", "microphone"] as const).some((id) => this.audio.isActive(id));
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
