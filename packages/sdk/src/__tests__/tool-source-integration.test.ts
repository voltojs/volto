import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  UNTRUSTED_PREFIX,
} from "@agent-core/core";
import type { ToolSource, ToolDefinition, ToolResult } from "@agent-core/core";

/**
 * Mock ToolSource that returns predefined tools and simulates calling them.
 */
function createMockToolSource(defs: ToolDefinition[], handlers?: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>): ToolSource & { tools: ToolDefinition[] } {
  let _tools = [...defs];
  const listeners = new Set<() => void>();

  const source: ToolSource & { tools: ToolDefinition[] } = {
    tools: _tools,
    async list() { return [..._tools]; },
    onChange(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    // Helper to simulate tool set changes (for testing onChange)
    _setTools(newTools: ToolDefinition[]) {
      _tools = newTools;
      source.tools = newTools;
      for (const l of listeners) l();
    },
  } as ToolSource & { tools: ToolDefinition[]; _setTools: (t: ToolDefinition[]) => void };

  // Patch callTool to route through handlers
  (source as unknown as Record<string, unknown>).callTool = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    if (handlers?.[name]) return handlers[name]!(input);
    return { modelContent: `mock: ${name}`, displayMetadata: { source: "mock" } };
  };

  return source;
}

const greetDef: ToolDefinition = {
  name: "mcp__srv__greet",
  description: "Greet someone",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  requires: ["mcp:srv"],
  riskTier: "READ_ONLY",
  trust: "untrusted",
};

describe("createAgent — ToolSource integration", () => {
  describe("toolSources option", () => {
    it("merges ToolSource tools into the agent's tool set", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "mcp__srv__greet", '{"name":"Alice"}'),
        textScript("Hi Alice!"),
      ]);

      const source = createMockToolSource([greetDef]);

      const agent = createAgent({
        modelPort: mockModel,
        toolSources: [source],
        capabilities: new Set(["mcp:srv"]),
      });

      const state = await agent.run("Greet Alice");

      // Tool was called (2 model calls: tool_use + text)
      expect(state.status).toBe("done");
      expect(mockModel.callCount).toBe(2);
      // Tool result message present
      const toolMsg = state.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      const blocks = toolMsg?.content as Array<{ type: string; content: string }>;
      expect(blocks.some((b) => b.type === "tool_result" && b.content === `${UNTRUSTED_PREFIX}mock: mcp__srv__greet`)).toBe(true);
    });

    it("backward compat: no toolSources = same as before (no ToolSource tools)", async () => {
      const mockModel = createMockModelPort([textScript("Hello")]);

      const agent = createAgent({ modelPort: mockModel });
      const state = await agent.run("Hi");

      expect(state.status).toBe("done");
      expect(mockModel.callCount).toBe(1);
    });

    it("backward compat: legacy toolSource still works", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "mcp__srv__greet", '{"name":"Bob"}'),
        textScript("Hi Bob!"),
      ]);

      const source = createMockToolSource([greetDef]);

      const agent = createAgent({
        modelPort: mockModel,
        toolSource: source as unknown as ToolSource,
        capabilities: new Set(["mcp:srv"]),
      });

      const state = await agent.run("Greet Bob");
      expect(state.status).toBe("done");
      expect(mockModel.callCount).toBe(2);
    });

    it("returns isError (not throw) for unknown tool name", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "nonexistent_tool", "{}"),
        textScript("error handled"),
      ]);

      const agent = createAgent({ modelPort: mockModel });

      const state = await agent.run("Do something");
      expect(state.status).toBe("done");
      // Error should be in tool result, not thrown
      const toolMsg = state.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      const blocks = toolMsg?.content as Array<{ type: string; content: string }>;
      expect(blocks.some((b) => b.type === "tool_result" && b.content?.includes("Unknown tool"))).toBe(true);
    });
  });
});
