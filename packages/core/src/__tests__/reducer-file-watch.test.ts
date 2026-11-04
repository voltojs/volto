/**
 * file_changed — reducer handling for debounced FileWatcher batches.
 *
 * Covers F-004..F-011:
 *  - idle opens a turn (status + call_model + transcript)
 *  - notice text carries watchId and each type/path
 *  - busy states append without interrupting
 *  - cancelling / done drop with an observable warning (never throw)
 */

import { describe, it, expect } from "vitest";
import { step, createInitialState, formatFileChangedNotice } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { AgentInput } from "../input.js";
import type { Effect } from "../effect.js";
import type { ToolDefinition } from "../tool.js";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const testTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    requires: ["filesystem:read"],
    riskTier: "READ_ONLY",
  },
];

const ctx: StepContext = { tools: testTools, model: "test-model" };

const fileChanged: AgentInput = {
  type: "file_changed",
  watchId: "watch-0",
  events: [
    { type: "change", path: "src/app.ts", mtime: 1_000 },
    { type: "rename", path: "src/old.ts" },
  ],
};

function emitEvents(effects: Effect[], type: string): Array<Record<string, unknown>> {
  return effects
    .filter((e): e is Extract<Effect, { type: "emit" }> => e.type === "emit" && e.event.type === type)
    .map((e) => e.event.data as Record<string, unknown>);
}

function reachCallingModel(): ReducerState {
  let state = createInitialState();
  state = step(state, { type: "user_message", content: "Do something" }, ctx).state;
  state = step(
    state,
    { type: "model_chunk", chunk: { type: "text_delta", text: "Thinking..." } },
    ctx,
  ).state;
  return state;
}

function reachCancelling(): ReducerState {
  let state = createInitialState();
  state = step(state, { type: "user_message", content: "Do something" }, ctx).state;
  state = step(state, { type: "cancel", reason: "user" }, ctx).state;
  return state;
}

function reachDone(): ReducerState {
  let state = createInitialState();
  state = step(state, { type: "user_message", content: "Do something" }, ctx).state;
  state = step(state, { type: "model_done", stopReason: "end_turn" }, ctx).state;
  return state;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("formatFileChangedNotice", () => {
  it("lists watchId, count, and each type/path", () => {
    const text = formatFileChangedNotice(fileChanged);
    expect(text).toContain('File watch "watch-0"');
    expect(text).toContain("2 change(s)");
    expect(text).toContain("- change src/app.ts");
    expect(text).toContain("- rename src/old.ts");
  });

  it("formats an empty batch as a zero-count header (still a sensible notice)", () => {
    const text = formatFileChangedNotice({ watchId: "w-empty", events: [] });
    expect(text).toBe('File watch "w-empty" reported 0 change(s):');
  });
});

describe("file_changed — idle (F-004..F-007)", () => {
  it("opens a turn: appends notice, status → calling_model, emits call_model", () => {
    const result = step(createInitialState(), fileChanged, ctx);

    expect(result.state.status).toBe("calling_model");
    expect(result.state.messages).toHaveLength(1);

    const msg = result.state.messages[0]!;
    expect(msg.role).toBe("user");
    if (typeof msg.content !== "string") throw new Error("expected string user content");
    expect(msg.content).toContain('File watch "watch-0"');
    expect(msg.content).toContain("- change src/app.ts");
    expect(msg.content).toContain("- rename src/old.ts");

    const callModels = result.effects.filter((e) => e.type === "call_model");
    expect(callModels).toHaveLength(1);
  });

  it("emits a file_changed transcript event with watchId and events", () => {
    const result = step(createInitialState(), fileChanged, ctx);
    const emits = emitEvents(result.effects, "file_changed");
    expect(emits).toHaveLength(1);
    expect(emits[0]!.watchId).toBe("watch-0");
    expect(emits[0]!.events).toEqual([
      { type: "change", path: "src/app.ts", mtime: 1_000 },
      { type: "rename", path: "src/old.ts" },
    ]);
  });

  it("still opens a turn for an empty events batch", () => {
    const empty: AgentInput = { type: "file_changed", watchId: "w-empty", events: [] };
    const result = step(createInitialState(), empty, ctx);

    expect(result.state.status).toBe("calling_model");
    const msg = result.state.messages[0]!;
    if (typeof msg.content !== "string") throw new Error("expected string user content");
    expect(msg.content).toContain('File watch "w-empty"');
    expect(msg.content).toContain("0 change(s)");
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(1);
  });
});

describe("file_changed — busy states (F-008..F-009)", () => {
  it("calling_model: queues the notice for the turn boundary, keeps status, does not emit call_model", () => {
    const busy = reachCallingModel();
    expect(busy.status).toBe("calling_model");
    const messagesBefore = busy.messages.length;

    const result = step(busy, fileChanged, ctx);

    expect(result.state.status).toBe("calling_model");
    // Not appended to messages mid-turn: an assistant tool_use may still be
    // awaiting its tool_result, and providers like Anthropic reject a
    // request that splits that pair with an interleaved user message.
    expect(result.state.messages).toHaveLength(messagesBefore);
    expect(result.state.queuedUserInputs).toHaveLength(1);
    const queued = result.state.queuedUserInputs[0]!;
    expect(queued.role).toBe("user");
    if (typeof queued.content !== "string") throw new Error("expected string user content");
    expect(queued.content).toContain('File watch "watch-0"');

    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);
    expect(emitEvents(result.effects, "file_changed")).toHaveLength(1);
  });

  it("executing_tools: queues the notice, keeps pending tools, no call_model", () => {
    let state = createInitialState();
    state = step(state, { type: "user_message", content: "Read the file" }, ctx).state;
    state = step(
      state,
      {
        type: "model_chunk",
        chunk: {
          type: "tool_use_delta",
          toolCallId: "call_1",
          toolCallName: "read_file",
          argumentsDelta: '{"path":"foo.ts"}',
        },
      },
      ctx,
    ).state;
    state = step(state, { type: "model_done", stopReason: "tool_use" }, ctx).state;
    expect(state.status).toBe("executing_tools");
    const messagesBefore = state.messages.length;
    const pendingBefore = state.pendingTools.length;

    const result = step(state, fileChanged, ctx);

    expect(result.state.status).toBe("executing_tools");
    expect(result.state.messages).toHaveLength(messagesBefore);
    expect(result.state.queuedUserInputs).toHaveLength(1);
    expect(result.state.pendingTools).toHaveLength(pendingBefore);
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);
    expect(emitEvents(result.effects, "file_changed")).toHaveLength(1);
  });

  it("waiting_for_input: queues the notice without changing status", () => {
    const waiting = createInitialState({ status: "waiting_for_input" });
    const result = step(waiting, fileChanged, ctx);

    expect(result.state.status).toBe("waiting_for_input");
    expect(result.state.messages).toHaveLength(0);
    expect(result.state.queuedUserInputs).toHaveLength(1);
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);
    expect(emitEvents(result.effects, "file_changed")).toHaveLength(1);
  });

  it("waiting_for_approval: queues the notice without changing status", () => {
    const waiting = createInitialState({ status: "waiting_for_approval" });
    const result = step(waiting, fileChanged, ctx);

    expect(result.state.status).toBe("waiting_for_approval");
    expect(result.state.messages).toHaveLength(0);
    expect(result.state.queuedUserInputs).toHaveLength(1);
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);
    expect(emitEvents(result.effects, "file_changed")).toHaveLength(1);
  });
});

describe("file_changed — cancelling / done drop (F-010..F-011)", () => {
  it("cancelling: does not throw, does not start call_model, emits observable warning", () => {
    const cancelling = reachCancelling();
    expect(cancelling.status).toBe("cancelling");
    const messagesBefore = cancelling.messages.length;

    const result = step(cancelling, fileChanged, ctx);

    expect(result.state.status).toBe("cancelling");
    expect(result.state.messages).toHaveLength(messagesBefore);
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);

    const errors = emitEvents(result.effects, "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.error)).toContain("file_changed dropped");
    expect(String(errors[0]!.error)).toContain("cancelling");
    expect(String(errors[0]!.error)).toContain("watch-0");
  });

  it("done: drops with warning instead of the generic done-state error", () => {
    const done = reachDone();
    expect(done.status).toBe("done");
    const messagesBefore = done.messages.length;

    const result = step(done, fileChanged, ctx);

    expect(result.state.status).toBe("done");
    expect(result.state.messages).toHaveLength(messagesBefore);
    expect(result.effects.filter((e) => e.type === "call_model")).toHaveLength(0);

    const errors = emitEvents(result.effects, "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.error)).toContain("file_changed dropped");
    expect(String(errors[0]!.error)).toContain("done");
  });

  it("other inputs on done still hit the existing done invariant", () => {
    const done = reachDone();
    // `user_message` is no longer "other": D4 queues it instead of erroring
    // (see steering-cross-status.test.ts). Model-turn inputs still reject.
    const result = step(done, { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } }, ctx);
    const errors = emitEvents(result.effects, "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.error)).toContain("step() called on done state");
  });
});

describe("file_changed — determinism", () => {
  it("same input sequence reproduces identical (state, effects)", () => {
    const inputs: AgentInput[] = [
      fileChanged,
      { type: "model_chunk", chunk: { type: "text_delta", text: "ok" } },
      {
        type: "file_changed",
        watchId: "watch-0",
        events: [{ type: "change", path: "src/b.ts" }],
      },
    ];

    const run = () => {
      let state = createInitialState();
      const effects: Effect[] = [];
      for (const input of inputs) {
        const r = step(state, input, ctx);
        state = r.state;
        effects.push(...r.effects);
      }
      return { state, effects };
    };

    expect(run()).toEqual(run());
  });
});
