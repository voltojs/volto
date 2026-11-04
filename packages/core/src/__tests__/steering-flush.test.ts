/**
 * Steering — cross-turn queue preservation and `steering_flush` turn
 * opening (D11).
 *
 * D11a: `resetTurnForNextInput` KEEPS `queuedUserInputs` — an un-delivered
 * queue is cross-turn state, exactly like `messages`.
 *
 * D11b: `handleIdle`'s `user_message` flushes the older queue FIRST
 * (`[...olderQueue, newUserMsg]`) and announces only the flushed older
 * entries with `steering_delivered` — the new message is the turn input,
 * never queued.
 *
 * `steering_flush`: opens a turn that delivers the whole queue as the
 * opening input (ORIGINAL ids preserved), one `call_model`, no
 * `user_message` emit. Empty queue → errorResult.
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState, resetTurnForNextInput } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";

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

/** Build inputs that reach calling_model status (after user_message + model starts) */
function reachCallingModel(): AgentInput[] {
  return [
    { type: "user_message", content: "Do something" },
    { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
  ];
}

/** A completed turn: user_message + model_done(end_turn) → status "done". */
function reachDone(context: StepContext): ReducerState {
  const trace = drive(
    [
      { type: "user_message", content: "First turn" },
      { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
    ],
    context,
  );
  return trace[trace.length - 1]!.state;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("cross-turn queue preservation (D11a)", () => {
  it("resetTurnForNextInput preserves queuedUserInputs", () => {
    const context = ctxWithIds();
    // Queue a message mid-turn, then finish the turn — the queue survives
    // into done (D4) and must survive the turn reset too.
    const setup = drive(reachCallingModel(), context);
    const callingState = setup[setup.length - 1]!.state;
    const queued = step(callingState, { type: "user_message", content: "late steer" }, context);
    expect(queued.state.queuedUserInputs).toHaveLength(1);
    const queuedMsg = queued.state.queuedUserInputs[0]!;

    const reset = resetTurnForNextInput(queued.state);

    // Turn-scoped accumulators are cleared and the state is idle ...
    expect(reset.status).toBe("idle");
    expect(reset.pendingTools).toEqual([]);
    expect(reset._toolResultBuffer).toEqual({});
    // ... but the un-delivered queue is cross-turn state, like messages.
    expect(reset.queuedUserInputs).toHaveLength(1);
    expect(reset.queuedUserInputs[0]).toEqual(queuedMsg);
    expect(reset.messages).toEqual(queued.state.messages);
  });
});

describe("idle user_message flushes the older queue first (D11b)", () => {
  it("idle user_message flushes older queued messages first", () => {
    const context = ctxWithIds();
    // A message queued after done (D4) survives the cross-turn reset (D11a).
    const doneState = reachDone(context);
    const queued = step(doneState, { type: "user_message", content: "m1 queued" }, context);
    const m1 = queued.state.queuedUserInputs[0]!;
    const idle = resetTurnForNextInput(queued.state);

    const result = step(idle, { type: "user_message", content: "m2 opening" }, context);

    // Message order is [..., m1, m2]: the queue is always older than the
    // opening message and flushes first.
    const tail = result.state.messages.slice(-2);
    expect(tail[0]!.id).toBe(m1.id);
    expect(tail[0]!.content).toBe("m1 queued");
    expect(tail[1]!.content).toBe("m2 opening");
    expect(tail[1]!.id).not.toBe(m1.id);

    // Queue cleared; steering_delivered names ONLY the flushed older
    // entries — the new message is the turn input, never queued.
    expect(result.state.queuedUserInputs).toHaveLength(0);
    expect(emitData(result.effects, "steering_delivered")).toEqual([{ ids: [m1.id] }]);

    // Exactly one model call opens the turn.
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(1);
    expect(result.state.status).toBe("calling_model");

    // The opening message keeps its user_message emit, unchanged.
    expect(emitData(result.effects, "user_message")).toEqual([{ content: "m2 opening" }]);
  });
});

describe("steering_flush opens one turn delivering the queue (D11)", () => {
  it("steering_flush opens one turn delivering the whole queue with original ids", () => {
    const context = ctxWithIds();
    // Two messages queued mid-turn survive the cross-turn reset (D11a).
    const setup = drive(reachCallingModel(), context);
    const callingState = setup[setup.length - 1]!.state;
    const q1 = step(callingState, { type: "user_message", content: "m1" }, context);
    const q2 = step(q1.state, { type: "user_message", content: "m2" }, context);
    const id1 = q2.state.queuedUserInputs[0]!.id;
    const id2 = q2.state.queuedUserInputs[1]!.id;
    const idle = resetTurnForNextInput(q2.state);

    const result = step(idle, { type: "steering_flush" }, context);

    // The queue rides the turn opening in FIFO order with its ORIGINAL ids.
    const tail = result.state.messages.slice(-2);
    expect(tail[0]!.id).toBe(id1);
    expect(tail[0]!.content).toBe("m1");
    expect(tail[1]!.id).toBe(id2);
    expect(tail[1]!.content).toBe("m2");
    expect(result.state.queuedUserInputs).toHaveLength(0);
    expect(result.state.status).toBe("calling_model");

    // steering_delivered realizes the whole queue ...
    expect(emitData(result.effects, "steering_delivered")).toEqual([{ ids: [id1, id2] }]);

    // ... and NO user_message emit: the content already reached the
    // transcript as steering_queued — steering_delivered realizes it.
    expect(emitData(result.effects, "user_message")).toEqual([]);

    // ONE model call, and its request ends with the queue in order.
    const callModels = result.effects.filter((e) => e.type === "call_model");
    expect(callModels).toHaveLength(1);
    const requestTail = callModels[0]!.request.messages.slice(-2);
    expect(requestTail[0]!.id).toBe(id1);
    expect(requestTail[1]!.id).toBe(id2);
  });

  it("steering_flush with an empty queue yields an errorResult", () => {
    const idle = createInitialState();

    const result = step(idle, { type: "steering_flush" }, ctx);

    // The rejection itself — a byte-exact error — never a silent no-op.
    expect(emitData(result.effects, "error")).toEqual([
      { error: "steering_flush: no queued messages" },
    ]);
    // State untouched, turn stays closed.
    expect(result.state).toEqual(idle);
    expect(result.state.status).toBe("idle");
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);
  });
});
