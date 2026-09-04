import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  textDelta,
  modelDone,
} from "@volto/core";
import type { ToolDefinition, ToolResult, ModelPort, ModelEvent, ModelRequest, ApprovalGate, SessionStore, Message, TranscriptEventInput } from "@volto/core";
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
    it("records session_meta once at construction when chatStore and chatMeta are provided", async () => {
      const calls: Array<{ sessionId: string; event: TranscriptEventInput }> = [];
      const chatStore = {
        async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
          for (const event of events) calls.push({ sessionId, event });
        },
      };

      createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        chatStore,
        chatSessionId: "chat-s1",
        chatMeta: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
      });

      expect(calls).toEqual([
        {
          sessionId: "chat-s1",
          event: expect.objectContaining({
            type: "session_meta",
            data: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
          }),
        },
      ]);
    });

    it("does not record session_meta when chatMeta is omitted", async () => {
      const calls: unknown[] = [];
      const chatStore = {
        async appendEvents(...args: unknown[]) {
          calls.push(args);
        },
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

    it("records exactly one assistant_message per turn via the Runner, never replaying prior turns", async () => {
      const events: Array<{ sessionId: string; event: TranscriptEventInput }> = [];
      const chatStore = {
        async appendEvents(sessionId: string, batch: TranscriptEventInput[]) {
          for (const event of batch) events.push({ sessionId, event });
        },
      };

      const agent = createAgent({
        modelPort: createMockModelPort([textScript("first"), textScript("second")]),
        chatStore,
        chatSessionId: "chat-s1",
      });

      await agent.run("one");
      await agent.run("two");

      // The Runner records assistant_message as it happens — one per turn,
      // never a turn-end bulk replay that could duplicate a prior turn.
      const assistantMessages = events.filter((e) => e.event.type === "assistant_message");
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages.every((e) => e.sessionId === "chat-s1")).toBe(true);
    });

    it("does not emit events for seeded initialMessages (simulates a post-rebuild agent instance)", async () => {
      const events: TranscriptEventInput[] = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      };

      // Simulates apps/headless-server rebuilding an agent instance mid-conversation
      // (e.g. model/permission switch) and re-seeding the messages that were already
      // durably persisted to chatStore before the rebuild.
      const seededHistory: Message[] = [
        { role: "user", content: "earlier turn" },
        { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
      ];

      const agent = createAgent({
        modelPort: createMockModelPort([textScript("new reply")]),
        chatStore,
        chatSessionId: "chat-s1",
        initialMessages: seededHistory,
      });

      await agent.run("new turn");

      // Only the new turn's own input/output produce events — the seeded
      // initialMessages never get their own user_message/assistant_message.
      const userMessages = events.filter((e) => e.type === "user_message");
      const assistantMessages = events.filter((e) => e.type === "assistant_message");
      expect(userMessages).toHaveLength(1);
      expect((userMessages[0]!.data as { content: unknown }).content).toBe("new turn");
      expect(assistantMessages).toHaveLength(1);
    });

    it("does not double-count the seed when both systemPrompt and initialMessages are set (off-by-one regression)", async () => {
      const events: TranscriptEventInput[] = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      };

      const msgA: Message = { role: "user", content: "earlier turn" };
      const msgB: Message = { role: "assistant", content: [{ type: "text", text: "earlier reply" }] };

      const agent = createAgent({
        modelPort: createMockModelPort([textScript("new reply")]),
        systemPrompt: "Be terse",
        chatStore,
        chatSessionId: "chat-s1",
        initialMessages: [msgA, msgB],
      });

      await agent.run("new turn");

      // Only the genuinely new turn's own events — never anything derived
      // from the synthesized system-prompt message or the seeded history.
      const userMessages = events.filter((e) => e.type === "user_message");
      const assistantMessages = events.filter((e) => e.type === "assistant_message");
      expect(userMessages).toHaveLength(1);
      expect(assistantMessages).toHaveLength(1);
    });

    it("records an error event (not a duplicate turn_end) when a Runner exists and run() rejects", async () => {
      const events: Array<{ sessionId: string; event: TranscriptEventInput }> = [];
      const chatStore = {
        async appendEvents(sessionId: string, batch: TranscriptEventInput[]) {
          for (const event of batch) events.push({ sessionId, event });
        },
      };
      // A modelPort that throws is normalized by the runner into a reducer
      // "model_error" input (see stream-early-break.test.ts) and does NOT
      // reject runner.run() — that's the documented, tested behavior of this
      // codebase's error-handling architecture ("errors never interrupt the
      // main loop"). To exercise the actual reject path where a Runner
      // exists but its own run() call rejects, we use a session:start hook
      // that throws — hook handler exceptions propagate straight out of
      // runner.run().
      const agent = createAgent({
        modelPort: createMockModelPort([textScript("unreachable")]),
        chatStore,
        chatSessionId: "chat-s1",
        hooks: [
          {
            name: "boom-hook",
            lifecycle: "session:start",
            handler: async () => {
              throw new Error("boom");
            },
          },
        ],
      });

      await expect(agent.run("hi")).rejects.toThrow("boom");

      // The Runner's own try/finally already closed this turn with its own
      // turn_end (no error text) — exactly one, never a second one carrying
      // the error text, which would be a duplicate turn-close event.
      const turnEnds = events.filter((e) => e.event.type === "turn_end");
      expect(turnEnds).toHaveLength(1);
      expect((turnEnds[0]!.event.data as { error?: string }).error).toBeUndefined();

      const errorEvent = events.find((e) => e.event.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.sessionId).toBe("chat-s1");
      expect((errorEvent!.event.data as { message: string }).message).toContain("boom");
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

    it("resume()'s cross-process fallback (lastRunner.resume() throwing) writes the resumed turn's events to chatStore", async () => {
      // Same shape as the previous test (a gate that never resolves in-process,
      // forcing the fallback branch), but this time chatStore/chatSessionId are
      // wired so we can assert the resumed turn's tool_result and closing
      // assistant_message actually reach the durable log — the fallback
      // Runner used to be constructed without chatStore/chatSessionId/turn/
      // clock at all, so none of this ever got written.
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

      const modelPort = createMockModelPort([
        toolCallScript("c1", "dangerous_op", "{}"),
        textScript("resumed after approval"),
      ]);

      const gate: ApprovalGate = {
        ask: () => new Promise<"allow" | "deny">(() => {}),
      };

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

      const events: TranscriptEventInput[] = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      };

      const agent = createAgent({
        modelPort,
        tools: [dangerousTool],
        capabilities: new Set(["test:danger"]),
        approvalGate: gate,
        sessionStore: flakyStore,
        chatStore,
        chatSessionId: "chat-s1",
        permissionConfig: {
          defaults: {
            READ_ONLY: "allow",
            WRITE_LOW: "allow",
            WRITE_HIGH: "ask",
            IRREVERSIBLE: "deny",
          },
        },
      });

      const runPromise = agent.run("do it");
      await new Promise((r) => setTimeout(r, 30));

      const saved = await innerStore.list();
      const sessionId = saved[0]!.id;

      const finalState = await agent.resume(sessionId, "allow");
      expect(finalState.status).toBe("done");
      expect(loadCallCount).toBeGreaterThanOrEqual(2); // fallback branch actually exercised

      // The approved tool's result and the closing assistant_message must
      // both have reached the store — a log missing either leaves an
      // assistant_message with stopReason "tool_use" and no matching
      // tool_result, which providers reject outright as the seed for the
      // next turn.
      const toolResults = events.filter((e) => e.type === "tool_result");
      const assistantMessages = events.filter((e) => e.type === "assistant_message");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
      expect(
        assistantMessages.some((e) =>
          (e.data as { content: Array<{ type: string; text?: string }> }).content.some(
            (c) => c.type === "text" && c.text === "resumed after approval",
          ),
        ),
      ).toBe(true);

      // All events belong to the turn that was originally claimed when
      // agent.run() started it — resuming must not consume a fresh turn
      // number.
      const turns = new Set(events.map((e) => e.turn));
      expect(turns).toEqual(new Set([1]));

      void runPromise;
    });
  });

  describe("sub-agent event forwarding", () => {
    it("forwards sub-agent events to the eventSink actually used for the current turn, not a construction-time-only one", async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      let callCount = 0;
      const modelPort: ModelPort = {
        async *stream(): AsyncGenerator<ModelEvent> {
          callCount++;
          if (callCount === 1) {
            // Parent turn: call the task tool.
            yield { type: "tool_use_start", toolCallId: "t1", toolName: "task" };
            yield { type: "tool_use_delta", toolCallId: "t1", argumentsDelta: JSON.stringify({ message: "sub task" }) };
            yield { type: "done", stopReason: "tool_use" };
          } else if (callCount === 2) {
            // Sub-agent's own turn.
            yield { type: "text_delta", text: "sub done" };
            yield { type: "done", stopReason: "end_turn" };
          } else {
            // Parent turn resumes after the tool result.
            yield { type: "text_delta", text: "parent done" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      };

      const agent = createAgent({
        modelPort,
        enableTaskTool: true,
        // No top-level eventSink here on purpose — this is exactly the shape
        // apps/headless-server's wiring uses, which reproduces the bug.
      });

      for await (const event of agent.stream("please delegate")) {
        events.push(event);
      }

      expect(events.some((e) => e.type === "text_delta" && e.data["agentDepth"] === 1)).toBe(true);
    });
  });
});
