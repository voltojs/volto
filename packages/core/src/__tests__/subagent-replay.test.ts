/**
 * Replay determinism for the sub-agent path (design §13 case 13).
 *
 * The generic replay suite never feeds a `task` call, a background dispatch
 * or a turn-boundary collection, so it cannot speak for them: the background
 * handlers stamp `startedAt` from the clock and the collection appends a
 * message, both of which are exactly the places non-determinism creeps in.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

const taskTool: ToolDefinition = {
  name: "task",
  description: "Spawn a sub-agent",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      subagent_type: { type: "string" },
      run_in_background: { type: "boolean" },
    },
    required: ["message"],
  },
  requires: ["agent:task"],
  riskTier: "WRITE_LOW",
};

/**
 * Fresh context per run: the id and clock ports are stateful counters, so
 * reusing one context across runs would be the test cheating rather than the
 * reducer being deterministic.
 */
function makeCtx(): StepContext {
  let ids = 0;
  let ticks = 0;
  return {
    tools: [taskTool],
    model: "test-model",
    id: { next: () => `id-${++ids}` },
    clock: { now: () => 1_000 + ++ticks },
  };
}

/** user → background task dispatch → end_turn → drain → final answer. */
function backgroundSubAgentSequence(): AgentInput[] {
  return [
    { type: "user_message", content: "Research X in the background" },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_bg_1",
        toolCallName: "task",
        argumentsDelta: JSON.stringify({
          message: "Research X",
          subagent_type: "researcher",
          run_in_background: true,
        }),
      },
    },
    { type: "model_done", stopReason: "tool_use" },
    // The Runner records the detached dispatch before reporting the result.
    { type: "background_task_started", taskId: "bg-1", subagentType: "researcher" },
    {
      type: "tool_result",
      toolCallId: "call_bg_1",
      toolName: "task",
      result: { modelContent: "Task bg-1 started in background." },
    },
    { type: "model_chunk", chunk: { type: "text_delta", text: "Working on it." } },
    { type: "model_done", stopReason: "end_turn" },
    // Turn-boundary drain: pushes the turn back to calling_model.
    { type: "background_task_completed", taskId: "bg-1", text: "X is a database." },
    { type: "model_chunk", chunk: { type: "text_delta", text: "X is a database." } },
    { type: "model_done", stopReason: "end_turn" },
  ];
}

/** Two sub-agents dispatched in one assistant turn, results reported by id. */
function parallelSubAgentSequence(): AgentInput[] {
  return [
    { type: "user_message", content: "Search two places at once" },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_a",
        toolCallName: "task",
        argumentsDelta: JSON.stringify({ message: "search A", subagent_type: "searcher" }),
      },
    },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_b",
        toolCallName: "task",
        argumentsDelta: JSON.stringify({ message: "search B", subagent_type: "searcher" }),
      },
    },
    { type: "model_done", stopReason: "tool_use" },
    // Out-of-dispatch-order completion is the normal case for a parallel
    // batch; the reducer must still assemble a stable history.
    {
      type: "tool_result",
      toolCallId: "call_b",
      toolName: "task",
      result: { modelContent: "found in B" },
    },
    {
      type: "tool_result",
      toolCallId: "call_a",
      toolName: "task",
      result: { modelContent: "found in A" },
    },
    { type: "model_chunk", chunk: { type: "text_delta", text: "Both done." } },
    { type: "model_done", stopReason: "end_turn" },
  ];
}

function replay(inputs: AgentInput[]): Array<{ state: ReducerState; effects: Effect[] }> {
  const ctx = makeCtx();
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = createInitialState();
  for (const input of inputs) {
    const result = step(state, input, ctx);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

describe("replay determinism — sub-agents and background tasks", () => {
  it("replays a background dispatch and its turn-boundary collection identically", () => {
    const inputs = backgroundSubAgentSequence();

    expect(replay(inputs)).toEqual(replay(inputs));
  });

  it("replays two parallel sub-agent dispatches identically", () => {
    const inputs = parallelSubAgentSequence();

    expect(replay(inputs)).toEqual(replay(inputs));
  });

  it("actually exercised the background path it claims to replay", () => {
    // Guard against a sequence that silently stops being about background
    // tasks (a renamed input type would otherwise replay identically as a
    // pair of no-ops, and this file would keep passing while testing nothing).
    const trace = replay(backgroundSubAgentSequence());
    const final = trace[trace.length - 1]!.state;
    expect(trace[3]!.state.backgroundTasks).toEqual([
      { id: "bg-1", subagentType: "researcher", status: "running", startedAt: 1001 },
    ]);
    expect(final.backgroundTasks?.[0]?.status).toBe("collected");
    expect(final.messages.map((m) => m.content)).toContainEqual(
      expect.stringContaining("X is a database."),
    );
  });

  it("keeps both parallel results in the history", () => {
    const trace = replay(parallelSubAgentSequence());
    const final = trace[trace.length - 1]!.state;
    const rendered = JSON.stringify(final.messages);
    expect(rendered).toContain("found in A");
    expect(rendered).toContain("found in B");
  });
});
