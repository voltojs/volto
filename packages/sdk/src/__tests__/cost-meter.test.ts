import { describe, it, expect } from "vitest";
import { createCostMeter } from "../cost-meter.js";
import type { PricingTable } from "../cost-meter.js";
import type { EventSink } from "@voltojs/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const TEST_PRICING: PricingTable = {
  "test-model": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
};

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("createCostMeter", () => {
  describe("usage aggregation", () => {
    it("should accumulate input and output tokens", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING });

      meter.record({ type: "usage", inputTokens: 100, outputTokens: 50 });
      const result = meter.result();

      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.cacheReadTokens).toBe(0);
      expect(result.cacheWriteTokens).toBe(0);
    });

    it("should accumulate cache tokens", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING });

      meter.record({
        type: "usage",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 80,
        cacheWriteTokens: 40,
      });
      const result = meter.result();

      expect(result.cacheReadTokens).toBe(80);
      expect(result.cacheWriteTokens).toBe(40);
    });

    it("should accumulate across multiple usage events", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING });

      meter.record({ type: "usage", inputTokens: 100, outputTokens: 50 });
      meter.record({ type: "usage", inputTokens: 200, outputTokens: 100 });
      const result = meter.result();

      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
    });
  });

  describe("cost calculation", () => {
    it("should compute dollar cost from pricing table", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING, model: "test-model" });

      meter.record({ type: "usage", inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const result = meter.result();

      // $3.00 input + $15.00 output = $18.00
      expect(result.totalCost).toBeCloseTo(18.0, 2);
    });

    it("should include cache read/write costs", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING, model: "test-model" });

      meter.record({
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      });
      const result = meter.result();

      // $0.30 cache read + $3.75 cache write = $4.05
      expect(result.totalCost).toBeCloseTo(4.05, 2);
    });

    it("should return 0 cost for unknown model", () => {
      const meter = createCostMeter({ pricing: {} });

      meter.record({ type: "usage", inputTokens: 1000, outputTokens: 500 });
      const result = meter.result();

      expect(result.totalCost).toBe(0);
    });
  });

  describe("EventSink emission", () => {
    it("should emit cost_summary to EventSink", () => {
      const emitted: unknown[] = [];
      const eventSink: EventSink = {
        emit: (event) => emitted.push(event),
      };

      const meter = createCostMeter({ pricing: TEST_PRICING, eventSink });
      meter.record({ type: "usage", inputTokens: 100, outputTokens: 50 });
      meter.result();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "cost_summary",
        data: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
        }),
      });
    });

    it("should not emit if no usage recorded", () => {
      const emitted: unknown[] = [];
      const eventSink: EventSink = {
        emit: (event) => emitted.push(event),
      };

      const meter = createCostMeter({ pricing: TEST_PRICING, eventSink });
      meter.result();

      expect(emitted).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("should clear all accumulated data", () => {
      const meter = createCostMeter({ pricing: TEST_PRICING });

      meter.record({ type: "usage", inputTokens: 100, outputTokens: 50 });
      meter.reset();
      const result = meter.result();

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalCost).toBe(0);
    });
  });
});
