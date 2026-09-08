/**
 * Pricing — pure token-cost arithmetic.
 *
 * Shared by the SDK's CostMeter and the Node runtime's budget gates. Both
 * need identical arithmetic, but the runtime cannot import the SDK
 * (dependency direction is core ← runtimes-* ← sdk), so the pure formula
 * lives here — the one package both sides may depend on.
 */

export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export type PricingTable = Record<string, PricingEntry>;

/** Token counts for one usage event or aggregate — the shape both call sites already have. */
export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Dollar cost for a usage snapshot against a pricing entry. Cache tokens are
 * priced at their dedicated rate when the entry defines one, and at zero
 * (never at the input/output rate) when it does not.
 */
export function computeUsageCost(entry: PricingEntry, usage: UsageCounts): number {
  const inputCost = (usage.inputTokens / 1_000_000) * entry.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * entry.outputPer1M;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheReadCost =
    cacheReadTokens > 0 && entry.cacheReadPer1M !== undefined
      ? (cacheReadTokens / 1_000_000) * entry.cacheReadPer1M
      : 0;
  const cacheWriteCost =
    cacheWriteTokens > 0 && entry.cacheWritePer1M !== undefined
      ? (cacheWriteTokens / 1_000_000) * entry.cacheWritePer1M
      : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Honest total token count for a usage snapshot — includes cache tokens, unlike input+output alone. */
export function totalUsageTokens(usage: UsageCounts): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
