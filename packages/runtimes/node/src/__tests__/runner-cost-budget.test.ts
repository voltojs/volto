/**
 * P0-1: Runner cost budget — verify cumulativeCost uses real dollar pricing.
 *
 * When pricing is configured, cumulativeCost should accumulate dollar amounts
 * (tokens × per-1M rate / 1M) rather than raw token counts. This ensures
 * maxCostDollars threshold triggers budget_exceeded at the correct dollar spend.
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import {
  createMockModelPort,
  createInitialState,
  textDelta,
  usage,
  modelDone,
} from "@volto/core";
import type { StepContext, ToolDefinition, EventSink } from "@volto/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

describe("Runner cost budget with pricing", () => {
  it("emits budget_exceeded when dollar cost exceeds maxCostDollars", async () => {
    // Pricing: $10/1M input, $30/1M output
    // Usage: 100 input tokens + 100 output tokens
    // Cost: (100 * 10 + 100 * 30) / 1_000_000 = 4000 / 1_000_000 = $0.004
    // Threshold: $0.001 → should trigger
    const pricing = { "test-model": { inputPer1M: 10, outputPer1M: 30 } };

    const mockModel = createMockModelPort([
      [usage(100, 100), textDelta("Done"), modelDone("end_turn")],
    ]);

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) { events.push(event as { type: string; data?: unknown }); },
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      availableCapabilities: capabilities,
      pricing,
      initialState: createInitialState({ maxCostDollars: 0.001 }),
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    // State should be done (budget_exceeded terminates the turn)
    expect(state.status).toBe("done");

    // A budget_exceeded event must have been emitted
    const budgetEvent = events.find((e) => e.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.data).toEqual({ reason: "Cost budget exceeded" });
  });

  it("does NOT emit budget_exceeded when cost is below threshold", async () => {
    // Pricing: $10/1M input, $30/1M output
    // Usage: 10 input tokens + 10 output tokens
    // Cost: (10 * 10 + 10 * 30) / 1_000_000 = 400 / 1_000_000 = $0.0004
    // Threshold: $0.001 → should NOT trigger
    const pricing = { "test-model": { inputPer1M: 10, outputPer1M: 30 } };

    const mockModel = createMockModelPort([
      [usage(10, 10), textDelta("OK"), modelDone("end_turn")],
    ]);

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) { events.push(event as { type: string; data?: unknown }); },
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      availableCapabilities: capabilities,
      pricing,
      initialState: createInitialState({ maxCostDollars: 0.001 }),
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");

    // No budget_exceeded event should be emitted
    const budgetEvent = events.find((e) => e.type === "budget_exceeded");
    expect(budgetEvent).toBeUndefined();
  });

  it("falls back to token counting when no pricing entry exists for model", async () => {
    // No pricing entry for "test-model" — should fall back to token accumulation
    // Usage: 500 input + 500 output = 1000 tokens
    // Threshold: 500 → triggers (token-based fallback)
    const pricing = { "other-model": { inputPer1M: 10, outputPer1M: 30 } };

    const mockModel = createMockModelPort([
      [usage(500, 500), textDelta("Hi"), modelDone("end_turn")],
    ]);

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) { events.push(event as { type: string; data?: unknown }); },
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      availableCapabilities: capabilities,
      pricing,
      initialState: createInitialState({ maxCostDollars: 0.001 }),
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");

    const budgetEvent = events.find((e) => e.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.data).toEqual({ reason: "Cost budget exceeded" });
  });

  it("falls back to token counting when pricing is undefined", async () => {
    // No pricing at all — should fall back to token accumulation
    // Usage: 500 input + 500 output = 1000 tokens
    // Threshold: 500 → triggers (token-based fallback)
    const mockModel = createMockModelPort([
      [usage(500, 500), textDelta("Hi"), modelDone("end_turn")],
    ]);

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) { events.push(event as { type: string; data?: unknown }); },
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      availableCapabilities: capabilities,
      initialState: createInitialState({ maxCostDollars: 0.001 }),
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");

    const budgetEvent = events.find((e) => e.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.data).toEqual({ reason: "Cost budget exceeded" });
  });
});
