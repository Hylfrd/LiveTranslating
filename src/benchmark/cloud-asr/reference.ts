import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseVtt } from "../vtt.js";
import type { CloudAsrBenchmarkConfig } from "./types.js";

export interface ReferenceSelection {
  readonly text: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export async function loadReference(config: CloudAsrBenchmarkConfig): Promise<ReferenceSelection> {
  if (config.referenceText) return exactSelection(config, normalizeWhitespace(config.referenceText));
  if (!config.reference) throw new Error("Reference text is required");
  const contents = await readFile(config.reference, "utf8");
  if (path.extname(config.reference).toLocaleLowerCase() !== ".vtt") {
    return exactSelection(config, normalizeWhitespace(stripMarkdown(contents)));
  }
  const endSeconds = config.startSeconds + config.durationSeconds;
  const cues = parseVtt(contents)
    .filter((cue) => cue.endSeconds > config.startSeconds && cue.startSeconds < endSeconds);
  const first = cues[0];
  const last = cues.at(-1);
  if (!first || !last) throw new Error("No VTT cues overlap the configured benchmark clip");
  let text = "";
  let previousEndSeconds: number | undefined;
  for (const cue of cues) {
    const overlapsPrevious = previousEndSeconds !== undefined && cue.startSeconds < previousEndSeconds;
    text = mergeCaptionText(text, cue.text, overlapsPrevious);
    previousEndSeconds = Math.max(previousEndSeconds ?? cue.endSeconds, cue.endSeconds);
  }
  return {
    text,
    startSeconds: first.startSeconds,
    durationSeconds: Math.max(0.001, last.endSeconds - first.startSeconds),
  };
}

function exactSelection(config: CloudAsrBenchmarkConfig, text: string): ReferenceSelection {
  return { text, startSeconds: config.startSeconds, durationSeconds: config.durationSeconds };
}

function mergeCaptionText(existing: string, incoming: string, overlapsPrevious: boolean): string {
  const left = normalizeWhitespace(existing);
  const right = normalizeWhitespace(incoming);
  if (!left) return right;
  if (!right) return left;
  if (!overlapsPrevious) return `${left} ${right}`;
  if (left.endsWith(right)) return left;
  const maximum = Math.min(500, left.length, right.length);
  for (let overlap = maximum; overlap >= 4; overlap -= 1) {
    if (left.slice(-overlap) === right.slice(0, overlap)) {
      return `${left}${right.slice(overlap)}`;
    }
  }
  return `${left} ${right}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/^#{1,6}\s+.*$/gmu, " ")
    .replace(/^\s*[-*]\s+/gmu, " ")
    .replace(/\[([^\n]+?)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_>]/gu, " ");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
