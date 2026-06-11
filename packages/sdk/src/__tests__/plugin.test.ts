import { describe, it, expect } from "vitest";
import {
  collectPlugins,
  createPluginToolSource,
  createPluginRegistry,
  type Plugin,
  type PluginRegistry,
} from "../plugin.js";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@agent-core/core";
import type { ToolDefinition, ToolResult } from "@agent-core/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const echoToolDef: ToolDefinition = {
  name: "echo",
  description: "Echo back the input",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

function createEchoTool() {
  return {
    definition: echoToolDef,
    handler: async (input: Record<string, unknown>): Promise<ToolResult> => ({
      modelContent: `echo: ${String(input["message"])}`,
    }),
  };
}

const helloToolDef: ToolDefinition = {
  name: "hello",
  description: "Say hello",
  inputSchema: { type: "object", properties: {} },
  requires: ["greet:say"],
  riskTier: "READ_ONLY",
};

function createHelloTool() {
  return {
    definition: helloToolDef,
    handler: async (): Promise<ToolResult> => ({
      modelContent: "Hello from plugin!",
    }),
  };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("collectPlugins", () => {
  it("collects tools from a single plugin", () => {
    const plugin: Plugin = {
      name: "echo-plugin",
      register(registry: PluginRegistry) {
        registry.addTool(createEchoTool());
      },
    };

    const collected = collectPlugins([plugin]);
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0]!.definition.name).toBe("echo");
  });

  it("last write wins on duplicate tool name", () => {
    const pluginA: Plugin = {
      name: "a",
      register(r) {
        r.addTool({
          definition: { ...echoToolDef, description: "v1" },
          handler: async () => ({ modelContent: "v1" }),
        });
      },
    };
    const pluginB: Plugin = {
      name: "b",
      register(r) {
        r.addTool({
          definition: { ...echoToolDef, description: "v2" },
          handler: async () => ({ modelContent: "v2" }),
        });
      },
    };

    const collected = collectPlugins([pluginA, pluginB]);
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0]!.definition.description).toBe("v2");
  });

  it("collects providers by name", () => {
    const provider = { name: "openai" };
    const plugin: Plugin = {
      name: "provider-plugin",
      register(r) {
        r.addProvider("openai", provider);
      },
    };

    const collected = collectPlugins([plugin]);
    expect(collected.providers.get("openai")).toBe(provider);
  });

  it("collects hooks (append-only)", () => {
    const plugin: Plugin = {
      name: "hook-plugin",
      register(r) {
        r.addHook({ name: "log", lifecycle: "preToolUse", handler: () => {} });
        r.addHook({ name: "audit", lifecycle: "postToolUse", handler: () => {} });
      },
    };

    const collected = collectPlugins([plugin]);
    expect(collected.hooks).toHaveLength(2);
    expect(collected.hooks[0]!.name).toBe("log");
    expect(collected.hooks[1]!.name).toBe("audit");
  });

  it("collects commands and skills", () => {
    const plugin: Plugin = {
      name: "dx-plugin",
      register(r) {
        r.addCommand({ name: "greet", template: "Hello {{name}}!" });
        r.addSkill({ name: "code-review", description: "Review code" });
      },
    };

    const collected = collectPlugins([plugin]);
    expect(collected.commands).toHaveLength(1);
    expect(collected.skills).toHaveLength(1);
  });

  it("collects agent specs", () => {
    const plugin: Plugin = {
      name: "agent-plugin",
      register(r) {
        r.addAgentSpec({ name: "reviewer", systemPrompt: "You review code." });
      },
    };

    const collected = collectPlugins([plugin]);
    expect(collected.agentSpecs).toHaveLength(1);
    expect(collected.agentSpecs[0]!.name).toBe("reviewer");
  });

  it("empty plugins list yields empty collected", () => {
    const collected = collectPlugins([]);
    expect(collected.tools).toHaveLength(0);
    expect(collected.providers.size).toBe(0);
    expect(collected.hooks).toHaveLength(0);
  });
});

describe("createPluginToolSource", () => {
  it("lists tool definitions from plugin tools", async () => {
    const tools = [createEchoTool(), createHelloTool()];
    const source = createPluginToolSource(tools);

    const defs = await source.list();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toEqual(["echo", "hello"]);
  });

  it("getTool returns the tool by name", () => {
    const tools = [createEchoTool()];
    const source = createPluginToolSource(tools);

    expect(source.getTool("echo")).toBeDefined();
    expect(source.getTool("nonexistent")).toBeUndefined();
  });
});

describe("createPluginRegistry", () => {
  it("addTool dedupes by name", () => {
    const { registry, collected } = createPluginRegistry();
    registry.addTool({
      definition: { ...echoToolDef, description: "v1" },
      handler: async () => ({ modelContent: "v1" }),
    });
    registry.addTool({
      definition: { ...echoToolDef, description: "v2" },
      handler: async () => ({ modelContent: "v2" }),
    });

    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0]!.definition.description).toBe("v2");
  });
});

describe("createAgent with plugins (M13)", () => {
  it("plugin-registered tool is visible and callable via model", async () => {
    const plugin: Plugin = {
      name: "echo-plugin",
      register(r) {
        r.addTool(createEchoTool());
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"from plugin"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      plugins: [plugin],
      capabilities: new Set(["test:echo"]),
    });

    const state = await agent.run("echo from plugin");
    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
    // user, assistant(tool_use), tool_result, assistant(text)
    expect(state.messages).toHaveLength(4);
    const toolResult = state.messages[2] as unknown as { content: Array<{ content: string }> };
    expect(toolResult.content[0]!.content).toContain("from plugin");
  });

  it("plugin tool missing capability is gated out", async () => {
    const plugin: Plugin = {
      name: "gated-plugin",
      register(r) {
        r.addTool(createHelloTool()); // requires "greet:say" — not in capabilities
      },
    };

    const mockModel = createMockModelPort([textScript("no tools")]);

    const agent = createAgent({
      modelPort: mockModel,
      plugins: [plugin],
      // Note: capabilities does NOT include "greet:say"
    });

    const state = await agent.run("say hello");
    expect(state.status).toBe("done");
    // Model sees no tools (gated out), returns plain text
    expect(mockModel.callCount).toBe(1);
  });

  it("multiple plugins register tools that coexist", async () => {
    const pluginA: Plugin = {
      name: "a",
      register(r) { r.addTool(createEchoTool()); },
    };
    const pluginB: Plugin = {
      name: "b",
      register(r) { r.addTool(createHelloTool()); },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"hi"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      plugins: [pluginA, pluginB],
      capabilities: new Set(["test:echo", "greet:say"]),
    });

    const state = await agent.run("echo hi");
    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
  });

  it("backward compat — no plugins, createAgent works as before", async () => {
    const mockModel = createMockModelPort([textScript("no plugins")]);
    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("hello");
    expect(state.status).toBe("done");
  });
});
