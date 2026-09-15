import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState } from "@volto/core";
import { buildPermissionReminder, isPermissionReminder } from "@volto/core";

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
  const cumulative: Array<{ id: string; role: string; content: string }> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        cumulative.push({ id: "m1", role: "assistant", content: `m${cumulative.length + 1}` });
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
          return { messages: [{ id: "m2", role: "assistant", content: "m1" }] } as unknown as ReducerState;
        }
        if (call === 2) {
          // Partial progress from the failed turn — not shorter than before.
          return {
            messages: [
              { id: "m3", role: "assistant", content: "m1" },
              { id: "m4", role: "user", content: "m1b" },
            ],
          } as unknown as ReducerState;
        }
        // call === 3: the flaky reset to a smaller build-time seed.
        return { messages: [{ id: "m5", role: "assistant", content: "m3" }] } as unknown as ReducerState;
      },
    };
  };
  return { builds, factory };
}

/** A registry with a stub connection attached so runTurn is allowed to run. */
function makeRegistry(
  factory: ReturnType<typeof makeFactory>["factory"],
  overrides: { projectStore?: unknown; extraWiring?: Record<string, unknown> } = {},
) {
  const written: string[] = [];
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: (overrides.projectStore ??
      { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) }) as never,
    providerStore: {
      // A distinctive, obviously-fake secret so the plaintext-leak test has
      // no risk of a false-negative substring match.
      resolveModel: async () => ({ kind: "custom", baseURL: null, apiKey: "sk-super-secret-token", code: "m" }),
    } as never,
    ...(overrides.extraWiring ?? {}),
  } as never);
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
    const config = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask" as const };

    await registry.runTurn("s1", "one", config);
    await registry.runTurn("s1", "two", config);

    expect(builds).toHaveLength(1);
  });

  it("rebuilds the agent and seeds history when the model changes", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p1", providerId: "v1", modelId: "m2", permissionMode: "ask",
    });

    expect(builds).toHaveLength(2);
    expect(builds[1]!["initialMessages"]).toHaveLength(1);
    expect(builds[1]!["initialMessages"]).toEqual([{ id: "m1", role: "assistant", content: "m1" }]);
  });

  it("rebuilds when the permission mode changes", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "auto",
    });

    expect(builds).toHaveLength(2);
  });

  it("passes the project path as the agent cwd", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    expect(builds[0]!["cwd"]).toBe("/tmp");
  });

  it("compaction defaults to the Plan 2 built-in when the host does not configure it", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    // Plan 2 flips the default: absent config means ON with host-chosen
    // defaults, not "never compact".
    expect(builds[0]!["compaction"]).toEqual({
      maxTokens: 60_000,
      recentKeepCount: 4,
      toolResultMaxChars: 8000,
      summaryMaxTokens: 4096,
    });
  });

  it("explicit false disables compaction", async () => {
    const { builds, factory } = makeFactory();
    const { registry } = makeRegistry(factory, { extraWiring: { compaction: false } });

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    expect(builds[0]!["compaction"]).toBeUndefined();
  });

  it("compaction passes through when explicitly configured", async () => {
    const { builds, factory } = makeFactory();
    const compaction = { maxTokens: 4000, toolResultMaxChars: 6000, summaryMaxTokens: 2048 };
    const { registry } = makeRegistry(factory, { extraWiring: { compaction } });

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    expect(builds[0]!["compaction"]).toEqual(compaction);
  });

  it("rebuilds when the project path changes", async () => {
    const { builds, factory } = makeFactory();
    const projectStore = {
      findById: async (id: string) => ({ id, name: id, path: `/workspace/${id}`, createdAt: 0 }),
    };
    const { registry } = makeRegistry(factory, { projectStore });

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p2", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    expect(builds).toHaveLength(2);
    expect(builds[0]!["cwd"]).toBe("/workspace/p1");
    expect(builds[1]!["cwd"]).toBe("/workspace/p2");
  });

  it("does not truncate history when a turn fails between two successful turns", async () => {
    const { builds, factory } = makeFlakyFactory();
    const { registry } = makeRegistry(factory);
    const config = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask" as const };

    await registry.runTurn("s1", "one", config); // succeeds -> history [m1]
    await registry.runTurn("s1", "two", config); // fails -> history [m1, m1b] (not shorter, kept)
    await registry.runTurn("s1", "three", config); // succeeds but reports a shorter array -> guarded, ignored

    // Force a rebuild to observe what history actually survived.
    await registry.runTurn("s1", "four", { ...config, modelId: "m2" });

    const seeded = builds.at(-1)!["initialMessages"] as Array<{ content: string }>;
    expect(seeded.some((m) => m.content === "m1")).toBe(true);
  });

  it("drops the stale permission reminder when a tier switch rebuilds the agent", async () => {
    // The captured history describes the OLD boundary, and the fresh agent
    // has no `_announcedPermission` to compare against, so it announces the
    // new one as a first announcement. Reseeding the old text verbatim would
    // leave the model reading "you cannot write at all" immediately followed
    // by "writes are confined to the workspace", with nothing saying which
    // one is in force -- one more contradiction per switch.
    const builds: Array<Record<string, unknown>> = [];
    const messages: Array<{ id: string; role: string; content: string }> = [
      { id: "m7", role: "user", content: buildPermissionReminder({ sandbox: "read-only", approval: "never" }) },
      { id: "m8", role: "user", content: "one" },
      { id: "m9", role: "assistant", content: "m1" },
    ];
    const factory = (opts: Record<string, unknown>) => {
      builds.push(opts);
      return {
        async *stream() {
          yield { type: "text_delta", data: { text: "hi" } };
        },
        getState: () => ({ messages: [...messages] }) as unknown as ReducerState,
      };
    };
    const { registry } = makeRegistry(factory as ReturnType<typeof makeFactory>["factory"]);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "read-only",
    });
    await registry.runTurn("s1", "two", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "auto",
    });

    expect(builds).toHaveLength(2);
    const seeded = builds[1]!["initialMessages"] as Array<{ role: string; content: string }>;
    expect(seeded.some((m) => isPermissionReminder(m as never))).toBe(false);
    // Everything that is not a reminder survives untouched.
    expect(seeded).toEqual([
      { id: "m8", role: "user", content: "one" },
      { id: "m9", role: "assistant", content: "m1" },
    ]);
  });

  it("emits an error frame and clears running when resolveConfig throws", async () => {
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
    // A config-resolution failure precedes any stream, so no turn_end exists
    // to express — the transport error frame is the whole turn, and v2 has
    // no terminal `done` frame.
    expect(written.some((chunk) => chunk.includes("event: done"))).toBe(false);
  });

  it("never leaks the plaintext apiKey into an SSE frame", async () => {
    const { factory } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
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
    await registry.runTurn("s1", "one", { providerId: "v1", modelId: "m1", permissionMode: "ask" });

    // No agent was ever built for this (non-)config, so the cwd fallback in
    // wiring.ts is never reached.
    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
    expect(registry.get("s1").running).toBe(false);
  });

  it("rejects a turn with providerId but no modelId instead of falling back to env config", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", { projectId: "p1", providerId: "v1", permissionMode: "ask" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });

  it("rejects a turn with modelId but no providerId", async () => {
    const { factory, builds } = makeFactory();
    const { registry, written } = makeRegistry(factory);

    await registry.runTurn("s1", "one", { projectId: "p1", modelId: "m1", permissionMode: "ask" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });

  it("threads a catalog credential's baseURL override into the ModelPort config", async () => {
    // The override is only useful if it survives resolveModel -> the
    // PiAiProviderConfig the agent's ModelPort is built from. Both ends have
    // their own tests (providers.ts's resolveModel, collection.ts's
    // buildCatalogProvider); this covers the projection between them.
    const { factory, builds } = makeFactory();
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: {
        resolveModel: async () => ({
          kind: "catalog",
          piProvider: "openai",
          baseURL: "https://mirror.internal/openai",
          apiKey: "sk-key",
          code: "gpt-5",
        }),
      } as never,
    });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    expect(builds).toHaveLength(1);
    expect(builds[0]!["providerConfig"]).toMatchObject({
      kind: "catalog",
      baseURL: "https://mirror.internal/openai",
    });
  });

  it("threads a catalog credential's reasoning override into the ModelPort config", async () => {
    // Same projection contract as the baseURL test above: a stored override
    // is only useful if it survives resolveModel -> PiAiProviderConfig.
    const { factory, builds } = makeFactory();
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: {
        resolveModel: async () => ({
          kind: "catalog",
          piProvider: "deepseek",
          baseURL: null,
          apiKey: "sk-key",
          code: "deepseek-v4-flash",
          reasoning: false,
        }),
      } as never,
    });
    registry.attach("s1", { write: () => {}, on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "deepseek-v4-flash", permissionMode: "ask",
    });

    expect(builds).toHaveLength(1);
    expect(builds[0]!["providerConfig"]).toMatchObject({
      kind: "catalog",
      modelCodes: ["deepseek-v4-flash"],
      reasoningOverrides: { "deepseek-v4-flash": false },
    });
  });

  // -- Task 4: a catalog-kind credential now builds a real agent, targeted --
  // -- at the resolved provider/model, not a default OpenAI-bound one. ------

  it("builds a real agent for a catalog-kind credential, targeting the resolved provider rather than a default", async () => {
    const { factory, builds } = makeFactory();
    const written: string[] = [];
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: {
        resolveModel: async () => ({
          kind: "catalog",
          piProvider: "openai",
          apiKey: "sk-super-secret-token",
          code: "gpt-5",
        }),
      } as never,
    });
    registry.attach("s1", {
      write: (chunk: string) => written.push(chunk),
      on: () => {},
    } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", {
      projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask",
    });

    // A real agent is now built — the catalog-kind path is wired, not
    // rejected before ever reaching agentFactory.
    expect(builds).toHaveLength(1);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(false);
    expect(registry.get("s1").running).toBe(false);

    // The build targets the resolved catalog provider/model, not a default:
    // "v1" (this turn's providerId) and "openai" (this credential's
    // piProvider) both surface, and the model is "gpt-5", not DEFAULT_MODEL.
    const providerConfig = builds[0]!["providerConfig"] as {
      kind: string;
      id: string;
      piProvider: string;
      modelCodes: string[];
    };
    expect(providerConfig.kind).toBe("catalog");
    expect(providerConfig.id).toBe("v1");
    expect(providerConfig.piProvider).toBe("openai");
    expect(providerConfig.modelCodes).toEqual(["gpt-5"]);
    expect(builds[0]!["model"]).toBe("gpt-5");

    // The apiKey never leaks into the SSE stream either.
    expect(written.some((chunk) => chunk.includes("sk-super-secret-token"))).toBe(false);

    // No override configured: the PiAiProviderConfig must carry no baseURL at
    // all, leaving pi-ai's own catalog address in place. An explicit
    // `baseURL: undefined` would be indistinguishable here but is what a
    // careless spread produces, so this asserts absence, not falsiness.
    expect("baseURL" in providerConfig).toBe(false);
  });

  // -- I3: an omitted permissionMode must resolve to the narrowest working --
  // -- tier ("ask"), not silently fall through to an unwired, wide-open -----
  // -- agent (no permissionConfig / sandboxMode / approvalGate at all). -----

  it("wires a permissionConfig/sandboxMode/approvalGate even when permissionMode is omitted", async () => {
    const { factory, builds } = makeFactory();
    const { registry } = makeRegistry(factory);

    // No permissionMode at all — exactly what an omitted field on
    // POST /messages looks like.
    await registry.runTurn("s1", "one", { projectId: "p1", providerId: "v1", modelId: "m1" });

    expect(builds).toHaveLength(1);
    expect(builds[0]!["permissionConfig"]).toBeDefined();
    expect(builds[0]!["sandboxMode"]).toBeDefined();
    expect(builds[0]!["approvalGate"]).toBeDefined();
    // An omitted mode on POST /messages must resolve to "ask" specifically —
    // not merely "some preset" — since that is the one behaviour the
    // EMPTY_CONFIG fix below must not disturb.
    expect(builds[0]!["permissionConfig"]).toMatchObject({ approval: "ask" });
  });

  // -- Regression: EMPTY_CONFIG backs ensureAgent(), which is the legacy ----
  // -- POST /run route's construction path. That route is a blocking JSON ---
  // -- response with no event channel at all — no SSE, no way for a client --
  // -- to learn a pending approval's callId, and interrupt() can't rescue ---
  // -- it either (it requires session.running, which only runTurn() sets). -
  // -- If EMPTY_CONFIG's preset ever had approval: "ask" again, the first ---
  // -- WRITE_HIGH tool call on this route would park on the gate forever ----
  // -- with nobody able to answer it. -----------------------------------------
  it("gives the legacy /run path (ensureAgent) a permission preset that can never park on the approval gate", async () => {
    const { factory, builds } = makeFactory();
    const { registry } = makeRegistry(factory);

    await registry.ensureAgent("legacy-session");

    expect(builds).toHaveLength(1);
    expect(builds[0]!["permissionConfig"]).toMatchObject({ approval: "never" });
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
