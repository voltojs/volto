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
  it("terminates the turn only when the intervention budget is exhausted (hard fallback)", () => {
    // K=3: need 2 prior failed pairs + 1 new call = 3 consecutive.
    // T8 ladder: a >=K detection with budget left passes through — this test
    // now covers ONLY the exhaustion path (spec 2 D2): with the default
    // budget of 2 already consumed by two loop_intervention rounds, the same
    // detection hard-terminates with the byte-identical pre-ladder message.
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" }); // generates 2 pairs
    const loopCtx: StepContext = { ...ctx, maxLoopCount: 3 };

    // Build a full scenario:
    // Start with idle → user_message → model_done(tool_use with 1 matching tool call)
    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      // Budget already consumed (fed by the Runner after two prior rounds).
      {
        type: "loop_intervention",
        repairPrompt: "[LOOP INTERVENTION] round 1",
        consumesBudget: true,
      },
      {
        type: "loop_intervention",
        repairPrompt: "[LOOP INTERVENTION] round 2",
        consumesBudget: true,
      },
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
    expect(final.loopInterventionCount).toBe(2);
    const errorEffect = trace[trace.length - 1]!.effects.find(
      (e) => e.type === "emit" && e.event.type === "error",
    );
    expect(errorEffect).toBeDefined();
    expect((errorEffect as EmitEffect).event.data.error).toBe(
      'Loop detected: tool "bash" has been called 3 times with identical input and returned errors',
    );
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

// ──────────────────────────────────────────────
// T8 Task 2 — reducer three-tier loop ladder (spec 2 D2)
// ──────────────────────────────────────────────

/** Feed inputs through step(), collecting (state, effects) after each input. */
function runSeq(
  inputs: AgentInput[],
  initialState: ReducerState,
  stepCtx: StepContext,
): Array<{ state: ReducerState; effects: Effect[] }> {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = initialState;
  for (const input of inputs) {
    const result = step(state, input, stepCtx);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

/** Streaming tool_use delta for `bash` with a stable call id. */
function bashChunk(callId: string, command = "echo hi"): AgentInput {
  return {
    type: "model_chunk",
    chunk: {
      type: "tool_use_delta",
      toolCallId: callId,
      toolCallName: "bash",
      argumentsDelta: JSON.stringify({ command }),
    },
  };
}

/** tool_result feed for a `bash` call. */
function bashResult(callId: string, isError: boolean): AgentInput {
  return {
    type: "tool_result",
    toolCallId: callId,
    toolName: "bash",
    result: { modelContent: isError ? "error" : "success", isError },
  };
}

/** model_chunk + model_done as one model round. */
function modelRound(callId: string, command = "echo hi"): AgentInput[] {
  return [bashChunk(callId, command), { type: "model_done", stopReason: "tool_use" }];
}

function hasDone(effects: Effect[]): boolean {
  return effects.some((e) => e.type === "done");
}

function errorEvent(effects: Effect[]): EmitEffect | undefined {
  return effects.find((e): e is EmitEffect => e.type === "emit" && e.event.type === "error");
}

function reminderEvent(effects: Effect[]): EmitEffect | undefined {
  return effects.find(
    (e): e is EmitEffect => e.type === "emit" && e.event.type === "context_reminder",
  );
}

describe("T8 Task 2 — reducer three-tier loop ladder (spec 2 D2)", () => {
  it("(a) soft tier: K-1 error chain books loopRemindedCount; control flow unchanged", () => {
    // K=3: 1 prior failing pair + 1 new call = 2 == K-1.
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" });
    const trace = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState({ messages: priorMessages }),
      ctx,
    );
    const final = trace[trace.length - 1]!;
    // Reminder tier must NOT change control flow — the batch executes as usual.
    expect(final.state.status).toBe("executing_tools");
    expect(final.state.pendingTools).toHaveLength(1);
    expect(hasDone(final.effects)).toBe(false);
    expect(errorEvent(final.effects)).toBeUndefined();
    // Bookkeeping: dedup field marked at the K-1 count; no budget consumed.
    expect(final.state.loopRemindedCount).toBe(2);
    expect(final.state.loopInterventionCount).toBe(0);
    expect(final.state.selfCorrectionCount).toBe(0);
  });

  it("(a) loop_reminder input appends the prompt + emits kind loop_reminder, touching no counter", () => {
    let state = createInitialState({
      loopRemindedCount: 1,
      loopInterventionCount: 1,
      selfCorrectionCount: 1,
    });
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;

    const r = step(
      state,
      { type: "loop_reminder", repairPrompt: "[LOOP REMINDER] bash", consumesBudget: false },
      ctx,
    );

    const lastMsg = r.state.messages[r.state.messages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect((lastMsg as { content: unknown }).content).toBe("[LOOP REMINDER] bash");
    // The dedup field belongs to the model_done branch — never to the handler.
    expect(r.state.loopRemindedCount).toBe(1);
    expect(r.state.loopInterventionCount).toBe(1);
    expect(r.state.selfCorrectionCount).toBe(1);

    const evt = reminderEvent(r.effects);
    expect(evt).toBeDefined();
    expect(evt!.event.data.kind).toBe("loop_reminder");
    expect(evt!.event.data.text).toBe("[LOOP REMINDER] bash");
    expect((evt!.event.data.displayMetadata as { consumesBudget: boolean }).consumesBudget).toBe(
      false,
    );
  });

  it("(b) intervention tier: >=K with budget passes through unchanged; loop_intervention books +1", () => {
    // K=3: 2 prior failing pairs + 1 new call = 3 == K.
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" });
    const trace = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState({ messages: priorMessages }),
      ctx,
    );
    const final = trace[trace.length - 1]!;
    expect(final.state.status).toBe("executing_tools");
    expect(final.state.pendingTools).toHaveLength(1);
    expect(hasDone(final.effects)).toBe(false);
    expect(errorEvent(final.effects)).toBeUndefined();
    // The model_done branch books nothing at the intervention tier — the
    // handler does, once the Runner feeds the input post-batch.
    expect(final.state.loopInterventionCount).toBe(0);
    expect(final.state.loopRemindedCount).toBe(0);

    const r = step(
      final.state,
      { type: "loop_intervention", repairPrompt: "[LOOP INTERVENTION] bash", consumesBudget: true },
      ctx,
    );
    expect(r.state.loopInterventionCount).toBe(1);
    expect(r.state.selfCorrectionCount).toBe(0);
    const lastMsg = r.state.messages[r.state.messages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect((lastMsg as { content: unknown }).content).toBe("[LOOP INTERVENTION] bash");

    const evt = reminderEvent(r.effects);
    expect(evt).toBeDefined();
    expect(evt!.event.data.kind).toBe("loop_intervention");
    expect(evt!.event.data.text).toBe("[LOOP INTERVENTION] bash");
    expect(
      (evt!.event.data.displayMetadata as { interventionCount: number }).interventionCount,
    ).toBe(1);
  });

  it("(c) exhaustion fallback: two interventions, then a third >=K detection -> done+error, byte-identical message", () => {
    const trace = fullLadderTrace();
    // Rounds 1 and 2: budget remains -> the turn keeps executing.
    expect(trace[2]!.state.status).toBe("executing_tools");
    expect(trace[6]!.state.status).toBe("executing_tools");
    expect(trace[4]!.state.loopInterventionCount).toBe(1);
    expect(trace[8]!.state.loopInterventionCount).toBe(2);

    // Round 3: budget exhausted -> hard termination, byte-identical message.
    const final = trace[trace.length - 1]!;
    expect(final.state.status).toBe("done");
    expect(final.state.pendingTools).toEqual([]);
    expect(final.state.loopInterventionCount).toBe(2);
    expect(hasDone(final.effects)).toBe(true);
    const err = errorEvent(final.effects);
    expect(err).toBeDefined();
    expect(err!.event.data.error).toBe(
      'Loop detected: tool "bash" has been called 4 times with identical input and returned errors',
    );
  });

  it("(d) maxLoopInterventions: 0 disables the intervention tier -> first >=K detection hard-terminates (today's behavior)", () => {
    const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" });
    const zeroCtx: StepContext = { ...ctx, maxLoopInterventions: 0 };
    const trace = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState({ messages: priorMessages }),
      zeroCtx,
    );
    const final = trace[trace.length - 1]!;
    expect(final.state.status).toBe("done");
    expect(final.state.pendingTools).toEqual([]);
    expect(hasDone(final.effects)).toBe(true);
    const err = errorEvent(final.effects);
    expect(err).toBeDefined();
    expect(err!.event.data.error).toBe(
      'Loop detected: tool "bash" has been called 3 times with identical input and returned errors',
    );
  });

  it("(e) K=2 has NO reminder tier: count 1 (== K-1) never marks; count 2 goes straight to the intervention tier", () => {
    const k2: StepContext = { ...ctx, maxLoopCount: 2 };

    // Count 1 == K-1 must NOT fire: the k >= 3 guard keeps the K-1 probe off.
    const first = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState(),
      k2,
    );
    const firstFinal = first[first.length - 1]!;
    expect(firstFinal.state.status).toBe("executing_tools");
    expect(firstFinal.state.loopRemindedCount).toBe(0);
    expect(firstFinal.state.loopInterventionCount).toBe(0);

    // Count 2 == K: intervention tier directly, still no reminder mark.
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" }); // 1 failing pair
    const second = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState({ messages: priorMessages }),
      k2,
    );
    const secondFinal = second[second.length - 1]!;
    expect(secondFinal.state.status).toBe("executing_tools");
    expect(secondFinal.state.pendingTools).toHaveLength(1);
    expect(secondFinal.state.loopRemindedCount).toBe(0); // no reminder tier at K=2
    expect(secondFinal.state.loopInterventionCount).toBe(0);
    expect(hasDone(secondFinal.effects)).toBe(false);
    expect(errorEvent(secondFinal.effects)).toBeUndefined();
  });

  it("(f) budget isolation: self_correct and loop_intervention each track only their own counter", () => {
    let state = createInitialState();
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;

    const kinds: unknown[] = [];
    const feed = (input: AgentInput) => {
      const r = step(state, input, ctx);
      state = r.state;
      kinds.push(reminderEvent(r.effects)?.event.data.kind);
    };

    feed({ type: "self_correct", repairPrompt: "s1", consumesBudget: true });
    feed({ type: "loop_intervention", repairPrompt: "i1", consumesBudget: true });
    feed({ type: "self_correct", repairPrompt: "s2", consumesBudget: true });
    feed({ type: "loop_intervention", repairPrompt: "i2", consumesBudget: true });
    feed({ type: "loop_reminder", repairPrompt: "r1", consumesBudget: false });

    expect(state.selfCorrectionCount).toBe(2); // only self_correct bumped it
    expect(state.loopInterventionCount).toBe(2); // only loop_intervention bumped it
    expect(state.loopRemindedCount).toBe(0); // no handler writes the dedup field
    expect(kinds).toEqual([
      "self_correction",
      "loop_intervention",
      "self_correction",
      "loop_intervention",
      "loop_reminder",
    ]);

    // Same guard as self_correct: in done status the input falls through to the
    // done-state error path — message list and counters untouched.
    const doneState: ReducerState = { ...state, status: "done" };
    const r = step(
      doneState,
      { type: "loop_intervention", repairPrompt: "i3", consumesBudget: true },
      ctx,
    );
    expect(r.state.messages).toHaveLength(state.messages.length);
    expect(r.state.loopInterventionCount).toBe(2);
    expect(errorEvent(r.effects)).toBeDefined();
  });

  it("(g) same-tier dedup: loopRemindedCount is monotonic — a later lower-count detection never re-marks it", () => {
    // Round 1: repeat chain reaches K=3 -> reminder mark at count 3.
    // Rounds 2-3: an unrelated error chain reaches only K-1 = 2 — the guard
    // (loopRemindedCount < count) must keep the field at 3, never lower it.
    const priorMessages = buildResultMessages(2, "bash", { command: "echo hi" }, false);
    const inputs: AgentInput[] = [
      { type: "user_message", content: "Run echo" },
      ...modelRound("rep-1"),
      bashResult("rep-1", false),
      ...modelRound("other", "echo bye"),
      bashResult("other", true),
      ...modelRound("err-1", "echo bye"),
    ];
    const trace = runSeq(inputs, createInitialState({ messages: priorMessages }), ctx);

    expect(trace[2]!.state.status).toBe("executing_tools");
    expect(trace[2]!.state.loopRemindedCount).toBe(3); // repeat tier marked
    const final = trace[trace.length - 1]!;
    expect(final.state.status).toBe("executing_tools");
    expect(final.state.loopRemindedCount).toBe(3); // monotonic: still 3, not lowered to K-1 = 2
    expect(final.state.loopInterventionCount).toBe(0);
    expect(hasDone(final.effects)).toBe(false);
    expect(errorEvent(final.effects)).toBeUndefined();
  });

  it("(g) same-tier dedup: a K-1 detection when loopRemindedCount already equals the count does not re-mark", () => {
    const priorMessages = buildLoopMessages(2, "bash", { command: "echo hi" }); // 1 failing pair
    const seeded = createInitialState({ messages: priorMessages, loopRemindedCount: 2 });
    const trace = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      seeded,
      ctx,
    );
    const final = trace[trace.length - 1]!;
    expect(final.state.loopRemindedCount).toBe(2);
    expect(final.state.status).toBe("executing_tools");
    expect(hasDone(final.effects)).toBe(false);
  });

  it("(h) maxLoopCount undefined: ladder fully off — zero change (counters stay 0)", () => {
    const priorMessages = buildLoopMessages(5, "bash", { command: "echo hi" }); // 4 failing pairs
    const noLoopCtx: StepContext = { ...ctx, maxLoopCount: undefined };
    const trace = runSeq(
      [{ type: "user_message", content: "Run echo" }, ...modelRound("loop-new")],
      createInitialState({ messages: priorMessages }),
      noLoopCtx,
    );
    const final = trace[trace.length - 1]!;
    expect(final.state.status).toBe("executing_tools");
    expect(final.state.pendingTools).toHaveLength(1);
    expect(final.state.loopRemindedCount).toBe(0);
    expect(final.state.loopInterventionCount).toBe(0);
    expect(hasDone(final.effects)).toBe(false);
    expect(errorEvent(final.effects)).toBeUndefined();
  });

  it("replay: the full ladder sequence reproduces identical (state, effects)", () => {
    expect(fullLadderTrace()).toEqual(fullLadderTrace());
  });
});

/**
 * Full ladder: K=3, budget default 2 — soft/passthrough detection round 1,
 * intervention round 2, hard termination round 3.
 *
 * Step index map: 0 user, 1 chunk1, 2 done1, 3 result1, 4 intervention1,
 * 5 chunk2, 6 done2, 7 result2, 8 intervention2, 9 chunk3, 10 done3.
 */
function fullLadderTrace(): Array<{ state: ReducerState; effects: Effect[] }> {
  const priorMessages = buildLoopMessages(3, "bash", { command: "echo hi" }); // 2 failing pairs
  let state: ReducerState = createInitialState({ messages: priorMessages });
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  const push = (input: AgentInput) => {
    const r = step(state, input, ctx);
    trace.push({ state: r.state, effects: r.effects });
    state = r.state;
  };

  push({ type: "user_message", content: "Run echo" });
  for (let round = 1; round <= 3; round++) {
    const callId = `loop-${round}`;
    push(bashChunk(callId));
    push({ type: "model_done", stopReason: "tool_use" });
    if (state.status === "done") break;
    push(bashResult(callId, true));
    if (round < 3) {
      push({
        type: "loop_intervention",
        repairPrompt: `[LOOP INTERVENTION] round ${round}`,
        consumesBudget: true,
      });
    }
  }
  return trace;
}
