import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";

import {
  OpenAICompatibleTranslationProvider,
  TranslationNotConfiguredError,
  TranslationProviderError,
} from "../translation/provider.js";
import {
  translationRequestSchema,
  translationReviewRequestSchema,
} from "../translation/schema.js";

function sendSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function registerRoutes(
  app: FastifyInstance,
  translator: OpenAICompatibleTranslationProvider,
): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    translation: {
      configured: translator.configured,
      provider: translator.provider,
      model: translator.model,
    },
  }));

  app.get("/v1/models", async () => ({
    primary: translator.model,
    configured: translator.registry.configuredModels(),
  }));

  app.post("/v1/translations", async (request, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
    reply.raw.once("close", abort);

    try {
      const input = translationRequestSchema.parse(request.body);
      return await translator.translate(input, controller.signal);
    } catch (error) {
      return sendError(reply, error);
    } finally {
      reply.raw.off("close", abort);
    }
  });

  app.post("/v1/translations/validated-stream", async (request, reply) => {
    let input;
    try {
      input = translationRequestSchema.parse(request.body);
    } catch (error) {
      return sendError(reply, error);
    }

    if (!translator.configured) {
      return sendError(reply, new TranslationNotConfiguredError());
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
    reply.raw.once("close", abort);

    try {
      for await (const event of translator.translateStream(input, controller.signal)) {
        if (controller.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
          return;
        }
        if (event.type === "delta") {
          sendSse(reply, "delta", { text: event.text });
        } else if (event.type === "usage") {
          sendSse(reply, "usage", event.usage);
        } else {
          sendSse(reply, "done", { text: event.text });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
        const payload = errorPayload(error);
        sendSse(reply, "error", payload.body.error);
      }
    } finally {
      reply.raw.off("close", abort);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  app.post("/v1/translations/review", async (request, reply) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
    reply.raw.once("close", abort);
    try {
      const input = translationReviewRequestSchema.parse(request.body);
      return await translator.reviewTranslation(input, controller.signal);
    } catch (error) {
      return sendError(reply, error);
    } finally {
      reply.raw.off("close", abort);
    }
  });
}

function errorPayload(error: unknown): {
  statusCode: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: { error: { code: "INVALID_REQUEST", message: "Invalid translation request" } },
    };
  }

  if (error instanceof TranslationNotConfiguredError) {
    return {
      statusCode: 503,
      body: { error: { code: "TRANSLATION_NOT_CONFIGURED", message: error.message } },
    };
  }

  if (error instanceof TranslationProviderError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.providerCode ?? "TRANSLATION_PROVIDER_ERROR",
          message: error.message,
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } },
  };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const payload = errorPayload(error);
  return reply.code(payload.statusCode).send(payload.body);
}
