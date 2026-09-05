export interface EditMetrics {
  readonly referenceUnits: number;
  readonly hypothesisUnits: number;
  readonly editDistance: number;
  readonly errorRate: number;
}

export function characterErrorMetrics(reference: string, hypothesis: string): EditMetrics {
  return editMetrics(characterUnits(reference), characterUnits(hypothesis));
}

export function mixedErrorMetrics(reference: string, hypothesis: string): EditMetrics {
  return editMetrics(mixedUnits(reference), mixedUnits(hypothesis));
}

export function wordErrorMetricsForCloud(reference: string, hypothesis: string): EditMetrics {
  return editMetrics(wordUnits(reference), wordUnits(hypothesis));
}

export function revisionErasure(previous: string, next: string): number {
  const left = Array.from(previous.normalize("NFKC"));
  const right = Array.from(next.normalize("NFKC"));
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  return left.length - prefix;
}

function editMetrics(reference: readonly string[], hypothesis: readonly string[]): EditMetrics {
  const errors = bitParallelDistance(reference, hypothesis);
  return {
    referenceUnits: reference.length,
    hypothesisUnits: hypothesis.length,
    editDistance: errors,
    errorRate: reference.length > 0 ? errors / reference.length : hypothesis.length > 0 ? 1 : 0,
  };
}

// Myers' bit-vector Levenshtein algorithm keeps memory linear in vocabulary size
// and remains practical for full-length meeting transcripts.
function bitParallelDistance(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const [pattern, text] = left.length <= right.length ? [left, right] : [right, left];
  const masks = new Map<string, bigint>();
  for (let index = 0; index < pattern.length; index += 1) {
    const value = pattern[index] ?? "";
    masks.set(value, (masks.get(value) ?? 0n) | (1n << BigInt(index)));
  }
  let positive = ~0n;
  let negative = 0n;
  let score = pattern.length;
  const last = 1n << BigInt(pattern.length - 1);
  for (const value of text) {
    const equals = masks.get(value) ?? 0n;
    const vertical = equals | negative;
    const horizontal = ((((equals & positive) + positive) ^ positive) | equals);
    let positiveHorizontal = negative | ~(horizontal | positive);
    let negativeHorizontal = positive & horizontal;
    if ((positiveHorizontal & last) !== 0n) score += 1;
    else if ((negativeHorizontal & last) !== 0n) score -= 1;
    positiveHorizontal = (positiveHorizontal << 1n) | 1n;
    negativeHorizontal <<= 1n;
    positive = negativeHorizontal | ~(vertical | positiveHorizontal);
    negative = positiveHorizontal & vertical;
  }
  return score;
}

function characterUnits(text: string): string[] {
  return Array.from(normalize(text).replace(/[\s\p{P}\p{S}]+/gu, ""));
}

function wordUnits(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [];
}

function mixedUnits(text: string): string[] {
  return normalize(text).match(/\p{Script=Han}|(?!\p{Script=Han})[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? [];
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en");
}
