/**
 * Follow-up to plan-020's final review: cumulativeTokens must count cache
 * tokens, not just input+output. A real DeepSeek V4 Flash turn was measured
 * as {inputTokens: 105, outputTokens: 10, cacheReadTokens: 5504} — cache is
 * 98% of the turn's tokens. Before the fix, cumulativeTokens only advanced by
 * 115 and maxTokensPerTurn was off by a factor of ~49.
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import { createMockModelPort, createInitialState, textDelta, modelDone } from "@volto/core";
import type { StepContext, ToolDefinition, EventSink, ModelEvent } from "@volto/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

// A usage event carrying a large cache-read count, mirroring a real
// DeepSeek V4 Flash turn where cache reads dwarf input+output.
const cacheHeavyUsage: ModelEvent = {
  type: "usage",
  inputTokens: 105,
  outputTokens: 10,
  cacheReadTokens: 5504,
};

describe("Runner token budget counts cache tokens", () => {
  it("emits budget_exceeded when cache tokens push the total over maxTokensPerTurn", async () => {
    // input(105) + output(10) = 115 — below a 1000 threshold on its own.
    // input+output+cacheRead = 5619 — over a 1000 threshold.
    const mockModel = createMockModelPort([
      [cacheHeavyUsage, textDelta("Done"), modelDone("end_turn")],
    ]);

    const events: Array<{ type: string; data?: unknown }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) {
        events.push(event as { type: string; data?: unknown });
      },
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      availableCapabilities: capabilities,
      initialState: createInitialState({ maxTokensPerTurn: 1000 }),
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");

    const budgetEvent = events.find((e) => e.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.data).toEqual({ reason: "Token budget exceeded" });
  });
});
