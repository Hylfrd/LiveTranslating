import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const glossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(200),
  caseSensitive: z.boolean().default(false),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

const glossarySchema = z.array(glossaryEntrySchema).max(2000);

export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export class GlossaryStore {
  readonly filePath: string;
  private entries: GlossaryEntry[] = [];
  private updatedAt?: Date;

  constructor(rootDirectory = process.cwd()) {
    this.filePath = path.join(rootDirectory, "data", "glossary.json");
  }

  get count(): number {
    return this.entries.length;
  }

  get lastUpdatedAt(): Date | undefined {
    return this.updatedAt;
  }

  all(): readonly GlossaryEntry[] {
    return this.entries;
  }

  matching(text: string): GlossaryEntry[] {
    return matchGlossaryEntries(this.entries, text);
  }

  async load(): Promise<number> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await writeFile(this.filePath, "[]\n", "utf8");
      raw = "[]";
    }
    this.entries = glossarySchema.parse(JSON.parse(raw));
    this.updatedAt = new Date();
    return this.entries.length;
  }
}

interface MatchableGlossaryEntry {
  readonly source: string;
  readonly target: string;
  readonly caseSensitive?: boolean;
  readonly aliases?: readonly string[];
}

export function matchGlossaryEntries<T extends MatchableGlossaryEntry>(
  entries: readonly T[],
  text: string,
  limit = 200,
): T[] {
  const normalizedText = text.toLocaleLowerCase();
  const exact: T[] = [];
  const fuzzy: Array<{ entry: T; score: number }> = [];

  for (const entry of entries) {
    const phrases = [entry.source, ...(entry.aliases ?? [])];
    const exactMatch = phrases.some((phrase) =>
      entry.caseSensitive
        ? text.includes(phrase)
        : normalizedText.includes(phrase.toLocaleLowerCase()),
    );
    if (exactMatch) {
      exact.push(entry);
      continue;
    }
    const score = Math.max(...phrases.map((phrase) => fuzzyPhraseScore(text, phrase)));
    const wordLength = normalizedWords(entry.source).length;
    const threshold = wordLength <= 1 ? 0.86 : 0.76;
    if (score >= threshold) {
      fuzzy.push({ entry, score });
    }
  }

  return [
    ...exact,
    ...fuzzy.sort((left, right) => right.score - left.score).map(({ entry }) => entry),
  ].slice(0, limit);
}

function fuzzyPhraseScore(text: string, phrase: string): number {
  const textWords = normalizedWords(text);
  const phraseWords = normalizedWords(phrase);
  const phraseValue = phraseWords.join("");
  if (phraseValue.length < 7 || phraseWords.length === 0) {
    return 0;
  }
  let best = 0;
  const minimumWindow = Math.max(1, phraseWords.length - 1);
  const maximumWindow = phraseWords.length + 1;
  for (let size = minimumWindow; size <= maximumWindow; size += 1) {
    for (let index = 0; index + size <= textWords.length; index += 1) {
      const candidate = textWords.slice(index, index + size).join("");
      const distance = levenshteinDistance(phraseValue, candidate);
      best = Math.max(best, 1 - distance / Math.max(phraseValue.length, candidate.length));
    }
  }
  return best;
}

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}
