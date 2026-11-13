import { describe, it, expect } from "vitest";
import { resolveAgentSpec, loadAgentSpec, type AgentSpec, type ToolRegistry } from "../agent-spec.js";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type { ToolDefinition, ToolResult } from "@voltojs/core";

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

function makeRegistry(...tools: ReturnType<typeof createEchoTool>[]): ToolRegistry {
  const reg = new Map<string, ReturnType<typeof createEchoTool>>();
  for (const t of tools) {
    reg.set(t.definition.name, t);
  }
  return reg;
}

// ──────────────────────────────────────────────
// resolveAgentSpec tests
// ──────────────────────────────────────────────

describe("resolveAgentSpec", () => {
  it("resolves tools by name from registry", () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = { name: "test", tools: ["echo"] };

    const resolved = resolveAgentSpec(spec, registry);
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0]!.definition.name).toBe("echo");
    expect(resolved.errors).toHaveLength(0);
  });

  it("carries reasoningEffort through into the resolved spec", () => {
    const registry = makeRegistry();
    const spec: AgentSpec = { name: "test", reasoningEffort: "high" };

    const resolved = resolveAgentSpec(spec, registry);
    expect(resolved.reasoningEffort).toBe("high");
  });

  it("reports unknown tools as errors (not thrown)", () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = { name: "test", tools: ["echo", "nonexistent"] };

    const resolved = resolveAgentSpec(spec, registry);
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0]).toContain("nonexistent");
  });

  it("empty tools array resolves to no tools, no errors", () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = { name: "test", tools: [] };

    const resolved = resolveAgentSpec(spec, registry);
    expect(resolved.tools).toHaveLength(0);
    expect(resolved.errors).toHaveLength(0);
  });

  it("capabilities from spec are included", () => {
    const spec: AgentSpec = { name: "test", capabilities: ["fs", "shell"] };
    const resolved = resolveAgentSpec(spec, new Map());
    expect(resolved.capabilities.has("fs")).toBe(true);
    expect(resolved.capabilities.has("shell")).toBe(true);
  });

  it("model settings are preserved", () => {
    const spec: AgentSpec = {
      name: "test",
      model: "gpt-4o",
      maxTokens: 2048,
      temperature: 0.3,
      maxIterations: 10,
      maxToolCalls: 5,
    };
    const resolved = resolveAgentSpec(spec, new Map());
    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.maxTokens).toBe(2048);
    expect(resolved.temperature).toBe(0.3);
    expect(resolved.maxIterations).toBe(10);
    expect(resolved.maxToolCalls).toBe(5);
  });

  it("permissionConfig from spec is preserved", () => {
    const policy = { sandbox: "workspace-write" as const, approval: "ask" as const };
    const spec: AgentSpec = { name: "test", policy };
    const resolved = resolveAgentSpec(spec, new Map());
    expect(resolved.permissionConfig).toBe(policy);
  });

  it("pure function — same inputs produce same output (snapshot)", () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = {
      name: "test",
      tools: ["echo"],
      capabilities: ["test:echo"],
      model: "gpt-4o",
      systemPrompt: "You are helpful.",
      enableTaskTool: true,
    };

    const r1 = resolveAgentSpec(spec, registry);
    const r2 = resolveAgentSpec(spec, registry);

    // Pure function check
    expect(r1.errors).toEqual(r2.errors);
    expect(r1.tools.length).toBe(r2.tools.length);
    expect(r1.model).toBe(r2.model);
    expect(r1.enableTaskTool).toBe(r2.enableTaskTool);

    // Snapshot
    expect(r1.errors).toMatchInlineSnapshot(`[]`);
    expect(r1.tools).toHaveLength(1);
    expect(r1.tools[0]!.definition.name).toBe("echo");
    expect(r1.model).toBe("gpt-4o");
    expect(r1.enableTaskTool).toBe(true);
  });

  it("spec is JSON-serializable round-trip", () => {
    const spec: AgentSpec = {
      name: "reviewer",
      systemPrompt: "You review code.",
      model: "gpt-4o",
      tools: ["echo"],
      capabilities: ["test:echo"],
      policy: { sandbox: "workspace-write", approval: "ask" },
      enableTaskTool: true,
      maxIterations: 15,
      responseFormat: { type: "json", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    };

    const serialized = JSON.stringify(spec);
    const deserialized: AgentSpec = JSON.parse(serialized);

    expect(deserialized.name).toBe("reviewer");
    expect(deserialized.tools).toEqual(["echo"]);
    expect(deserialized.policy).toEqual(spec.policy);
    expect(deserialized.responseFormat).toEqual(spec.responseFormat);
  });
});

// ──────────────────────────────────────────────
// loadAgentSpec integration tests
// ──────────────────────────────────────────────

describe("loadAgentSpec (M13)", () => {
  it("loads and runs a simple agent from spec", async () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = {
      name: "echo-agent",
      systemPrompt: "You echo.",
      tools: ["echo"],
      capabilities: ["test:echo"],
    };

    const mockModel = createMockModelPort([textScript("spec agent works")]);
    const agent = loadAgentSpec({
      spec,
      modelPort: mockModel,
      toolRegistry: registry,
    });

    const state = await agent.run("hello");
    expect(state.status).toBe("done");
    // messages: [system, user, assistant]
    const assistantMsg = state.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "spec agent works" }],
    });
  });

  it("spec-driven agent can use tools via model", async () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = {
      name: "tool-agent",
      tools: ["echo"],
      capabilities: ["test:echo"],
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"spec tool"}'),
      textScript("done"),
    ]);

    const agent = loadAgentSpec({
      spec,
      modelPort: mockModel,
      toolRegistry: registry,
    });

    const state = await agent.run("echo spec tool");
    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
  });

  it("unknown tools are silently skipped (not errors thrown)", async () => {
    const registry = makeRegistry(createEchoTool());
    const spec: AgentSpec = {
      name: "partial-agent",
      tools: ["echo", "nonexistent"],
      capabilities: ["test:echo"],
    };

    const mockModel = createMockModelPort([textScript("partial")]);
    const agent = loadAgentSpec({
      spec,
      modelPort: mockModel,
      toolRegistry: registry,
    });

    // No error thrown — unknown tool is just not loaded
    const state = await agent.run("hello");
    expect(state.status).toBe("done");
  });

  it("backward compat — existing createAgent path unchanged", async () => {
    const mockModel = createMockModelPort([textScript("legacy")]);
    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("hello");
    expect(state.status).toBe("done");
  });
});
