const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  auto: "mixed or automatically detected languages",
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
    sourceLanguage === "auto"
      ? `You translate live subtitles that may mix multiple languages into ${target}.`
      : `You translate live subtitles from ${source} to ${target}.`,
    "Return only the single best translation.",
    `Translate only spans that are not already in ${target}; preserve existing ${target} spans exactly once.`,
    "Never duplicate or paraphrase a span that is already in the target language.",
    "Preserve names, brands, numbers, and technical terms unless a standard translation exists.",
    "Correct obvious speech-recognition errors only when the surrounding context makes the correction clear.",
    "Keep the result concise, natural, and suitable for immediate on-screen display.",
    "Do not add explanations, alternatives, labels, or quotation marks.",
  ].join("\n");
}

export function buildReviewSystemPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  mode: "general" | "terminology",
): string {
  const source = languageName(sourceLanguage);
  const target = languageName(targetLanguage);

  const shared = [
    `Review a live-subtitle translation from ${source} to ${target}.`,
    "Use the source, candidate translation, and recent context as primary evidence.",
    `Preserve spans that were already written in ${target}; never duplicate them.`,
  ];
  const task = mode === "terminology" ? [
    "Determine whether any expression has a domain-specific meaning in context rather than an ordinary meaning.",
    "Change the candidate only when it contains a well-supported terminology error.",
    "Do not rewrite general wording, style, fluency, numbers, names, or already acceptable terminology.",
    "Do not assume every unusual phrase is terminology. Prefer the candidate when context is inconclusive.",
    "Your decision applies only to this subtitle; do not create or imply persistent terminology rules.",
  ] : [
    "Correct only well-supported omissions, mistranslations, entity, number, coherence, or fluency errors.",
    "When a second translation candidate is supplied, use it as additional evidence rather than automatically preferring it.",
    "Do not change an already accurate candidate merely for stylistic variety.",
  ];
  return [
    ...shared,
    ...task,
    "If the candidate is already correct, return it unchanged.",
    "Return only the final reviewed translation with no label, explanation, alternatives, or quotes.",
  ].join("\n");
}
