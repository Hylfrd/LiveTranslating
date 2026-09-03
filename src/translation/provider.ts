import OpenAI from "openai";

import type { AppConfig } from "../config.js";
import { AbortableSemaphore, abortableDelay } from "./concurrency.js";
import { buildReviewSystemPrompt, buildSystemPrompt } from "./prompts.js";
import type {
  TranslationModelId,
  TranslationRequest,
  TranslationResult,
  TranslationReviewRequest,
  TranslationReviewResult,
  TranslationStreamEvent,
  TranslationUsage,
} from "./schema.js";
import {
  validateTranslation,
  type TranslationValidationIssue,
} from "./validator.js";

type TranslationSettings = AppConfig["translation"];
type ProviderSettings = TranslationSettings["providers"][TranslationModelId];
type ThinkingMode = "disabled" | "enabled";

export interface TranslationProviderTelemetry {
  readonly type: "rate_limit_retry";
  readonly model: TranslationModelId;
  readonly attempt: number;
  readonly delayMs: number;
}

type CompatibleRequest = OpenAI.Chat.Completions.ChatCompletionCreateParams &
  Record<string, unknown>;

interface BufferedStream {
  readonly chunks: readonly string[];
  readonly text: string;
  readonly usage?: TranslationUsage;
}

const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 300;

export class TranslationNotConfiguredError extends Error {
  constructor(message = "Translation provider is not configured") {
    super(message);
    this.name = "TranslationNotConfiguredError";
  }
}

export class TranslationProviderError extends Error {
  readonly statusCode: number;
  readonly providerCode: string | undefined;

  constructor(message: string, statusCode = 502, providerCode?: string) {
    super(message);
    this.name = "TranslationProviderError";
    this.statusCode = statusCode;
    this.providerCode = providerCode;
  }
}

export class TranslationValidationError extends TranslationProviderError {
  readonly issues: readonly TranslationValidationIssue[];

  constructor(issues: readonly TranslationValidationIssue[]) {
    super(
      "Translation result failed deterministic validation",
      502,
      "TRANSLATION_VALIDATION_FAILED",
    );
    this.name = "TranslationValidationError";
    this.issues = issues;
  }
}

function createTranslationMessages(
  request: TranslationRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildSystemPrompt(request.sourceLanguage, request.targetLanguage),
    },
  ];

  for (const turn of request.context) {
    messages.push({ role: "user", content: turn.source });
    messages.push({ role: "assistant", content: turn.translation });
  }

  const glossary = request.glossary
    .map((term) => `${term.source} => ${term.target}`)
    .join("\n");
  messages.push({
    role: "user",
    content: glossary
      ? `ASR-aware glossary (speech recognition may contain phonetic misspellings; apply only relevant mappings):\n${glossary}\n\nSource text:\n${request.text}`
      : request.text,
  });
  return messages;
}

function createReviewMessages(
  request: TranslationReviewRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const context = request.context
    .map((turn) => `Source: ${turn.source}\nTranslation: ${turn.translation}`)
    .join("\n\n");
  const glossary = request.glossary
    .map((term) => `${term.source} => ${term.target}`)
    .join("\n");

  return [
    {
      role: "system",
      content: buildReviewSystemPrompt(request.sourceLanguage, request.targetLanguage),
    },
    {
      role: "user",
      content: [
        context ? `Recent context:\n${context}` : "Recent context: (none)",
        glossary ? `Required glossary:\n${glossary}` : "Required glossary: (none)",
        `Source text:\n${request.sourceText}`,
        `Candidate translation:\n${request.originalTranslation}`,
      ].join("\n\n"),
    },
  ];
}

function providerExtras(
  vendor: ProviderSettings["vendor"],
  thinkingMode: ThinkingMode,
): Record<string, unknown> {
  if (vendor === "deepseek") {
    return {
      thinking: { type: thinkingMode },
      ...(thinkingMode === "enabled" ? { reasoning_effort: "low" } : {}),
    };
  }
  return {};
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  const providerCode = error.code === null ? "" : String(error.code);
  return error.status === 429 || providerCode.startsWith("429");
}

function mapProviderError(error: unknown, signal: AbortSignal): never {
  if (error instanceof TranslationProviderError || error instanceof TranslationNotConfiguredError) {
    throw error;
  }

  if (signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error && reason.name === "TimeoutError") {
      throw new TranslationProviderError(
        "Translation request timed out",
        504,
        "TRANSLATION_TIMEOUT",
      );
    }
    throw new TranslationProviderError(
      "Translation request was cancelled",
      499,
      "TRANSLATION_CANCELLED",
    );
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    throw new TranslationProviderError(
      "Translation request timed out",
      504,
      "TRANSLATION_TIMEOUT",
    );
  }

  if (error instanceof OpenAI.APIUserAbortError) {
    throw new TranslationProviderError(
      "Translation request was cancelled",
      499,
      "TRANSLATION_CANCELLED",
    );
  }

  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 502;
    if (isRateLimitError(error)) {
      throw new TranslationProviderError(
        "Translation provider rate limit reached",
        429,
        "TRANSLATION_RATE_LIMITED",
      );
    }
    if (status === 408) {
      throw new TranslationProviderError(
        "Translation provider timed out",
        504,
        "TRANSLATION_TIMEOUT",
      );
    }
    throw new TranslationProviderError(
      status >= 400 && status < 500
        ? "Translation provider configuration was rejected"
        : "Translation provider request failed",
      status >= 500 ? 502 : status === 401 || status === 403 ? 502 : status,
      status >= 400 && status < 500
        ? "TRANSLATION_PROVIDER_CONFIGURATION"
        : "TRANSLATION_PROVIDER_ERROR",
    );
  }

  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw new TranslationProviderError(
      error.name === "TimeoutError"
        ? "Translation request timed out"
        : "Translation request was cancelled",
      error.name === "TimeoutError" ? 504 : 499,
      error.name === "TimeoutError" ? "TRANSLATION_TIMEOUT" : "TRANSLATION_CANCELLED",
    );
  }

  throw new TranslationProviderError("Translation provider request failed");
}

function assertCompleted(finishReason: string | null | undefined): void {
  if (finishReason === "stop") {
    return;
  }
  if (finishReason === "length") {
    throw new TranslationProviderError(
      "Translation result was truncated",
      502,
      "TRANSLATION_TRUNCATED",
    );
  }
  if (finishReason === "content_filter") {
    throw new TranslationProviderError(
      "Translation result was filtered",
      502,
      "TRANSLATION_FILTERED",
    );
  }
  if (finishReason === "insufficient_system_resource") {
    throw new TranslationProviderError(
      "Translation provider is temporarily unavailable",
      503,
      "TRANSLATION_PROVIDER_BUSY",
    );
  }
  throw new TranslationProviderError(
    "Translation provider returned an incomplete result",
    502,
    "TRANSLATION_INCOMPLETE",
  );
}

function assertValid(request: TranslationRequest, text: string): void {
  const validation = validateTranslation(request, text);
  if (!validation.valid) {
    throw new TranslationValidationError(validation.issues);
  }
}

class ProviderRuntime {
  readonly configured: boolean;
  readonly id: TranslationModelId;
  private readonly client?: OpenAI;
  private readonly semaphore: AbortableSemaphore;

  constructor(
    private readonly settings: ProviderSettings,
    private readonly timeoutMs: number,
    private readonly maxOutputTokens: number,
    private readonly onTelemetry?: (event: TranslationProviderTelemetry) => void,
  ) {
    this.configured = Boolean(settings.apiKey);
    this.id = settings.id;
    this.semaphore = new AbortableSemaphore(settings.concurrency);

    if (settings.apiKey) {
      this.client = new OpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl,
        maxRetries: 0,
        timeout: timeoutMs,
      });
    }
  }

  async complete(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    thinkingMode: ThinkingMode,
    signal?: AbortSignal,
    limits?: { maxOutputTokens?: number; timeoutMs?: number },
  ): Promise<TranslationResult> {
    const combinedSignal = this.createSignal(signal, limits?.timeoutMs);

    try {
      return await this.withRateLimitRetry(async () => {
        const client = this.requireClient();
        const release = await this.semaphore.acquire(combinedSignal);
        try {
          const response = await client.chat.completions.create(
            this.createParams(messages, false, thinkingMode, limits?.maxOutputTokens),
            { signal: combinedSignal, timeout: limits?.timeoutMs ?? this.timeoutMs },
          );
          const completion = response as OpenAI.Chat.Completions.ChatCompletion;
          const choice = completion.choices[0];
          assertCompleted(choice?.finish_reason);
          const text = choice?.message.content?.trim();
          if (!text) {
            throw new TranslationProviderError("Translation provider returned an empty result");
          }

          const result: TranslationResult = { text };
          if (completion.usage) {
            result.usage = {
              inputTokens: completion.usage.prompt_tokens,
              outputTokens: completion.usage.completion_tokens,
            };
          }
          return result;
        } finally {
          release();
        }
      }, combinedSignal);
    } catch (error) {
      return mapProviderError(error, combinedSignal);
    }
  }

  async completeStreamBuffered(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    thinkingMode: ThinkingMode,
    signal?: AbortSignal,
  ): Promise<BufferedStream> {
    const combinedSignal = this.createSignal(signal);

    try {
      return await this.withRateLimitRetry(async () => {
        const client = this.requireClient();
        const release = await this.semaphore.acquire(combinedSignal);
        const chunks: string[] = [];
        let finishReason: string | null | undefined;
        let usage: TranslationUsage | undefined;

        try {
          const stream = await client.chat.completions.create(
            this.createParams(messages, true, thinkingMode),
            { signal: combinedSignal, timeout: this.timeoutMs },
          );

          for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
            const choice = chunk.choices[0];
            const delta = choice?.delta.content;
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (delta) {
              chunks.push(delta);
            }
            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              };
            }
          }

          assertCompleted(finishReason);
          const text = chunks.join("").trim();
          if (!text) {
            throw new TranslationProviderError("Translation provider returned an empty result");
          }
          return usage ? { chunks, text, usage } : { chunks, text };
        } finally {
          release();
        }
      }, combinedSignal);
    } catch (error) {
      return mapProviderError(error, combinedSignal);
    }
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new TranslationNotConfiguredError(`Translation model ${this.id} is not configured`);
    }
    return this.client;
  }

  private createSignal(signal?: AbortSignal, timeoutMs = this.timeoutMs): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  private createParams(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    stream: boolean,
    thinkingMode: ThinkingMode,
    maxOutputTokens = this.maxOutputTokens,
  ): CompatibleRequest {
    return {
      model: this.settings.model,
      messages,
      max_tokens: maxOutputTokens,
      temperature: 0.2,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...providerExtras(this.settings.vendor, thinkingMode),
    };
  }

  private async withRateLimitRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        const maximumRetries = this.settings.vendor === "tencent" ? 0 : MAX_RATE_LIMIT_RETRIES;
        if (!isRateLimitError(error) || attempt >= maximumRetries) {
          throw error;
        }
        const exponential = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
        const jitter = Math.floor(Math.random() * RATE_LIMIT_BASE_DELAY_MS);
        const delayMs = exponential + jitter;
        this.onTelemetry?.({
          type: "rate_limit_retry",
          model: this.id,
          attempt: attempt + 1,
          delayMs,
        });
        await abortableDelay(delayMs, signal);
      }
    }
  }
}

export class TranslationProviderRegistry {
  readonly primaryModel: TranslationModelId;
  readonly fallbackModel: TranslationModelId;
  private readonly runtimes = new Map<TranslationModelId, ProviderRuntime>();
  private readonly telemetryListeners = new Set<(event: TranslationProviderTelemetry) => void>();

  constructor(settings: TranslationSettings) {
    this.primaryModel = settings.primaryModel;
    this.fallbackModel = settings.fallbackModel;
    for (const provider of Object.values(settings.providers)) {
      this.runtimes.set(
        provider.id,
        new ProviderRuntime(
          provider,
          settings.timeoutMs,
          settings.maxOutputTokens,
          (event) => this.emitTelemetry(event),
        ),
      );
    }
  }

  isConfigured(model: TranslationModelId): boolean {
    return this.runtimes.get(model)?.configured ?? false;
  }

  configuredModels(): TranslationModelId[] {
    return [...this.runtimes.entries()]
      .filter(([, runtime]) => runtime.configured)
      .map(([model]) => model);
  }

  subscribeTelemetry(listener: (event: TranslationProviderTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  translate(
    model: TranslationModelId,
    request: TranslationRequest,
    signal?: AbortSignal,
  ): Promise<TranslationResult> {
    return this.runtime(model).complete(createTranslationMessages(request), "disabled", signal);
  }

  translateStreamBuffered(
    model: TranslationModelId,
    request: TranslationRequest,
    signal?: AbortSignal,
  ): Promise<BufferedStream> {
    return this.runtime(model).completeStreamBuffered(
      createTranslationMessages(request),
      "disabled",
      signal,
    );
  }

  review(
    request: TranslationReviewRequest,
    signal?: AbortSignal,
  ): Promise<TranslationResult> {
    return this.runtime("deepseek-v4-flash").complete(
      createReviewMessages(request),
      "enabled",
      signal,
      { maxOutputTokens: 8192, timeoutMs: 60000 },
    );
  }

  private runtime(model: TranslationModelId): ProviderRuntime {
    const runtime = this.runtimes.get(model);
    if (!runtime) {
      throw new TranslationProviderError(
        `Unknown translation model: ${model}`,
        400,
        "TRANSLATION_MODEL_UNKNOWN",
      );
    }
    return runtime;
  }

  private emitTelemetry(event: TranslationProviderTelemetry): void {
    for (const listener of this.telemetryListeners) {
      listener(event);
    }
  }
}

// Compatibility facade used by the existing server and routes.
export class OpenAICompatibleTranslationProvider {
  readonly provider = "registry";
  readonly model: TranslationModelId;
  readonly configured: boolean;
  readonly registry: TranslationProviderRegistry;

  constructor(settings: TranslationSettings) {
    this.registry = new TranslationProviderRegistry(settings);
    this.model = settings.primaryModel;
    this.configured =
      this.registry.isConfigured(settings.primaryModel) ||
      this.registry.isConfigured(settings.fallbackModel);
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult> {
    const selectedModel = request.model ?? this.registry.primaryModel;
    try {
      const result = await this.registry.translate(selectedModel, request, signal);
      assertValid(request, result.text);
      return result;
    } catch (error) {
      if (!this.shouldFallback(selectedModel, error)) {
        throw error;
      }
      const fallback = await this.registry.translate(this.registry.fallbackModel, request, signal);
      assertValid(request, fallback.text);
      return fallback;
    }
  }

  async *translateStream(
    request: TranslationRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<TranslationStreamEvent> {
    const selectedModel = request.model ?? this.registry.primaryModel;
    let result: BufferedStream;

    try {
      result = await this.registry.translateStreamBuffered(selectedModel, request, signal);
      assertValid(request, result.text);
    } catch (error) {
      if (!this.shouldFallback(selectedModel, error)) {
        throw error;
      }
      result = await this.registry.translateStreamBuffered(
        this.registry.fallbackModel,
        request,
        signal,
      );
      assertValid(request, result.text);
    }

    // Results are buffered until validation so fallback text can never be appended
    // to already-emitted invalid text on the existing SSE protocol.
    for (const chunk of result.chunks) {
      yield { type: "delta", text: chunk };
    }
    if (result.usage) {
      yield { type: "usage", usage: result.usage };
    }
    yield { type: "done", text: result.text };
  }

  async reviewTranslation(
    request: TranslationReviewRequest,
    signal?: AbortSignal,
  ): Promise<TranslationReviewResult> {
    const result = await this.registry.review(request, signal);
    const validationRequest: TranslationRequest = {
      text: request.sourceText,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      context: request.context,
      glossary: request.glossary,
    };
    assertValid(validationRequest, result.text);

    const reviewed: TranslationReviewResult = {
      originalTranslation: request.originalTranslation,
      reviewedTranslation: result.text,
      corrected: request.originalTranslation.trim() !== result.text.trim(),
      model: "deepseek-v4-flash",
    };
    if (result.usage) {
      reviewed.usage = result.usage;
    }
    return reviewed;
  }

  private shouldFallback(model: TranslationModelId, error: unknown): boolean {
    if (model === this.registry.fallbackModel || !this.registry.isConfigured(this.registry.fallbackModel)) {
      return false;
    }
    return !(
      error instanceof TranslationProviderError &&
      error.providerCode === "TRANSLATION_CANCELLED"
    );
  }
}
