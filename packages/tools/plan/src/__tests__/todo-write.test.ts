import { describe, it, expect } from "vitest";
import { createTodoWriteTool, CAP_PLAN_WRITE } from "../index.js";

describe("todo_write tool", () => {
  const tool = createTodoWriteTool();

  it("definition requires plan:write and WRITE_LOW", () => {
    expect(tool.definition.name).toBe("todo_write");
    expect(tool.definition.requires).toEqual([CAP_PLAN_WRITE]);
    expect(tool.definition.riskTier).toBe("WRITE_LOW");
  });

  it("success returns counts, statePatch, and no pendingEvents", async () => {
    const todos = [
      { content: "step one", status: "in_progress" as const },
      { content: "step two", status: "pending" as const },
    ];
    const result = await tool.handler({ todos });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe(
      "Updated todo list: 1 pending, 1 in progress, 0 completed.",
    );
    expect(result.statePatch?.todos).toEqual(todos);
    expect(result.displayMetadata?.["pendingEvents"]).toBeUndefined();
  });

  it("rejects empty content", async () => {
    const result = await tool.handler({ todos: [{ content: "  ", status: "pending" }] });
    expect(result.isError).toBe(true);
    expect(result.statePatch).toBeUndefined();
  });

  it("rejects duplicate content", async () => {
    const result = await tool.handler({
      todos: [
        { content: "same", status: "pending" },
        { content: "same", status: "completed" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.statePatch).toBeUndefined();
  });

  it("enforces maxInProgress when configured", async () => {
    const strict = createTodoWriteTool({ maxInProgress: 1 });
    const result = await strict.handler({
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.statePatch).toBeUndefined();
  });

  it("allows empty list clear", async () => {
    const result = await tool.handler({ todos: [] });
    expect(result.isError).toBeFalsy();
    expect(result.statePatch?.todos).toEqual([]);
    expect(result.modelContent).toBe(
      "Updated todo list: 0 pending, 0 in progress, 0 completed.",
    );
  });
});
