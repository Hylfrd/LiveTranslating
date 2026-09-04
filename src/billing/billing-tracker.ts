import type { BillingCurrency, BillingModelSnapshot, BillingSnapshot } from "./types.js";
import type { ProviderModelId, TranslationUsage } from "../translation/schema.js";

interface MutableModelUsage {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedRequests: number;
  cost: number;
}

interface PriceRule {
  readonly currency: BillingCurrency;
  readonly source: string;
  readonly verifiedAt: string;
  readonly pricesAt: (date: Date) => {
    readonly input: number;
    readonly cachedInput?: number;
    readonly output: number;
    readonly tier?: "peak" | "off-peak";
  };
}

const VERIFIED_AT = "2026-09-04";
const PRICE_RULES: Readonly<Record<ProviderModelId, PriceRule>> = {
  "hy-mt2-plus": {
    currency: "CNY",
    source: "Tencent TokenHub official pricing",
    verifiedAt: VERIFIED_AT,
    pricesAt: () => ({ input: 0.5, output: 2 }),
  },
  "hy-mt2-pro": {
    currency: "CNY",
    source: "Tencent TokenHub official pricing",
    verifiedAt: VERIFIED_AT,
    pricesAt: () => ({ input: 0.5, output: 2 }),
  },
  "deepseek-v4-flash": {
    currency: "USD",
    source: "DeepSeek official peak/off-peak pricing",
    verifiedAt: VERIFIED_AT,
    pricesAt: (date) => {
      const tier = isDeepSeekPeak(date) ? "peak" : "off-peak";
      return tier === "peak"
        ? { input: 0.44, cachedInput: 0.014, output: 1.32, tier }
        : { input: 0.22, cachedInput: 0.007, output: 0.66, tier };
    },
  },
  "deepseek-v4-pro": {
    currency: "USD",
    source: "DeepSeek official peak/off-peak pricing",
    verifiedAt: VERIFIED_AT,
    pricesAt: (date) => {
      const tier = isDeepSeekPeak(date) ? "peak" : "off-peak";
      return tier === "peak"
        ? { input: 1.32, cachedInput: 0.044, output: 3.96, tier }
        : { input: 0.66, cachedInput: 0.022, output: 1.98, tier };
    },
  },
};

export class BillingTracker {
  private readonly usage = new Map<ProviderModelId, MutableModelUsage>();
  private sessionStartedAt: string | undefined;
  private referenceStatus: BillingSnapshot["pricingReference"] = {
    source: "models.dev",
    status: "checking",
    message: "正在核对在线价格参考",
  };

  startSession(startedAt = new Date()): void {
    this.usage.clear();
    this.sessionStartedAt = startedAt.toISOString();
  }

  record(model: ProviderModelId, usage: TranslationUsage | undefined, at = new Date()): void {
    if (!usage) {
      return;
    }
    const current = this.usage.get(model) ?? {
      requests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      estimatedRequests: 0,
      cost: 0,
    };
    const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
    const uncachedInputTokens = usage.inputTokens - cachedInputTokens;
    const prices = PRICE_RULES[model].pricesAt(at);
    current.requests += 1;
    current.inputTokens += usage.inputTokens;
    current.cachedInputTokens += cachedInputTokens;
    current.outputTokens += usage.outputTokens;
    current.estimatedRequests += usage.estimated ? 1 : 0;
    current.cost += (
      uncachedInputTokens * prices.input
      + cachedInputTokens * (prices.cachedInput ?? prices.input)
      + usage.outputTokens * prices.output
    ) / 1_000_000;
    this.usage.set(model, current);
  }

  async refreshPricingReference(): Promise<void> {
    this.referenceStatus = {
      source: "models.dev",
      status: "checking",
      message: "正在核对在线价格参考",
    };
    try {
      const response = await fetch("https://models.dev/api.json", {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const catalog = await response.json() as ModelsDevCatalog;
      const deepSeek = catalog.deepseek?.models?.["deepseek-v4-flash"];
      const stale = !deepSeek?.last_updated || deepSeek.last_updated < "2026-08-16";
      this.referenceStatus = {
        source: "models.dev",
        status: "checked",
        checkedAt: new Date().toISOString(),
        message: stale
          ? "在线参考仍是旧价，当前继续采用官方峰谷价"
          : "在线参考已检查；渠道价不自动覆盖官方计费规则",
      };
    } catch (error) {
      this.referenceStatus = {
        source: "models.dev",
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: `在线参考不可用，继续采用官方兜底价：${errorMessage(error)}`,
      };
    }
  }

  getSnapshot(at = new Date()): BillingSnapshot {
    const models = (Object.keys(PRICE_RULES) as ProviderModelId[]).map((model) => {
      const current = this.usage.get(model) ?? {
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedRequests: 0,
        cost: 0,
      };
      const rule = PRICE_RULES[model];
      const prices = rule.pricesAt(at);
      return {
        model,
        requests: current.requests,
        inputTokens: current.inputTokens,
        cachedInputTokens: current.cachedInputTokens,
        outputTokens: current.outputTokens,
        estimatedRequests: current.estimatedRequests,
        cost: roundCost(current.cost),
        currency: rule.currency,
        inputPricePerMillion: prices.input,
        ...(prices.cachedInput === undefined ? {} : { cachedInputPricePerMillion: prices.cachedInput }),
        outputPricePerMillion: prices.output,
        ...(prices.tier === undefined ? {} : { priceTier: prices.tier }),
        priceSource: rule.source,
        priceVerifiedAt: rule.verifiedAt,
      } satisfies BillingModelSnapshot;
    });
    const totals: Partial<Record<BillingCurrency, number>> = {};
    for (const item of models) {
      totals[item.currency] = roundCost((totals[item.currency] ?? 0) + item.cost);
    }
    return {
      ...(this.sessionStartedAt ? { sessionStartedAt: this.sessionStartedAt } : {}),
      models,
      totalInputTokens: models.reduce((sum, item) => sum + item.inputTokens, 0),
      totalCachedInputTokens: models.reduce((sum, item) => sum + item.cachedInputTokens, 0),
      totalOutputTokens: models.reduce((sum, item) => sum + item.outputTokens, 0),
      totalRequests: models.reduce((sum, item) => sum + item.requests, 0),
      estimatedRequests: models.reduce((sum, item) => sum + item.estimatedRequests, 0),
      totals,
      pricingReference: this.referenceStatus,
    };
  }
}

interface ModelsDevCatalog {
  readonly deepseek?: {
    readonly models?: Record<string, {
      readonly last_updated?: string;
      readonly cost?: { readonly input?: number; readonly output?: number };
    }>;
  };
}

function isDeepSeekPeak(date: Date): boolean {
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
