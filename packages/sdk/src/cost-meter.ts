/**
 * CostMeter — per-turn token and dollar cost aggregation.
 *
 * Consumes normalized usage events, aggregates token counts and dollar costs,
 * and exposes results via EventSink + Telemetry port. Does NOT trigger any
 * budget enforcement (that's M8 Phase 4's responsibility).
 */

import type { ModelEvent, EventSink, Telemetry, PricingEntry, PricingTable } from "@voltojs/core";
import { computeUsageCost } from "@voltojs/core";

// Re-exported so the SDK's public API is unchanged — the arithmetic and
// types now live in @voltojs/core (shared with the Node runtime's budget
// gates), but consumers of @voltojs/sdk still import them from here.
export type { PricingEntry, PricingTable };

export interface CostMeterResult {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  model: string;
}

export interface CostMeterOptions {
  /** Pricing table keyed by "provider/model" (e.g. "anthropic/claude-sonnet-4-20250514") */
  pricing: PricingTable;
  /** Model name for pricing lookup */
  model?: string;
  /** EventSink to emit cost summary events */
  eventSink?: EventSink;
  /** Telemetry port to report cost metrics */
  telemetry?: Telemetry;
}

/**
 * Create a CostMeter that accumulates usage across a single turn.
 *
 * Usage:
 * ```ts
 * const meter = createCostMeter({ pricing, eventSink, telemetry });
 * for await (const event of modelStream) {
 *   meter.record(event); // accumulates usage events
 *   yield event;         // pass through to consumer
 * }
 * const result = meter.result(); // get aggregated cost
 * ```
 */
export function createCostMeter(opts: CostMeterOptions) {
  const { pricing, eventSink, telemetry } = opts;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = opts.model ?? "";
  let recorded = false;

  function record(event: ModelEvent, modelOverride?: string): void {
    if (modelOverride) model = modelOverride;

    if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      cacheReadTokens += event.cacheReadTokens ?? 0;
      cacheWriteTokens += event.cacheWriteTokens ?? 0;
      recorded = true;
    }
  }

  function result(): CostMeterResult {
    const entry = pricing[model];
    const cost = entry
      ? computeUsageCost(entry, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
      : 0;

    const summary: CostMeterResult = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalCost: cost,
      model,
    };

    if (recorded) {
      eventSink?.emit({
        type: "cost_summary",
        data: summary as unknown as Record<string, unknown>,
      });

      telemetry?.metric("cost_total", cost);
      telemetry?.metric("tokens_input", inputTokens);
      telemetry?.metric("tokens_output", outputTokens);
    }

    return summary;
  }

  function reset(): void {
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
    model = opts.model ?? "";
    recorded = false;
  }

  return { record, result, reset };
}
