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
 * Agent stub whose stream stays open until its `signal` aborts — standing in
 * for a real turn that is mid-generation. It also records the signal it was
 * handed, so a test can prove the registry forwards one at all rather than
 * merely observing that the turn ended.
 */
function makeBlockingFactory() {
  const builds: Array<Record<string, unknown>> = [];
  const seen: Array<{ signal?: AbortSignal }> = [];
  let started!: () => void;
  const firstYield = new Promise<void>((resolve) => {
    started = resolve;
  });

  const factory = (opts: Record<string, unknown>) => {
    builds.push(opts);
    return {
      async *stream(_input: string, streamOpts?: { signal?: AbortSignal }) {
        seen.push({ ...(streamOpts?.signal ? { signal: streamOpts.signal } : {}) });
        yield { type: "text_delta", data: { text: "hi" } };
        started();
        // A real runner unwinds on abort; this stub does the same, which is
        // what lets the registry's `for await` finish.
        await new Promise<void>((resolve) => {
          const signal = streamOpts?.signal;
          if (!signal) return; // never resolves — the test would time out, as it should
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      getState: () => ({ messages: [] }) as unknown as ReducerState,
    };
  };

  return { builds, seen, factory, firstYield };
}

function makeRegistry(
  factory: ReturnType<typeof makeBlockingFactory>["factory"],
  resolved: Record<string, unknown> = { baseURL: null, apiKey: "sk-test", code: "m" },
) {
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: {
      findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }),
    } as never,
    providerStore: { resolveModel: async () => resolved } as never,
  });
  registry.attach("s1", { write: () => {}, on: () => {} } as never);
  created.push(registry);
  return registry;
}

const CONFIG = {
  projectId: "p1",
  providerId: "v1",
  modelId: "m1",
  permissionMode: "plan" as const,
};

describe("registry.interrupt", () => {
  it("cancels a running turn by aborting the signal handed to stream()", async () => {
    const { factory, seen, firstYield } = makeBlockingFactory();
    const registry = makeRegistry(factory);

    const turn = registry.runTurn("s1", "hello", CONFIG);
    await firstYield;

    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect(registry.interrupt("s1")).toBe(true);

    // The turn settles only because the abort propagated — a stub that
    // ignored the signal would hang here.
    await turn;
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  it("reports false when no turn is running, so the route can answer 409", async () => {
    const { factory, firstYield } = makeBlockingFactory();
    const registry = makeRegistry(factory);

    expect(registry.interrupt("s1")).toBe(false);

    const turn = registry.runTurn("s1", "hello", CONFIG);
    await firstYield;
    registry.interrupt("s1");
    await turn;

    // A second interrupt after the turn settled must not poison the next one.
    expect(registry.interrupt("s1")).toBe(false);
  });

  it("reports false for a session that was never seen", () => {
    const { factory } = makeBlockingFactory();
    const registry = makeRegistry(factory);
    expect(registry.interrupt("never-existed")).toBe(false);
  });
});

describe("model maxOutputTokens plumbing", () => {
  it("forwards a resolved maxOutputTokens to the agent as maxTokens", async () => {
    const { factory, builds, firstYield } = makeBlockingFactory();
    const registry = makeRegistry(factory, {
      baseURL: null,
      apiKey: "sk-test",
      code: "m",
      maxOutputTokens: 4096,
    });

    const turn = registry.runTurn("s1", "hello", CONFIG);
    await firstYield;
    registry.interrupt("s1");
    await turn;

    expect(builds[0]).toMatchObject({ maxTokens: 4096 });
  });

  it("omits maxTokens entirely when the model has no cap configured", async () => {
    const { factory, builds, firstYield } = makeBlockingFactory();
    const registry = makeRegistry(factory);

    const turn = registry.runTurn("s1", "hello", CONFIG);
    await firstYield;
    registry.interrupt("s1");
    await turn;

    expect(builds[0]).not.toHaveProperty("maxTokens");
  });
});
