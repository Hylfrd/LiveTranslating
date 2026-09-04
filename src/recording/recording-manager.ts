import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AudioSourceId } from "../audio/types.js";
import { Pcm16WavWriter } from "./wav-writer.js";

export type ArchiveExportKind = "audio" | "transcription" | "translation";

export interface ArchivedSession {
  readonly sourceId: AudioSourceId;
  readonly name: string;
  readonly savedAt: string;
  readonly audioDirectory: string;
  readonly transcriptionPath: string;
  readonly translationPath: string;
}

export interface RecordingMetadata {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly model: string;
  readonly sourceId: AudioSourceId;
}

interface RecordingSession {
  readonly id: string;
  readonly sourceId: AudioSourceId;
  readonly workDirectory: string;
  readonly audioWorkDirectory: string;
  readonly startedAt: string;
  readonly metadata: RecordingMetadata;
  readonly tracks: Map<AudioSourceId, RecordingTrack>;
  readonly segmentNumbers: Map<AudioSourceId, number>;
  readonly transcripts: Map<string, RecordedTranscript>;
  readonly failedSources: Set<AudioSourceId>;
  readonly activeFromMs: number;
  desiredName: string;
  acceptingAudio: boolean;
  finalizing: boolean;
  endedAtMs: number | undefined;
  transcriptWriteTail: Promise<void>;
}

interface RecordingTrack {
  readonly segment: number;
  readonly startedAt: number;
  readonly writer: Pcm16WavWriter;
}

interface TranscriptParagraph {
  readonly sourceId: AudioSourceId;
  readonly timestamp: string;
  readonly entries: RecordedTranscript[];
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
  translationOmitted?: boolean;
}

export class RecordingManager {
  private readonly activeSessions = new Map<AudioSourceId, RecordingSession>();
  private readonly latestArchives = new Map<AudioSourceId, ArchivedSession>();
  private readonly reservedNames = new Set<string>();
  private readonly sessions = new Map<string, RecordingSession>();
  readonly archiveRoot: string;
  readonly audioRoot: string;
  readonly transcriptionRoot: string;
  readonly translationRoot: string;
  private readonly workRoot: string;

  constructor(private readonly rootDirectory = process.cwd()) {
    this.archiveRoot = path.join(rootDirectory, "archives");
    this.audioRoot = path.join(this.archiveRoot, "audio");
    this.transcriptionRoot = path.join(this.archiveRoot, "transcription");
    this.translationRoot = path.join(this.archiveRoot, "translation");
    this.workRoot = path.join(this.archiveRoot, ".working");
  }

  active(sourceId?: AudioSourceId): boolean {
    if (sourceId) {
      return this.activeSessions.get(sourceId)?.acceptingAudio ?? false;
    }
    return [...this.activeSessions.values()].some((session) => session.acceptingAudio);
  }

  directory(sourceId: AudioSourceId): string | undefined {
    return this.activeSessions.get(sourceId)?.workDirectory;
  }

  sessionId(sourceId: AudioSourceId): string | undefined {
    const session = this.activeSessions.get(sourceId);
    return session?.acceptingAudio ? session.id : undefined;
  }

  currentName(sourceId: AudioSourceId): string | undefined {
    return this.activeSessions.get(sourceId)?.desiredName;
  }

  lastSaved(sourceId: AudioSourceId): ArchivedSession | undefined {
    return this.latestArchives.get(sourceId);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.audioRoot, { recursive: true }),
      mkdir(this.transcriptionRoot, { recursive: true }),
      mkdir(this.translationRoot, { recursive: true }),
      mkdir(this.workRoot, { recursive: true }),
    ]);
    const latest = await Promise.all(
      (["system", "microphone"] as const).map((sourceId) => this.findLatestArchive(sourceId)),
    );
    latest.forEach((archive) => {
      if (archive) this.latestArchives.set(archive.sourceId, archive);
    });
  }

  sessionIdForSpeech(
    sourceId: AudioSourceId,
    speechStartedAt: number,
    speechEndedAt: number,
  ): string | undefined {
    const midpoint = speechStartedAt + Math.max(0, speechEndedAt - speechStartedAt) / 2;
    const sessions = [...this.sessions.values()].reverse();
    return sessions.find(
      (session) =>
        session.sourceId === sourceId
        && session.activeFromMs <= midpoint
        && (session.endedAtMs === undefined || midpoint <= session.endedAtMs),
    )?.id;
  }

  async start(sourceId: AudioSourceId, name: string, metadata: RecordingMetadata): Promise<string> {
    const existing = this.activeSessions.get(sourceId);
    if (existing) {
      return existing.workDirectory;
    }
    await this.initialize();
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const workDirectory = path.join(this.workRoot, id);
    const audioWorkDirectory = path.join(workDirectory, "audio");
    await mkdir(audioWorkDirectory, { recursive: true });
    const session: RecordingSession = {
      id,
      sourceId,
      workDirectory,
      audioWorkDirectory,
      startedAt,
      metadata,
      tracks: new Map(),
      segmentNumbers: new Map(),
      transcripts: new Map(),
      failedSources: new Set(),
      activeFromMs: Date.now(),
      desiredName: normalizeArchiveName(name),
      acceptingAudio: true,
      finalizing: false,
      endedAtMs: undefined,
      transcriptWriteTail: Promise.resolve(),
    };
    this.activeSessions.set(sourceId, session);
    this.sessions.set(id, session);
    return workDirectory;
  }

  renameCurrent(sourceId: AudioSourceId, name: string): string {
    const normalized = normalizeArchiveName(name);
    const session = this.activeSessions.get(sourceId);
    if (session) {
      session.desiredName = normalized;
    }
    return normalized;
  }

  writePcm(sourceId: AudioSourceId, chunk: Buffer): void {
    const session = this.activeSessions.get(sourceId);
    if (!session?.acceptingAudio || session.failedSources.has(sourceId)) {
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
        const finalPath = path.join(session.audioWorkDirectory, baseName);
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
      try {
        track?.writer.close();
      } catch {
        // Preserve the original recording failure.
      }
      throw new RecordingWriteError(
        sourceId,
        `Recording write failed for ${sourceId}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async appendTranscript(entry: RecordedTranscript, sessionId?: string): Promise<void> {
    const session = sessionId
      ? this.sessions.get(sessionId)
      : this.activeSessions.get(entry.sourceId);
    if (!session || session.finalizing) {
      return;
    }
    const previous = session.transcripts.get(entry.id);
    const combined: RecordedTranscript = { ...(previous ?? entry), ...entry };
    session.transcripts.set(entry.id, combined);
    const event = {
      type: entry.revisedTranslation ? "revision" : entry.translation ? "translation" : "transcription",
      ...entry,
    };
    const operation = session.transcriptWriteTail.then(() => appendFile(
      path.join(session.workDirectory, "transcript.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    ));
    session.transcriptWriteTail = operation.catch(() => undefined);
    await operation;
  }

  async stop(sourceId: AudioSourceId): Promise<ArchivedSession | undefined> {
    const session = this.activeSessions.get(sourceId);
    if (!session) {
      return undefined;
    }
    session.acceptingAudio = false;
    session.finalizing = true;
    session.endedAtMs = Date.now();
    const name = this.reserveArchiveName(session.desiredName);
    const errors: unknown[] = [];
    for (const [sourceId, track] of session.tracks) {
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
    session.tracks.clear();
    await session.transcriptWriteTail.catch((error) => errors.push(error));

    const audioDirectory = path.join(this.audioRoot, name);
    const transcriptionPath = path.join(this.transcriptionRoot, `${name}.md`);
    const translationPath = path.join(this.translationRoot, `${name}.md`);
    const endedAt = new Date(session.endedAtMs).toISOString();
    const paragraphs = groupTranscripts(session.transcripts.values());

    try {
      await writeFile(
        transcriptionPath,
        renderTranscriptionMarkdown(name, sourceId, session.startedAt, endedAt, paragraphs),
        "utf8",
      );
      await writeFile(
        translationPath,
        renderTranslationMarkdown(
          name,
          sourceId,
          session.startedAt,
          endedAt,
          session.metadata.targetLanguage,
          paragraphs,
        ),
        "utf8",
      );
      await rename(session.audioWorkDirectory, audioDirectory);
      await rm(session.workDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    } finally {
      this.sessions.delete(session.id);
      if (this.activeSessions.get(sourceId) === session) {
        this.activeSessions.delete(sourceId);
      }
      this.reservedNames.delete(name);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Archive finalization completed with errors");
    }
    const archive: ArchivedSession = {
      sourceId,
      name,
      savedAt: endedAt,
      audioDirectory,
      transcriptionPath,
      translationPath,
    };
    this.latestArchives.set(sourceId, archive);
    return archive;
  }

  async abort(sourceId: AudioSourceId): Promise<void> {
    const session = this.activeSessions.get(sourceId);
    if (!session) {
      return;
    }
    session.acceptingAudio = false;
    for (const track of session.tracks.values()) {
      try {
        track.writer.close();
      } catch {
        // The temporary workspace is removed below.
      }
    }
    session.tracks.clear();
    this.sessions.delete(session.id);
    this.activeSessions.delete(sourceId);
    await rm(session.workDirectory, { recursive: true, force: true });
  }

  exportPath(
    sourceId: AudioSourceId,
    kind: ArchiveExportKind,
  ): { path: string; name: string; directory: boolean } | undefined {
    const archive = this.latestArchives.get(sourceId);
    if (!archive) {
      return undefined;
    }
    if (kind === "audio") {
      return { path: archive.audioDirectory, name: archive.name, directory: true };
    }
    return {
      path: kind === "transcription" ? archive.transcriptionPath : archive.translationPath,
      name: `${archive.name}.md`,
      directory: false,
    };
  }

  private reserveArchiveName(requested: string): string {
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? requested : `${requested}_${suffix}`;
      if (
        !this.reservedNames.has(name)
        && !existsSync(path.join(this.audioRoot, name))
        && !existsSync(path.join(this.transcriptionRoot, `${name}.md`))
        && !existsSync(path.join(this.translationRoot, `${name}.md`))
      ) {
        this.reservedNames.add(name);
        return name;
      }
    }
  }

  private async findLatestArchive(sourceId: AudioSourceId): Promise<ArchivedSession | undefined> {
    const files = (await readdir(this.translationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
    const candidates = (await Promise.all(files.map(async (entry) => {
      const translationPath = path.join(this.translationRoot, entry.name);
      const content = await readFile(translationPath, "utf8");
      if (!content.includes(`- 声源：${sourceId}`)) {
        return undefined;
      }
      const details = await stat(translationPath);
      return { entry, details, translationPath };
    }))).filter((item): item is NonNullable<typeof item> => item !== undefined);
    const latest = candidates.sort((left, right) => right.details.mtimeMs - left.details.mtimeMs)[0];
    if (!latest) {
      return undefined;
    }
    const name = latest.entry.name.slice(0, -3);
    return {
      sourceId,
      name,
      savedAt: latest.details.mtime.toISOString(),
      audioDirectory: path.join(this.audioRoot, name),
      transcriptionPath: path.join(this.transcriptionRoot, `${name}.md`),
      translationPath: latest.translationPath,
    };
  }
}

export function createDefaultArchiveName(date = new Date()): string {
  return `LiveTranslating_${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}`;
}

export function normalizeArchiveName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .slice(0, 96);
  if (!normalized) {
    throw new Error("Archive name cannot be empty");
  }
  return normalized;
}

function groupTranscripts(entries: Iterable<RecordedTranscript>): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  for (const entry of entries) {
    const previous = paragraphs.at(-1);
    const previousEntry = previous?.entries.at(-1);
    const gap = previousEntry ? timeOfDaySeconds(entry.timestamp) - timeOfDaySeconds(previousEntry.timestamp) : 0;
    const currentCharacters = previous?.entries.reduce(
      (sum, item) => sum + item.sourceText.length + item.translation.length,
      0,
    ) ?? 0;
    const startsNew = !previous
      || previous.sourceId !== entry.sourceId
      || gap > 12
      || gap < 0
      || previous.entries.length >= 4
      || currentCharacters + entry.sourceText.length + entry.translation.length > 720;
    if (startsNew) {
      paragraphs.push({ sourceId: entry.sourceId, timestamp: entry.timestamp, entries: [entry] });
    } else {
      previous.entries.push(entry);
    }
  }
  return paragraphs;
}

function renderTranscriptionMarkdown(
  name: string,
  sourceId: AudioSourceId,
  startedAt: string,
  endedAt: string,
  paragraphs: readonly TranscriptParagraph[],
): string {
  const content = paragraphs.map((paragraph) => [
    `## ${paragraph.timestamp} · ${sourceLabel(paragraph.sourceId)}`,
    "",
    joinParts(paragraph.entries.map((entry) => entry.sourceText), "en"),
  ].join("\n")).join("\n\n");
  return `${archiveHeader(name, sourceId, startedAt, endedAt, "纯文字稿")}\n\n${content || "_本次会话没有识别到语音。_"}\n`;
}

function renderTranslationMarkdown(
  name: string,
  sourceId: AudioSourceId,
  startedAt: string,
  endedAt: string,
  targetLanguage: string,
  paragraphs: readonly TranscriptParagraph[],
): string {
  const content = paragraphs.map((paragraph) => [
    `## ${paragraph.timestamp} · ${sourceLabel(paragraph.sourceId)}`,
    "",
    "**原文**",
    "",
    joinParts(paragraph.entries.map((entry) => entry.sourceText), "en"),
    "",
    ...(paragraph.entries.every((entry) => entry.translationOmitted)
      ? []
      : [
          "**译文**",
          "",
          joinParts(
            paragraph.entries
              .filter((entry) => !entry.translationOmitted)
              .map((entry) => entry.revisedTranslation ?? entry.translation ?? ""),
            targetLanguage,
          ) || "_翻译未完成。_",
        ]),
  ].join("\n")).join("\n\n");
  return `${archiveHeader(name, sourceId, startedAt, endedAt, "双语翻译稿")}\n\n${content || "_本次会话没有识别到语音。_"}\n`;
}

function archiveHeader(
  name: string,
  sourceId: AudioSourceId,
  startedAt: string,
  endedAt: string,
  type: string,
): string {
  return [
    `# ${name}`,
    "",
    `- 类型：${type}`,
    `- 声源：${sourceId}`,
    `- 开始：${startedAt}`,
    `- 结束：${endedAt}`,
  ].join("\n");
}

function joinParts(parts: readonly string[], language: string): string {
  return parts.filter(Boolean).join(/^(?:zh|ja|ko)(?:-|$)/iu.test(language) ? "" : " ");
}

function sourceLabel(sourceId: AudioSourceId): string {
  return sourceId === "system" ? "电脑声音" : "麦克风";
}

function timeOfDaySeconds(timestamp: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = timestamp.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
