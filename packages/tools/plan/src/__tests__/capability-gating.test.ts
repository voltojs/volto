import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@volto/core";
import { filterVisibleTools } from "@volto/core";
import { createTodoWriteTool, CAP_PLAN_WRITE } from "../index.js";

describe("plan capability gating", () => {
  it("todo_write tool is visible when plan:write capability is present", () => {
    const tool = createTodoWriteTool();
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set([CAP_PLAN_WRITE]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe("todo_write");
  });

  it("todo_write tool is hidden when plan:write capability is absent", () => {
    const tool = createTodoWriteTool();
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set(["filesystem:read", "shell:exec"]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(0);
  });
});
