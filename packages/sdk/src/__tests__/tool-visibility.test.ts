import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@voltojs/core";
import type { ToolDefinition, ToolResult } from "@voltojs/core";

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

  it("default (no toolVisibility) still runs the agent with no configuration", async () => {
    // Renamed from "backward compat: no toolVisibility = no trimming": T3
    // toolset governance removed the unbounded default — the visible set is
    // now capped at 20 with the synthesized floor table (pinned in
    // tool-visibility-default.test.ts). What this pin keeps is the original
    // intent: no configuration is needed for the agent to run.
    const names = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    const agent = makeAgentWithTools(names);
    const state = await agent.run("hi");
    expect(state.status).toBe("done");
  });
});
