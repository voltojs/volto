import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@agent-core/core";
import { filterVisibleTools } from "@agent-core/core";
import { createBashTool, CAP_SHELL_EXEC } from "../index.js";

describe("shell capability gating", () => {
  it("bash tool is visible when shell:exec capability is present", () => {
    const bashTool = createBashTool({ async *exec() { yield { type: "exit", code: 0 }; } });
    const tools: ToolDefinition[] = [bashTool.definition];
    const caps = new Set([CAP_SHELL_EXEC]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe("bash");
  });

  it("bash tool is hidden when shell:exec capability is absent", () => {
    const bashTool = createBashTool({ async *exec() { yield { type: "exit", code: 0 }; } });
    const tools: ToolDefinition[] = [bashTool.definition];
    const caps = new Set(["filesystem:read"]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(0);
  });

  it("bash tool is hidden when capabilities set is empty", () => {
    const bashTool = createBashTool({ async *exec() { yield { type: "exit", code: 0 }; } });
    const tools: ToolDefinition[] = [bashTool.definition];
    const visible = filterVisibleTools(tools, new Set());
    expect(visible).toHaveLength(0);
  });
});
