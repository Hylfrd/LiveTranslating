import { z } from "zod";

export const TRANSLATION_MODEL_IDS = [
  "hy-mt2-plus",
  "hy-mt2-pro",
] as const;

export const REVIEW_MODEL_IDS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

export const PROVIDER_MODEL_IDS = [
  ...TRANSLATION_MODEL_IDS,
  ...REVIEW_MODEL_IDS,
] as const;

export const translationModelIdSchema = z.enum(TRANSLATION_MODEL_IDS);
export type TranslationModelId = z.infer<typeof translationModelIdSchema>;
export const reviewModelIdSchema = z.enum(REVIEW_MODEL_IDS);
export type ReviewModelId = z.infer<typeof reviewModelIdSchema>;
export const providerModelIdSchema = z.enum(PROVIDER_MODEL_IDS);
export type ProviderModelId = z.infer<typeof providerModelIdSchema>;

const languageCode = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/);

export const translationRequestSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  sourceLanguage: languageCode.default("auto"),
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
});

export type TranslationRequest = z.infer<typeof translationRequestSchema>;

export const translationReviewRequestSchema = z.object({
  sourceText: z.string().trim().min(1).max(8000),
  originalTranslation: z.string().trim().min(1).max(8000),
  sourceLanguage: languageCode.default("auto"),
  targetLanguage: languageCode.default("zh"),
  mode: z.enum(["general", "terminology"]).default("general"),
  model: reviewModelIdSchema.default("deepseek-v4-flash"),
  secondaryTranslation: z.string().trim().min(1).max(8000).optional(),
  context: z
    .array(
      z.object({
        source: z.string().trim().min(1).max(4000),
        translation: z.string().trim().min(1).max(4000),
      }),
    )
    .max(8)
    .default([]),
});

export type TranslationReviewRequest = z.infer<typeof translationReviewRequestSchema>;

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimated?: boolean;
}

export interface TranslationResult {
  text: string;
  model: ProviderModelId;
  usage?: TranslationUsage;
}

export interface TranslationReviewResult {
  originalTranslation: string;
  reviewedTranslation: string;
  corrected: boolean;
  model: ReviewModelId;
  usage?: TranslationUsage;
}

export type TranslationStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: TranslationUsage }
  | { type: "done"; text: string };
