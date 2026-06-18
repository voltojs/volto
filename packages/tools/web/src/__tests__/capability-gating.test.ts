import { describe, it, expect } from "vitest";
import type { Network, ToolDefinition } from "@volto/core";
import { filterVisibleTools } from "@volto/core";
import { createWebFetchTool, CAP_NETWORK_FETCH } from "../index.js";

const stubNetwork: Network = {
  async fetch() { return { status: 200, headers: {}, body: "" }; },
};

describe("web capability gating", () => {
  it("web_fetch tool is visible when network:fetch capability is present", () => {
    const tool = createWebFetchTool(stubNetwork);
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set([CAP_NETWORK_FETCH]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe("web_fetch");
  });

  it("web_fetch tool is hidden when network:fetch capability is absent", () => {
    const tool = createWebFetchTool(stubNetwork);
    const tools: ToolDefinition[] = [tool.definition];
    const caps = new Set(["filesystem:read"]);
    const visible = filterVisibleTools(tools, caps);
    expect(visible).toHaveLength(0);
  });
});
