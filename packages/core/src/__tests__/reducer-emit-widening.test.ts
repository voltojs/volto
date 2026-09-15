import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../index.js";
import type { ReducerState, StepContext, Effect } from "../index.js";

const ctx: StepContext = { tools: [], model: "test-model" };

function emitted(effects: Effect[], type: string): Record<string, unknown> | undefined {
  for (const e of effects) {
    if (e.type === "emit" && e.event.type === type) return e.event.data;
  }
  return undefined;
}

describe("model_done emit", () => {
  it("carries the assembled assistant message so the Runner need not rebuild it", () => {
    let state: ReducerState = createInitialState();
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;
    state = step(state, { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } }, ctx).state;

    const result = step(state, { type: "model_done", stopReason: "end_turn" }, ctx);
    const data = emitted(result.effects, "model_done");

    expect(data).toBeDefined();
    expect(data!["message"]).toEqual({
      id: "",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "end_turn",
      source: { modelId: "test-model" },
    });
  });
});

describe("tool_result emit", () => {
  it("carries the real content, displayMetadata and the batch order", () => {
    let state: ReducerState = createInitialState();
    state = step(state, { type: "user_message", content: "go" }, ctx).state;
    state = step(
      state,
      { type: "model_chunk", chunk: { type: "tool_use_delta", toolCallId: "c1", toolCallName: "read_file", argumentsDelta: "{}" } },
      ctx,
    ).state;
    state = step(
      state,
      { type: "model_chunk", chunk: { type: "tool_use_delta", toolCallId: "c2", toolCallName: "list_dir", argumentsDelta: "{}" } },
      ctx,
    ).state;
    state = step(state, { type: "model_done", stopReason: "tool_use" }, ctx).state;

    // The SECOND tool reports first — orderInBatch must still say it is index 1.
    const result = step(
      state,
      {
        type: "tool_result",
        toolCallId: "c2",
        toolName: "list_dir",
        result: { modelContent: "a,b,c", displayMetadata: { lineCount: 3 } },
      },
      ctx,
    );
    const data = emitted(result.effects, "tool_result");

    expect(data).toBeDefined();
    expect(data!["content"]).toBe("a,b,c");
    expect(data!["displayMetadata"]).toEqual({ lineCount: 3 });
    expect(data!["orderInBatch"]).toBe(1);
  });

  it("reports orderInBatch 0 for the first pending tool", () => {
    let state: ReducerState = createInitialState();
    state = step(state, { type: "user_message", content: "go" }, ctx).state;
    state = step(
      state,
      { type: "model_chunk", chunk: { type: "tool_use_delta", toolCallId: "c1", toolCallName: "read_file", argumentsDelta: "{}" } },
      ctx,
    ).state;
    state = step(state, { type: "model_done", stopReason: "tool_use" }, ctx).state;

    const result = step(
      state,
      { type: "tool_result", toolCallId: "c1", toolName: "read_file", result: { modelContent: "ok" } },
      ctx,
    );
    expect(emitted(result.effects, "tool_result")!["orderInBatch"]).toBe(0);
  });
});
