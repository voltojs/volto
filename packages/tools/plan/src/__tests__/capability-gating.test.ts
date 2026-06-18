import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@volto/core";
import { filterVisibleTools } from "@volto/core";
import { createWriteTodosTool, CAP_PLAN_WRITE } from "../index.js";

describe("plan capability gating", () => {
  it("write_todos tool is visible when plan:write capability is present", () => {
    const tool = createWriteTodosTool();
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set([CAP_PLAN_WRITE]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe("write_todos");
  });

  it("write_todos tool is hidden when plan:write capability is absent", () => {
    const tool = createWriteTodosTool();
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set(["filesystem:read", "shell:exec"]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(0);
  });
});
