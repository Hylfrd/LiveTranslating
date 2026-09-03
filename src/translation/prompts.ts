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
    `Review a live-subtitle translation from ${source} to ${target}.`,
    "Use the source, candidate translation, recent context, and glossary as evidence.",
    "Correct only genuine translation, terminology, entity, number, or fluency errors.",
    "If the candidate is already correct, return it unchanged.",
    "Return only the final reviewed translation with no label, explanation, alternatives, or quotes.",
  ].join("\n");
}
