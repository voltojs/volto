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
    expect(resetTurnForNextInput(started).backgroundTasks ?? []).toEqual([]);
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
});
