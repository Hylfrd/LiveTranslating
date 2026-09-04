import type { ProviderModelId } from "../translation/schema.js";

export type BillingCurrency = "CNY" | "USD";
export type PricingReferenceStatus = "checking" | "checked" | "unavailable";

export interface BillingModelSnapshot {
  readonly model: ProviderModelId;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly estimatedRequests: number;
  readonly cost: number;
  readonly currency: BillingCurrency;
  readonly inputPricePerMillion: number;
  readonly cachedInputPricePerMillion?: number;
  readonly outputPricePerMillion: number;
  readonly priceTier?: "peak" | "off-peak";
  readonly priceSource: string;
  readonly priceVerifiedAt: string;
}

export interface BillingSnapshot {
  readonly sessionStartedAt?: string;
  readonly models: readonly BillingModelSnapshot[];
  readonly totalInputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalRequests: number;
  readonly estimatedRequests: number;
  readonly totals: Readonly<Partial<Record<BillingCurrency, number>>>;
  readonly pricingReference: {
    readonly source: "models.dev";
    readonly status: PricingReferenceStatus;
    readonly checkedAt?: string;
    readonly message: string;
  };
}
