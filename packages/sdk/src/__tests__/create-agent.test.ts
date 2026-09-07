import { describe, it, expect } from "vitest";
import { createAgent, renderSkillCatalog } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
  textDelta,
  modelDone,
} from "@volto/core";
import type { ToolDefinition, ToolResult, ModelPort, ModelEvent, ModelRequest, ApprovalGate, SessionStore, Message, TranscriptEventInput, SkillRegistry } from "@volto/core";
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
    it("should yield transcript events and deltas as the runner processes them", async () => {
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
      // Task R6: the runner streams the transcript vocabulary it records —
      // assistant_message (with the recorded payload) and turn_end arrive on
      // the stream, while the raw reducer model_done is gone.
      expect(types).toContain("assistant_message");
      expect(types).toContain("turn_end");
      expect(types).not.toContain("model_done");

      const assistant = events.find((e) => e.type === "assistant_message")!;
      expect(assistant.data).toMatchObject({
        content: [{ type: "text", text: "Hello" }],
        stopReason: "end_turn",
        durationMs: expect.any(Number),
      });
      const turnEnd = events.find((e) => e.type === "turn_end")!;
      expect(turnEnd.data).toMatchObject({ turn: 1, reason: "done" });
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

    it("seeds turnCounter from initialTurn so a rebuilt agent's next turn continues numbering instead of restarting at 1", async () => {
      // Simulates apps/headless-server rebuilding an agent instance
      // mid-conversation: the durable transcript already has 5 completed
      // turns, so this fresh instance must record its first turn as 6, not 1.
      const events: TranscriptEventInput[] = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      };

      const agent = createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        chatStore,
        chatSessionId: "chat-s1",
        initialTurn: 5,
      });

      await agent.run("continue");

      const turnStart = events.find((e) => e.type === "turn_start");
      expect(turnStart).toBeDefined();
      expect(turnStart!.turn).toBe(6);
      expect((turnStart!.data as { turn: number }).turn).toBe(6);
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

    it("carries systemPrompt into request_header.systemLayers without duplicating it into the model request", async () => {
      const events: TranscriptEventInput[] = [];
      const chatStore = {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      };
      // Capture the actual ModelRequest so the test can prove the header
      // mirror is header-only: the context-layer route would make the
      // ContextAssembler emit a second system message per model call.
      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([textScript("Arrr!")]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      const agent = createAgent({
        modelPort,
        systemPrompt: "You are a pirate",
        chatStore,
        chatSessionId: "chat-s1",
      });

      const state = await agent.run("hi");

      // Seed behavior intact: the system prompt is still the first message
      // of the conversation state.
      expect(state.messages[0]).toMatchObject({ role: "system", content: "You are a pirate" });

      // Surfaced in the header via the runner's seedSystemPrompt option —
      // the only way request_header.systemLayers reflects the option.
      const header = events.find((e) => e.type === "request_header");
      expect(header).toBeDefined();
      const { systemLayers } = header!.data as { systemLayers: Array<{ id: string; text: string }> };
      expect(systemLayers).toContainEqual({ id: "system-prompt", text: "You are a pirate" });

      // But the model request carries the prompt exactly once — the seed
      // message — never twice (a duplicated layer message would be a
      // regression against the option's documented semantics).
      expect(capturedRequests).toHaveLength(1);
      const systemMessages = capturedRequests[0]!.messages.filter((m) => m.role === "system");
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]).toMatchObject({ role: "system", content: "You are a pirate" });
    });

    it("survives a chatStore whose appendEvents throws synchronously (a plain, non-async implementation)", async () => {
      // A plain (non-`async`) function that throws never produces a promise
      // for `.catch()` to attach to — `.catch()` on its return value would
      // never even be reached, since the throw happens before any value is
      // returned. `createAgent()`'s six best-effort chatStore writes
      // (construction-time session_meta, recordTurnEndError,
      // recordTurnError, and the three sub-agent bracket writes) must all
      // tolerate this: the store is a durable record, never a precondition
      // for running a turn. An `async` stub that rejects would NOT reproduce
      // this bug (the throw becomes a rejection, which `.catch()` already
      // handles fine) — the function must be genuinely synchronous.
      function throwingAppendEvents(): Promise<void> {
        throw new Error("synchronous store explosion");
      }
      const chatStore = { appendEvents: throwingAppendEvents };

      // Construction itself calls appendEvents (session_meta) synchronously
      // via the best-effort helper — this must not throw out of createAgent().
      const agent = createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        chatStore,
        chatSessionId: "chat-s1",
        chatMeta: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
      });

      // A normal turn must still complete — the Runner's own transcript
      // writes go through the same throwing store, but a turn is never
      // gated on the transcript succeeding.
      const state = await agent.run("hi");
      expect(state.status).toBe("done");
    });

    it("recordTurnEndError still surfaces the real rejection when the store throws synchronously", async () => {
      // resolveContextLayers rejecting means no Runner is ever constructed —
      // recordTurnEndError() is the only place that records this failure
      // (see its doc comment). Its own doc comment promises it "never throws
      // into the caller" — a synchronous throw from the store used to
      // replace "layer boom" with "synchronous store explosion" instead.
      function throwingAppendEvents(): Promise<void> {
        throw new Error("synchronous store explosion");
      }
      const chatStore = { appendEvents: throwingAppendEvents };

      const agent = createAgent({
        modelPort: createMockModelPort([textScript("unreachable")]),
        chatStore,
        chatSessionId: "chat-s1",
        resolveContextLayers: async () => {
          throw new Error("layer boom");
        },
      });

      await expect(agent.run("hi")).rejects.toThrow("layer boom");
    });

    it("recordTurnError still surfaces the real rejection when the store throws synchronously", async () => {
      // A Runner exists here (session:start hook throws AFTER construction),
      // so recordTurnError() is the path exercised — same "never throws into
      // the caller" contract as recordTurnEndError above.
      function throwingAppendEvents(): Promise<void> {
        throw new Error("synchronous store explosion");
      }
      const chatStore = { appendEvents: throwingAppendEvents };

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

    it("seeds turnCounter from initialTurn so a cross-process resume reports the real turn, not the 0 sentinel", async () => {
      // Same shape as the previous test, but this simulates a fresh SDK
      // instance built with `initialTurn` seeded from a host's own durable
      // transcript (e.g. apps/headless-server rebuilding on a config change)
      // — the very first thing it does is resume a turn that was claimed
      // BEFORE this instance ever existed. Without seeding, turnCounter
      // starts at 0, and `RunnerOptions.turn` defaults to that same 0 used
      // as the "no turn" sentinel elsewhere — the two collide, and a real
      // turn 5 would be recorded as turn 0.
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

      // The host's transcript already has 4 completed turns; this instance
      // is (re)built to continue from there.
      const agent = createAgent({
        modelPort,
        tools: [dangerousTool],
        capabilities: new Set(["test:danger"]),
        approvalGate: gate,
        sessionStore: flakyStore,
        chatStore,
        chatSessionId: "chat-s1",
        initialTurn: 4,
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

      // This turn was claimed as turn 5 (initialTurn + 1) when agent.run()
      // started it — the fallback resume Runner must report that same
      // number, never the 0 sentinel.
      const turns = new Set(events.map((e) => e.turn));
      expect(turns).toEqual(new Set([5]));

      void runPromise;
    });

    it("seeds the cross-process resume Runner's step counter from initialStep so it continues the paused turn's numbering", async () => {
      // Same shape as the previous test, but for the step axis: the host's
      // transcript shows the paused turn already has a step-1 model call,
      // so it passes `initialStep: 1`. The fallback Runner's fresh step
      // counter must pick up from there — its post-resume model call is
      // step 2, not step 1, which would collide with the paused turn's
      // step-1 model_call_start/assistant_message and make a projection
      // merge two distinct model calls into one.
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
        initialStep: 1,
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

      // The paused turn's step-1 model call and the resumed model call must
      // carry distinct step numbers: [1 (pre-pause), 2 (post-resume)] —
      // without the seed the fallback Runner restarts at 1 and the pair
      // collapses to [1, 1].
      const modelCallStarts = events.filter((e) => e.type === "model_call_start");
      expect(modelCallStarts.map((e) => e.step)).toEqual([1, 2]);

      // The resumed assistant_message is stamped with the incremented step,
      // strictly above the paused turn's max step (1) — never a re-record of
      // an existing step.
      const resumedAssistant = events.find(
        (e) =>
          e.type === "assistant_message" &&
          (e.data as { content: Array<{ type: string; text?: string }> }).content.some(
            (c) => c.type === "text" && c.text === "resumed after approval",
          ),
      );
      expect(resumedAssistant?.step).toBe(2);

      void runPromise;
    });

    it("passes hints as the second argument (empty touchedPaths on a fresh first turn)", async () => {
      const seen: unknown[] = [];
      const agent = createAgent({
        modelPort: createMockModelPort([textScript("ok")]),
        resolveContextLayers: async (input, hints) => {
          seen.push({ input, hints });
          return [];
        },
      });

      await agent.run("hi");

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ input: "hi", hints: { touchedPaths: [] } });
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

  describe("skillRegistry progressive disclosure", () => {
    const registry: SkillRegistry = {
      list: async () => [
        {
          name: "alpha",
          description: "Alpha does things\nwith a second line",
          invocation: { modelInvocable: true, userInvocable: true },
        },
        {
          name: "hidden",
          description: "Not for the model",
          invocation: { modelInvocable: false, userInvocable: true },
        },
      ],
      load: async (name: string) =>
        name === "alpha" ? { body: "ALPHA-BODY", baseDir: "/skills/alpha" } : undefined,
    };

    it("renders a sorted single-line catalog", () => {
      const summaries = [
        { name: "b", description: "B", invocation: { modelInvocable: true, userInvocable: true } },
        { name: "a", description: "A  with   spaces\nand newline", invocation: { modelInvocable: true, userInvocable: true } },
      ];
      expect(renderSkillCatalog(summaries)).toBe(
        "Available skills (load full instructions with the skill tool):\n- a: A with spaces and newline\n- b: B",
      );
    });

    it("sorts by codepoint, not locale collation", () => {
      // "B" (U+0042) < "a" (U+0061) by codepoint; locale collation (e.g. en-US)
      // would order "a" first — the docstring's "deterministic" must hold
      // regardless of the host's locale.
      const summaries = [
        { name: "a", description: "lower", invocation: { modelInvocable: true, userInvocable: true } },
        { name: "B", description: "upper", invocation: { modelInvocable: true, userInvocable: true } },
      ];
      expect(renderSkillCatalog(summaries)).toBe(
        "Available skills (load full instructions with the skill tool):\n- B: upper\n- a: lower",
      );
    });

    it("truncates long descriptions with an ellipsis", () => {
      const long = "d".repeat(250);
      const text = renderSkillCatalog(
        [{ name: "a", description: long, invocation: { modelInvocable: true, userInvocable: true } }],
        200,
      );
      const line = text.split("\n")[1]!;
      expect(line).toBe(`- a: ${"d".repeat(200)}…`);
    });

    it("leaves a description at exactly the limit untouched", () => {
      const exact = "d".repeat(200);
      const text = renderSkillCatalog(
        [{ name: "a", description: exact, invocation: { modelInvocable: true, userInvocable: true } }],
        200,
      );
      expect(text.split("\n")[1]!).toBe(`- a: ${exact}`);
    });

    it("collapses whitespace before measuring the limit", () => {
      const text = renderSkillCatalog(
        [{ name: "a", description: "one\n\n  two", invocation: { modelInvocable: true, userInvocable: true } }],
        200,
      );
      expect(text.split("\n")[1]!).toBe("- a: one two");
    });

    it("appends the skill-catalog layer to the turn's context layers", async () => {
      // Capturing model port — same pattern as the resolveContextLayers tests above.
      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([textScript("ok")]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      const layersSeen: unknown[] = [];
      const agent = createAgent({
        modelPort,
        skillRegistry: registry,
        resolveContextLayers: async () => {
          layersSeen.push(1);
          return []; // host layers empty — the catalog is still appended
        },
      });

      await agent.run("hi");
      expect(layersSeen).toEqual([1]);

      const systemContents = capturedRequests[0]!.messages
        .filter((m) => m.role === "system")
        .map((m) => (m as { content: string }).content);
      expect(systemContents.some((c) => c.startsWith("Available skills (load full instructions with the skill tool):"))).toBe(true);
      expect(systemContents.some((c) => c.includes("- alpha: Alpha does things with a second line"))).toBe(true);
      expect(systemContents.some((c) => c.includes("hidden"))).toBe(false);
    });

    it("appends no catalog layer when no skill is model-invocable (passthrough)", async () => {
      // Capturing model port — same pattern as the resolveContextLayers tests above.
      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([textScript("ok")]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      const nonInvocableRegistry: SkillRegistry = {
        list: async () => [
          {
            name: "manual-only",
            description: "User-invoked only",
            invocation: { modelInvocable: false, userInvocable: true },
          },
        ],
        load: async () => undefined,
      };
      const agent = createAgent({ modelPort, skillRegistry: nonInvocableRegistry });

      await agent.run("hi"); // must not throw — empty catalog is a passthrough, not an error

      const systemContents = capturedRequests[0]!.messages
        .filter((m) => m.role === "system")
        .map((m) => (m as { content: string }).content);
      expect(systemContents.some((c) => c.includes("Available skills"))).toBe(false);
    });

    it("registers the skill tool and loads bodies through it", async () => {
      // Capturing model port — same pattern as the resolveContextLayers tests above.
      const capturedRequests: ModelRequest[] = [];
      const inner = createMockModelPort([
        toolCallScript("c1", "skill", JSON.stringify({ name: "alpha" })),
        textScript("loaded"),
      ]);
      const modelPort: ModelPort = {
        async *stream(req) {
          capturedRequests.push(req);
          yield* inner.stream(req);
        },
      };

      const agent = createAgent({
        modelPort,
        skillRegistry: registry,
      });

      await agent.run("load alpha");

      expect(capturedRequests[0]!.tools.some((t) => t.name === "skill")).toBe(true);
      const toolResult = capturedRequests[1]!.messages.find((m) => m.role === "tool");
      expect(JSON.stringify(toolResult)).toContain("ALPHA-BODY");
    });
  });
});
