import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  textDelta,
  modelDone,
} from "@volto/core";
import type { ToolDefinition, ToolResult, ModelPort, ModelRequest, ApprovalGate, SessionStore } from "@volto/core";
import { createMemoryStore } from "@volto/store-memory";
import { mergeConfig } from "../config.js";
import type { ResolvedConfig } from "../config.js";
import type { Tool } from "@volto/tools-common";

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

  describe("with chat store", () => {
    it("calls appendMeta once at construction when chatStore and chatMeta are provided", async () => {
      const calls: Array<{ sessionId: string; meta: unknown }> = [];
      const chatStore = {
        async appendMeta(sessionId: string, meta: unknown) {
          calls.push({ sessionId, meta });
        },
        async appendMessages() {},
        async appendError() {},
        async appendTrajectoryEntry() {},
      };

      createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        chatStore,
        chatSessionId: "chat-s1",
        chatMeta: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
      });

      expect(calls).toEqual([
        { sessionId: "chat-s1", meta: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" } },
      ]);
    });

    it("does not call appendMeta when chatMeta is omitted", async () => {
      const calls: unknown[] = [];
      const chatStore = {
        async appendMeta(...args: unknown[]) {
          calls.push(args);
        },
        async appendMessages() {},
        async appendError() {},
        async appendTrajectoryEntry() {},
      };

      createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        chatStore,
        chatSessionId: "chat-s1",
      });

      expect(calls).toEqual([]);
    });

    it("accepts createAgent without a chatStore, unchanged behavior", async () => {
      const mockModel = createMockModelPort([textScript("ok")]);
      const agent = createAgent({ modelPort: mockModel });

      const state = await agent.run("hi");
      expect(state.status).toBe("done");
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

    it("preserves prior turn state when resolveContextLayers rejects, so a retry still carries forward history", async () => {
      const mockModel = createMockModelPort([
        textScript("First reply"),
        textScript("Second reply"),
      ]);

      let callCount = 0;
      const agent = createAgent({
        modelPort: mockModel,
        resolveContextLayers: async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error("resolveContextLayers failed");
          }
          return [];
        },
      });

      const state1 = await agent.run("Turn 1");
      expect(state1.messages).toHaveLength(2);

      await expect(agent.run("Turn 2 (fails)")).rejects.toThrow("resolveContextLayers failed");

      const state2 = await agent.run("Turn 2 (retry)");
      expect(state2.messages).toHaveLength(4);
      expect(state2.messages[3]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Second reply" }],
      });
    });

    it("resume()'s fallback branch (lastRunner.resume() throwing) still carries the turn's resolved contextLayers", async () => {
      const dangerousToolDef: ToolDefinition = {
        name: "dangerous_op",
        description: "A tool gated by HITL approval",
        inputSchema: { type: "object", properties: {}, required: [] },
        requires: ["test:danger"],
        riskTier: "WRITE_HIGH",
      };
      const dangerousTool: Tool = {
        definition: dangerousToolDef,
        handler: async (): Promise<ToolResult> => ({ modelContent: "operation completed" }),
      };

      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([
        toolCallScript("c1", "dangerous_op", "{}"),
        textScript("resumed after approval"),
      ]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      // Gate that never resolves — forces the runner to park in
      // waiting_for_approval so a checkpoint gets persisted.
      const gate: ApprovalGate = {
        ask: () => new Promise<"allow" | "deny">(() => {}),
      };

      // Wraps a real store but makes the FIRST load() call throw, simulating
      // a transient failure inside lastRunner.resume() (which loads the
      // checkpoint via the same sessionStore). The SDK's own fallback load()
      // call (the second one) succeeds normally.
      const innerStore = createMemoryStore();
      let loadCallCount = 0;
      const flakyStore: SessionStore = {
        save: (snapshot) => innerStore.save(snapshot),
        load: async (id: string) => {
          loadCallCount++;
          if (loadCallCount === 1) throw new Error("simulated transient store failure");
          return innerStore.load(id);
        },
        list: () => innerStore.list(),
      };

      const agent = createAgent({
        modelPort,
        tools: [dangerousTool],
        capabilities: new Set(["test:danger"]),
        approvalGate: gate,
        sessionStore: flakyStore,
        resolveContextLayers: async () => [{ id: "user-memory", text: "LAYER MARKER TEXT" }],
        permissionConfig: {
          defaults: {
            READ_ONLY: "allow",
            WRITE_LOW: "allow",
            WRITE_HIGH: "ask",
            IRREVERSIBLE: "deny",
          },
        },
      });

      // Fire the turn but don't await — the runner parks in
      // waiting_for_approval because the gate never resolves.
      const runPromise = agent.run("do it");
      await new Promise((r) => setTimeout(r, 30));

      const saved = await innerStore.list();
      expect(saved.length).toBeGreaterThanOrEqual(1);
      const sessionId = saved[0]!.id;

      const finalState = await agent.resume(sessionId, "allow");
      expect(finalState.status).toBe("done");
      // Fallback branch was actually exercised (load() called at least twice:
      // once (throwing) inside lastRunner.resume(), once inside the SDK's
      // own fallback).
      expect(loadCallCount).toBeGreaterThanOrEqual(2);

      // The rebuilt fallback runner's model request must still include the
      // turn's resolved context layer as a system message.
      const lastRequest = capturedRequests[capturedRequests.length - 1]!;
      const systemMessages = lastRequest.messages.filter((m) => m.role === "system");
      expect(systemMessages.some((m) => (m as { content: string }).content === "LAYER MARKER TEXT")).toBe(true);

      void runPromise;
    });
  });
});
