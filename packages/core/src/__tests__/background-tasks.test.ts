import { describe, it, expect } from "vitest";
import { step, createInitialState, resetTurnForNextInput } from "../index.js";
import type { StepContext } from "../index.js";

// These state-only inputs need no tools or ports; a bare context keeps the
// cases focused on the reducer's background-task bookkeeping.
const ctx: StepContext = { tools: [] };

describe("background task state", () => {
  it("records a dispatched task as running", () => {
    const { state } = step(
      createInitialState(),
      {
        type: "background_task_started",
        taskId: "t1",
        subagentType: "searcher",
      },
      ctx,
    );
    expect(state.backgroundTasks).toEqual([
      expect.objectContaining({ id: "t1", subagentType: "searcher", status: "running" }),
    ]);
  });

  it("marks a task collected and appends its result as a message", () => {
    const started = step(
      createInitialState(),
      { type: "background_task_started", taskId: "t1" },
      ctx,
    ).state;
    const { state } = step(
      started,
      { type: "background_task_completed", taskId: "t1", text: "found 3 matches" },
      ctx,
    );

    expect(state.backgroundTasks?.find((t) => t.id === "t1")?.status).toBe("collected");
    const last = state.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(JSON.stringify(last)).toContain("found 3 matches");
  });

  it("emits an auditable context reminder for the injection", () => {
    const started = step(
      createInitialState(),
      { type: "background_task_started", taskId: "t1" },
      ctx,
    ).state;
    const { effects } = step(
      started,
      { type: "background_task_completed", taskId: "t1", text: "x" },
      ctx,
    );
    const reminder = effects.find(
      (e) => e.type === "emit" && (e.event as { type: string }).type === "context_reminder",
    );
    expect(JSON.stringify(reminder)).toContain("background_task");
  });

  it("clears the table at the turn boundary", () => {
    const started = step(
      createInitialState(),
      { type: "background_task_started", taskId: "t1" },
      ctx,
    ).state;
    // No `??` fallback: the implementation writes `backgroundTasks: []`
    // explicitly (triple-state semantics); a deleted field must fail here.
    expect(resetTurnForNextInput(started).backgroundTasks).toEqual([]);
  });

  it("survives a serialize/deserialize round trip", () => {
    const started = step(
      createInitialState(),
      { type: "background_task_started", taskId: "t1" },
      ctx,
    ).state;
    const revived = JSON.parse(JSON.stringify(started)) as typeof started;
    expect(revived.backgroundTasks).toEqual(started.backgroundTasks);
  });

  it("drains a completion at the turn boundary: done → calling_model", () => {
    // Dispatch a background task, then drive a full user → assistant turn
    // to "done" — the state a Task 9 drain feed actually arrives at.
    let state = step(
      createInitialState(),
      { type: "background_task_started", taskId: "t1" },
      ctx,
    ).state;
    state = step(state, { type: "user_message", content: "hi" }, ctx).state;
    state = step(
      state,
      { type: "model_chunk", chunk: { type: "text_delta", text: "hello" } },
      ctx,
    ).state;
    state = step(state, { type: "model_done", stopReason: "end_turn" }, ctx).state;
    expect(state.status).toBe("done");

    const { state: drained, effects } = step(
      state,
      { type: "background_task_completed", taskId: "t1", text: "found 3 matches" },
      ctx,
    );

    expect(drained.status).toBe("calling_model");
    const callModel = effects.find((e) => e.type === "call_model");
    expect(callModel).toBeDefined();

    const noticeText = "[background task t1 finished]\nfound 3 matches";
    expect(drained.messages.at(-1)?.content).toBe(noticeText);
    if (callModel?.type !== "call_model") throw new Error("expected call_model effect");
    expect(
      callModel.request.messages.some((m) => m.content === noticeText),
    ).toBe(true);
  });
});
