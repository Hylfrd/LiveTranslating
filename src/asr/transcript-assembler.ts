import type { AsrTranscript } from "./ffmpeg-whisper.js";

export interface TranscriptAssemblerOptions {
  readonly idleFlushMs?: number;
  readonly maxGapMs?: number;
  readonly maxSpanMs?: number;
  readonly hardMaxSpanMs?: number;
  readonly maxWords?: number;
  readonly minimumSentenceWords?: number;
}

interface PendingTranscript extends AsrTranscript {
  text: string;
  receivedAt: number;
  speechStartedAt: number;
  speechEndedAt: number;
}

const NON_SPEECH = /^\[\s*(?:blank_audio|silence|music|pause|applause|laughter|noise)\s*\]$/iu;
const FILLER_ONLY = /^(?:okay|ok|um+|uh+|hmm+)[,.!?;:，。！？；：]*$/iu;
const CONNECTOR_ONLY = /^(?:and|or|but|because|if|that|which|of|to|the|a|an|is|are|was|were)[,.!?;:，。！？；：]*$/iu;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|vs|etc|e\.g|i\.e|U\.S|U\.K)\.$/u;
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

export class TranscriptAssembler {
  private readonly idleFlushMs: number;
  private readonly maxGapMs: number;
  private readonly maxSpanMs: number;
  private readonly hardMaxSpanMs: number;
  private readonly maxWords: number;
  private readonly minimumSentenceWords: number;
  private pending: PendingTranscript | undefined;
  private lastEmitted: { text: string; endedAt: number } | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly onTranscript: (transcript: AsrTranscript) => void,
    options: TranscriptAssemblerOptions = {},
  ) {
    this.idleFlushMs = options.idleFlushMs ?? 2200;
    this.maxGapMs = options.maxGapMs ?? 1800;
    this.maxSpanMs = options.maxSpanMs ?? 9000;
    this.hardMaxSpanMs = options.hardMaxSpanMs ?? 13000;
    this.maxWords = options.maxWords ?? 50;
    this.minimumSentenceWords = options.minimumSentenceWords ?? 2;
  }

  push(transcript: AsrTranscript): void {
    const text = cleanAsrText(transcript.text);
    if (!text) {
      return;
    }
    if (
      this.pending &&
      transcript.speechStartedAt - this.pending.speechEndedAt > this.maxGapMs
    ) {
      this.flush();
    }
    if (!this.pending) {
      this.pending = { ...transcript, text };
    } else {
      this.pending.text = mergeWithOverlap(this.pending.text, text);
      this.pending.speechEndedAt = Math.max(
        this.pending.speechEndedAt,
        transcript.speechEndedAt,
      );
      this.pending.receivedAt = transcript.receivedAt;
    }

    this.emitCompleteSentences();
    this.emitLongClauseIfNeeded();
    this.scheduleIdleFlush();
  }

  flush(): void {
    this.clearTimer();
    if (!this.pending) {
      return;
    }
    this.emitPrefix(this.pending.text.length);
  }

  discard(): void {
    this.clearTimer();
    this.pending = undefined;
  }

  private emitCompleteSentences(): void {
    while (this.pending) {
      const text = this.pending.text;
      const boundary = findSentenceBoundary(text, this.minimumSentenceWords);
      if (boundary === undefined) {
        return;
      }
      this.emitPrefix(boundary);
    }
  }

  private emitLongClauseIfNeeded(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const spanMs = pending.speechEndedAt - pending.speechStartedAt;
    const words = wordCount(pending.text);
    if (spanMs < this.maxSpanMs && words < this.maxWords) {
      return;
    }
    const clauseBoundary = findClauseBoundary(pending.text);
    const clauseIsInternal =
      clauseBoundary !== undefined && pending.text.slice(clauseBoundary).trim().length > 0;
    if (clauseBoundary !== undefined && (clauseIsInternal || spanMs >= this.hardMaxSpanMs)) {
      this.emitPrefix(clauseBoundary);
      return;
    }
    if (spanMs >= this.hardMaxSpanMs || words >= this.maxWords) {
      this.flush();
    }
  }

  private emitPrefix(endIndex: number): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const prefix = pending.text.slice(0, endIndex).trim();
    const remainder = pending.text.slice(endIndex).trim();
    if (!prefix) {
      this.pending = remainder ? { ...pending, text: remainder } : undefined;
      return;
    }
    const totalCharacters = Math.max(1, prefix.length + remainder.length);
    const durationMs = Math.max(0, pending.speechEndedAt - pending.speechStartedAt);
    const prefixEnd = remainder
      ? pending.speechStartedAt + durationMs * (prefix.length / totalCharacters)
      : pending.speechEndedAt;
    const cleanedPrefix = cleanAsrText(prefix);
    if (!cleanedPrefix) {
      this.pending = remainder
        ? { ...pending, text: remainder, speechStartedAt: prefixEnd }
        : undefined;
      return;
    }
    const normalized = normalizeForDeduplication(cleanedPrefix);
    if (
      this.lastEmitted &&
      this.lastEmitted.text === normalized &&
      pending.speechStartedAt - this.lastEmitted.endedAt < 5000
    ) {
      this.pending = remainder
        ? { ...pending, text: remainder, speechStartedAt: prefixEnd }
        : undefined;
      return;
    }
    this.lastEmitted = { text: normalized, endedAt: prefixEnd };
    this.onTranscript({
      sourceId: pending.sourceId,
      text: cleanedPrefix,
      receivedAt: pending.receivedAt,
      speechStartedAt: pending.speechStartedAt,
      speechEndedAt: prefixEnd,
    });
    this.pending = remainder
      ? {
          ...pending,
          text: remainder,
          speechStartedAt: prefixEnd,
        }
      : undefined;
  }

  private scheduleIdleFlush(): void {
    this.clearTimer();
    if (!this.pending || this.idleFlushMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => this.flush(), this.idleFlushMs);
    this.idleTimer.unref();
  }

  private clearTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

export function cleanAsrText(text: string): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  return NON_SPEECH.test(cleaned) || FILLER_ONLY.test(cleaned) || CONNECTOR_ONLY.test(cleaned)
    ? ""
    : cleaned;
}

function findSentenceBoundary(text: string, minimumWords: number): number | undefined {
  const pattern = /[.!?。！？](?=\s|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const endIndex = (match.index ?? 0) + match[0].length;
    const candidate = text.slice(0, endIndex);
    if (ABBREVIATION.test(candidate)) {
      continue;
    }
    if (wordCount(candidate) >= minimumWords || /[!?！？]$/u.test(candidate)) {
      return endIndex;
    }
  }
  return undefined;
}

function findClauseBoundary(text: string): number | undefined {
  const minimumIndex = Math.floor(text.length * 0.45);
  let result: number | undefined;
  const pattern = /[,;:，；：](?=\s|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const endIndex = (match.index ?? 0) + match[0].length;
    if (endIndex >= minimumIndex && !endsWithConnector(text.slice(0, endIndex))) {
      result = endIndex;
    }
  }
  return result;
}

function endsWithConnector(text: string): boolean {
  return /\b(?:and|or|but|because|if|that|which|of|to|the|a|an|is|are|was|were|instead\s+of)[,;:]?$/iu.test(
    text.trim(),
  );
}

function mergeWithOverlap(existing: string, incoming: string): string {
  const left = existing.replace(/-\s*$/u, "").trimEnd();
  const incomingParts = incoming.trim().split(/\s+/u);
  const leftParts = left.split(/\s+/u);
  const maximum = Math.min(4, leftParts.length, incomingParts.length);
  let overlap = 0;
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = leftParts.slice(-length).map(normalizeBoundaryToken);
    const prefix = incomingParts.slice(0, length).map(normalizeBoundaryToken);
    if (suffix.every((token, index) => token && token === prefix[index])) {
      overlap = length;
      break;
    }
  }
  const remainder = incomingParts.slice(overlap).join(" ");
  return remainder ? `${left} ${remainder}` : left;
}

function normalizeBoundaryToken(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return NUMBER_WORDS[normalized] ?? normalized;
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function normalizeForDeduplication(text: string): string {
  return text.toLocaleLowerCase("en").replace(/[\s\p{P}\p{S}]+/gu, "");
}
