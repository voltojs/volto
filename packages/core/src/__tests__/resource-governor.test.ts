/**
 * Phase 4 — resource governor (deterministic limits in core + Runner wallclock/cost).
 *
 * Tests that:
 *  - token / tool call / iteration limits enforced by the reducer (pure, replayable)
 *  - wallclock / cost limits enforced by the Runner (via budget_exceeded input)
 *  - undefined limits = no limit (backward compatible)
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";
import type { EmitEffect } from "../effect.js";

const testTools: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requires: ["shell:exec"],
    riskTier: "WRITE_LOW",
  },
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
];

const ctx: StepContext = { tools: testTools, model: "test-model", maxTokens: 4096 };

function drive(inputs: AgentInput[], context: StepContext = ctx, overrides?: Partial<ReducerState>) {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = createInitialState(overrides);
  for (const input of inputs) {
    if (state.status === "done") break;
    const result = step(state, input, context);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

/** One full inner-loop iteration: model → tool_use → tool_result */
function oneIteration(toolId: string, toolName: string, resultContent: string): AgentInput[] {
  return [
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: toolId,
        toolCallName: toolName,
        argumentsDelta: '{"command":"echo hi"}',
      },
    },
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 20 } },
    {
      type: "tool_result",
      toolCallId: toolId,
      toolName,
      result: { modelContent: resultContent },
    },
  ];
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Phase 4 — resource governor (core limits)", () => {
  describe("toolCallCount", () => {
    it("increments toolCallCount when tools are dispatched", () => {
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Run a tool" },
        ...oneIteration("c1", "bash", "output"),
      ];
      const trace = drive(inputs, ctx, { maxToolCalls: 5 });
      const final = trace[trace.length - 1]!.state;
      expect(final.toolCallCount).toBe(1);
    });

    it("terminates when toolCallCount reaches maxToolCalls", () => {
      // Run 2 iterations with maxToolCalls = 2.
      // After 2 full iterations, toolCallCount = 2.
      // Third model_done(tool_use) increments count to 3 → limit check fires.
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Run tools" },
        ...oneIteration("c1", "bash", "out1"),
        ...oneIteration("c2", "bash", "out2"),
        // Third iteration: model wants 1 more tool call
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: "c3",
            toolCallName: "bash",
            argumentsDelta: '{"command":"echo 3"}',
          },
        },
        { type: "model_done", stopReason: "tool_use" },
      ];
      const trace = drive(inputs, ctx, { maxToolCalls: 2 });
      const final = trace[trace.length - 1]!.state;
      // Should be done because limit was hit at tool dispatch time
      expect(final.status).toBe("done");
      expect(final.toolCallCount).toBeGreaterThanOrEqual(2);
      // Error event emitted
      const errorEffect = trace[trace.length - 1]!.effects.find(
        (e: Effect) => e.type === "emit" && (e as EmitEffect).event.type === "error",
      );
      expect(errorEffect).toBeDefined();
    });
  });

  describe("budget_exceeded input", () => {
    it("terminates the turn when budget_exceeded is received", () => {
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Do stuff" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Working..." } },
        // While in calling_model, receive budget_exceeded
        { type: "budget_exceeded", reason: "Wallclock limit exceeded" },
      ];
      const trace = drive(inputs, ctx);
      const final = trace[trace.length - 1]!.state;
      expect(final.status).toBe("done");
      // Should emit budget_exceeded event
      const budgetEvent = trace[trace.length - 1]!.effects.find(
        (e: Effect) => e.type === "emit" && (e as EmitEffect).event.type === "budget_exceeded",
      );
      expect(budgetEvent).toBeDefined();
    });

    it("works during executing_tools status", () => {
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Run tools" },
        ...oneIteration("c1", "bash", "output"),
        // During the tool_result, we're in executing_tools with pendingTools
        // But wait — with the new buffering, one tool completes and we go to calling_model.
        // Let's use a multi-tool scenario: inject budget_exceeded during tool execution.
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: "c2",
            toolCallName: "bash",
            argumentsDelta: '{"command":"echo 2"}',
          },
        },
        { type: "model_done", stopReason: "tool_use" },
        // Now in executing_tools with c2 pending — inject budget_exceeded
        { type: "budget_exceeded", reason: "Cost budget exceeded" },
      ];
      const trace = drive(inputs, ctx);
      const final = trace[trace.length - 1]!.state;
      expect(final.status).toBe("done");
      expect(final.pendingTools).toEqual([]);
    });
  });

  describe("backward compatibility", () => {
    it("no limit set → no termination from budget fields", () => {
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Hello" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Hi!" } },
        { type: "model_done", stopReason: "end_turn" },
      ];
      const trace = drive(inputs, ctx);
      const final = trace[trace.length - 1]!.state;
      expect(final.status).toBe("done");
      expect(final.toolCallCount).toBe(0);
      // No budget_exceeded effects
      const budgetEvents = trace[trace.length - 1]!.effects.filter(
        (e: Effect) => e.type === "emit" && (e as EmitEffect).event.type === "budget_exceeded",
      );
      expect(budgetEvents).toHaveLength(0);
    });
  });

  describe("replay determinism with budget_exceeded", () => {
    it("budget_exceeded at calling_model produces identical final state", () => {
      const inputs: AgentInput[] = [
        { type: "user_message", content: "Do work" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Working..." } },
        { type: "budget_exceeded", reason: "Test limit" },
      ];
      const trace1 = drive(inputs, ctx);
      const trace2 = drive(inputs, ctx);
      const final1 = trace1[trace1.length - 1]!;
      const final2 = trace2[trace2.length - 1]!;
      expect(final1.state).toEqual(final2.state);
      expect(final1.effects).toEqual(final2.effects);
    });
  });
});
