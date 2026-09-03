import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState, Message, TranscriptStore } from "@volto/core";
import type { JsonlSessionStore } from "@volto/store-jsonl";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

/**
 * Minimal JsonlSessionStore stand-in — records the `workspacePath` each
 * method receives so a test can verify `scopeToWorkspace()` actually
 * threaded the resolved project path through, rather than just checking
 * that the scoped store is callable.
 */
function makeFakeChatStore(): JsonlSessionStore & { workspacePaths: Array<string | null> } {
  const workspacePaths: Array<string | null> = [];
  return {
    workspacePaths,
    async appendMeta(workspacePath) {
      workspacePaths.push(workspacePath);
    },
    async appendMessages(workspacePath) {
      workspacePaths.push(workspacePath);
    },
    async appendError(workspacePath) {
      workspacePaths.push(workspacePath);
    },
    async appendTrajectoryEntry(workspacePath) {
      workspacePaths.push(workspacePath);
    },
    async readSession() {
      return undefined;
    },
    async listSessions() {
      return [];
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
    await expect(scoped.appendMessages("s1", [])).resolves.toBeUndefined();
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

  it("hydrates history from the transcript on a cold start", async () => {
    const chatStore = makeFakeChatStore();
    chatStore.readSession = async (sessionId: string) =>
      sessionId === "s1"
        ? {
            sessionId: "s1",
            meta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
            messages: [{ role: "user", content: "earlier turn" }],
            messageTimestamps: [0],
            errors: [],
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
});
