import { describe, it, expect, vi } from "vitest";
import { createWriteTodosTool, CAP_PLAN_WRITE } from "../index.js";
import type { EventSink } from "@agent-core/core";

describe("write_todos tool", () => {
  it("updates the todo list and returns formatted summary", async () => {
    const tool = createWriteTodosTool();
    const todos = [
      { id: "t1", content: "Implement feature", status: "completed" as const },
      { id: "t2", content: "Write tests", status: "in_progress" as const },
      { id: "t3", content: "Deploy", status: "pending" as const },
    ];
    const result = await tool.handler({ todos });
    expect(result.modelContent).toContain("[x] t1: Implement feature");
    expect(result.modelContent).toContain("[~] t2: Write tests");
    expect(result.modelContent).toContain("[ ] t3: Deploy");
    expect(result.modelContent).toContain("1/3 completed");
    expect(result.displayMetadata?.completedCount).toBe(1);
    expect(result.displayMetadata?.totalCount).toBe(3);
  });

  it("emits todoListUpdated event via EventSink", async () => {
    const emit = vi.fn();
    const eventSink: EventSink = { emit };
    const tool = createWriteTodosTool(eventSink);
    const todos = [{ id: "t1", content: "Task", status: "completed" as const }];
    await tool.handler({ todos });
    expect(emit).toHaveBeenCalledWith({
      type: "todoListUpdated",
      data: { todos },
    });
  });

  it("works without EventSink", async () => {
    const tool = createWriteTodosTool();
    const todos = [{ id: "t1", content: "Task", status: "pending" as const }];
    const result = await tool.handler({ todos });
    expect(result.isError).toBeFalsy();
  });

  it("definition requires plan:write and has WRITE_LOW risk", () => {
    const tool = createWriteTodosTool();
    expect(tool.definition.requires).toEqual([CAP_PLAN_WRITE]);
    expect(tool.definition.riskTier).toBe("WRITE_LOW");
  });
});
