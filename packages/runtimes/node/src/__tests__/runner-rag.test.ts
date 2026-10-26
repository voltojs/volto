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

const RAG_HEADER = "# Retrieved Memory";

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

  it("degrades to no injection when the queryBuilder throws, without failing the turn", async () => {
    const store = createSpyMemoryStore([{ id: "m1", text: "relevant fact A" }]);
    const model = createMockModelPort();

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: {
        memoryStore: store,
        // Host-supplied callback that explodes: same trust level as the
        // store, so it must degrade to no RAG instead of aborting the turn.
        queryBuilder: () => {
          throw new Error("host callback exploded");
        },
      },
    });

    // Must not throw or reject — the model call still happens.
    await runner.run({ type: "user_message", content: "question" });

    expect(model.requests).toHaveLength(1);
    const msgs = model.lastMessages as Array<{ role: string; content: string }>;
    const ragMsg = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
    );
    expect(ragMsg).toBeUndefined();
    expect(store.queries).toHaveLength(0);
  });

  it("a failing memory query degrades to no injection and is not retried this turn", async () => {
    let queryCalls = 0;
    const store: MemoryStore = {
      async save(): Promise<string> { return "ok"; },
      async query(): Promise<MemoryEntry[]> {
        queryCalls++;
        throw new Error("store offline");
      },
      async delete(): Promise<boolean> { return true; },
    };
    // Two model calls in one turn (tool batch) to pin the once-per-turn
    // semantics: a failed query must not be retried by the second call.
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
      rag: { memoryStore: store },
    });

    // Must not throw or reject — both model calls still happen.
    await runner.run({ type: "user_message", content: "question" });

    expect(model.requests).toHaveLength(2);
    expect(queryCalls).toBe(1);
    for (const req of model.requests) {
      const msgs = req.messages as Array<{ role: string; content: string }>;
      const ragMsg = msgs.find(
        (m) => typeof m.content === "string" && m.content.includes(RAG_HEADER),
      );
      expect(ragMsg).toBeUndefined();
    }
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

  it("records exactly one context_reminder per turn, not per model call", async () => {
    const store = createMockMemoryStore([{ id: "1", text: "relevant fact A" }]);
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "response" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const chatStore = {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...(batch as unknown as Array<{ type: string; data: Record<string, unknown> }>));
      },
    };
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
      rag: { memoryStore: store },
      chatStore,
      chatSessionId: "chat-dedupe",
    });
    await runner.run({ type: "user_message", content: "question" });

    // Two model calls both inject the same cached text, but the audit trail
    // records the retrieval once (spec 2026-10-20 memory-rag §5.2).
    expect(model.requests).toHaveLength(2);
    const reminders = events.filter((e) => e.type === "context_reminder");
    expect(reminders).toHaveLength(1);
  });

  it("caps a long retrieval by code point and keeps fragmentCount truthful", async () => {
    // Each fragment is ~1200 code points: four of them blow past the
    // 4000-char injection cap.
    const big = (tag: string): string => `${tag} ${"x".repeat(1200)}`;
    const store = createMockMemoryStore([
      { id: "1", text: big("\ud83d\ude00 fact one") },
      { id: "2", text: big("\ud83d\ude00 fact two") },
      { id: "3", text: big("\ud83d\ude00 fact three") },
      { id: "4", text: big("\ud83d\ude00 fact four") },
    ]);
    const model = createMockModelPort();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const chatStore = {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...(batch as unknown as Array<{ type: string; data: Record<string, unknown> }>));
      },
    };
    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      rag: { memoryStore: store },
      chatStore,
      chatSessionId: "chat-cap",
    });
    await runner.run({ type: "user_message", content: "question" });

    const reminder = events.find((e) => e.type === "context_reminder")!;
    const text = reminder.data.text as string;
    expect(Array.from(text).length).toBeLessThanOrEqual(4000);
    expect(text).toContain("(truncated)");
    // The cut is by code point: no lone surrogate ever ships to the model.
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const meta = reminder.data.displayMetadata as { fragmentCount: number };
    // Only complete blocks survive the cut, and the declared count matches
    // the blocks actually present in the injected text.
    expect(meta.fragmentCount).toBeGreaterThanOrEqual(1);
    expect(meta.fragmentCount).toBeLessThan(4);
    // Each `\n\n[` in the injected text starts one block (header included).
    expect(text.match(/\n\n\[/g)?.length ?? 0).toBe(meta.fragmentCount);
  });
});
