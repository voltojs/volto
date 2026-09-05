import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState, Message, TranscriptStore, TranscriptEvent, TranscriptEventInput } from "@volto/core";
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

/**
 * A stateful JsonlSessionStore stand-in — actually accumulates appended
 * events per session so `readSession()` reflects what was really written,
 * unlike `makeFakeChatStore()` above (which only records calls). Needed to
 * exercise `resolveInitialTurn()`'s hot-process rebuild path: it re-reads
 * the transcript via `readSession()`, so the read has to see writes made by
 * earlier turns in the same test.
 */
function makeStatefulChatStore(): JsonlSessionStore {
  const bySession = new Map<string, TranscriptEvent[]>();
  let seq = 0;
  return {
    async appendEvents(_workspacePath, sessionId, events) {
      const arr = bySession.get(sessionId) ?? [];
      for (const event of events) arr.push({ ...event, seq: seq++ });
      bySession.set(sessionId, arr);
    },
    async readEvents(sessionId) {
      return bySession.get(sessionId) ?? [];
    },
    async readSession(sessionId) {
      const events = bySession.get(sessionId);
      if (!events) return undefined;
      return {
        sessionId,
        meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
        events,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    async listSessions() {
      return { records: [], skipped: [] };
    },
    async deleteSession() {},
  };
}

/**
 * Agent stub that mimics the one piece of real `createAgent()` behavior this
 * suite cares about: seeding its own turn counter from `opts.initialTurn`
 * and recording a `turn_start` event (via the `chatStore`/`chatSessionId` it
 * was actually built with) on every turn. Each `factory(opts)` call is a
 * fresh "agent instance" with its own counter, exactly like a real rebuild
 * constructing a brand-new `createAgent()` — so this stub can only report
 * correct turn numbers across a rebuild if the registry passed it the right
 * `initialTurn` each time.
 */
function makeTurnRecordingFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    let turnCounter = (opts["initialTurn"] as number | undefined) ?? 0;
    const scopedChatStore = opts["chatStore"] as TranscriptStore | undefined;
    const chatSessionId = opts["chatSessionId"] as string | undefined;
    const cumulative: Message[] = [];
    return {
      async *stream() {
        turnCounter += 1;
        const turn = turnCounter;
        if (scopedChatStore && chatSessionId) {
          await scopedChatStore.appendEvents(chatSessionId, [
            { time: 0, type: "turn_start", data: { turn }, turn },
          ]);
        }
        cumulative.push({ role: "assistant", content: [{ type: "text", text: `m${turn}` }] });
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

  it("seeds initialTurn from the highest turn_start in the persisted transcript on a cold start", async () => {
    const chatStore = makeFakeChatStore();
    chatStore.readSession = async (sessionId: string): Promise<ChatSessionRecord | undefined> =>
      sessionId === "s1"
        ? {
            sessionId: "s1",
            meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
            events: [
              { seq: 0, time: 0, type: "turn_start", data: { turn: 1 }, turn: 1 },
              { seq: 1, time: 1, type: "user_message", data: { content: "turn 1" }, turn: 1 },
              { seq: 2, time: 2, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
              { seq: 3, time: 3, type: "turn_start", data: { turn: 2 }, turn: 2 },
              { seq: 4, time: 4, type: "user_message", data: { content: "turn 2" }, turn: 2 },
              { seq: 5, time: 5, type: "turn_end", data: { turn: 2, reason: "done" }, turn: 2 },
            ],
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined;

    const { factory, builds } = makeFactory();
    // A brand-new registry has no in-memory session — simulates a server
    // restart with the same on-disk transcript still present.
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialTurn"]).toBe(2);
  });

  it("omits initialTurn when the persisted transcript has no turn_start events", async () => {
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
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialTurn"]).toBeUndefined();
  });

  it("seeds initialStep from the highest step of the last turn in the persisted transcript on a cold start", async () => {
    const chatStore = makeFakeChatStore();
    chatStore.readSession = async (sessionId: string): Promise<ChatSessionRecord | undefined> =>
      sessionId === "s1"
        ? {
            sessionId: "s1",
            meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
            events: [
              // Turn 1 completed with three model-call steps…
              { seq: 0, time: 0, type: "turn_start", data: { turn: 1 }, turn: 1 },
              { seq: 1, time: 1, type: "user_message", data: { content: "turn 1" }, turn: 1 },
              { seq: 2, time: 2, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
              { seq: 3, time: 3, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
              { seq: 4, time: 4, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 3 },
              { seq: 5, time: 5, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
              // …then turn 2 paused early, after a single step-1 model call.
              { seq: 6, time: 6, type: "turn_start", data: { turn: 2 }, turn: 2 },
              { seq: 7, time: 7, type: "user_message", data: { content: "turn 2" }, turn: 2 },
              { seq: 8, time: 8, type: "model_call_start", data: { headerHash: "h2" }, turn: 2, step: 1 },
            ],
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined;

    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialTurn"]).toBe(2);
    // The step seed is the PAUSED (last) turn's max step — 1, not the
    // transcript-wide max of 3 from the earlier turn — so a cross-process
    // resume of turn 2 continues its step sequence at 2 instead of
    // colliding with its existing step 1.
    expect(builds[0]!["initialStep"]).toBe(1);
  });

  it("omits initialStep when the last turn has no step-stamped events", async () => {
    const chatStore = makeFakeChatStore();
    chatStore.readSession = async (sessionId: string): Promise<ChatSessionRecord | undefined> =>
      sessionId === "s1"
        ? {
            sessionId: "s1",
            meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
            events: [
              { seq: 0, time: 0, type: "turn_start", data: { turn: 1 }, turn: 1 },
              { seq: 1, time: 1, type: "user_message", data: { content: "turn 1" }, turn: 1 },
              // Paused before any model call ran — no step stamps at all.
              { seq: 2, time: 2, type: "approval_asked", data: { callId: "c1", name: "op", riskTier: "WRITE_HIGH" }, turn: 1 },
            ],
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined;

    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory, chatStore);

    await registry.runTurn("s1", "continue", config);

    expect(builds[0]!["initialTurn"]).toBe(1);
    expect(builds[0]!["initialStep"]).toBeUndefined();
  });

  it("works without a chatStore configured (persistence is optional)", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await expect(registry.runTurn("s1", "one", config)).resolves.toBeUndefined();
    expect(builds[0]!["chatStore"]).toBeUndefined();
  });

  it("records a config-resolution failure to chatStore even though no agent was ever built", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    // No projectStore/providerStore configured — resolveConfig() throws
    // before rebuild() (and therefore before any createAgent() instance)
    // ever runs, so createAgent()'s own internal recordTurnEndError (which
    // only fires once stream() has actually been entered) never sees this
    // failure. sessions.ts's own catch block is the only place left that
    // can record it — as a bare `error` event, not a `turn_end` (no turn
    // number exists yet to attribute it to).
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      chatStore,
    });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", { projectId: "p1" });

    expect(builds).toHaveLength(0);
    expect(chatStore.appendCalls).toHaveLength(1);
    expect(chatStore.appendCalls[0]!.events[0]!.type).toBe("error");
    expect((chatStore.appendCalls[0]!.events[0]!.data as { message: string }).message).toContain(
      "Project store is not configured",
    );
  });

  it("records a config-resolution failure even on a later turn, after an agent from an earlier turn is already alive", async () => {
    const { factory, builds } = makeFactory();
    const chatStore = makeFakeChatStore();
    const registry = makeRegistry(factory, chatStore);

    // First turn succeeds and builds a real agent — session.agent is alive
    // from here on, exactly like a session that has already run N turns.
    await registry.runTurn("s1", "one", config);
    expect(builds).toHaveLength(1);
    expect(chatStore.appendCalls).toHaveLength(0);

    // Second turn's requested config is incomplete (no projectId), so
    // resolveConfig() throws before stream() is ever reached — the agent
    // being alive from the prior turn does not help createAgent() see this
    // failure, since stream() is never entered on this turn either.
    await registry.runTurn("s1", "two", {});

    expect(chatStore.appendCalls).toHaveLength(1);
    expect(chatStore.appendCalls[0]!.events[0]!.type).toBe("error");
    expect((chatStore.appendCalls[0]!.events[0]!.data as { message: string }).message).toContain(
      "projectId is required",
    );
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

  it("continues turn numbering across a hot-process rebuild (config change), not just a cold start", async () => {
    // Two turns on the first agent instance, then a modelId change forces a
    // rebuild, then a third turn on the NEW instance. The persisted
    // turn_start values must be [1, 2, 3] — a rebuild mid-conversation must
    // see the two turns already on disk, not restart at 1 or (if it used a
    // value cached only at cold start) collide by recording turn 1 again.
    const chatStore = makeStatefulChatStore();
    const { factory, builds } = makeTurnRecordingFactory();
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: { resolveModel: async () => ({ baseURL: null, apiKey: "sk-secret", code: "m" }) } as never,
      chatStore,
    });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", config);
    await registry.runTurn("s1", "two", config);
    // modelId change -> sameConfig() is false -> rebuild().
    await registry.runTurn("s1", "three", { ...config, modelId: "m2" });

    expect(builds).toHaveLength(2); // one initial build, one rebuild
    // The rebuild must see both turns already on disk, not the value cached
    // (and never refreshed) at whatever cold-start hydration last ran.
    expect(builds[1]!["initialTurn"]).toBe(2);

    const persisted = await chatStore.readSession("s1");
    const turnStarts = persisted!.events
      .filter((e) => e.type === "turn_start")
      .map((e) => (e.data as { turn: number }).turn);
    expect(turnStarts).toEqual([1, 2, 3]);
  });
});
