/**
 * Replay test — the cornerstone of deterministic core guarantee.
 * Same input sequence must produce exactly the same (state, effects) sequence.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

const testTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
  {
    name: "edit_file",
    description: "Edit a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    requires: ["filesystem:write"],
    riskTier: "WRITE_LOW",
  },
];

const ctx: StepContext = { tools: testTools, model: "test-model", maxTokens: 4096 };

/** Build a realistic input sequence: user → tool_use → tool_result → text → done */
function buildInputSequence(): AgentInput[] {
  return [
    { type: "user_message", content: "Read the file foo.ts and then edit it" },
    // Model starts responding
    { type: "model_chunk", chunk: { type: "text_delta", text: "I'll read the file first." } },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_replay_1",
        toolCallName: "read_file",
        argumentsDelta: '{"path":',
      },
    },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "",
        toolCallName: "",
        argumentsDelta: '"foo.ts"}',
      },
    },
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 50 } },
    // Tool result
    {
      type: "tool_result",
      toolCallId: "call_replay_1",
      toolName: "read_file",
      result: { modelContent: "line 1: const x = 1;\nline 2: const y = 2;" },
    },
    // Model edits the file
    { type: "model_chunk", chunk: { type: "text_delta", text: "Now I'll edit it." } },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_replay_2",
        toolCallName: "edit_file",
        argumentsDelta: '{"path":"foo.ts","old_string":"const x = 1;","new_string":"const x = 42;"}',
      },
    },
    { type: "model_done", stopReason: "tool_use" },
    // Tool result
    {
      type: "tool_result",
      toolCallId: "call_replay_2",
      toolName: "edit_file",
      result: { modelContent: "Edit applied successfully." },
    },
    // Final response
    { type: "model_chunk", chunk: { type: "text_delta", text: "Done! Changed x from 1 to 42." } },
    { type: "model_done", stopReason: "end_turn" },
  ];
}

function replay(
  inputs: AgentInput[],
  ctx: StepContext,
): Array<{ state: ReducerState; effects: Effect[] }> {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = createInitialState();
  for (const input of inputs) {
    const result = step(state, input, ctx);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

describe("replay determinism", () => {
  it("should produce identical (state, effects) sequence when run twice with the same inputs", () => {
    const inputs = buildInputSequence();

    const trace1 = replay(inputs, ctx);
    const trace2 = replay(inputs, ctx);

    expect(trace1).toHaveLength(trace2.length);

    for (let i = 0; i < trace1.length; i++) {
      // Deep-equal state
      expect(trace1[i]!.state).toEqual(trace2[i]!.state);
      // Deep-equal effects
      expect(trace1[i]!.effects).toEqual(trace2[i]!.effects);
    }
  });

  it("should produce identical results with different tool sets (no tools)", () => {
    const inputs: AgentInput[] = [
      { type: "user_message", content: "Hello" },
      { type: "model_chunk", chunk: { type: "text_delta", text: "Hi!" } },
      { type: "model_done", stopReason: "end_turn" },
    ];
    const ctxNoTools: StepContext = { tools: [] };

    const trace1 = replay(inputs, ctxNoTools);
    const trace2 = replay(inputs, ctxNoTools);

    expect(trace1).toEqual(trace2);
  });

  it("should produce identical results across 3 runs", () => {
    const inputs = buildInputSequence();

    const trace1 = replay(inputs, ctx);
    const trace2 = replay(inputs, ctx);
    const trace3 = replay(inputs, ctx);

    expect(trace1).toEqual(trace2);
    expect(trace2).toEqual(trace3);
  });
});
