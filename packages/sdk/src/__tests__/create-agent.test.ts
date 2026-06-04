import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  textDelta,
  modelDone,
} from "@agent-core/core";
import type { ToolDefinition, ToolResult } from "@agent-core/core";
import { createMemoryStore } from "@agent-core/store-memory";

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
    it("should throw when no session exists yet", async () => {
      const mockModel = createMockModelPort([textScript("ok")]);
      const agent = createAgent({ modelPort: mockModel });

      await expect(agent.resume("session-1", "allow")).rejects.toThrow("No active session");
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
});
