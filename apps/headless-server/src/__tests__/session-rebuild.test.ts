import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState } from "@volto/core";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

/** Minimal agent stub that records how it was constructed. */
function makeFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream() {
        yield { type: "text_delta", data: { text: "hi" } };
      },
      getState: () =>
        ({ messages: [{ role: "assistant", content: "hi" }] }) as unknown as ReducerState,
    };
  };
  return { builds, factory };
}

/** A registry with a stub connection attached so runTurn is allowed to run. */
function makeRegistry(factory: ReturnType<typeof makeFactory>["factory"]) {
  const written: string[] = [];
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
    providerStore: {
      resolveModel: async () => ({ baseURL: null, apiKey: "k", code: "m" }),
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
    expect(builds[1]!["initialMessages"]).toEqual([{ role: "assistant", content: "hi" }]);
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
});
