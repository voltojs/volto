import { describe, it, expect } from "vitest";
import { computeUsageCost, totalUsageTokens } from "../pricing.js";
import type { PricingEntry } from "../pricing.js";

describe("computeUsageCost", () => {
  const withCachePricing: PricingEntry = {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  };

  const withoutCachePricing: PricingEntry = {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  };

  it("prices cache tokens at their dedicated rate when the entry defines one", () => {
    const cost = computeUsageCost(withCachePricing, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    // $0.30 cache read + $3.75 cache write = $4.05
    expect(cost).toBeCloseTo(4.05, 5);
  });

  it("prices cache tokens at zero — never at the input/output rate — when the entry has no cache pricing", () => {
    const cost = computeUsageCost(withoutCachePricing, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    // Only input+output should be priced; cache tokens contribute $0.
    const inputOutputOnly = computeUsageCost(withoutCachePricing, { inputTokens: 100, outputTokens: 50 });
    expect(cost).toBeCloseTo(inputOutputOnly, 10);
  });

  it("computes only input/output cost when cache tokens are zero", () => {
    const cost = computeUsageCost(withCachePricing, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // $3.00 input + $15.00 output = $18.00
    expect(cost).toBeCloseTo(18.0, 5);
  });

  it("treats omitted cache fields the same as zero", () => {
    const cost = computeUsageCost(withCachePricing, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(18.0, 5);
  });
});

describe("totalUsageTokens", () => {
  it("includes cache tokens in the total", () => {
    expect(
      totalUsageTokens({ inputTokens: 105, outputTokens: 10, cacheReadTokens: 5504, cacheWriteTokens: 0 }),
    ).toBe(5619);
  });

  it("defaults missing cache fields to zero", () => {
    expect(totalUsageTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });
});
