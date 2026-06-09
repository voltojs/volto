/**
 * Phase 2 — parallel tool execution + deterministic result merging.
 *
 * Tests the reducer's buffering behavior: tool results are collected by id,
 * then flushed in pendingTools order when all are complete. This guarantees
 * that the message sequence is deterministic regardless of completion order.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";
import type { ToolResultContent } from "../state.js";

const multiTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "search",
    description: "Search files",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    requires: ["shell:exec"],
    riskTier: "WRITE_LOW",
  },
];

const ctx: StepContext = { tools: multiTools, model: "test-model", maxTokens: 4096 };

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Drive the reducer through a sequence of inputs, returning the full trace */
function drive(
  inputs: AgentInput[],
  ctx: StepContext,
  initial?: ReducerState,
): Array<{ state: ReducerState; effects: Effect[] }> {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = initial ?? createInitialState();
  for (const input of inputs) {
    const result = step(state, input, ctx);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

/** Build inputs that reach executing_tools with 3 pending tool calls (A, B, C) */
function buildMultiToolSetup(): AgentInput[] {
  return [
    { type: "user_message", content: "Do three things" },
    // Model responds with 3 tool_use
    { type: "model_chunk", chunk: { type: "text_delta", text: "Working on it..." } },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_A",
        toolCallName: "read_file",
        argumentsDelta: '{"path":"a.ts"}',
      },
    },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_B",
        toolCallName: "search",
        argumentsDelta: '{"query":"hello"}',
      },
    },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_C",
        toolCallName: "bash",
        argumentsDelta: '{"command":"echo hi"}',
      },
    },
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 50 } },
  ];
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Phase 2 — deterministic result merging", () => {
  describe("buffering behavior", () => {
    it("should buffer tool results and flush in pendingTools order", () => {
      const setup = buildMultiToolSetup();
      const setupTrace = drive(setup, ctx);
      const afterSetup = setupTrace[setupTrace.length - 1]!.state;

      expect(afterSetup.status).toBe("executing_tools");
      expect(afterSetup.pendingTools.map((t) => t.id)).toEqual(["call_A", "call_B", "call_C"]);

      // Feed results in reverse order: C, B, A
      const resultC: AgentInput = {
        type: "tool_result",
        toolCallId: "call_C",
        toolName: "bash",
        result: { modelContent: "hi" },
      };
      const resultB: AgentInput = {
        type: "tool_result",
        toolCallId: "call_B",
        toolName: "search",
        result: { modelContent: "found 1 match" },
      };
      const resultA: AgentInput = {
        type: "tool_result",
        toolCallId: "call_A",
        toolName: "read_file",
        result: { modelContent: "file content" },
      };

      // C arrives — buffered, still executing_tools
      const afterC = step(afterSetup, resultC, ctx);
      expect(afterC.state.status).toBe("executing_tools");
      expect(afterC.state.pendingTools.map((t) => t.id)).toEqual(["call_A", "call_B", "call_C"]);

      // B arrives — buffered, still executing_tools
      const afterB = step(afterC.state, resultB, ctx);
      expect(afterB.state.status).toBe("executing_tools");

      // A arrives — all done! flush in pendingTools order: A, B, C
      const afterA = step(afterB.state, resultA, ctx);
      expect(afterA.state.status).toBe("calling_model");
      expect(afterA.state.pendingTools).toEqual([]);
      expect(afterA.state._toolResultBuffer).toEqual({});

      // Verify messages: last 3 messages should be tool results in A, B, C order
      const lastThree = afterA.state.messages.slice(-3);
      expect(lastThree.map((m) => m.role)).toEqual(["tool", "tool", "tool"]);
      const contentA = lastThree[0]!.content as ToolResultContent[];
      const contentB = lastThree[1]!.content as ToolResultContent[];
      const contentC = lastThree[2]!.content as ToolResultContent[];
      expect(contentA[0]!.toolUseId).toBe("call_A");
      expect(contentB[0]!.toolUseId).toBe("call_B");
      expect(contentC[0]!.toolUseId).toBe("call_C");

      // Should emit call_model effect
      expect(afterA.effects.some((e) => e.type === "call_model")).toBe(true);
    });

    it("should handle single tool (backward compatible)", () => {
      // Single tool_use → single tool_result should work as before
      const inputs: AgentInput[] = [
        { type: "user_message", content: "read file" },
        {
          type: "model_chunk",
          chunk: {
            type: "tool_use_delta",
            toolCallId: "call_single",
            toolCallName: "read_file",
            argumentsDelta: '{"path":"x.ts"}',
          },
        },
        { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
        {
          type: "tool_result",
          toolCallId: "call_single",
          toolName: "read_file",
          result: { modelContent: "content" },
        },
      ];

      const trace = drive(inputs, ctx);
      const afterResult = trace[trace.length - 1]!.state;
      expect(afterResult.status).toBe("calling_model");
      // Messages: user + assistant + tool_result
      const toolMsg = afterResult.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      const toolContent = toolMsg!.content as ToolResultContent[];
      expect(toolContent[0]!.toolUseId).toBe("call_single");
    });
  });

  describe("replay determinism with out-of-order results", () => {
    it("should produce identical final state and effects when results arrive in different orders", () => {
      const setup = buildMultiToolSetup();

      // Run 1: results arrive in order A, B, C
      const inputs1: AgentInput[] = [
        ...setup,
        { type: "tool_result", toolCallId: "call_A", toolName: "read_file", result: { modelContent: "file content" } },
        { type: "tool_result", toolCallId: "call_B", toolName: "search", result: { modelContent: "found" } },
        { type: "tool_result", toolCallId: "call_C", toolName: "bash", result: { modelContent: "hi" } },
      ];

      // Run 2: same results arrive in reverse order C, B, A
      const inputs2: AgentInput[] = [
        ...setup,
        { type: "tool_result", toolCallId: "call_C", toolName: "bash", result: { modelContent: "hi" } },
        { type: "tool_result", toolCallId: "call_B", toolName: "search", result: { modelContent: "found" } },
        { type: "tool_result", toolCallId: "call_A", toolName: "read_file", result: { modelContent: "file content" } },
      ];

      const trace1 = drive(inputs1, ctx);
      const trace2 = drive(inputs2, ctx);

      expect(trace1.length).toBe(trace2.length);

      // Final state must be identical (messages in same order, buffer cleared)
      const final1 = trace1[trace1.length - 1]!;
      const final2 = trace2[trace2.length - 1]!;
      expect(final1.state).toEqual(final2.state);
      expect(final1.effects).toEqual(final2.effects);

      // Key invariant: messages from the tool phase must be in pendingTools
      // order (A, B, C) regardless of arrival order
      const toolMsgs = final1.state.messages.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(3);
      const ids = toolMsgs.map((m) => (m.content as ToolResultContent[])[0]!.toolUseId);
      expect(ids).toEqual(["call_A", "call_B", "call_C"]);
    });
  });

  describe("cancel during executing_tools", () => {
    it("should clear buffer on cancel", () => {
      const setup = buildMultiToolSetup();
      const setupTrace = drive(setup, ctx);
      const afterSetup = setupTrace[setupTrace.length - 1]!.state;

      // Feed one result (partial), then cancel
      const partialResult: AgentInput = {
        type: "tool_result",
        toolCallId: "call_A",
        toolName: "read_file",
        result: { modelContent: "partial" },
      };
      const afterPartial = step(afterSetup, partialResult, ctx);
      expect(afterPartial.state._toolResultBuffer["call_A"]).toBeDefined();

      // Cancel
      const afterCancel = step(afterPartial.state, { type: "cancel", reason: "user" }, ctx);
      expect(afterCancel.state.status).toBe("cancelling");
      expect(afterCancel.state.pendingTools).toEqual([]);
      expect(afterCancel.state._toolResultBuffer).toEqual({});
    });
  });
});
