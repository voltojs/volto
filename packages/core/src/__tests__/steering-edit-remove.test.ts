/**
 * Steering — queue mutations D14/D15.
 *
 * D14: `steering_edit { id, content }` replaces a queued message's content
 * IN PLACE — same id, same position — and emits `steering_edited`.
 * D15: `steering_remove { id }` hard-deletes the queued entry (no tombstone)
 * and emits `steering_removed`.
 *
 * Both are cross-status (accepted in ANY state including idle/done — the
 * queue outlives the turn) and delivery wins: an id that is no longer in
 * `queuedUserInputs` yields an errorResult with state untouched, so there is
 * no way to "edit an already-sent message".
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
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

/**
 * Drive to calling_model with `count` messages queued via the D4 cross-status
 * queue site — returns the queue-holding state and the stamped ids.
 */
function queuedState(count: number, contents: string[]): { state: ReducerState; ids: string[] } {
  const context = ctxWithIds();
  const setup = drive(
    [
      { type: "user_message", content: "Do something" },
      { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
    ],
    context,
  );
  let state = setup[setup.length - 1]!.state;
  for (const content of contents) {
    state = step(state, { type: "user_message", content }, context).state;
  }
  const ids = state.queuedUserInputs.map((m) => m.id);
  expect(ids).toHaveLength(count);
  return { state, ids };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("steering_edit (D14)", () => {
  it("steering_edit replaces content in place keeping id and position", () => {
    const { state, ids } = queuedState(2, ["first", "second"]);
    const firstBefore = state.queuedUserInputs[0]!;
    const secondBefore = state.queuedUserInputs[1]!;

    const result = step(
      state,
      { type: "steering_edit", id: ids[0]!, content: "first (edited)" },
      ctx,
    );

    const queue = result.state.queuedUserInputs;
    expect(queue).toHaveLength(2);
    // Position and identity preserved: same id at index 0, second untouched.
    expect(queue[0]!.id).toBe(ids[0]);
    expect(queue[1]!.id).toBe(ids[1]);
    expect(queue[1]!.content).toBe("second");
    // Content replaced with a NEW object (no mutation of the old entry).
    expect(queue[0]!.content).toBe("first (edited)");
    expect(queue[0]).not.toBe(firstBefore);
    expect(queue[1]).toBe(secondBefore);

    // Exactly the documented event, carrying the id and the new content.
    expect(emitData(result.effects, "steering_edited")).toEqual([
      { id: ids[0], content: "first (edited)" },
    ]);
    expect(emitData(result.effects, "error")).toEqual([]);
    // No delivery / status side effects from an edit.
    expect(result.state.status).toBe(state.status);
    expect(result.state.messages).toEqual(state.messages);
  });

  it("steering_edit accepts ContentBlock[] content", () => {
    const { state, ids } = queuedState(1, ["plain"]);
    const blocks: Array<{ type: "text"; text: string }> = [{ type: "text", text: "blocky" }];

    const result = step(state, { type: "steering_edit", id: ids[0]!, content: blocks }, ctx);

    expect(result.state.queuedUserInputs[0]!.content).toEqual(blocks);
    expect(emitData(result.effects, "steering_edited")).toEqual([{ id: ids[0], content: blocks }]);
  });
});

describe("steering_remove (D15)", () => {
  it("steering_remove deletes the entry and emits steering_removed", () => {
    const { state, ids } = queuedState(3, ["keep-1", "drop", "keep-2"]);

    const result = step(state, { type: "steering_remove", id: ids[1]! }, ctx);

    const queue = result.state.queuedUserInputs;
    expect(queue).toHaveLength(2);
    // Hard delete: the remaining entries keep their ids and relative order.
    expect(queue.map((m) => m.id)).toEqual([ids[0], ids[2]]);
    expect(queue.map((m) => m.content)).toEqual(["keep-1", "keep-2"]);
    // No tombstone-shaped residue anywhere in the queue.
    expect(queue.some((m) => m.id === ids[1])).toBe(false);

    expect(emitData(result.effects, "steering_removed")).toEqual([{ id: ids[1] }]);
    expect(emitData(result.effects, "error")).toEqual([]);
    expect(result.state.status).toBe(state.status);
  });
});

describe("unknown id — errorResult, state unchanged (delivery wins)", () => {
  it("unknown id yields an errorResult and leaves state unchanged", () => {
    const { state } = queuedState(1, ["only"]);

    // D14 — unknown id.
    const beforeEdit = JSON.stringify(state);
    const edit = step(state, { type: "steering_edit", id: "msg-nope", content: "hacked" }, ctx);
    expect(JSON.stringify(edit.state)).toBe(beforeEdit);
    expect(edit.effects).toHaveLength(1);
    expect(emitData(edit.effects, "error")).toEqual([
      { error: `steering_edit: no queued message with id "msg-nope"` },
    ]);
    expect(emitData(edit.effects, "steering_edited")).toEqual([]);

    // D15 — unknown id (same shape, its own verbatim prefix).
    const beforeRemove = JSON.stringify(state);
    const remove = step(state, { type: "steering_remove", id: "msg-nope" }, ctx);
    expect(JSON.stringify(remove.state)).toBe(beforeRemove);
    expect(remove.effects).toHaveLength(1);
    expect(emitData(remove.effects, "error")).toEqual([
      { error: `steering_remove: no queued message with id "msg-nope"` },
    ]);
    expect(emitData(remove.effects, "steering_removed")).toEqual([]);

    // An already-delivered id is simply an unknown id: the queue drained, so
    // the same errorResult applies (delivery wins — no late mutation).
    const drainCtx = ctxWithIds();
    const preDrain = drive(
      [
        { type: "user_message", content: "Do something" },
        { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
        { type: "user_message", content: "queued" },
      ],
      drainCtx,
    );
    const queuedId = preDrain[preDrain.length - 1]!.state.queuedUserInputs[0]!.id;
    const drained = step(
      preDrain[preDrain.length - 1]!.state,
      { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      drainCtx,
    );
    // D3 end_turn continuation drains the queue into the history (delivery),
    // so the id is gone from queuedUserInputs — a late edit can't reach it.
    expect(drained.state.queuedUserInputs).toHaveLength(0);
    expect(drained.state.messages.some((m) => m.id === queuedId)).toBe(true);
    const late = step(drained.state, { type: "steering_edit", id: queuedId, content: "too late" }, drainCtx);
    expect(JSON.stringify(late.state)).toBe(JSON.stringify(drained.state));
    expect(emitData(late.effects, "error")).toEqual([
      { error: `steering_edit: no queued message with id "${queuedId}"` },
    ]);
  });
});

describe("cross-status acceptance (any state, incl. idle/done)", () => {
  it("edit and remove work during executing_tools and on a done state", () => {
    const context = ctxWithIds();

    // executing_tools — one pending tool, one queued message.
    const execTrace = drive(
      [
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
        { type: "user_message", content: "queued mid-run" },
      ],
      context,
    );
    const execState = execTrace[execTrace.length - 1]!.state;
    expect(execState.status).toBe("executing_tools");
    const execId = execState.queuedUserInputs[0]!.id;

    const edited = step(execState, { type: "steering_edit", id: execId, content: "queued, revised" }, context);
    expect(edited.state.status).toBe("executing_tools");
    expect(edited.state.pendingTools).toEqual(execState.pendingTools);
    expect(edited.state.queuedUserInputs[0]!.content).toBe("queued, revised");
    expect(emitData(edited.effects, "steering_edited")).toEqual([
      { id: execId, content: "queued, revised" },
    ]);

    const removed = step(edited.state, { type: "steering_remove", id: execId }, context);
    expect(removed.state.status).toBe("executing_tools");
    expect(removed.state.queuedUserInputs).toHaveLength(0);
    expect(emitData(removed.effects, "steering_removed")).toEqual([{ id: execId }]);

    // done — queue survives termination (D4), so it stays mutable there too.
    const doneTrace = drive(
      [
        { type: "user_message", content: "Finish up" },
        { type: "model_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "user_message", content: "queued after done" },
      ],
      context,
    );
    const doneState = doneTrace[doneTrace.length - 1]!.state;
    expect(doneState.status).toBe("done");
    const doneId = doneState.queuedUserInputs[0]!.id;

    const doneEdit = step(doneState, { type: "steering_edit", id: doneId, content: "revised after done" }, context);
    expect(doneEdit.state.status).toBe("done");
    expect(doneEdit.state.queuedUserInputs[0]!.content).toBe("revised after done");
    expect(emitData(doneEdit.effects, "steering_edited")).toEqual([
      { id: doneId, content: "revised after done" },
    ]);

    const doneRemove = step(doneEdit.state, { type: "steering_remove", id: doneId }, context);
    expect(doneRemove.state.status).toBe("done");
    expect(doneRemove.state.queuedUserInputs).toHaveLength(0);
    expect(emitData(doneRemove.effects, "steering_removed")).toEqual([{ id: doneId }]);
  });
});

describe("replay determinism", () => {
  it("edit/remove replay determinism", () => {
    // One sequence covering queue → edit → remove → edit unknown (error path)
    // → remove unknown (error path), run twice from a fresh state with a
    // fresh Id port: every (state, effects) pair must match byte for byte.
    // The mutated ids are read back from state (never hardcoded) so the
    // sequence asserts the same behavior, not the same id generator.
    const runOnce = () => {
      const context = ctxWithIds();
      const trace: Array<{ state: ReducerState; effects: Effect[] }> = [];
      let state = createInitialState();
      const feed = (input: AgentInput) => {
        const result = step(state, input, context);
        trace.push({ state: result.state, effects: result.effects });
        state = result.state;
      };

      feed({ type: "user_message", content: "Do something" });
      feed({ type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } });
      feed({ type: "user_message", content: "alpha" });
      feed({ type: "user_message", content: "beta" });
      const [idA, idB] = state.queuedUserInputs.map((m) => m.id);
      feed({ type: "steering_edit", id: idA!, content: "alpha edited" });
      feed({ type: "steering_remove", id: idB! });
      feed({ type: "steering_edit", id: "msg-999", content: "ghost" });
      feed({ type: "steering_remove", id: "msg-999" });
      return trace;
    };

    const first = runOnce();
    const second = runOnce();
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
    for (let i = 0; i < first.length; i++) {
      expect(JSON.stringify(second[i]!.state)).toBe(JSON.stringify(first[i]!.state));
      expect(JSON.stringify(second[i]!.effects)).toBe(JSON.stringify(first[i]!.effects));
    }

    // Sanity: the sequence really exercised mutation AND error paths.
    expect(first[4]!.state.queuedUserInputs[0]!.content).toBe("alpha edited");
    expect(first[5]!.state.queuedUserInputs).toHaveLength(1);
    expect(emitData(first[6]!.effects, "error")).toEqual([
      { error: `steering_edit: no queued message with id "msg-999"` },
    ]);
    expect(emitData(first[7]!.effects, "error")).toEqual([
      { error: `steering_remove: no queued message with id "msg-999"` },
    ]);
  });
});
