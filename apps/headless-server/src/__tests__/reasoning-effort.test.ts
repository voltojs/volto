/**
 * Task 5 — reasoningEffort bound to a session turn, exactly parallel to
 * permissionMode: TurnConfig / ResolvedConfig / sameConfig / chatMeta all
 * carry it, createWiredAgent forwards it to createAgent(), and an
 * unsupported value is rejected — before any provider I/O, never silently
 * rewritten — by resolveConfig().
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionRegistry } from "../sessions.js";
import { createServer, type HeadlessServer } from "../server.js";
import { createStore as createJsonlStore } from "@volto/store-jsonl";
import type { ReducerState, Message, ModelPort } from "@volto/core";

/** Registries created by a test, torn down so their heartbeat timers die. */
const created: Array<{ closeAll: () => void }> = [];

afterEach(() => {
  for (const registry of created) registry.closeAll();
  created.length = 0;
});

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
 * A resolveModel stub for a custom-kind model that declares `reasoning:
 * true` — the same flag `describeModelInfo` (pi-ai) reads to derive a
 * default effort set (minimal/low/medium/high — see collection.ts).
 */
function makeReasoningProviderStore() {
  return {
    resolveModel: async () => ({
      kind: "custom" as const,
      baseURL: null,
      apiKey: "sk-secret",
      code: "m1",
      reasoning: true,
    }),
  };
}

/**
 * A resolveModel stub for a model that declares no reasoning capability at
 * all (`describeModel` returns no `reasoning` field) — the normal "switched
 * to a non-reasoning model while a stale reasoningEffort is still in flight"
 * user path, distinct from "effort not in the declared list".
 */
function makeNonReasoningProviderStore() {
  return {
    resolveModel: async () => ({
      kind: "custom" as const,
      baseURL: null,
      apiKey: "sk-secret",
      code: "m1",
    }),
  };
}

function makeRegistry(
  factory: ReturnType<typeof makeFactory>["factory"],
  overrides: { chatStore?: unknown } = {},
) {
  const registry = createSessionRegistry({
    agentFactory: factory as never,
    projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
    providerStore: makeReasoningProviderStore() as never,
    ...(overrides.chatStore ? { chatStore: overrides.chatStore as never } : {}),
  });
  registry.attach("s1", { write: () => {}, on: () => {} } as never);
  created.push(registry);
  return registry;
}

const baseConfig = { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "ask" as const };

describe("reasoningEffort — session-level unit tests (createSessionRegistry)", () => {
  it("a valid reasoningEffort reaches createAgent", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", { ...baseConfig, reasoningEffort: "low" });

    expect(builds).toHaveLength(1);
    expect(builds[0]!["reasoningEffort"]).toBe("low");
  });

  it("an omitted reasoningEffort behaves exactly as before (no key forwarded)", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", baseConfig);

    expect(builds).toHaveLength(1);
    expect(builds[0]!["reasoningEffort"]).toBeUndefined();
  });

  it("an unsupported reasoningEffort is rejected before any agent is built", async () => {
    const { factory, builds } = makeFactory();
    const written: string[] = [];
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: makeReasoningProviderStore() as never,
    });
    registry.attach("s1", { write: (chunk: string) => written.push(chunk), on: () => {} } as never);
    created.push(registry);

    await registry.runTurn("s1", "one", { ...baseConfig, reasoningEffort: "nonexistent-level" });

    expect(builds).toHaveLength(0);
    expect(written.some((chunk) => chunk.includes("event: error"))).toBe(true);
  });

  it("a reasoningEffort supplied for a model with no reasoning capability at all is rejected, not crashed or silently accepted", async () => {
    const { factory, builds } = makeFactory();
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: makeNonReasoningProviderStore() as never,
    });
    created.push(registry);

    await expect(
      registry.resolveConfig({ ...baseConfig, reasoningEffort: "low" }),
    ).rejects.toThrow(/reasoningEffort/i);
    expect(builds).toHaveLength(0);
  });

  it("resolveConfig() itself throws on an unsupported effort, without building an agent", async () => {
    const { factory, builds } = makeFactory();
    const registry = createSessionRegistry({
      agentFactory: factory as never,
      projectStore: { findById: async (id: string) => ({ id, name: id, path: "/tmp", createdAt: 0 }) } as never,
      providerStore: makeReasoningProviderStore() as never,
    });
    created.push(registry);

    await expect(
      registry.resolveConfig({ ...baseConfig, reasoningEffort: "nonexistent-level" }),
    ).rejects.toThrow(/reasoningEffort/i);
    expect(builds).toHaveLength(0);
  });

  it("rebuilds the agent when reasoningEffort changes between turns", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", { ...baseConfig, reasoningEffort: "low" });
    await registry.runTurn("s1", "two", { ...baseConfig, reasoningEffort: "high" });

    expect(builds).toHaveLength(2);
    expect(builds[0]!["reasoningEffort"]).toBe("low");
    expect(builds[1]!["reasoningEffort"]).toBe("high");
  });

  it("reuses the agent when reasoningEffort is unchanged", async () => {
    const { factory, builds } = makeFactory();
    const registry = makeRegistry(factory);

    await registry.runTurn("s1", "one", { ...baseConfig, reasoningEffort: "low" });
    await registry.runTurn("s1", "two", { ...baseConfig, reasoningEffort: "low" });

    expect(builds).toHaveLength(1);
  });

});

// -- HTTP-level: POST /messages must answer 400 (not a mid-stream SSE error) --
// -- for an unsupported effort, and never even trigger the turn. -------------

function post(
  pathname: string,
  body: unknown,
  base: string,
  token: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "Hello" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

describe("POST /messages — reasoningEffort validated before ack (HTTP level)", () => {
  let server: HeadlessServer;
  let baseUrl: string;
  let configDir: string;
  let launchToken: string;

  beforeAll(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-reasoning-effort-http-"));
    process.env["VOLTO_CONFIG_DIR"] = configDir;
    server = await createServer({ port: 0, modelPort: MOCK_MODEL });
    launchToken = server.launchToken;
    await new Promise<void>((resolve) => {
      server.on("listening", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  const openRequests: http.ClientRequest[] = [];

  afterAll(async () => {
    // SSE connections are kept alive indefinitely; server.close() only
    // invokes its callback once every socket is gone, so these must be torn
    // down explicitly first or the hook hangs forever.
    for (const req of openRequests) req.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function createProjectAndReasoningModel(): Promise<{
    projectId: string;
    providerId: string;
    modelId: string;
  }> {
    const project = await post(
      "/projects",
      { name: "reasoning-effort-test", path: process.cwd() },
      baseUrl,
      launchToken,
    );
    const provider = await post(
      "/providers",
      {
        name: "reasoning-effort-provider",
        models: [{ name: "reasoning-model", code: "reasoning-model", reasoning: true }],
      },
      baseUrl,
      launchToken,
    );
    const providerData = provider.data as { id: string; models: Array<{ id: string }> };
    return {
      projectId: (project.data as { id: string }).id,
      providerId: providerData.id,
      modelId: providerData.models[0]!.id,
    };
  }

  function openEvents(sessionId: string): void {
    const req = http.get(
      new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, baseUrl),
      { headers: { Authorization: `Bearer ${launchToken}` } },
    );
    openRequests.push(req);
  }

  it("returns 400 and never appends any transcript for an unsupported reasoningEffort", async () => {
    const sessionId = `reasoning-effort-invalid-${Date.now()}`;
    const config = await createProjectAndReasoningModel();
    openEvents(sessionId);
    // Give the SSE channel a tick to attach before POSTing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await post(
      "/messages",
      { sessionId, message: "hi", ...config, reasoningEffort: "nonexistent-level" },
      baseUrl,
      launchToken,
    );

    expect(res.status).toBe(400);

    // No agent was ever built for this turn: rebuild() is the only place
    // that ever appends a session_meta/turn_start to the jsonl store, so an
    // untouched store proves the agent factory was never reached.
    const store = createJsonlStore({ directory: path.join(configDir, "sessions") });
    const persisted = await store.readSession(sessionId);
    expect(persisted).toBeUndefined();
  });

  it("accepts (202) a valid reasoningEffort, runs the turn, and persists it into chatMeta", async () => {
    const sessionId = `reasoning-effort-valid-${Date.now()}`;
    const config = await createProjectAndReasoningModel();
    openEvents(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await post(
      "/messages",
      { sessionId, message: "hi", ...config, reasoningEffort: "low" },
      baseUrl,
      launchToken,
    );

    expect(res.status).toBe(202);

    // The turn runs asynchronously over SSE; give createAgent() time to have
    // built the agent and appended its session_meta event.
    const store = createJsonlStore({ directory: path.join(configDir, "sessions") });
    let persisted: Awaited<ReturnType<typeof store.readSession>>;
    for (let i = 0; i < 40; i++) {
      persisted = await store.readSession(sessionId);
      if (persisted) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect((persisted?.meta as { reasoningEffort?: string } | undefined)?.reasoningEffort).toBe("low");
  });

  it("GET /sessions/:id reports back the reasoningEffort a session was created with", async () => {
    const sessionId = `reasoning-effort-readback-${Date.now()}`;
    const config = await createProjectAndReasoningModel();
    openEvents(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await post(
      "/messages",
      { sessionId, message: "hi", ...config, reasoningEffort: "low" },
      baseUrl,
      launchToken,
    );

    // The turn runs asynchronously over SSE; poll GET /sessions/:id until the
    // session_meta event has landed.
    let data: { reasoningEffort?: string } | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        http.get(
          new URL(`/sessions/${encodeURIComponent(sessionId)}`, baseUrl),
          { headers: { Authorization: `Bearer ${launchToken}` } },
          (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (chunk: Buffer) => chunks.push(chunk));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }),
          );
          r.on("error", reject);
        });
      });
      if (res.status === 200) {
        data = res.data as { reasoningEffort?: string };
        if (data.reasoningEffort !== undefined) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(data?.reasoningEffort).toBe("low");
  });

  it("GET /sessions does not gain a spurious reasoningEffort key for a session created without one", async () => {
    const sessionId = `reasoning-effort-absent-${Date.now()}`;
    const config = await createProjectAndReasoningModel();
    openEvents(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await post("/messages", { sessionId, message: "hi", ...config }, baseUrl, launchToken);

    let found: { reasoningEffort?: string } | undefined;
    for (let i = 0; i < 40; i++) {
      const res = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
        http.get(
          new URL("/sessions", baseUrl),
          { headers: { Authorization: `Bearer ${launchToken}` } },
          (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (chunk: Buffer) => chunks.push(chunk));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }),
          );
          r.on("error", reject);
        });
      });
      const sessions = (res.data as { sessions: Array<{ id: string; reasoningEffort?: string }> }).sessions;
      found = sessions.find((s) => s.id === sessionId);
      if (found) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(found).toBeDefined();
    expect(found && "reasoningEffort" in found).toBe(false);
  });
});
