import { describe, it, expect } from "vitest";
import { drainBackgroundTasks, createRunner } from "../runner.js";
import {
  createMockModelPort,
  createInitialState,
  modelDone,
  textDelta,
} from "@volto/core";
import type { AgentState } from "@volto/core";

function stateWithRunning(ids: string[]): AgentState {
  return {
    backgroundTasks: ids.map((id) => ({ id, status: "running" as const, startedAt: 0 })),
  } as unknown as AgentState;
}

describe("turn-boundary drain", () => {
  it("feeds a completion input for every uncollected task", async () => {
    const fed: Array<{ type: string; taskId?: string }> = [];
    await drainBackgroundTasks({
      state: stateWithRunning(["t1", "t2"]),
      registry: { collect: async (id: string) => ({ text: `result-${id}` }) } as never,
      feed: (input) => { fed.push(input as { type: string; taskId?: string }); },
    });
    expect(fed.filter((f) => f.type === "background_task_completed").map((f) => f.taskId))
      .toEqual(["t1", "t2"]);
  });

  it("drain forwards the collected child session id", async () => {
    const fed: Array<Record<string, unknown>> = [];
    await drainBackgroundTasks({
      state: stateWithRunning(["t1"]),
      registry: {
        collect: async () => ({ text: "done", childSessionId: "child-1" }),
      } as never,
      feed: (input) => { fed.push(input as unknown as Record<string, unknown>); },
    });
    const completion = fed.find((f) => f["type"] === "background_task_completed")!;
    expect(completion["childSessionId"]).toBe("child-1");
  });

  it("fails a task the resumed Runner has no handle for, instead of waiting", async () => {
    const fed: Array<Record<string, unknown>> = [];
    await drainBackgroundTasks({
      state: stateWithRunning(["ghost"]),
      // A rebuilt Runner: the registry knows nothing about the prior process.
      registry: { collect: async () => ({ error: "unknown task: ghost" }) } as never,
      feed: (input) => { fed.push(input as unknown as Record<string, unknown>); },
    });
    const completion = fed.find((f) => f["type"] === "background_task_completed")!;
    expect(completion["isError"]).toBe(true);
    expect(String(completion["text"])).toMatch(/ghost/);
  });

  it("does nothing when every task was already collected", async () => {
    const fed: unknown[] = [];
    const state = {
      backgroundTasks: [{ id: "t1", status: "collected" as const, startedAt: 0 }],
    } as unknown as AgentState;
    await drainBackgroundTasks({
      state,
      registry: { collect: async () => ({ text: "x" }) } as never,
      feed: (i) => { fed.push(i); },
    });
    expect(fed).toEqual([]);
  });

  it("skips a task the model already collected via task_output (no double-feed)", async () => {
    // Task 8 concern: task_output collection updates only the registry
    // cache, never state.backgroundTasks.status. Drain must not hand the
    // model the same result a second time.
    const fed: Array<{ type: string; taskId?: string }> = [];
    await drainBackgroundTasks({
      state: stateWithRunning(["t1"]),
      registry: {
        collect: async (id: string) => ({ text: `result-${id}` }),
        isCollected: (id: string) => id === "t1",
      } as never,
      feed: (input) => { fed.push(input as { type: string; taskId?: string }); },
    });
    expect(fed).toEqual([]);
  });

  it("normalizes an unexpected registry rejection into a failed completion", async () => {
    // Error isolation: a host-supplied collector that throws must fail the
    // task with an explanation, never take the turn down.
    const fed: Array<Record<string, unknown>> = [];
    await drainBackgroundTasks({
      state: stateWithRunning(["t1"]),
      registry: {
        collect: async () => { throw new Error("collector exploded"); },
      } as never,
      feed: (input) => { fed.push(input as unknown as Record<string, unknown>); },
    });
    const completion = fed.find((f) => f["type"] === "background_task_completed")!;
    expect(completion["isError"]).toBe(true);
    expect(String(completion["text"])).toContain("collector exploded");
  });
});

// ──────────────────────────────────────────────
// Runner loop integration: F-035 / F-036
// ──────────────────────────────────────────────

describe("runner turn-end drain integration", () => {
  it("F-035: reopens an ended turn to deliver an uncollected background task", async () => {
    const model = createMockModelPort([
      [modelDone("end_turn")],
      [textDelta("Integrated."), modelDone("end_turn")],
    ]);
    const registry = {
      collect: async (_id: string) => ({ text: "The result" }),
      isCollected: (_id: string) => false,
    };
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      backgroundRegistry: registry,
      initialState: {
        ...createInitialState(),
        backgroundTasks: [{ id: "t1", status: "running", startedAt: 0 }],
      },
    });

    const final = await runner.run({ type: "user_message", content: "go" });

    // The turn did not end after the first end_turn: the drain fed a
    // completion, the reducer reopened the turn, the model ran again.
    expect(model.callCount).toBe(2);
    expect(final.status).toBe("done");
    expect(final.backgroundTasks?.[0]?.status).toBe("collected");
    const notice = final.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[background task t1 finished]"),
    );
    expect(notice).toBeDefined();
    expect(String(notice!.content)).toContain("The result");
  });

  it("F-036: fails a resume-lost task with an explanation instead of hanging", async () => {
    const model = createMockModelPort([
      [modelDone("end_turn")],
      [textDelta("Understood, the task is gone."), modelDone("end_turn")],
    ]);
    // A rebuilt Runner after cross-process resume: empty registry, state
    // still carries the running task from the checkpoint.
    const registry = {
      collect: async (id: string) => ({ error: `unknown task: ${id}` }),
    };
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      backgroundRegistry: registry,
      initialState: {
        ...createInitialState(),
        backgroundTasks: [{ id: "ghost", status: "running", startedAt: 0 }],
      },
    });

    const final = await runner.run({ type: "user_message", content: "go" });

    // The turn did not deadlock: the failure was fed, the model ran once
    // more and ended the turn for real.
    expect(model.callCount).toBe(2);
    expect(final.status).toBe("done");
    expect(final.backgroundTasks?.[0]?.status).toBe("collected");
    const notice = final.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[background task ghost finished]"),
    );
    expect(notice).toBeDefined();
    expect(String(notice!.content)).toContain("unknown task: ghost");
  });

  it("ends the turn after one model call when the task was already collected via task_output", async () => {
    const model = createMockModelPort([[modelDone("end_turn")]]);
    const registry = {
      collect: async (id: string) => ({ text: `result-${id}` }),
      isCollected: (_id: string) => true,
    };
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      backgroundRegistry: registry,
      initialState: {
        ...createInitialState(),
        backgroundTasks: [{ id: "t1", status: "running", startedAt: 0 }],
      },
    });

    const final = await runner.run({ type: "user_message", content: "go" });

    // Drain skipped the already-collected task, fed nothing, and the turn
    // ended — exactly one model call, no duplicate notice message.
    expect(model.callCount).toBe(1);
    expect(final.status).toBe("done");
    expect(
      final.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("[background task"),
      ),
    ).toBe(false);
    // Known state-status gap (Task 8): task_output collection never flips
    // state — the stale "running" marker is locked in deliberately; it is
    // cleared by resetTurnForNextInput at the next turn boundary.
    expect(final.backgroundTasks?.[0]?.status).toBe("running");
  });
});
