/**
 * Phase 5 — loop / oscillation detection.
 *
 * Tests:
 *  1. detectLoop pure function (unit tests)
 *  2. Reducer integration (loop triggers termination)
 *  3. Replay determinism with loop sequences
 */

import { describe, it, expect } from "vitest";
import { detectLoop, renderLoopReminder, renderLoopIntervention } from "../loop-detector.js";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";
import type { Message, AssistantMessage, PendingToolCall } from "../state.js";
import type { EmitEffect } from "../effect.js";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

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

const ctx: StepContext = { tools: testTools, model: "test-model", maxTokens: 4096, maxLoopCount: 3 };

/** Build messages that represent K-1 consecutive identical failed tool calls */
function buildLoopMessages(k: number, toolName: string, input: Record<string, unknown>): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < k - 1; i++) {
    // assistant message with tool_use
    messages.push({
      id: "m1",
      role: "assistant",
      content: [{ type: "tool_use", id: `loop-${i}`, name: toolName, input }],
    });
    // tool_result with error
    messages.push({
      id: "m2",
      role: "tool",
      content: [{ type: "tool_result", toolUseId: `loop-${i}`, content: [{ type: "text", text: "error" }], isError: true }],
    });
  }
  return messages;
}

/** Build messages representing `pairs` consecutive identical tool calls with the given error state */
function buildResultMessages(
  pairs: number,
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      id: "m1",
      role: "assistant",
      content: [{ type: "tool_use", id: `seq-${i}`, name: toolName, input }],
    });
    messages.push({
      id: "m2",
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: `seq-${i}`,
          content: [{ type: "text", text: isError ? "error" : "success" }],
          isError,
        },
      ],
    });
  }
  return messages;
}

// ──────────────────────────────────────────────
// Unit tests: detectLoop
// ──────────────────────────────────────────────

/** Helper: create a minimal AssistantMessage with given tool calls */
function makeAssistantMsg(toolCalls: PendingToolCall[]): AssistantMessage {
  return {
    id: "m3",
    role: "assistant",
    content: toolCalls.map((tc) => ({
      type: "tool_use" as const,
      id: tc.id,
      name: tc.name,
      input: tc.input,
    })),
  };
}

describe("detectLoop — pure function", () => {
  it("returns false when k < 2", () => {
    const tc = { id: "c1", name: "bash", input: { command: "echo" } };
    const result = detectLoop([], makeAssistantMsg([tc]), [tc], 1);
    expect(result.detected).toBe(false);
  });

  it("returns false when no new tool calls", () => {
    const result = detectLoop([], makeAssistantMsg([]), [], 3);
    expect(result.detected).toBe(false);
  });

  it("detects K-1 prior failures + 1 new = K consecutive identical failures", () => {
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" });
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result.detected).toBe(true);
    expect(result.toolName).toBe("bash");
    expect(result.consecutiveCount).toBe(3);
  });

  it("does NOT detect when inputs differ", () => {
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" });
    const newCall = { id: "new", name: "bash", input: { command: "echo bye" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result.detected).toBe(false);
  });

  it("does NOT detect when tool name differs", () => {
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" });
    const newCall = { id: "new", name: "read_file", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result.detected).toBe(false);
  });

  it("does NOT detect below threshold when prior results are not errors (1 success + new call = 2 < k=3)", () => {
    const messages = buildResultMessages(1, "bash", { command: "echo hi" }, false);
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(messages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result).toEqual({ detected: false, consecutiveCount: 0 });
  });

  it("detects loop with k=2 (minimum)", () => {
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo" });
    const newCall = { id: "new", name: "bash", input: { command: "echo" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 2);
    expect(result.detected).toBe(true);
    expect(result.consecutiveCount).toBe(2);
  });

  it("stops counting when non-matching entry appears in trace", () => {
    const messages: Message[] = [
      {
        id: "m6",
        role: "assistant",
        content: [{ type: "tool_use", id: "c0", name: "bash", input: { command: "echo hi" } }],
      },
      {
        id: "m7",
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "c0", content: [{ type: "text", text: "err" }], isError: true }],
      },
      {
        id: "m8",
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "echo bye" } }],
      },
      {
        id: "m9",
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "err" }], isError: true }],
      },
    ];
    const newCall = { id: "new", name: "bash", input: { command: "echo bye" } };
    const result = detectLoop(messages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result.detected).toBe(false); // Only 2 consecutive, need 3
  });
});

// ──────────────────────────────────────────────
// T8 — loop kind classification (error-loop vs repeat)
// ──────────────────────────────────────────────

describe("detectLoop — kind classification (error-loop vs repeat)", () => {
  it("error-chain regression: identical failing calls >= k -> kind 'error-loop' with byte-identical fields to pre-kind output", () => {
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" }); // 2 failing pairs
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    // toEqual pins the exact shape: every pre-existing field is unchanged from
    // pre-T8 output (toolName/toolInput/consecutiveCount byte-identical),
    // `kind` is the sole addition (spec 4.1).
    expect(result).toEqual({
      detected: true,
      kind: "error-loop",
      toolName: "bash",
      toolInput: { command: "echo hi" },
      consecutiveCount: 3,
    });
  });

  it("error-chain regression: not-detected result keeps the exact pre-kind shape (no kind/toolName/toolInput)", () => {
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" }); // 1 failing pair
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result).toEqual({ detected: false, consecutiveCount: 0 });
  });

  it("repeat chain: identical SUCCEEDING calls >= k -> kind 'repeat'", () => {
    const priorMessages = buildResultMessages(2, "bash", { command: "echo hi" }, false);
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result).toEqual({
      detected: true,
      kind: "repeat",
      toolName: "bash",
      toolInput: { command: "echo hi" },
      consecutiveCount: 3,
    });
  });

  it("repeat chain below threshold: 2 identical successes + new call < k=4 -> not detected", () => {
    const priorMessages = buildResultMessages(2, "bash", { command: "echo hi" }, false);
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 4);
    expect(result).toEqual({ detected: false, consecutiveCount: 0 });
  });

  it("mixed chain (Review Focus 4): k-1 successes then a failure -> error chain restarts at the first failure (count = 1 new + 1 trailing error = 2 < k=4, not detected; success count NOT inherited)", () => {
    // Chronological order: 3 successes, then 1 failure (most recent), then the new failing call.
    const priorMessages = [
      ...buildResultMessages(3, "bash", { command: "echo hi" }, false),
      ...buildResultMessages(1, "bash", { command: "echo hi" }, true),
    ];
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 4);
    // Error chain restarts at the trailing failure: 1 (new) + 1 (failure) = 2 < 4.
    // Repeat chain breaks at the failure: 1 < 4. Neither chain reaches k.
    expect(result).toEqual({ detected: false, consecutiveCount: 0 });
  });

  it("mixed chain does NOT merge counts: 2 successes then 2 failures -> error chain counts only trailing failures (1 new + 2 errors = 3 >= k=3, not 5)", () => {
    const priorMessages = [
      ...buildResultMessages(2, "bash", { command: "echo hi" }, false),
      ...buildResultMessages(2, "bash", { command: "echo hi" }, true),
    ];
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 3);
    expect(result).toEqual({
      detected: true,
      kind: "error-loop",
      toolName: "bash",
      toolInput: { command: "echo hi" },
      // Trailing failures only: 2 prior failures + 1 new call; the 2 successes contribute nothing.
      consecutiveCount: 3,
    });
  });

  it("mixed chain (vice versa): failures then a success -> repeat chain restarts at the first success (count = 1 new + 1 success = 2 < k=4, not detected; failure count NOT inherited)", () => {
    const priorMessages = [
      ...buildResultMessages(3, "bash", { command: "echo hi" }, true),
      ...buildResultMessages(1, "bash", { command: "echo hi" }, false),
    ];
    const newCall = { id: "new", name: "bash", input: { command: "echo hi" } };
    const result = detectLoop(priorMessages, makeAssistantMsg([newCall]), [newCall], 4);
    expect(result).toEqual({ detected: false, consecutiveCount: 0 });
  });
});

// ──────────────────────────────────────────────
// T8 — verbatim loop texts (spec 2 D3)
// ──────────────────────────────────────────────

describe("loop texts — verbatim formats (spec 2 D3)", () => {
  it("renderLoopReminder error variant is byte-exact (marker + fixed closing sentence)", () => {
    const text = renderLoopReminder({ toolName: "bash", consecutiveCount: 3, kind: "error" });
    expect(text).toBe(
      '[LOOP REMINDER] "bash" has been called 3 times in a row with identical input and each attempt failed. This is the last reminder before a forced stop — change the approach now.',
    );
    expect(text).toContain("LOOP REMINDER");
    expect(text).toContain("This is the last reminder before a forced stop — change the approach now.");
  });

  it("renderLoopReminder repeat variant is byte-exact (marker + fixed closing sentence)", () => {
    const text = renderLoopReminder({ toolName: "bash", consecutiveCount: 4, kind: "repeat" });
    expect(text).toBe(
      '[LOOP REMINDER] "bash" has been called 4 times in a row with identical input. If the repetition is intentional, continue; otherwise vary the input or switch tools.',
    );
    expect(text).toContain("LOOP REMINDER");
    expect(text).toContain("If the repetition is intentional, continue; otherwise vary the input or switch tools.");
  });

  it("renderLoopIntervention is byte-exact (marker + fixed closing sentence)", () => {
    const text = renderLoopIntervention({ toolName: "bash", consecutiveCount: 3 });
    expect(text).toBe(
      '[LOOP INTERVENTION] The identical call to "bash" has failed 3 times. Do not repeat it: vary the input, choose a different tool, or ask the user for direction. Two more identical failures will force-stop this turn.',
    );
    expect(text).toContain("LOOP INTERVENTION");
    expect(text).toContain("Two more identical failures will force-stop this turn.");
  });
});

// ──────────────────────────────────────────────
// Integration: reducer terminates on loop
// ──────────────────────────────────────────────

describe("Phase 5 — reducer loop detection integration", () => {
  it("terminates the turn when K consecutive identical failures occur", () => {
    // K=3: need 2 prior failed pairs + 1 new call = 3 consecutive
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" }); // generates 2 pairs
    const loopCtx: StepContext = { ...ctx, maxLoopCount: 3 };

    // Build a full scenario:
    // Start with idle → user_message → model_done(tool_use with 1 matching tool call)
    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      // Model accumulates loop messages + the current loop
      // First, manually inject the prior loop messages via a model chunk sequence:
      // (We'll use the reducer's ability to accumulate tool calls)
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "loop-new",
          toolCallName: "bash",
          argumentsDelta: '{"command":"echo hi"}',
        },
      },
      { type: "model_done", stopReason: "tool_use" },
    ];

    // Pre-seed the state with the prior loop messages
    const initialState = createInitialState({ messages: priorMessages });
    const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
    let state = initialState;

    for (const input of inputs) {
      if (state.status === "done") break;
      const result = step(state, input, loopCtx);
      trace.push({ state: result.state, effects: result.effects });
      state = result.state;
    }

    const final = trace[trace.length - 1]!.state;
    // Should be done with loop detection error
    expect(final.status).toBe("done");
    expect(final.pendingTools).toEqual([]);
    const errorEffect = trace[trace.length - 1]!.effects.find(
      (e) => e.type === "emit" && e.event.type === "error",
    );
    expect(errorEffect).toBeDefined();
    expect((errorEffect as EmitEffect).event.data.error).toContain("Loop detected");
  });

  it("does NOT trigger when fewer than K consecutive failures", () => {
    // K=3: only 1 prior pair + 1 new = 2 < 3 → should NOT trigger
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" }); // generates 1 pair
    const loopCtx: StepContext = { ...ctx, maxLoopCount: 3 };

    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "loop-new",
          toolCallName: "bash",
          argumentsDelta: '{"command":"echo hi"}',
        },
      },
      { type: "model_done", stopReason: "tool_use" },
    ];

    const initialState = createInitialState({ messages: priorMessages });
    const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
    let state = initialState;

    for (const input of inputs) {
      if (state.status === "done") break;
      const result = step(state, input, loopCtx);
      trace.push({ state: result.state, effects: result.effects });
      state = result.state;
    }

    const final = trace[trace.length - 1]!.state;
    // Should NOT be done — tool call should proceed
    expect(final.status).toBe("executing_tools");
    expect(final.pendingTools).toHaveLength(1);
  });

  it("no maxLoopCount = no loop check (backward compatible)", () => {
    const priorMessages = buildLoopMessages(5, "bash", { command: "echo hi" });
    const noLoopCtx: StepContext = { ...ctx, maxLoopCount: undefined };

    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "loop-new",
          toolCallName: "bash",
          argumentsDelta: '{"command":"echo hi"}',
        },
      },
      { type: "model_done", stopReason: "tool_use" },
    ];

    const initialState = createInitialState({ messages: priorMessages });
    const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
    let state = initialState;

    for (const input of inputs) {
      if (state.status === "done") break;
      const result = step(state, input, noLoopCtx);
      trace.push({ state: result.state, effects: result.effects });
      state = result.state;
    }

    const final = trace[trace.length - 1]!.state;
    // Should NOT terminate — no loop check configured
    expect(final.status).toBe("executing_tools");
  });
});

// ──────────────────────────────────────────────
// Replay determinism
// ──────────────────────────────────────────────

describe("Phase 5 — replay determinism with loop", () => {
  it("loop detection produces identical final state on replay", () => {
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" });
    const loopCtx: StepContext = { ...ctx, maxLoopCount: 3 };

    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "loop-new",
          toolCallName: "bash",
          argumentsDelta: '{"command":"echo hi"}',
        },
      },
      { type: "model_done", stopReason: "tool_use" },
    ];

    const makeTrace = () => {
      const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
      let state = createInitialState({ messages: priorMessages });
      for (const input of inputs) {
        if (state.status === "done") break;
        const result = step(state, input, loopCtx);
        trace.push({ state: result.state, effects: result.effects });
        state = result.state;
      }
      return trace;
    };

    const trace1 = makeTrace();
    const trace2 = makeTrace();

    const final1 = trace1[trace1.length - 1]!;
    const final2 = trace2[trace2.length - 1]!;
    expect(final1.state).toEqual(final2.state);
    expect(final1.effects).toEqual(final2.effects);
  });
});
