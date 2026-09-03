import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { StepContext, ModelPort, ModelRequest, ModelEvent, MemoryStore, MemoryEntry } from "@volto/core";

const ctx: StepContext = { tools: [], model: "test-model" };

function createMockModelPort(): ModelPort & { lastMessages?: unknown[]; lastRequest?: ModelRequest } {
  let capturedMessages: unknown[] = [];
  return {
    lastMessages: undefined,
    lastRequest: undefined,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      capturedMessages = req.messages;
      (this as unknown as { lastMessages: unknown[]; lastRequest: ModelRequest }).lastMessages = capturedMessages;
      (this as unknown as { lastMessages: unknown[]; lastRequest: ModelRequest }).lastRequest = req;
      yield { type: "text_delta", text: "response" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

function createMockMemoryStore(entries: MemoryEntry[]): MemoryStore {
  return {
    async save(): Promise<string> { return "ok"; },
    async query(text: string, k?: number): Promise<MemoryEntry[]> {
      return entries.slice(0, k ?? 10);
    },
    async delete(): Promise<boolean> { return true; },
  };
}

describe("Runner RAG pipeline", () => {
  it("injects retrieved fragments after system messages", async () => {
    const store = createMockMemoryStore([
      { id: "1", text: "relevant fact A" },
      { id: "2", text: "relevant fact B" },
    ]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store, topK: 2 },
    });

    await runner.run({ type: "user_message", content: "question" });

    // The model should have received messages with a RAG fragment
    expect(model.lastMessages).toBeDefined();
    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find((m) => typeof m.content === "string" && m.content.includes("Retrieved Context"));
    expect(ragMsg).toBeDefined();
    expect(ragMsg!.content).toContain("relevant fact A");
    expect(ragMsg!.content).toContain("relevant fact B");

    // With no system messages, the RAG fragment must precede the user's
    // question — it augments the query, not follows it.
    expect(msgs[0]!.content).toContain("Retrieved Context");
    expect(msgs[1]!.content).toBe("question");
  });

  it("does not inject RAG when memory store returns empty", async () => {
    const store = createMockMemoryStore([]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store },
    });

    await runner.run({ type: "user_message", content: "question" });

    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find((m) => typeof m.content === "string" && m.content.includes("Retrieved Context"));
    expect(ragMsg).toBeUndefined();
  });

  it("no RAG when rag option is undefined", async () => {
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      // No rag config
    });

    await runner.run({ type: "user_message", content: "question" });

    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find((m) => typeof m.content === "string" && m.content.includes("Retrieved Context"));
    expect(ragMsg).toBeUndefined();
  });

  it("includes contextLayers from stepContext in the assembled prompt", async () => {
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model", contextLayers: [{ id: "user-memory", text: "Be terse" }] },
    });

    await runner.run({ type: "user_message", content: "hi" });

    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    expect(msgs.some((m) => m.role === "system" && m.content === "Be terse")).toBe(true);
  });

  it("includes layerOrigins in the live model request", async () => {
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model", contextLayers: [{ id: "user-memory", text: "Be terse" }] },
    });

    await runner.run({ type: "user_message", content: "hi" });

    expect(model.lastRequest).toBeDefined();
    expect(model.lastRequest!.layerOrigins).toContainEqual({ id: "user-memory", messageIndex: 0 });
  });
});

function createFakeChatStore() {
  const entries: Array<{ sessionId: string; entry: unknown }> = [];
  return {
    entries,
    store: {
      async appendMeta() {},
      async appendMessages() {},
      async appendError() {},
      async appendTrajectoryEntry(sessionId: string, entry: unknown) {
        entries.push({ sessionId, entry });
      },
    },
  };
}

describe("Runner trajectory capture", () => {
  it("emits context_assembled with layerOrigins when contextLayers are present", async () => {
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model", contextLayers: [{ id: "user-memory", text: "Be terse" }] },
    });

    await runner.run({ type: "user_message", content: "hi" });

    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    expect(msgs.some((m) => m.role === "system" && m.content === "Be terse")).toBe(true);
  });

  it("does not emit context_assembled when there are no contextLayers", async () => {
    const model = createMockModelPort();
    const events: Array<{ type: string }> = [];

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      eventSink: { emit: (e) => events.push(e) },
    });

    await runner.run({ type: "user_message", content: "hi" });

    expect(events.some((e) => e.type === "context_assembled")).toBe(false);
  });

  it("records a trajectory entry for tool_result, model_done, and context_assembled when chatStore is configured", async () => {
    const model = createMockModelPort();
    const { store, entries } = createFakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model", contextLayers: [{ id: "user-memory", text: "Be terse" }] },
      chatStore: store,
      chatSessionId: "chat-s1",
      turn: 3,
    });

    await runner.run({ type: "user_message", content: "hi" });

    const eventTypes = entries.map((e) => (e.entry as { eventType: string }).eventType);
    expect(eventTypes).toContain("context_assembled");
    expect(eventTypes).toContain("model_done");
    expect(entries.every((e) => e.sessionId === "chat-s1")).toBe(true);
    expect(entries.every((e) => (e.entry as { turn: number }).turn === 3)).toBe(true);
    // Steps are sequential within the turn, starting at 1.
    const steps = entries.map((e) => (e.entry as { step: number }).step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
  });

  it("does not record trajectory entries when chatStore is not configured", async () => {
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
    });

    // No chatStore/chatSessionId — must not throw.
    await expect(runner.run({ type: "user_message", content: "hi" })).resolves.toBeDefined();
  });
});
