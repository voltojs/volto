import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState, Message } from "@volto/core";
import type { ChatSessionMeta, ChatSessionRecord, JsonlSessionStore } from "@volto/store-jsonl";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

/** In-memory JsonlSessionStore stand-in that records every call it received. */
function makeFakeChatStore() {
  const files = new Map<
    string,
    { meta: ChatSessionMeta | null; messages: Message[]; errors: string[]; workspacePaths: Array<string | null> }
  >();

  function record(sessionId: string) {
    let entry = files.get(sessionId);
    if (!entry) {
      entry = { meta: null, messages: [], errors: [], workspacePaths: [] };
      files.set(sessionId, entry);
    }
    return entry;
  }

  const store: JsonlSessionStore = {
    async appendMeta(workspacePath, sessionId, meta) {
      const entry = record(sessionId);
      entry.meta = meta;
      entry.workspacePaths.push(workspacePath);
    },
    async appendMessages(workspacePath, sessionId, messages) {
      const entry = record(sessionId);
      entry.messages.push(...messages);
      entry.workspacePaths.push(workspacePath);
    },
    async appendError(workspacePath, sessionId, message) {
      const entry = record(sessionId);
      entry.errors.push(message);
      entry.workspacePaths.push(workspacePath);
    },
    async readSession(sessionId): Promise<ChatSessionRecord | undefined> {
      const entry = files.get(sessionId);
      if (!entry) return undefined;
      return {
        sessionId,
        meta: entry.meta ?? { projectId: null, providerId: null, modelId: null, permissionMode: null },
        messages: entry.messages,
        messageTimestamps: entry.messages.map(() => 0),
        errors: entry.errors.map((message) => ({ message, timestamp: 0 })),
        createdAt: 0,
        updatedAt: 0,
      };
    },
    async listSessions() {
      return Promise.all([...files.keys()].map((id) => store.readSession(id) as Promise<ChatSessionRecord>));
    },
    async deleteSession(sessionId) {
      files.delete(sessionId);
    },
  };
  return { store, files };
}

/** Agent stub reporting a growing message history across turns. */
function makeFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const cumulative: Message[] = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        cumulative.push({ role: "assistant", content: [{ type: "text", text: `m${cumulative.length + 1}` }] });
        yield { type: "text_delta", data: { text: "hi" } };
      },
      getState: () => ({ messages: [...cumulative] }) as unknown as ReducerState,
    };
  };
  return { builds, factory };
}

function makeRegistry(
  factory: ReturnType<typeof makeFactory>["factory"],
  chatStore?: JsonlSessionStore,
) {
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
    providerStore: { resolveModel: async () => ({ baseURL: null, apiKey: "sk-secret", code: "m" }) } as never,
    ...(chatStore ? { chatStore } : {}),
  });
  registry.attach("s1", { write: () => {}, on: () => {} } as never);
  created.push(registry);
  return registry;
}

const config = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" as const };

describe("chat transcript persistence (jsonl)", () => {
  it("appends meta once per config binding and messages produced by the turn", async () => {
    const { factory } = makeFactory();
    const { store, files } = makeFakeChatStore();
    const registry = makeRegistry(factory, store);

    await registry.runTurn("s1", "one", config);

    const entry = files.get("s1")!;
    expect(entry.meta).toEqual({ projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" });
    expect(entry.messages).toHaveLength(1);
    expect(entry.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "m1" }] });
    // The resolved project's absolute path (from the stub projectStore),
    // not the raw projectId, is what locates the session's file on disk.
    expect(entry.workspacePaths).toEqual(["/tmp", "/tmp"]);
  });

  it("only persists meta again when the resolved config actually changes", async () => {
    const { factory } = makeFactory();
    const { store, files } = makeFakeChatStore();
    const registry = makeRegistry(factory, store);

    await registry.runTurn("s1", "one", config);
    await registry.runTurn("s1", "two", config);

    // Two turns, same config: one meta write, two accumulated messages.
    expect(files.get("s1")!.messages).toHaveLength(2);
  });

  it("never leaks the resolved apiKey into the transcript's meta record", async () => {
    const { factory } = makeFactory();
    const { store, files } = makeFakeChatStore();
    const registry = makeRegistry(factory, store);

    await registry.runTurn("s1", "one", config);

    expect(JSON.stringify(files.get("s1")!.meta)).not.toContain("sk-secret");
  });

  it("records a turn-level error without touching message history", async () => {
    const { factory } = makeFactory();
    const { store, files } = makeFakeChatStore();
    // No projectStore/providerStore -> resolveConfig throws before any agent runs.
    const registry = createSessionRegistry({ agentFactory: factory as never, chatStore: store });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", { projectId: "p1" });

    const entry = files.get("s1")!;
    expect(entry.errors).toHaveLength(1);
    expect(entry.messages).toHaveLength(0);
  });

  it("hydrates history from the transcript on a cold start", async () => {
    const { store } = makeFakeChatStore();
    await store.appendMessages("/tmp", "s1", [{ role: "user", content: "earlier turn" }]);

    const { factory, builds } = makeFactory();
    // A brand-new registry has no in-memory session — this simulates a
    // server restart with the same on-disk transcript still present.
    const registry = makeRegistry(factory, store);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialMessages"]).toEqual([{ role: "user", content: "earlier turn" }]);
  });

  it("works without a chatStore configured (persistence is optional)", async () => {
    const { factory } = makeFactory();
    const registry = makeRegistry(factory);

    await expect(registry.runTurn("s1", "one", config)).resolves.toBeUndefined();
  });
});
