/**
 * M8 port default implementations — smoke tests.
 *
 * Each default is exercised to verify basic contract compliance:
 * - Methods are callable
 * - Return types match the interface
 * - Semantic behavior is correct (no-op, allow-all, throw-if-called, etc.)
 */

import { describe, it, expect } from "vitest";
import {
  defaultToolSource,
  createDefaultMemoryStore,
  defaultEmbedder,
  defaultTelemetry,
  createDefaultCache,
  defaultSandbox,
  defaultSecrets,
  defaultScheduler,
  defaultPolicyEngine,
} from "../defaults.js";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textScript } from "@voltojs/core";

// ──────────────────────────────────────────────
// ToolSource
// ──────────────────────────────────────────────

describe("defaultToolSource", () => {
  it("list() returns an empty array", async () => {
    const tools = await defaultToolSource.list();
    expect(tools).toEqual([]);
  });

  it("onChange is not defined (optional)", () => {
    expect(defaultToolSource.onChange).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// MemoryStore
// ──────────────────────────────────────────────

describe("createDefaultMemoryStore", () => {
  it("save + query round-trips entries", async () => {
    const store = createDefaultMemoryStore();
    await store.save({ id: "a1", text: "hello world", metadata: { tag: "greeting" } });
    await store.save({ id: "a2", text: "goodbye world" });

    const results = await store.query("world", 10);
    expect(results.length).toBe(2);
    expect(results.map((e) => e.id).sort()).toEqual(["a1", "a2"]);
  });

  it("query respects k limit", async () => {
    const store = createDefaultMemoryStore();
    await store.save({ id: "b1", text: "one" });
    await store.save({ id: "b2", text: "two" });
    await store.save({ id: "b3", text: "three" });

    const results = await store.query("", 2);
    expect(results.length).toBe(2);
  });

  it("filtered queries return nothing instead of leaking across scopes", async () => {
    const store = createDefaultMemoryStore();
    await store.save({
      id: "d1",
      text: "alpha",
      scope: { kind: "project", projectId: "pA" },
    });
    await store.save({
      id: "d2",
      text: "beta",
      scope: { kind: "project", projectId: "pB" },
    });

    // The inert default cannot honor scope/tier semantics; any filter must
    // yield nothing rather than silently crossing project boundaries.
    const scoped = await store.query("alpha", 10, {
      projectId: "pA",
      includeGlobal: false,
    });
    expect(scoped).toEqual([]);

    const emptyFilter = await store.query("alpha", 10, {});
    expect(emptyFilter).toEqual([]);

    const tierOnly = await store.query("alpha", 10, { tier: "semantic" });
    expect(tierOnly).toEqual([]);

    // No filter keeps the naive advanced-use behavior.
    const unfiltered = await store.query("alpha", 10);
    expect(unfiltered.map((e) => e.id).sort()).toEqual(["d1", "d2"]);
  });

  it("delete removes an entry", async () => {
    const store = createDefaultMemoryStore();
    await store.save({ id: "c1", text: "ephemeral" });

    const deleted = await store.delete("c1");
    expect(deleted).toBe(true);

    const results = await store.query("ephemeral");
    expect(results.length).toBe(0);
  });

  it("delete returns false for unknown id", async () => {
    const store = createDefaultMemoryStore();
    const deleted = await store.delete("nonexistent");
    expect(deleted).toBe(false);
  });
});

// ──────────────────────────────────────────────
// Embedder
// ──────────────────────────────────────────────

describe("defaultEmbedder", () => {
  it("embed() rejects with configuration error", async () => {
    await expect(defaultEmbedder.embed(["hello"])).rejects.toThrow(/No Embedder configured/);
  });
});

// ──────────────────────────────────────────────
// Telemetry
// ──────────────────────────────────────────────

describe("defaultTelemetry", () => {
  it("startSpan returns a span with no-op methods", () => {
    const span = defaultTelemetry.startSpan("test.span", { key: "value" });
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.end).toBe("function");

    // Should not throw
    span.setAttribute("foo", "bar");
    span.end();
  });

  it("metric() does not throw", () => {
    expect(() => {
      defaultTelemetry.metric("requests.count", 42, { endpoint: "/api" });
    }).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// Cache
// ──────────────────────────────────────────────

describe("createDefaultCache", () => {
  it("get returns undefined for missing keys", async () => {
    const cache = createDefaultCache();
    const value = await cache.get("missing");
    expect(value).toBeUndefined();
  });

  it("set + get round-trips values", async () => {
    const cache = createDefaultCache();
    await cache.set("key1", { data: 42 });
    const value = await cache.get<{ data: number }>("key1");
    expect(value).toEqual({ data: 42 });
  });

  it("delete removes a key", async () => {
    const cache = createDefaultCache();
    await cache.set("key2", "value");
    const deleted = await cache.delete("key2");
    expect(deleted).toBe(true);
    expect(await cache.get("key2")).toBeUndefined();
  });

  it("delete returns false for missing keys", async () => {
    const cache = createDefaultCache();
    const deleted = await cache.delete("nonexistent");
    expect(deleted).toBe(false);
  });

  it("TTL expiry: expired entries return undefined", async () => {
    const cache = createDefaultCache();
    // Set with 1ms TTL
    await cache.set("short-lived", "data", 1);
    // Wait a tick for expiry
    await new Promise((r) => setTimeout(r, 10));
    const value = await cache.get("short-lived");
    expect(value).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// Sandbox
// ──────────────────────────────────────────────

describe("defaultSandbox", () => {
  it("run() throws configuration error", () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _iter = defaultSandbox.run({ command: "echo" });
    }).toThrow(/No Sandbox configured/);
  });
});

// ──────────────────────────────────────────────
// Secrets
// ──────────────────────────────────────────────

describe("defaultSecrets", () => {
  it("resolve() returns undefined for any ref", async () => {
    const value = await defaultSecrets.resolve("MY_API_KEY");
    expect(value).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// Scheduler
// ──────────────────────────────────────────────

describe("defaultScheduler", () => {
  it("schedule() returns a string id", async () => {
    const id = await defaultScheduler.schedule(1000, "task-ref");
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^sched-/);
  });

  it("cancel() returns false (nothing to cancel)", async () => {
    const result = await defaultScheduler.cancel("some-id");
    expect(result).toBe(false);
  });

  it("sleep() resolves immediately", async () => {
    const start = Date.now();
    await defaultScheduler.sleep(10_000);
    const elapsed = Date.now() - start;
    // Should resolve nearly instantly, not wait 10s
    expect(elapsed).toBeLessThan(100);
  });
});

// ──────────────────────────────────────────────
// PolicyEngine
// ──────────────────────────────────────────────

describe("defaultPolicyEngine", () => {
  it("evaluate() returns 'allow' for any request", async () => {
    const result = await defaultPolicyEngine.evaluate({
      action: "shell:exec",
      principal: "user",
      context: { dangerous: true },
    });
    expect(result).toBe("allow");
  });
});

// ──────────────────────────────────────────────
// Integration: createAgent with minimal config
// ──────────────────────────────────────────────

describe("createAgent minimal config (modelPort only)", () => {
  it("agent.ports exposes all M8 ports with defaults", () => {
    const modelPort = createMockModelPort([textScript("hi")]);
    const agent = createAgent({ modelPort });

    expect(agent.ports).toBeDefined();
    expect(agent.ports.toolSource).toBeDefined();
    expect(agent.ports.memoryStore).toBeDefined();
    expect(agent.ports.embedder).toBeDefined();
    expect(agent.ports.telemetry).toBeDefined();
    expect(agent.ports.cache).toBeDefined();
    expect(agent.ports.sandbox).toBeDefined();
    expect(agent.ports.secrets).toBeDefined();
    expect(agent.ports.scheduler).toBeDefined();
    expect(agent.ports.policyEngine).toBeDefined();
  });

  it("minimal config can run a turn (regression)", async () => {
    const modelPort = createMockModelPort([textScript("hello")]);
    const agent = createAgent({ modelPort });

    const state = await agent.run("hi");
    expect(state.status).toBe("done");
    expect(state.messages.length).toBeGreaterThan(0);
  });
});
