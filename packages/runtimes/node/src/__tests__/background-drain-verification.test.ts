import { describe, it, expect } from "vitest";
import { drainBackgroundTasks } from "../runner.js";
import { createInitialState } from "@voltojs/core";

// The drain path is where the model never called task_output: a failed
// acceptance verdict must not arrive as an ordinary completion. The notice
// format itself is pinned by core's renderVerificationNotice (Task 2).
describe("drain verification notice", () => {
  it("prefixes the completion notice and marks a rejected task as an error", async () => {
    const fed: unknown[] = [];
    await drainBackgroundTasks({
      state: { ...createInitialState(), backgroundTasks: [{ id: "t1", status: "running" }] } as never,
      registry: {
        async collect() {
          return { text: "child output", rejected: true,
            verification: { status: "failed", attempts: 2, failures: ["no tests"] } };
        },
      },
      feed: (input) => fed.push(input),
    });
    expect(fed).toEqual([{
      type: "background_task_completed", taskId: "t1", text: "[verification: failed after 2 attempts] no tests\nchild output", isError: true,
    }]);
  });

  it("keeps a passed task successful but still states the verdict", async () => {
    const fed: unknown[] = [];
    await drainBackgroundTasks({
      state: { ...createInitialState(), backgroundTasks: [{ id: "t1", status: "running" }] } as never,
      registry: {
        async collect() {
          return { text: "child output",
            verification: { status: "passed", attempts: 1, failures: [] } };
        },
      },
      feed: (input) => fed.push(input),
    });
    expect(fed).toEqual([
      {
        type: "background_task_completed",
        taskId: "t1",
        text: "[verification: passed]\nchild output",
      },
    ]);
  });
});
