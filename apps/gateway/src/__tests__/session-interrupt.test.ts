import { describe, it, expect, afterEach } from "vitest";
import { createSessionRegistry } from "../sessions.js";
import type { ReducerState } from "@voltojs/core";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => Promise<void> }> = [];

afterEach(async () => {
  for (const registry of created) await registry.closeAll();
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
  resolved: Record<string, unknown> = { kind: "custom", baseURL: null, apiKey: "sk-test", code: "m" },
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
  permissionMode: "ask" as const,
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
      kind: "custom",
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

/**
 * Collect the SSE frames a fake connection receives. `res.write` is the only
 * channel surface emitToSession (and push) touch; each write() carries one
 * full frame (`id: …\nevent: …\ndata: …\n\n`).
 */
function makeCapturingConnection() {
  const written: string[] = [];
  const res = { write: (chunk: string) => void written.push(chunk) } as never;
  return { res, written };
}

/** The event payloads of the `event` frames among the written chunks. */
function eventPayloadsOf(written: string[]): Array<Record<string, unknown>> {
  return written
    .filter((chunk) => chunk.includes("\nevent: event\n"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: ")) ?? "";
      return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
    });
}

describe("registry.emitToSession", () => {
  it("delivers an out-of-band event as an `event` frame to the live connection and reports delivery", async () => {
    const registry = createSessionRegistry({});
    created.push(registry);
    const conn = makeCapturingConnection();
    registry.attach("s1", conn.res as never);
    // Detach-on-attach fires on the FIRST attach of a session object only
    // when one existed; the token is minted per attach, irrelevant here.

    const delivered = registry.emitToSession("s1", {
      type: "ask_user",
      data: { callId: "ask_user-1", question: "q?", options: [], multiSelect: false },
    });

    expect(delivered).toBe(true);
    expect(conn.written.length).toBeGreaterThan(0);
    const eventFrames = eventPayloadsOf(conn.written);
    const ask = eventFrames.find((e) => e["type"] === "ask_user");
    expect(ask).toBeDefined();
    expect((ask!["data"] as Record<string, unknown>)["callId"]).toBe("ask_user-1");
    // A real emission timestamp rides the frame — the shared client treats it
    // like any transcript-stamped event.
    expect(typeof ask!["time"]).toBe("number");
  });

  it("writes to the CURRENT connection only after a reconnect supersedes the old one", async () => {
    const registry = createSessionRegistry({});
    created.push(registry);
    const first = makeCapturingConnection();
    const second = makeCapturingConnection();
    registry.attach("s1", first.res as never);
    registry.attach("s1", second.res as never);

    registry.emitToSession("s1", { type: "ask_user", data: { callId: "c1" } });

    // The superseded connection receives nothing new; the live one does.
    // (first.written holds only its own attach-time frames, never the emit.)
    expect(eventPayloadsOf(second.written).length).toBe(1);
    expect(eventPayloadsOf(first.written)).toEqual([]);
  });

  it("buffers for a connection-less session (replayable) and reports no delivery", () => {
    const registry = createSessionRegistry({});
    created.push(registry);
    registry.get("s1"); // materialise without attaching

    expect(registry.emitToSession("s1", { type: "ask_user", data: { callId: "c1" } })).toBe(false);
  });

  it("returns false for an unknown session without materialising it", () => {
    const registry = createSessionRegistry({});
    created.push(registry);

    expect(registry.emitToSession("never-seen", { type: "ask_user", data: {} })).toBe(false);
    // No phantom session entered the pool (eviction candidates, /sessions listings).
    expect(registry.size()).toBe(0);
  });

  it("keeps the approval brackets on the live channel: deny-on-interrupt settles a parked ask_user and emits approval_decision", async () => {
    // The synthesis wiring (sessions.ts's approvalHooks): a parked ask_user
    // entry settled through the fail-closed path must emit a synthetic
    // approval_decision so the web card clears even for the deny paths.
    const registry = createSessionRegistry({});
    created.push(registry);
    const conn = makeCapturingConnection();
    registry.attach("s1", conn.res as never);

    // Park a real ask_user call through the same gate the wiring hands createAgent.
    const pending = registry.get("s1").approvals.gate.ask(
      { id: "ask_user-9", name: "ask_user", input: { question: "q?" } },
      "READ_ONLY",
    );
    // The same fail-closed settlement interrupt()/detach() run (interrupt()
    // itself needs a running turn; the hook contract under test is settleAll's).
    registry.get("s1").approvals.settleAll("deny", "interrupted");

    await expect(pending).resolves.toMatchObject({ decision: "deny" });
    const eventFrames = eventPayloadsOf(conn.written);
    const asked = eventFrames.find((e) => e["type"] === "approval_asked");
    const decision = eventFrames.find((e) => e["type"] === "approval_decision");
    expect((asked!["data"] as Record<string, unknown>)["name"]).toBe("ask_user");
    expect((decision!["data"] as Record<string, unknown>)).toMatchObject({
      callId: "ask_user-9",
      decision: "deny",
    });
  });

  it("does not synthesize brackets for ordinary tool approvals (the Runner already brackets those)", async () => {
    const registry = createSessionRegistry({});
    created.push(registry);
    const conn = makeCapturingConnection();
    registry.attach("s1", conn.res as never);

    const pending = registry
      .get("s1")
      .approvals.gate.ask({ id: "call-1", name: "bash", input: {} }, "WRITE_HIGH");
    registry.get("s1").approvals.settleAll("deny", "interrupted");
    await pending;

    const types = eventPayloadsOf(conn.written).map((e) => e["type"]);
    expect(types).not.toContain("approval_asked");
    expect(types).not.toContain("approval_decision");
  });
});
