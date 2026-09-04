import { Tokenizer } from "@huggingface/tokenizers";

import type { ProviderModelId, TranslationUsage } from "../translation/schema.js";

const MODEL_REPOSITORIES: Readonly<Record<ProviderModelId, string>> = {
  "deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-v4-pro": "deepseek-ai/DeepSeek-V4-Pro",
  "hy-mt2-plus": "tencent/HY-MT2-7B",
  "hy-mt2-pro": "tencent/HY-MT2-30B-A3B",
};

const tokenizers = new Map<ProviderModelId, Promise<Tokenizer>>();

export async function estimateTokenUsage(
  model: ProviderModelId,
  input: string,
  output: string,
): Promise<TranslationUsage> {
  try {
    const tokenizer = await loadTokenizer(model);
    return {
      inputTokens: tokenizer.encode(input).ids.length,
      outputTokens: tokenizer.encode(output).ids.length,
      estimated: true,
    };
  } catch {
    return {
      inputTokens: approximateTokens(input),
      outputTokens: approximateTokens(output),
      estimated: true,
    };
  }
}

function loadTokenizer(model: ProviderModelId): Promise<Tokenizer> {
  const existing = tokenizers.get(model);
  if (existing) {
    return existing;
  }
  const repository = MODEL_REPOSITORIES[model];
  const operation = Promise.all([
    fetchJson(`https://huggingface.co/${repository}/resolve/main/tokenizer.json`),
    fetchJson(`https://huggingface.co/${repository}/resolve/main/tokenizer_config.json`),
  ]).then(([tokenizer, config]) => new Tokenizer(tokenizer, config));
  tokenizers.set(model, operation);
  operation.catch(() => tokenizers.delete(model));
  return operation;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Tokenizer download failed with HTTP ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

function approximateTokens(text: string): number {
  const han = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const other = Math.max(0, text.length - han);
  return Math.max(1, han + Math.ceil(other / 4));
}
