import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type {
  StepContext,
  ModelPort,
  ModelRequest,
  ModelEvent,
  MemoryStore,
  MemoryEntry,
  MemoryQueryFilter,
  TranscriptEventInput,
} from "@volto/core";

const ctx: StepContext = { tools: [], model: "test-model" };

const RAG_HEADER = "# Retrieved Memory (project-scoped)";

function createMockModelPort(script?: ModelEvent[][]): ModelPort & {
  lastMessages?: unknown[];
  lastRequest?: ModelRequest;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    lastMessages: undefined,
    lastRequest: undefined,
    requests,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      requests.push(req);
      (this as unknown as { lastMessages: unknown[]; lastRequest: ModelRequest }).lastMessages = req.messages;
      (this as unknown as { lastMessages: unknown[]; lastRequest: ModelRequest }).lastRequest = req;
      const events = script?.[index] ?? [{ type: "text_delta" as const, text: "response" }];
      index++;
      for (const event of events) yield event;
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

/** Spy store: records every query's text/k/filter, returns a fixed entry list. */
function createSpyMemoryStore(entries: MemoryEntry[]): MemoryStore & {
  queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }>;
} {
  const queries: Array<{ text: string; k?: number; filter?: MemoryQueryFilter }> = [];
  return {
    queries,
    async save(): Promise<string> { return "ok"; },
    async query(text: string, k?: number, filter?: MemoryQueryFilter): Promise<MemoryEntry[]> {
      queries.push({ text, k, filter });
      return entries;
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
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
    expect(ragMsg).toBeDefined();
    expect(ragMsg!.content).toContain("relevant fact A");
    expect(ragMsg!.content).toContain("relevant fact B");

    // With no system messages, the RAG fragment must precede the user's
    // question — it augments the query, not follows it.
    expect(msgs[0]!.content).toContain(RAG_HEADER);
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
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
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
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
    expect(ragMsg).toBeUndefined();
  });

  it("queries once with the scoped filter and reuses the retrieval across model calls", async () => {
    // Two model calls in one turn: a tool batch, then the closing text call.
    const store = createSpyMemoryStore([{ id: "m1", text: "relevant fact A" }]);
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "response" }, { type: "done", stopReason: "end_turn" }],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY" as const,
          },
        ],
        model: "test-model",
      },
      availableCapabilities: new Set<string>(),
      toolExecutor: async () => ({ modelContent: "ok", isError: false }),
      rag: { memoryStore: store, topK: 2, projectId: "p1" },
    });

    await runner.run({ type: "user_message", content: "question" });

    expect(model.requests).toHaveLength(2);
    // One query for the whole turn — the second model call reuses the cache.
    expect(store.queries).toHaveLength(1);
    expect(store.queries[0]).toEqual({
      text: "question",
      k: 2,
      filter: { projectId: "p1", includeGlobal: true, tier: "semantic" },
    });

    for (const req of model.requests) {
      const ragMsg = (req.messages as Array<{ role: string; content: string }>).find(
        (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
      );
      expect(ragMsg).toBeDefined();
      expect(ragMsg!.content).toContain("relevant fact A");
    }
  });

  it("defaults includeGlobal to true when projectId is unset (global-only query)", async () => {
    const store = createSpyMemoryStore([]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store, topK: 3 },
    });

    await runner.run({ type: "user_message", content: "question" });

    expect(store.queries[0]!.filter).toEqual({
      projectId: undefined,
      includeGlobal: true,
      tier: "semantic",
    });
  });

  it("honors includeGlobal: false from the rag options", async () => {
    const store = createSpyMemoryStore([]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store, projectId: "p1", includeGlobal: false },
    });

    await runner.run({ type: "user_message", content: "question" });

    expect(store.queries[0]!.filter).toEqual({
      projectId: "p1",
      includeGlobal: false,
      tier: "semantic",
    });
  });

  it("truncates an over-long rendered message to 4000 chars with a (truncated) marker", async () => {
    const store = createMockMemoryStore([{ id: "big", text: "x".repeat(5000) }]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store, topK: 1 },
    });

    await runner.run({ type: "user_message", content: "question" });

    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
    expect(ragMsg).toBeDefined();
    expect(ragMsg!.content.length).toBeLessThanOrEqual(4000);
    expect(ragMsg!.content.endsWith("(truncated)")).toBe(true);
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

  it("records the retrieved fragments as a context_reminder", async () => {
    const memoryStore = createMockMemoryStore([
      { id: "1", text: "relevant fact A" },
      { id: "2", text: "relevant fact B" },
    ]);
    const model = createMockModelPort();

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    // `appendEvents` must accept TranscriptEventInput[]: the looser {type,data}
    // shape is NOT assignable to TranscriptStore.appendEvents (TS2322) and
    // would fail the typecheck gate. Cast on push, mirroring the existing
    // fixture in runner.test.ts.
    const chatStore = {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...(batch as unknown as Array<{ type: string; data: Record<string, unknown> }>));
      },
    };

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore, topK: 2 },
      chatStore,
      chatSessionId: "chat-1",
    });

    await runner.run({ type: "user_message", content: "question" });

    const reminder = events.find((e) => e.type === "context_reminder");
    expect(reminder).toBeDefined();
    expect(reminder!.data.kind).toBe("retrieval");
    expect(reminder!.data.text as string).toContain("relevant fact A");
    expect(reminder!.data.text as string).toContain("relevant fact B");
    expect(reminder!.data.displayMetadata).toEqual({
      fragmentCount: 2,
      memoryIds: ["1", "2"],
    });

    // Byte-for-byte: the audit `text` must be exactly the string injected into
    // the model request, not merely a copy that overlaps it.
    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
    expect(ragMsg).toBeDefined();
    expect(ragMsg!.content).toBe(reminder!.data.text);
  });
});

describe("Runner context_assembled event", () => {
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

  it("emits context_assembled when contextLayers are present", async () => {
    const model = createMockModelPort();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model", contextLayers: [{ id: "user-memory", text: "Be terse" }] },
      eventSink: { emit: (e) => events.push(e) },
    });

    await runner.run({ type: "user_message", content: "hi" });

    const event = events.find((e) => e.type === "context_assembled");
    expect(event).toBeDefined();
    expect(event!.data["layerOrigins"]).toContainEqual({ id: "user-memory", messageIndex: 0 });
  });
});
