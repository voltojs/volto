import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState, Message, TranscriptStore, TranscriptEventInput } from "@volto/core";
import type { ChatSessionRecord, JsonlSessionStore } from "@volto/store-jsonl";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

/**
 * Minimal JsonlSessionStore stand-in — records the `workspacePath` each
 * `appendEvents` call receives so a test can verify `scopeToWorkspace()`
 * actually threaded the resolved project path through, rather than just
 * checking that the scoped store is callable. Also records every append so a
 * test can assert exactly what (and how many times) sessions.ts writes
 * itself, as opposed to what a real `createAgent()` writes internally.
 */
function makeFakeChatStore(): JsonlSessionStore & {
  workspacePaths: Array<string | null>;
  appendCalls: Array<{ workspacePath: string | null; sessionId: string; events: readonly TranscriptEventInput[] }>;
} {
  const workspacePaths: Array<string | null> = [];
  const appendCalls: Array<{ workspacePath: string | null; sessionId: string; events: readonly TranscriptEventInput[] }> = [];
  return {
    workspacePaths,
    appendCalls,
    async appendEvents(workspacePath, sessionId, events) {
      workspacePaths.push(workspacePath);
      appendCalls.push({ workspacePath, sessionId, events });
    },
    async readEvents() {
      return [];
    },
    async readSession() {
      return undefined;
    },
    async listSessions() {
      return { records: [], skipped: [] };
    },
    async deleteSession() {},
  };
}

/** Agent stub reporting a growing message history across turns; captures every options object it was built with. */
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

/**
 * Agent stub whose stream() rejects mid-iteration, AFTER first recording the
 * error to chatStore itself — mirroring what createAgent()'s own internal
 * error handling really does (append a `turn_end` event via chatStore, then
 * let the rejection propagate to the caller). Used to prove sessions.ts
 * itself never writes to chatStore once the agent was already built —
 * durable recording of that failure is entirely createAgent()'s job now.
 */
function makeThrowingStreamFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        yield { type: "text_delta", data: { text: "partial" } };
        const err = new Error("runner exploded");
        const chatStore = opts["chatStore"] as TranscriptStore | undefined;
        const chatSessionId = opts["chatSessionId"] as string | undefined;
        if (chatStore && chatSessionId) {
          await chatStore
            .appendEvents(chatSessionId, [
              { time: 0, type: "turn_end", data: { turn: 1, reason: "error", error: err.message } },
            ])
            .catch(() => {});
        }
        throw err;
      },
      getState: () => ({ messages: [] }) as unknown as ReducerState,
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

describe("chat transcript wiring (jsonl)", () => {
  it("builds the agent with a chatStore scoped to the resolved project path and a stable chatSessionId", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "one", config);

    const built = builds[0]!;
    expect(built["chatSessionId"]).toBe("s1");
    expect(built["chatStore"]).toBeDefined();
    const scoped = built["chatStore"] as TranscriptStore;
    await expect(scoped.appendEvents("s1", [])).resolves.toBeUndefined();
    // Proves scopeToWorkspace() actually threaded the resolved project path
    // through, rather than always passing null.
    expect(chatStore.workspacePaths).toContain("/tmp");
  });

  it("passes chatMeta built from the resolved config, never the resolved apiKey", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "one", config);

    const built = builds[0]!;
    expect(built["chatMeta"]).toEqual({ projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" });
    expect(JSON.stringify(built["chatMeta"])).not.toContain("sk-secret");
  });

  it("only rebuilds (and re-derives chatMeta) when the resolved config actually changes", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "one", config);
    await registry.runTurn("s1", "two", config);

    // Same config both turns -> the agent (and its chatMeta) is only built once.
    expect(builds).toHaveLength(1);
  });

  it("hydrates history from the transcript on a cold start, projecting the raw event log itself", async () => {
    const chatStore = makeFakeChatStore();
    chatStore.readSession = async (sessionId: string): Promise<ChatSessionRecord | undefined> =>
      sessionId === "s1"
        ? {
            sessionId: "s1",
            meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
            events: [
              { seq: 0, time: 0, type: "user_message", data: { content: "earlier turn" } },
            ],
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined;

    const { factory, builds } = makeFactory();
    // A brand-new registry has no in-memory session — this simulates a
    // server restart with the same on-disk transcript still present.
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialMessages"]).toEqual([{ role: "user", content: "earlier turn" }]);
  });

  it("works without a chatStore configured (persistence is optional)", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await expect(registry.runTurn("s1", "one", config)).resolves.toBeUndefined();
    expect(builds[0]!["chatStore"]).toBeUndefined();
  });

  it("does not write to chatStore for a config-resolution failure before any agent is built", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    // No projectStore/providerStore configured — resolveConfig() throws
    // before rebuild() (and therefore before any createAgent() instance)
    // ever runs. Durable recording of a turn's outcome is now entirely
    // createAgent()'s responsibility (via chatStore/chatSessionId), so a
    // failure this early — before an agent even exists — is not recorded
    // anywhere durable; sessions.ts no longer hand-writes around that gap.
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      chatStore,
    });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", { projectId: "p1" });

    expect(builds).toHaveLength(0);
    expect(chatStore.appendCalls).toHaveLength(0);
  });

  it("does not double-record when stream() rejects after the agent was already built", async () => {
    const chatStore = makeFakeChatStore();
    const { factory, builds } = makeThrowingStreamFactory();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "one", config);

    // The agent WAS built (unlike the config-resolution-failure case above).
    // The stub's stream() records the rejection to chatStore itself, exactly
    // mirroring what createAgent() really does internally — sessions.ts has
    // no append call of its own left to double-write it.
    expect(builds).toHaveLength(1);
    expect(chatStore.appendCalls).toHaveLength(1);
    expect(chatStore.appendCalls[0]!.sessionId).toBe("s1");
  });
});
