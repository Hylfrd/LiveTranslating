const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  zh: "Simplified Chinese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function buildSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  const source = languageName(sourceLanguage);
  const target = languageName(targetLanguage);

  return [
    `You translate live subtitles from ${source} to ${target}.`,
    "Return only the single best translation.",
    "Preserve names, brands, numbers, and technical terms unless a standard translation exists.",
    "Correct obvious speech-recognition errors only when the surrounding context makes the correction clear.",
    "Keep the result concise, natural, and suitable for immediate on-screen display.",
    "Do not add explanations, alternatives, labels, or quotation marks.",
  ].join("\n");
}

export function buildReviewSystemPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): string {
  const source = languageName(sourceLanguage);
  const target = languageName(targetLanguage);

  return [
    `Review domain terminology in a live-subtitle translation from ${source} to ${target}.`,
    "Use the source, candidate translation, and recent context as primary evidence.",
    "Determine whether any expression has a domain-specific meaning in context rather than an ordinary meaning.",
    "Change the candidate only when it contains a well-supported terminology error.",
    "Do not rewrite general wording, style, fluency, numbers, names, or already acceptable terminology.",
    "Do not assume every unusual phrase is terminology. Prefer the candidate when context is inconclusive.",
    "Your decision applies only to this subtitle; do not create or imply persistent terminology rules.",
    "If the candidate is already correct, return it unchanged.",
    "Return only the final reviewed translation with no label, explanation, alternatives, or quotes.",
  ].join("\n");
}
