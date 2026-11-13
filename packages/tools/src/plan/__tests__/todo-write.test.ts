import { describe, it, expect } from "vitest";
import { filterVisibleTools, resolvePermission } from "@voltojs/core";
import { createTodoWriteTool, CAP_PLAN_WRITE } from "../index.js";

describe("todo_write tool", () => {
  const tool = createTodoWriteTool();

  it("definition requires plan:write, is READ_ONLY and declared as session state", () => {
    expect(tool.definition.name).toBe("todo_write");
    expect(tool.definition.requires).toEqual([CAP_PLAN_WRITE]);
    // The todo list is agent-owned state, not a workspace file: a read-only /
    // plan session must keep it, so the sandbox ceiling may not grade it as a
    // workspace write.
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.writesSessionState).toBe(true);
  });

  it("stays visible and allowed under a read-only/plan ceiling", () => {
    const caps = new Set([CAP_PLAN_WRITE]);
    const visible = filterVisibleTools([tool.definition], caps, "READ_ONLY");
    expect(visible.map((t) => t.name)).toEqual(["todo_write"]);

    const { decision } = resolvePermission(
      { sandbox: "read-only", approval: "never" },
      tool.definition.name,
      tool.definition.riskTier,
      new Set(tool.definition.requires),
    );
    expect(decision).toBe("allow");
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
