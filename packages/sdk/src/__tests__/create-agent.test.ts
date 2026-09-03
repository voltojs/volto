import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  textDelta,
  modelDone,
} from "@volto/core";
import type { ToolDefinition, ToolResult, ModelPort, ModelRequest } from "@volto/core";
import { createMemoryStore } from "@volto/store-memory";
import { mergeConfig } from "../config.js";
import type { ResolvedConfig } from "../config.js";

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

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("createAgent — SDK facade", () => {
  describe("minimal config (only modelPort)", () => {
    it("should start a pure conversation agent and complete one turn", async () => {
      const mockModel = createMockModelPort([
        textScript("Hello from the agent!"),
      ]);

      const agent = createAgent({
        modelPort: mockModel,
      });

      const state = await agent.run("Hi there");

      expect(state.status).toBe("done");
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0]).toMatchObject({ role: "user", content: "Hi there" });
      expect(state.messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Hello from the agent!" }],
      });
    });

    it("should support multiple turns (state carries over)", async () => {
      const mockModel = createMockModelPort([
        textScript("First reply"),
        textScript("Second reply"),
      ]);

      const agent = createAgent({ modelPort: mockModel });

      const state1 = await agent.run("Turn 1");
      expect(state1.messages).toHaveLength(2);

      const state2 = await agent.run("Turn 2");
      expect(state2.messages).toHaveLength(4);
      expect(state2.messages[3]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Second reply" }],
      });
    });
  });

  describe("with tools", () => {
    it("should route tool calls through the SDK", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "echo", '{"message":"hello"}'),
        textScript("Tool done"),
      ]);

      const agent = createAgent({
        modelPort: mockModel,
        tools: [createEchoTool()],
        capabilities: new Set(["test:echo"]),
      });

      const state = await agent.run("Echo hello");

      expect(state.status).toBe("done");
      expect(mockModel.callCount).toBe(2);
      // user, assistant(tool_use), tool_result, assistant(text)
      expect(state.messages).toHaveLength(4);
      expect(state.messages[2]).toMatchObject({ role: "tool" });
    });
  });

  describe("stream()", () => {
    it("should yield events as the runner processes them", async () => {
      const mockModel = createMockModelPort([
        [textDelta("Hello"), modelDone("end_turn")],
      ]);

      const agent = createAgent({ modelPort: mockModel });

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      for await (const event of agent.stream("Hi")) {
        events.push(event);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("text_delta");
      expect(types).toContain("model_done");
    });
  });

  describe("resume()", () => {
    it("should throw when no session exists in runner or store", async () => {
      const mockModel = createMockModelPort([textScript("ok")]);
      const agent = createAgent({ modelPort: mockModel });

      await expect(agent.resume("nonexistent", "allow")).rejects.toThrow("Session not found");
    });
  });

  describe("with permissionConfig", () => {
    it("should respect permission config for tool execution", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "echo", '{"message":"test"}'),
        textScript("done"),
      ]);

      const agent = createAgent({
        modelPort: mockModel,
        tools: [createEchoTool()],
        capabilities: new Set(["test:echo"]),
        permissionConfig: {
          defaults: {
            READ_ONLY: "allow",
            WRITE_LOW: "allow",
            WRITE_HIGH: "allow",
            IRREVERSIBLE: "allow",
          },
        },
      });

      const state = await agent.run("echo test");
      expect(state.status).toBe("done");
    });
  });

  describe("with session store", () => {
    it("should accept a session store without error", async () => {
      const mockModel = createMockModelPort([textScript("ok")]);
      const store = createMemoryStore();

      const agent = createAgent({
        modelPort: mockModel,
        sessionStore: store,
      });

      const state = await agent.run("hi");
      expect(state.status).toBe("done");
      // Session store is accepted; checkpoints are only saved during HITL approval
    });
  });

  describe("with layered config (M13)", () => {
    it("should use config layer values as defaults when opts omit them", async () => {
      const mockModel = createMockModelPort([textScript("config works")]);
      const config: ResolvedConfig = mergeConfig(
        { model: "gpt-4", maxTokens: 512, temperature: 0.3 },
      );

      const agent = createAgent({
        modelPort: mockModel,
        config,
      });

      const state = await agent.run("hello");
      expect(state.status).toBe("done");
    });

    it("explicit opts override config layer values", async () => {
      const mockModel = createMockModelPort([textScript("override works")]);
      const config: ResolvedConfig = mergeConfig(
        { model: "gpt-4", temperature: 0.3 },
      );

      const agent = createAgent({
        modelPort: mockModel,
        config,
        model: "gpt-4o", // explicit opts wins
        temperature: 0.9,
      });

      const state = await agent.run("hello");
      expect(state.status).toBe("done");
    });

    it("config capabilities are merged with adapter capabilities", async () => {
      const mockModel = createMockModelPort([
        toolCallScript("c1", "echo", '{"message":"hi"}'),
        textScript("done"),
      ]);
      const config: ResolvedConfig = mergeConfig({
        capabilities: ["test:echo"],
      });

      const agent = createAgent({
        modelPort: mockModel,
        config,
        tools: [createEchoTool()],
        // Note: no explicit capabilities — config provides "test:echo"
      });

      const state = await agent.run("echo hi");
      expect(state.status).toBe("done");
    });

    it("backward compat — no config, createAgent works as before", async () => {
      const mockModel = createMockModelPort([textScript("no config")]);
      const agent = createAgent({ modelPort: mockModel });
      const state = await agent.run("hello");
      expect(state.status).toBe("done");
    });
  });

  describe("resolveContextLayers", () => {
    it("passes resolveContextLayers' result into the turn's model request", async () => {
      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([textScript("ok")]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      const agent = createAgent({
        modelPort,
        resolveContextLayers: async (input) => [{ id: "test-layer", text: `layer for: ${input}` }],
      });

      await agent.run("hello");

      expect(capturedRequests).toHaveLength(1);
      const systemMessages = capturedRequests[0]!.messages.filter((m) => m.role === "system");
      expect(systemMessages.some((m) => (m as { content: string }).content === "layer for: hello")).toBe(true);
    });

    it("defaults contextLayers to empty when resolveContextLayers is not provided", async () => {
      const mockModel = createMockModelPort([textScript("ok")]);
      const agent = createAgent({ modelPort: mockModel });

      const state = await agent.run("hello");
      expect(state.status).toBe("done");
    });
  });
});
