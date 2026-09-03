export interface WordErrorMetrics {
  readonly referenceWords: number;
  readonly hypothesisWords: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly wordErrorRate: number;
}

export function wordErrorMetrics(referenceText: string, hypothesisText: string): WordErrorMetrics {
  const reference = normalizedWords(referenceText);
  const hypothesis = normalizedWords(hypothesisText);
  const columns = hypothesis.length + 1;
  const matrix = new Uint32Array((reference.length + 1) * columns);

  for (let row = 0; row <= reference.length; row += 1) {
    matrix[row * columns] = row;
  }
  for (let column = 0; column <= hypothesis.length; column += 1) {
    matrix[column] = column;
  }
  for (let row = 1; row <= reference.length; row += 1) {
    for (let column = 1; column <= hypothesis.length; column += 1) {
      const substitution = matrix[(row - 1) * columns + column - 1] ?? 0;
      const deletion = matrix[(row - 1) * columns + column] ?? 0;
      const insertion = matrix[row * columns + column - 1] ?? 0;
      matrix[row * columns + column] = reference[row - 1] === hypothesis[column - 1]
        ? substitution
        : Math.min(substitution, deletion, insertion) + 1;
    }
  }

  let row = reference.length;
  let column = hypothesis.length;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (row > 0 || column > 0) {
    if (
      row > 0 && column > 0 &&
      reference[row - 1] === hypothesis[column - 1] &&
      matrix[row * columns + column] === matrix[(row - 1) * columns + column - 1]
    ) {
      row -= 1;
      column -= 1;
      continue;
    }
    const current = matrix[row * columns + column] ?? 0;
    if (
      row > 0 && column > 0 &&
      current === (matrix[(row - 1) * columns + column - 1] ?? 0) + 1
    ) {
      substitutions += 1;
      row -= 1;
      column -= 1;
    } else if (row > 0 && current === (matrix[(row - 1) * columns + column] ?? 0) + 1) {
      deletions += 1;
      row -= 1;
    } else {
      insertions += 1;
      column -= 1;
    }
  }

  const errors = substitutions + deletions + insertions;
  return {
    referenceWords: reference.length,
    hypothesisWords: hypothesis.length,
    substitutions,
    deletions,
    insertions,
    wordErrorRate: reference.length > 0 ? errors / reference.length : hypothesis.length > 0 ? 1 : 0,
  };
}

export function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index];
}

export function mean(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

export function normalizedWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

export function normalizedNumbers(text: string): string[] {
  const wordValues: Readonly<Record<string, string>> = {
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
  const wordPattern = "zero|one|two|three|four|five|six|seven|eight|nine|ten";
  const wordNumbers: string[] = [];
  const remaining = text.toLocaleLowerCase("en").replace(
    new RegExp(`\\b(${wordPattern})\\s+point\\s+(${wordPattern})\\b`, "gu"),
    (_match, whole: string, decimal: string) => {
      wordNumbers.push(`${wordValues[whole] ?? whole}.${wordValues[decimal] ?? decimal}`);
      return " ";
    },
  );
  const standaloneWords = remaining.match(new RegExp(`\\b(?:${wordPattern})\\b`, "gu")) ?? [];
  const digits = (remaining.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[%％])?/gu) ?? [])
    .map((value) => value.replaceAll(",", "").replace("％", "%"))
  return [
    ...digits,
    ...wordNumbers,
    ...standaloneWords.map((word) => wordValues[word] ?? word),
  ].sort();
}

export function multisetRecall(expected: readonly string[], actual: readonly string[]): number | undefined {
  if (expected.length === 0) {
    return undefined;
  }
  const remaining = [...actual];
  let matches = 0;
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index >= 0) {
      matches += 1;
      remaining.splice(index, 1);
    }
  }
  return matches / expected.length;
}
