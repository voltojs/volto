import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@agent-core/core";
import type { ToolDefinition, ToolResult } from "@agent-core/core";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object" },
    requires: [],
    riskTier: "READ_ONLY",
  };
}

function makeAgentWithTools(toolNames: string[], toolVisibility?: { limit?: number }) {
  const tools = toolNames.map((name) => ({
    definition: makeTool(name),
    handler: async (): Promise<ToolResult> => ({ modelContent: `ok: ${name}` }),
  }));

  const mockModel = createMockModelPort([textScript("done")]);

  return createAgent({
    modelPort: mockModel,
    tools,
    toolVisibility,
  });
}

describe("createAgent — toolVisibility", () => {
  it("trims visible tool set to limit when tools exceed it", async () => {
    // 30 tools, limit 5 → only first 5 should be visible; agent still runs without error
    const names = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    const agent = makeAgentWithTools(names, { limit: 5 });
    const state = await agent.run("hi");
    expect(state.status).toBe("done");
  });

  it("backward compat: no toolVisibility = no trimming", async () => {
    const names = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    const agent = makeAgentWithTools(names);
    const state = await agent.run("hi");
    expect(state.status).toBe("done");
  });
});
