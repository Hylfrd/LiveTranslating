import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AudioSourceId } from "../audio/types.js";
import { Pcm16WavWriter } from "./wav-writer.js";

interface RecordingSession {
  readonly id: string;
  readonly directory: string;
  readonly startedAt: string;
  readonly tracks: Map<AudioSourceId, RecordingTrack>;
  readonly segmentNumbers: Map<AudioSourceId, number>;
  readonly transcripts: Map<string, RecordedTranscript>;
  readonly failedSources: Set<AudioSourceId>;
  readonly activeFromMs: number;
  acceptingAudio: boolean;
  finalizing: boolean;
  finalized: boolean;
  endedAtMs: number | undefined;
  cleanupTimer: NodeJS.Timeout | undefined;
  transcriptWriteTail: Promise<void>;
}

interface RecordingTrack {
  readonly segment: number;
  readonly startedAt: number;
  readonly writer: Pcm16WavWriter;
}

export class RecordingWriteError extends Error {
  constructor(
    readonly sourceId: AudioSourceId,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecordingWriteError";
  }
}

export interface RecordedTranscript {
  id: string;
  sourceId: AudioSourceId;
  timestamp: string;
  sourceText: string;
  translation: string;
  revisedTranslation?: string;
}

export class RecordingManager {
  private session: RecordingSession | undefined;
  private readonly sessions = new Map<string, RecordingSession>();

  constructor(private readonly rootDirectory = process.cwd()) {}

  get active(): boolean {
    return this.session?.acceptingAudio ?? false;
  }

  get directory(): string | undefined {
    return this.session?.directory;
  }

  get sessionId(): string | undefined {
    return this.session?.acceptingAudio ? this.session.id : undefined;
  }

  sessionIdForSpeech(speechStartedAt: number, speechEndedAt: number): string | undefined {
    const midpoint = speechStartedAt + Math.max(0, speechEndedAt - speechStartedAt) / 2;
    const sessions = [...this.sessions.values()].reverse();
    return sessions.find(
      (session) =>
        session.activeFromMs <= midpoint &&
        (session.endedAtMs === undefined || midpoint <= session.endedAtMs),
    )?.id;
  }

  async start(metadata: Record<string, unknown>): Promise<string> {
    if (this.session) {
      return this.session.directory;
    }
    const startedAt = new Date().toISOString();
    const directory = path.join(
      this.rootDirectory,
      "recordings",
      startedAt.replace(/[:.]/g, "-"),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session.json"),
      `${JSON.stringify({ startedAt, format: "wav/pcm_s16le/16000/mono", ...metadata }, null, 2)}\n`,
      "utf8",
    );
    const session: RecordingSession = {
      id: randomUUID(),
      directory,
      startedAt,
      tracks: new Map(),
      segmentNumbers: new Map(),
      transcripts: new Map(),
      failedSources: new Set(),
      activeFromMs: Date.now(),
      acceptingAudio: true,
      finalizing: false,
      finalized: false,
      endedAtMs: undefined,
      cleanupTimer: undefined,
      transcriptWriteTail: Promise.resolve(),
    };
    this.session = session;
    this.sessions.set(session.id, session);
    return directory;
  }

  writePcm(sourceId: AudioSourceId, chunk: Buffer): void {
    const session = this.session;
    if (!session?.acceptingAudio) {
      return;
    }
    if (session.failedSources.has(sourceId)) {
      return;
    }
    let track = session.tracks.get(sourceId);
    try {
      const now = Date.now();
      if (track && now - track.startedAt >= 15 * 60 * 1000) {
        track.writer.close();
        session.tracks.delete(sourceId);
        track = undefined;
      }
      if (!track) {
        const segment = (session.segmentNumbers.get(sourceId) ?? 0) + 1;
        session.segmentNumbers.set(sourceId, segment);
        const baseName = `${sourceId}-${String(segment).padStart(3, "0")}.wav`;
        const finalPath = path.join(session.directory, baseName);
        track = {
          segment,
          startedAt: now,
          writer: new Pcm16WavWriter(`${finalPath}.part`, finalPath),
        };
        session.tracks.set(sourceId, track);
      }
      track.writer.writeFloat32(chunk);
    } catch (error) {
      session.tracks.delete(sourceId);
      session.failedSources.add(sourceId);
      if (track) {
        try {
          track.writer.close();
        } catch {
          // The write error remains the primary failure reported to the caller.
        }
      }
      throw new RecordingWriteError(
        sourceId,
        `Recording write failed for ${sourceId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async appendTranscript(entry: RecordedTranscript, sessionId?: string): Promise<void> {
    const session = sessionId ? this.sessions.get(sessionId) : this.session;
    if (!session) {
      return;
    }
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = undefined;
    }
    const previous = session.transcripts.get(entry.id);
    const combined: RecordedTranscript = {
      ...(previous ?? entry),
      ...entry,
    };
    session.transcripts.set(entry.id, combined);
    const event = {
      type: entry.revisedTranslation ? "revision" : "translation",
      ...entry,
    };
    const operation = session.transcriptWriteTail.then(async () => {
      await appendFile(
        path.join(session.directory, "transcript.jsonl"),
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
      if (session.finalizing || session.finalized) {
        await this.writeTranscriptMarkdown(session);
      }
    });
    session.transcriptWriteTail = operation.catch(() => undefined);
    try {
      await operation;
    } finally {
      if (session.finalized) {
        this.scheduleCleanup(session);
      }
    }
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    session.acceptingAudio = false;
    session.finalizing = true;
    session.endedAtMs = Date.now();
    const tracks = [...session.tracks.entries()];
    session.tracks.clear();
    const errors: unknown[] = [];
    for (const [sourceId, track] of tracks) {
      try {
        track.writer.close();
      } catch (error) {
        errors.push(new RecordingWriteError(
          sourceId,
          `Recording finalization failed for ${sourceId}: ${errorMessage(error)}`,
          { cause: error },
        ));
      }
    }
    const finalize = session.transcriptWriteTail.then(async () => {
      try {
        await this.writeTranscriptMarkdown(session);
      } catch (error) {
        errors.push(error);
      }
      try {
        await writeFile(
          path.join(session.directory, "completed.json"),
          `${JSON.stringify({
            startedAt: session.startedAt,
            endedAt: new Date(session.endedAtMs ?? Date.now()).toISOString(),
            ...(session.failedSources.size > 0
              ? { failedRecordingSources: [...session.failedSources] }
              : {}),
          }, null, 2)}\n`,
          "utf8",
        );
      } catch (error) {
        errors.push(error);
      }
    });
    session.transcriptWriteTail = finalize.catch(() => undefined);
    try {
      await finalize;
    } finally {
      session.finalizing = false;
      session.finalized = true;
      if (this.session === session) {
        this.session = undefined;
      }
      this.scheduleCleanup(session);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Recording cleanup completed with errors");
    }
  }

  private async writeTranscriptMarkdown(session: RecordingSession): Promise<void> {
    const markdown = [...session.transcripts.values()]
      .map(
        (entry) =>
          `- ${entry.timestamp} [${entry.sourceId}] ${entry.sourceText}\n  ${entry.revisedTranslation ?? entry.translation}`,
      )
      .join("\n");
    if (markdown) {
      await writeFile(path.join(session.directory, "transcript.md"), `${markdown}\n`, "utf8");
    }
  }

  private scheduleCleanup(session: RecordingSession): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
    }
    session.cleanupTimer = setTimeout(() => {
      if (session.finalized && this.session !== session) {
        this.sessions.delete(session.id);
      }
    }, 15 * 60 * 1000);
    session.cleanupTimer.unref();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
