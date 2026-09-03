import type { TranslationRequest } from "./schema.js";

export type TranslationValidationIssue =
  | "EMPTY_RESULT"
  | "REPETITION_LOOP"
  | "NUMBER_MISMATCH"
  | "DATE_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "GLOSSARY_MISMATCH"
  | "ENGLISH_RESIDUE"
  | "EXTRA_EXPLANATION";

export interface TranslationValidationResult {
  readonly valid: boolean;
  readonly issues: readonly TranslationValidationIssue[];
}

const EXTRA_EXPLANATION_PATTERNS = [
  /^\s*(?:translation|translated text|answer)\s*[:：]/iu,
  /^\s*(?:译文|翻译(?:结果)?|答案)\s*[:：]/u,
  /^\s*(?:here is|here's)\s+(?:the\s+)?translation\b/iu,
  /^\s*以下(?:是|为).{0,16}(?:翻译|译文)/u,
  /```/u,
  /(?:^|\n)\s*(?:option|alternative|版本|译法)\s*\d*\s*[:：]/iu,
];

const CURRENCY_ALIASES: Readonly<Record<string, readonly RegExp[]>> = {
  USD: [/\$/u, /\bUSD\b/iu, /\bUS\s*dollars?\b/iu, /美元/u, /美金/u],
  CNY: [/[¥￥]/u, /\bCNY\b/iu, /\bRMB\b/iu, /\byuan\b/iu, /人民币/u, /元/u],
  EUR: [/€/u, /\bEUR\b/iu, /\beuros?\b/iu, /欧元/u],
  GBP: [/£/u, /\bGBP\b/iu, /\bpounds?\b/iu, /英镑/u],
};

const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

interface DateExtraction {
  readonly dates: readonly string[];
  readonly remainingText: string;
}

function extractDates(text: string): DateExtraction {
  const dates: string[] = [];
  let remainingText = text.replace(
    /\b(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})\s*日?/gu,
    (_match, year: string, month: string, day: string) => {
      dates.push(`${Number(year)}-${Number(month)}-${Number(day)}`);
      return " ";
    },
  );

  const monthNames = Object.keys(MONTHS).join("|");
  const monthFirst = new RegExp(
    `\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})\\b`,
    "giu",
  );
  remainingText = remainingText.replace(
    monthFirst,
    (_match, month: string, day: string, year: string) => {
      dates.push(`${Number(year)}-${MONTHS[month.toLowerCase()]}-${Number(day)}`);
      return " ";
    },
  );

  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:,)?\\s+(\\d{4})\\b`,
    "giu",
  );
  remainingText = remainingText.replace(
    dayFirst,
    (_match, day: string, month: string, year: string) => {
      dates.push(`${Number(year)}-${MONTHS[month.toLowerCase()]}-${Number(day)}`);
      return " ";
    },
  );

  return { dates: dates.sort(), remainingText };
}

function normalizedNumbers(text: string): string[] {
  return (text.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[%％])?/gu) ?? [])
    .map((value) => {
      const compact = value.replaceAll(",", "").replace("％", "%");
      const percent = compact.endsWith("%");
      const numeric = percent ? compact.slice(0, -1) : compact;
      const normalized = String(Number(numeric));
      return `${normalized}${percent ? "%" : ""}`;
    })
    .sort();
}

function sameNumberValues(source: readonly string[], translated: readonly string[]): boolean {
  if (source.length === 0) {
    return true;
  }
  const sourceCounts = counts(source);
  const translatedCounts = counts(translated);
  return (
    [...sourceCounts.entries()].every(
      ([value, count]) => (translatedCounts.get(value) ?? 0) >= count,
    ) &&
    [...translatedCounts.keys()].every((value) => sourceCounts.has(value))
  );
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function currencies(text: string): string[] {
  return Object.entries(CURRENCY_ALIASES)
    .filter(([, aliases]) => aliases.some((pattern) => pattern.test(text)))
    .map(([currency]) => currency)
    .sort();
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasRepetitionLoop(text: string): boolean {
  const normalized = text.replace(/[\s\p{P}\p{S}]+/gu, "");
  const maximumUnit = Math.min(48, Math.floor(normalized.length / 3));

  for (let unitLength = 2; unitLength <= maximumUnit; unitLength += 1) {
    for (let start = 0; start + unitLength * 3 <= normalized.length; start += 1) {
      const unit = normalized.slice(start, start + unitLength);
      if (
        normalized.slice(start + unitLength, start + unitLength * 2) === unit &&
        normalized.slice(start + unitLength * 2, start + unitLength * 3) === unit
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasObviousEnglishResidue(request: TranslationRequest, translation: string): boolean {
  const sourceLanguage = request.sourceLanguage.toLowerCase();
  if (
    !request.targetLanguage.toLowerCase().startsWith("zh") ||
    (!sourceLanguage.startsWith("en") && sourceLanguage !== "auto")
  ) {
    return false;
  }

  const latinWords = translation.match(/[A-Za-z]+(?:['.-][A-Za-z]+)*/gu) ?? [];
  const hanCharacters = translation.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinCharacters = latinWords.reduce((total, word) => total + word.length, 0);

  if (
    hanCharacters === 0 &&
    latinWords.length > 0 &&
    latinWords.every((word) => word.length <= 2) &&
    /[_()[\]{}=+*\/^]|\p{Sm}/u.test(translation)
  ) {
    return false;
  }

  if (hanCharacters === 0) {
    return latinWords.length >= 2 || latinCharacters >= 16;
  }

  return latinWords.length >= 5 && latinCharacters > hanCharacters * 1.5;
}

export function validateTranslation(
  request: TranslationRequest,
  translation: string,
): TranslationValidationResult {
  const text = translation.trim();
  const issues: TranslationValidationIssue[] = [];

  if (!text) {
    issues.push("EMPTY_RESULT");
    return { valid: false, issues };
  }

  if (hasRepetitionLoop(text)) {
    issues.push("REPETITION_LOOP");
  }
  const sourceDates = extractDates(request.text);
  const translatedDates = extractDates(text);
  if (!sameValues(sourceDates.dates, translatedDates.dates)) {
    issues.push("DATE_MISMATCH");
  }
  if (!sameNumberValues(
    normalizedNumbers(sourceDates.remainingText),
    normalizedNumbers(translatedDates.remainingText),
  )) {
    issues.push("NUMBER_MISMATCH");
  }
  const sourceCurrencies = currencies(request.text);
  const translatedCurrencies = currencies(text);
  if (sourceCurrencies.some((currency) => !translatedCurrencies.includes(currency))) {
    issues.push("CURRENCY_MISMATCH");
  }
  const normalizedTranslation = normalizeGlossaryText(text);
  if (
    request.glossary.some(
      (entry) => !normalizedTranslation.includes(normalizeGlossaryText(entry.target)),
    )
  ) {
    issues.push("GLOSSARY_MISMATCH");
  }
  if (hasObviousEnglishResidue(request, text)) {
    issues.push("ENGLISH_RESIDUE");
  }
  if (EXTRA_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text))) {
    issues.push("EXTRA_EXPLANATION");
  }

  return { valid: issues.length === 0, issues };
}

function normalizeGlossaryText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}
