import { describe, it, expect } from "vitest";
import { createScheduleTool, createCancelScheduleTool, SCHEDULE_TOOL_NAMES } from "../index.js";
import type { Scheduler } from "@volto/core";

function createMockScheduler(): Scheduler {
  let counter = 0;
  const scheduled = new Map<string, { ref: string; delayMs: number }>();
  return {
    async schedule(delayMs: number, ref: string): Promise<string> {
      const id = `mock-sched-${counter++}`;
      scheduled.set(id, { ref, delayMs });
      return id;
    },
    async cancel(id: string): Promise<boolean> {
      return scheduled.delete(id);
    },
    async sleep(): Promise<void> {},
  };
}

describe("createScheduleTool", () => {
  it("has correct tool definition", () => {
    const tool = createScheduleTool(createMockScheduler());
    expect(tool.definition.name).toBe("schedule_task");
    expect(tool.definition.riskTier).toBe("WRITE_LOW");
    expect(tool.definition.requires).toContain("scheduler:exec");
  });

  it("schedule returns task id on success", async () => {
    const tool = createScheduleTool(createMockScheduler());
    const result = await tool.handler({ delay_ms: 1000, ref: "wake-up" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("mock-sched-0");
    expect(result.modelContent).toContain("wake-up");
    expect(result.displayMetadata?.taskId).toBe("mock-sched-0");
  });

  it("schedule returns error for invalid delay", async () => {
    const tool = createScheduleTool(createMockScheduler());
    const result = await tool.handler({ delay_ms: -1, ref: "test" });
    expect(result.isError).toBe(true);
  });

  it("schedule returns error for delay too large", async () => {
    const tool = createScheduleTool(createMockScheduler());
    const result = await tool.handler({ delay_ms: 999_999_999, ref: "test" });
    expect(result.isError).toBe(true);
  });
});

describe("createCancelScheduleTool", () => {
  it("has correct tool definition", () => {
    const tool = createCancelScheduleTool(createMockScheduler());
    expect(tool.definition.name).toBe("cancel_task");
    expect(tool.definition.riskTier).toBe("READ_ONLY");
  });

  it("cancel returns success for existing task", async () => {
    const scheduler = createMockScheduler();
    const scheduleTool = createScheduleTool(scheduler);
    const scheduleResult = await scheduleTool.handler({ delay_ms: 1000, ref: "ref" });
    const taskId = scheduleResult.displayMetadata?.taskId as string;

    const cancelTool = createCancelScheduleTool(scheduler);
    const result = await cancelTool.handler({ task_id: taskId });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("cancelled");
  });

  it("cancel returns not-found for unknown task", async () => {
    const tool = createCancelScheduleTool(createMockScheduler());
    const result = await tool.handler({ task_id: "nonexistent" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("not found");
  });
});

describe("SCHEDULE_TOOL_NAMES", () => {
  it("includes both tools", () => {
    expect(SCHEDULE_TOOL_NAMES.has("schedule_task")).toBe(true);
    expect(SCHEDULE_TOOL_NAMES.has("cancel_task")).toBe(true);
    expect(SCHEDULE_TOOL_NAMES.size).toBe(2);
  });
});
