import cors from "@fastify/cors";
import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import { registerRoutes } from "./http/routes.js";
import { OpenAICompatibleTranslationProvider } from "./translation/provider.js";

export async function createServer(
  appConfig: AppConfig,
  loggerEnabled = true,
  translator = new OpenAICompatibleTranslationProvider(appConfig.translation),
) {
  const app = Fastify({
    logger: loggerEnabled ? {
      level: "info",
      redact: [
        "req.headers.authorization",
        "headers.authorization",
        "TRANSLATION_API_KEY",
        "HY_MT2_PLUS_API_KEY",
        "HY_MT2_PRO_API_KEY",
        "DEEPSEEK_V4_FLASH_API_KEY",
        "translation.apiKey",
      ],
    } : false,
  });

  await app.register(cors, {
    origin: appConfig.corsOrigin,
    methods: ["GET", "POST"],
  });

  await registerRoutes(app, translator);
  return app;
}
