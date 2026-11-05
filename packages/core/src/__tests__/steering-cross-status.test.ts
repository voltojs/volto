/**
 * Steering — cross-status queueing (D4) and end_turn continuation (D3).
 *
 * D4: `user_message` is never rejected. Outside idle it always queues into
 * `queuedUserInputs` and emits `steering_queued`, including the terminal /
 * suspended statuses (`waiting_for_approval`, `waiting_for_input`,
 * `cancelling`, `done`) that used to answer with errorResult.
 *
 * D3: `model_done` with end_turn (or pure text) drains a non-empty queue in
 * the SAME turn — the queued messages ride after the assistant message, the
 * model is called again, and the turn stays open (no `done` effect).
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { AssistantMessage } from "../state.js";

const ctx: StepContext = { tools: [], model: "test-model", maxTokens: 4096 };

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function drive(
  inputs: AgentInput[],
  context: StepContext = ctx,
  initial?: ReducerState,
): Array<{ state: ReducerState; effects: Effect[] }> {
  const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
  let state = initial ?? createInitialState();
  for (const input of inputs) {
    const result = step(state, input, context);
    trace.push({ state: result.state, effects: result.effects });
    state = result.state;
  }
  return trace;
}

/** StepContext with an Id port so stamped message ids are real and distinct. */
function ctxWithIds(): StepContext {
  let n = 0;
  return { ...ctx, id: { next: () => `msg-${++n}` } };
}

/** Data of every emit effect of the given event type, in effects order. */
function emitData(effects: Effect[], type: string): Array<Record<string, unknown>> {
  return effects
    .filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit" && e.event.type === type)
    .map((e) => e.event.data);
}

/** Index of the first emit effect of the given event type, or -1. */
function emitIndex(effects: Effect[], type: string): number {
  return effects.findIndex((e) => e.type === "emit" && e.event.type === type);
}

/** Build inputs that reach calling_model status (after user_message + model starts) */
function reachCallingModel(): AgentInput[] {
  return [
    { type: "user_message", content: "Do something" },
    { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
  ];
}

/** Build inputs that reach executing_tools with one pending tool */
function reachExecutingTools(): AgentInput[] {
  return [
    { type: "user_message", content: "Read the file" },
    {
      type: "model_chunk",
      chunk: {
        type: "tool_use_delta",
        toolCallId: "call_1",
        toolCallName: "read_file",
        argumentsDelta: '{"path":"foo.ts"}',
      },
    },
    { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("steering cross-status queueing (D4)", () => {
  it("user_message during waiting_for_approval queues and keeps status", () => {
    const context = ctxWithIds();
    const setup = drive(reachExecutingTools(), context);
    const execState = setup[setup.length - 1]!.state;

    const approval = step(execState, { type: "request_approval", toolCallId: "call_1" }, context);
    expect(approval.state.status).toBe("waiting_for_approval");

    const result = step(
      approval.state,
      { type: "user_message", content: "Actually, also check bar.ts" },
      context,
    );

    // Status and the pending approval must survive the queueing untouched.
    expect(result.state.status).toBe("waiting_for_approval");
    expect(result.state.pendingApprovalTool?.id).toBe("call_1");
    expect(result.state.queuedUserInputs).toHaveLength(1);
    expect(result.state.queuedUserInputs[0]!.content).toBe("Actually, also check bar.ts");

    // Announced via steering_queued carrying the stamped id — never an error.
    const queued = result.state.queuedUserInputs[0]!;
    expect(emitData(result.effects, "steering_queued")).toEqual([
      { id: queued.id, content: "Actually, also check bar.ts" },
    ]);
    expect(emitData(result.effects, "error")).toEqual([]);
  });

  it("user_message during waiting_for_input / cancelling / done queues instead of erroring", () => {
    const context = ctxWithIds();

    // waiting_for_input (suspended state set by the host) — one assertion.
    const waitingInput: ReducerState = createInitialState({ status: "waiting_for_input" });
    const r1 = step(
      waitingInput,
      { type: "user_message", content: "While waiting for input" },
      context,
    );
    expect(r1.state.status).toBe("waiting_for_input");
    expect(r1.state.queuedUserInputs).toHaveLength(1);
    expect(emitData(r1.effects, "steering_queued")).toEqual([
      { id: r1.state.queuedUserInputs[0]!.id, content: "While waiting for input" },
    ]);
    expect(emitData(r1.effects, "error")).toEqual([]);

    // cancelling — one assertion.
    const calling = drive(reachCallingModel(), context);
    const cancelling = step(calling[calling.length - 1]!.state, { type: "cancel", reason: "user" }, context);
    expect(cancelling.state.status).toBe("cancelling");
    const r2 = step(
      cancelling.state,
      { type: "user_message", content: "While cancelling" },
      context,
    );
    expect(r2.state.status).toBe("cancelling");
    expect(r2.state.queuedUserInputs).toHaveLength(1);
    expect(emitData(r2.effects, "steering_queued")).toEqual([
      { id: r2.state.queuedUserInputs[0]!.id, content: "While cancelling" },
    ]);
    expect(emitData(r2.effects, "error")).toEqual([]);

    // done — one assertion.
    const doneTrace = drive(
      [
        { type: "user_message", content: "Finish up" },
        { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      context,
    );
    const doneState = doneTrace[doneTrace.length - 1]!.state;
    expect(doneState.status).toBe("done");
    const r3 = step(
      doneState,
      { type: "user_message", content: "After done" },
      context,
    );
    expect(r3.state.status).toBe("done");
    expect(r3.state.queuedUserInputs).toHaveLength(1);
    expect(emitData(r3.effects, "steering_queued")).toEqual([
      { id: r3.state.queuedUserInputs[0]!.id, content: "After done" },
    ]);
    expect(emitData(r3.effects, "error")).toEqual([]);
  });
});

describe("end_turn continuation (D3)", () => {
  it("end_turn with queued messages drains them and calls the model again in the same turn", () => {
    const context = ctxWithIds();
    const setup = drive(reachCallingModel(), context);
    const callingState = setup[setup.length - 1]!.state;

    const q1 = step(callingState, { type: "user_message", content: "First queued" }, context);
    const q2 = step(q1.state, { type: "user_message", content: "Second queued" }, context);
    const id1 = q2.state.queuedUserInputs[0]!.id;
    const id2 = q2.state.queuedUserInputs[1]!.id;
    expect(id1).not.toBe("");
    expect(id2).not.toBe("");

    const result = step(
      q2.state,
      { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      context,
    );

    // Messages end with [...assistant, ...queued].
    const tail = result.state.messages.slice(-3);
    expect(tail[0]!.role).toBe("assistant");
    expect((tail[0] as AssistantMessage).stopReason).toBe("end_turn");
    expect(tail[1]!.role).toBe("user");
    expect(tail[1]!.content).toBe("First queued");
    expect(tail[2]!.role).toBe("user");
    expect(tail[2]!.content).toBe("Second queued");

    // Queue drained, turn stays open (in-turn continuation, no done effect).
    expect(result.state.queuedUserInputs).toHaveLength(0);
    expect(result.state.status).toBe("calling_model");
    expect(result.effects.some((e) => e.type === "done")).toBe(false);

    // steering_delivered names every drained id (FIFO) and sits before call_model.
    expect(emitData(result.effects, "steering_delivered")).toEqual([{ ids: [id1, id2] }]);
    const callModels = result.effects.filter((e) => e.type === "call_model");
    expect(callModels).toHaveLength(1);
    expect(emitIndex(result.effects, "steering_delivered")).toBeLessThan(
      result.effects.findIndex((e) => e.type === "call_model"),
    );

    // The re-issued request ends with [...assistant, ...queued].
    const requestTail = callModels[0]!.request.messages.slice(-3);
    expect(requestTail[0]!.role).toBe("assistant");
    expect(requestTail[1]!.content).toBe("First queued");
    expect(requestTail[2]!.content).toBe("Second queued");
  });

  it("end_turn continuation with a hit limit terminates the turn and keeps queuedUserInputs", () => {
    const context = ctxWithIds();
    // maxIterations: 1 — the first model_done already trips the runaway
    // guard, so the queued end_turn continuation must NOT issue a call.
    const setup = drive(reachCallingModel(), context, createInitialState({ maxIterations: 1 }));
    const callingState = setup[setup.length - 1]!.state;

    const queued = step(callingState, { type: "user_message", content: "Queued before end_turn" }, context);
    expect(queued.state.queuedUserInputs).toHaveLength(1);
    const queuedId = queued.state.queuedUserInputs[0]!.id;

    const result = step(
      queued.state,
      { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      context,
    );

    // The guard wins over continuation: done + an error naming the cap.
    expect(result.state.status).toBe("done");
    expect(result.effects.some((e) => e.type === "done")).toBe(true);
    expect(result.effects.some((e) => e.type === "call_model")).toBe(false);
    expect(emitData(result.effects, "error")).toEqual([{ error: "Maximum iterations reached" }]);
    expect(emitData(result.effects, "steering_delivered")).toEqual([]);
    // The queue survives untouched for the host-side auto-flush (scenario G).
    expect(result.state.queuedUserInputs).toHaveLength(1);
    expect(result.state.queuedUserInputs[0]!.id).toBe(queuedId);
    expect(result.state.queuedUserInputs[0]!.content).toBe("Queued before end_turn");
  });

  it("end_turn with empty queue completes the turn as before", () => {
    const context = ctxWithIds();
    const setup = drive(reachCallingModel(), context);
    const callingState = setup[setup.length - 1]!.state;

    const result = step(
      callingState,
      { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      context,
    );

    expect(result.state.status).toBe("done");
    expect(result.effects.some((e) => e.type === "call_model")).toBe(false);
    expect(result.effects.some((e) => e.type === "done")).toBe(true);
    expect(emitData(result.effects, "steering_delivered")).toEqual([]);
    expect(result.state.queuedUserInputs).toHaveLength(0);
  });
});

describe("terminated done paths keep the queue for host auto-run", () => {
  it("limit-terminated done keeps queuedUserInputs for the host to auto-run", () => {
    const context = ctxWithIds();
    // maxIterations: 1 — the tool_use turn hits the runaway guard at model_done.
    let state = createInitialState({ maxIterations: 1 });
    let lastEffects: Effect[] = [];
    for (const input of [
      { type: "user_message", content: "Run the tool" } as AgentInput,
      { type: "user_message", content: "Queued while running" } as AgentInput,
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "call_1",
          toolCallName: "read_file",
          argumentsDelta: '{"path":"foo.ts"}',
        },
      } as AgentInput,
      { type: "model_done", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } } as AgentInput,
    ]) {
      const result = step(state, input, context);
      state = result.state;
      lastEffects = result.effects;
    }

    // The guard really fired: done + an error naming the cap (never a silent done).
    expect(state.status).toBe("done");
    expect(lastEffects.some((e) => e.type === "done")).toBe(true);
    expect(emitData(lastEffects, "error")).toEqual([{ error: "Maximum iterations reached" }]);
    // The queue survives untouched for the host-side auto-run to deliver.
    expect(state.queuedUserInputs).toHaveLength(1);
    expect(state.queuedUserInputs[0]!.content).toBe("Queued while running");
  });

  it("non-retriable model_error done keeps queuedUserInputs for the host to auto-run", () => {
    const context = ctxWithIds();
    let state = createInitialState();
    let lastEffects: Effect[] = [];
    for (const input of [
      { type: "user_message", content: "Run the model" } as AgentInput,
      { type: "user_message", content: "Queued while running" } as AgentInput,
      { type: "model_error", error: "endpoint rejected the request", retriable: false } as AgentInput,
    ]) {
      const result = step(state, input, context);
      state = result.state;
      lastEffects = result.effects;
    }

    // The non-retriable path really fired: done + the model error surfaced.
    expect(state.status).toBe("done");
    expect(lastEffects.some((e) => e.type === "done")).toBe(true);
    expect(emitData(lastEffects, "error")).toEqual([{ error: "endpoint rejected the request" }]);
    // The queue survives untouched for the host-side auto-run to deliver.
    expect(state.queuedUserInputs).toHaveLength(1);
    expect(state.queuedUserInputs[0]!.content).toBe("Queued while running");
  });
});
