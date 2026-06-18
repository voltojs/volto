/**
 * CostMeter — per-turn token and dollar cost aggregation.
 *
 * Consumes normalized usage events, aggregates token counts and dollar costs,
 * and exposes results via EventSink + Telemetry port. Does NOT trigger any
 * budget enforcement (that's M8 Phase 4's responsibility).
 */

import type { ModelEvent, EventSink, Telemetry } from "@volto/core";

export interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export type PricingTable = Record<string, PricingEntry>;

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
    const cost = entry ? computeCost(entry, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) : 0;

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

function computeCost(
  entry: PricingEntry,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * entry.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * entry.outputPer1M;
  const cacheReadCost = cacheReadTokens > 0 && entry.cacheReadPer1M !== undefined
    ? (cacheReadTokens / 1_000_000) * entry.cacheReadPer1M
    : 0;
  const cacheWriteCost = cacheWriteTokens > 0 && entry.cacheWritePer1M !== undefined
    ? (cacheWriteTokens / 1_000_000) * entry.cacheWritePer1M
    : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
