import { z } from "zod";

export const TRANSLATION_MODEL_IDS = [
  "hy-mt2-plus",
  "hy-mt2-pro",
  "deepseek-v4-flash",
] as const;

export const translationModelIdSchema = z.enum(TRANSLATION_MODEL_IDS);
export type TranslationModelId = z.infer<typeof translationModelIdSchema>;

const languageCode = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/);

export const translationGlossaryEntrySchema = z.object({
  source: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(200),
});

export const translationRequestSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  sourceLanguage: languageCode.default("en"),
  targetLanguage: languageCode.default("zh"),
  context: z
    .array(
      z.object({
        source: z.string().trim().min(1).max(4000),
        translation: z.string().trim().min(1).max(4000),
      }),
    )
    .max(8)
    .default([]),
  model: translationModelIdSchema.optional(),
  glossary: z.array(translationGlossaryEntrySchema).max(200).default([]),
});

export type TranslationRequest = z.infer<typeof translationRequestSchema>;

export const translationReviewRequestSchema = z.object({
  sourceText: z.string().trim().min(1).max(8000),
  originalTranslation: z.string().trim().min(1).max(8000),
  sourceLanguage: languageCode.default("en"),
  targetLanguage: languageCode.default("zh"),
  context: z
    .array(
      z.object({
        source: z.string().trim().min(1).max(4000),
        translation: z.string().trim().min(1).max(4000),
      }),
    )
    .max(8)
    .default([]),
  glossary: z.array(translationGlossaryEntrySchema).max(200).default([]),
});

export type TranslationReviewRequest = z.infer<typeof translationReviewRequestSchema>;

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TranslationResult {
  text: string;
  usage?: TranslationUsage;
}

export interface TranslationReviewResult {
  originalTranslation: string;
  reviewedTranslation: string;
  corrected: boolean;
  model: "deepseek-v4-flash";
  usage?: TranslationUsage;
}

export type TranslationStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: TranslationUsage }
  | { type: "done"; text: string };
