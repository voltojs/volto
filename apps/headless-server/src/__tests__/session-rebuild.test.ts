import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState } from "@volto/core";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

/**
 * Minimal agent stub that records how it was constructed and reports a
 * growing message history across turns (turn 1 -> [m1], turn 2 -> [m1,m2]).
 * A constant-length stub would not be able to distinguish "history captured
 * before the stream ran" from "captured after", nor detect truncation.
 */
function makeFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const cumulative: Array<{ role: string; content: string }> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        cumulative.push({ role: "assistant", content: `m${cumulative.length + 1}` });
        yield { type: "text_delta", data: { text: "hi" } };
      },
      getState: () => ({ messages: [...cumulative] }) as unknown as ReducerState,
    };
  };
  return { builds, factory };
}

/**
 * Agent stub that fails on its second turn, then reports a message array on
 * its third turn that is *shorter* than what was already captured after the
 * second turn. This mirrors the SDK's real `getState()` behavior: after a
 * failed turn, the next turn has no `lastFinalState` to carry forward and
 * falls back to the agent's build-time seed, which can be smaller than the
 * conversation history already captured by the registry.
 */
function makeFlakyFactory() {
  const builds: Array<Record<string, unknown>> = [];
  let call = 0;
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        call += 1;
        if (call === 2) {
          throw new Error("boom");
        }
        yield { type: "text_delta", data: { text: "hi" } };
      },
      getState: (): ReducerState => {
        if (call === 1) {
          return { messages: [{ role: "assistant", content: "m1" }] } as unknown as ReducerState;
        }
        if (call === 2) {
          // Partial progress from the failed turn — not shorter than before.
          return {
            messages: [
              { role: "assistant", content: "m1" },
              { role: "user", content: "m1b" },
            ],
          } as unknown as ReducerState;
        }
        // call === 3: the flaky reset to a smaller build-time seed.
        return { messages: [{ role: "assistant", content: "m3" }] } as unknown as ReducerState;
      },
    };
  };
  return { builds, factory };
}

/** A registry with a stub connection attached so runTurn is allowed to run. */
function makeRegistry(
  factory: ReturnType<typeof makeFactory>["factory"],
  overrides: { projectStore?: unknown } = {},
) {
  const written: string[] = [];
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: (overrides.projectStore ??
      { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) }) as never,
    providerStore: {
      // A distinctive, obviously-fake secret so the plaintext-leak test has
      // no risk of a false-negative substring match.
      resolveModel: async () => ({ baseURL: null, apiKey: "sk-super-secret-token", code: "m" }),
    } as never,
  });
  registry.attach("s1", {
    write: (chunk: string) => written.push(chunk),
    on: () => {},
  } as never);
  // attach() starts a heartbeat interval; without teardown vitest would hang.
  created.push(registry);
  return { registry, written };
}

describe("session agent lifecycle", () => {
  it("reuses the agent when the config is unchanged", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);
    const config = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" as const };

    await registry.runTurn("s1", "one", config);
    await registry.runTurn("s1", "two", config);

    expect(builds).toHaveLength(1);
  });

  it("rebuilds the agent and seeds history when the model changes", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p1", providerId: "v1", modelId: "m2", permissionMode: "plan",
    });

    expect(builds).toHaveLength(2);
    expect(builds[1]!["initialMessages"]).toHaveLength(1);
    expect(builds[1]!["initialMessages"]).toEqual([{ role: "assistant", content: "m1" }]);
  });

  it("rebuilds when the permission mode changes", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "auto-accept",
    });

    expect(builds).toHaveLength(2);
  });

  it("passes the project path as the agent cwd", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });

    expect(builds[0]!["cwd"]).toBe("/tmp");
  });

  it("rebuilds when the project path changes", async () => {
    const { builds, factory } = makeFactory();
    const projectStore = {
      findById: async (id: string) => ({ id, name: id, path: `/workspace/${id}`, createdAt: 0 }),
    };
    const { registry } = makeRegistry(factory, { projectStore });

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p2", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });

    expect(builds).toHaveLength(2);
    expect(builds[0]!["cwd"]).toBe("/workspace/p1");
    expect(builds[1]!["cwd"]).toBe("/workspace/p2");
  });

  it("does not truncate history when a turn fails between two successful turns", async () => {
    const { builds, factory } = makeFlakyFactory();
    const { registry } = makeRegistry(factory);
    const config = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" as const };

    await registry.runTurn("s1", "one", config); // succeeds -> history [m1]
    await registry.runTurn("s1", "two", config); // fails -> history [m1, m1b] (not shorter, kept)
    await registry.runTurn("s1", "three", config); // succeeds but reports a shorter array -> guarded, ignored

    // Force a rebuild to observe what history actually survived.
    await registry.runTurn("s1", "four", { ...config, modelId: "m2" });

    const seeded = builds.at(-1)!["initialMessages"] as Array<{ content: string }>;
    expect(seeded.some((m) => m.content === "m1")).toBe(true);
  });

  it("emits error then done and clears running when resolveConfig throws", async () => {
    const { factory } = makeFactory();
    const written: string[] = [];
    // No projectStore/providerStore configured — resolveConfig must throw.
    const registry = createSessionRegistry({ agentFactory: factory as never });
    registry.attach("s1", {
      write: (chunk: string) => written.push(chunk),
      on: () => {},
    } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", { projectId: "p1" });

    expect(registry.get("s1").running).toBe(false);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
    expect(written.some((chunk) => chunk.includes("event: done"))).toBe(true);
  });

  it("never leaks the plaintext apiKey into an SSE frame", async () => {
    const { factory } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan",
    });

    expect(written.some((chunk) => chunk.includes("sk-super-secret-token"))).toBe(false);
  });

  // -- F2: resolveConfig must reject an incomplete config instead of ------
  // -- silently falling back to the gateway's own process cwd / env model --

  it("rejects a turn with no projectId instead of falling back to the process cwd", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    // No projectId at all — this is exactly what a session migrated from a
    // pre-project-binding schema sends (see session-store.ts's migrate()).
    await registry.runTurn("s1", "one", { providerId: "v1", modelId: "m1", permissionMode: "plan" });

    // No agent was ever built for this (non-)config, so the cwd fallback in
    // wiring.ts is never reached.
    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
    expect(written.some((chunk) => chunk.includes("event: done"))).toBe(true);
    expect(registry.get("s1").running).toBe(false);
  });

  it("rejects a turn with providerId but no modelId instead of falling back to env config", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", { projectId: "p1", providerId: "v1", permissionMode: "plan" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });

  it("rejects a turn with modelId but no providerId", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", { projectId: "p1", modelId: "m1", permissionMode: "plan" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });

  it("rejects a turn with an unknown projectId rather than defaulting", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory, {
      projectStore: { findById: async () => null },
    });

    await registry.runTurn("s1", "one", { projectId: "ghost", providerId: "v1", modelId: "m1" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });
});
