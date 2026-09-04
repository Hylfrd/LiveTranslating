import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3978),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  HY_MT2_PLUS_API_KEY: optionalSecret,
  HY_MT2_PRO_API_KEY: optionalSecret,
  DEEPSEEK_V4_FLASH_API_KEY: optionalSecret,
  TRANSLATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  TRANSLATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(32).max(8192).default(512),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
}

const timeoutMs = parsed.data.TRANSLATION_TIMEOUT_MS;
const maxOutputTokens = parsed.data.TRANSLATION_MAX_OUTPUT_TOKENS;

export const config = {
  host: parsed.data.HOST,
  port: parsed.data.PORT,
  corsOrigin: parsed.data.CORS_ORIGIN,
  translation: {
    // These compatibility fields keep the current server and health endpoint stable.
    provider: "registry",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    apiKey: parsed.data.HY_MT2_PLUS_API_KEY,
    model: "hy-mt2-plus",
    primaryModel: "hy-mt2-plus",
    fallbackModel: "hy-mt2-plus",
    timeoutMs,
    maxOutputTokens,
    providers: {
      "hy-mt2-plus": {
        id: "hy-mt2-plus",
        vendor: "tencent",
        baseUrl: "https://tokenhub.tencentmaas.com/v1",
        apiKey: parsed.data.HY_MT2_PLUS_API_KEY,
        model: "hy-mt2-plus",
        concurrency: 8,
      },
      "hy-mt2-pro": {
        id: "hy-mt2-pro",
        vendor: "tencent",
        baseUrl: "https://tokenhub.tencentmaas.com/v1",
        apiKey: parsed.data.HY_MT2_PRO_API_KEY,
        model: "hy-mt2-pro",
        concurrency: 16,
      },
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        vendor: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: parsed.data.DEEPSEEK_V4_FLASH_API_KEY,
        model: "deepseek-v4-flash",
        concurrency: 32,
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        vendor: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: parsed.data.DEEPSEEK_V4_FLASH_API_KEY,
        model: "deepseek-v4-pro",
        concurrency: 16,
      },
    },
  },
} as const;

export type AppConfig = typeof config;
