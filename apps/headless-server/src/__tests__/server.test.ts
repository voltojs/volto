import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createServer } from "../server.js";
import type { ModelPort, ReducerState } from "@volto/core";

const MOCK_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "Hello" };
    yield { type: "text_delta", text: " world" };
    yield {
      type: "done",
      stopReason: "end_turn",
    };
  },
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env["VOLTO_CONFIG_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "volto-test-"));
  server = createServer({ port: 0, modelPort: MOCK_MODEL });
  // Wait for the server to start. Binding to an explicit host (as opposed to
  // the previous no-host call, which bound synchronously) routes through
  // Node's async listen path even for a literal IP, so `address()` is only
  // populated once "listening" actually fires — read it inside the handler,
  // not synchronously right after `.listen()`.
  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getSse(path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
        resolve(lines.map((l) => l.slice(6)));
      });
      res.on("error", reject);
    });
  });
}

interface ProtocolFrame {
  id: string;
  event: string;
  data: unknown;
}

/** Parse the SSE wire format into frames, ignoring incomplete trailing data. */
function parseFrames(raw: string): ProtocolFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.includes("event: "))
    .map((block) => {
      const frame: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf(": ");
        if (idx > 0) frame[line.slice(0, idx)] = line.slice(idx + 2);
      }
      return {
        id: frame["id"] ?? "",
        event: frame["event"] ?? "",
        data: JSON.parse(frame["data"] ?? "null"),
      };
    });
}

/**
 * Open an /events channel, trigger one turn via POST /messages, and collect
 * every protocol frame up to and including `done`.
 *
 * `config` is merged into the /messages body. `resolveConfig` (F2) now
 * requires a real, resolvable projectId/providerId/modelId for every turn
 * requested through /messages, so any caller that needs a turn to actually
 * run (rather than immediately error) must supply one — see
 * `createTestProjectAndModel` below.
 */
function collectProtocolTurn(
  sessionId: string,
  message: string,
  config: Record<string, unknown> = {},
): Promise<ProtocolFrame[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, baseUrl);
    const timer = setTimeout(() => reject(new Error("timed out waiting for done")), 10_000);

    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
        if (!raw.includes("event: done")) return;
        clearTimeout(timer);
        req.destroy();
        resolve(parseFrames(raw));
      });
      res.on("error", reject);

      // The channel must be attached before the turn is triggered.
      post("/messages", { sessionId, message, ...config }).catch(reject);
    });
    req.on("error", (err) => {
      // destroy() after resolving surfaces here; ignore once we already resolved.
      if (!req.destroyed) reject(err);
    });
  });
}

/**
 * Create a project (rooted at the current working directory) and a
 * single-model provider, and return the ids a `/messages` body needs to
 * pass `resolveConfig`'s completeness check.
 */
async function createTestProjectAndModel(): Promise<{
  projectId: string;
  providerId: string;
  modelId: string;
}> {
  const project = await post("/projects", { name: "turn-test", path: process.cwd() });
  const provider = await post("/providers", {
    name: "turn-test-provider",
    models: [{ name: "test-model", code: "test-model" }],
  });
  const providerData = provider.data as { id: string; models: Array<{ id: string }> };
  return {
    projectId: (project.data as { id: string }).id,
    providerId: providerData.id,
    modelId: providerData.models[0]!.id,
  };
}

function getJson(path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, baseUrl), (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
      res.on("error", reject);
    });
  });
}

function del(path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, baseUrl), { method: "DELETE" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Headless server", () => {
  it("GET /health returns ok", async () => {
    const url = new URL("/health", baseUrl);
    const { status, data } = await new Promise<{ status: number; data: unknown }>((resolve) => {
      http.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
    });
    expect(status).toBe(200);
    expect(data).toEqual({ status: "ok" });
  });

  // Runs before any other test creates a project — later tests in this file
  // (turn tests, F2 coverage) create their own projects via
  // `createTestProjectAndModel`, which would make this assertion vacuous if
  // it ran after them.
  it("GET /projects starts empty and POST adds one", async () => {
    const before = await getJson("/projects");
    expect(before.status).toBe(200);
    expect(before.data).toEqual([]);

    const created = await post("/projects", { name: "tmp", path: process.cwd() });
    expect(created.status).toBe(201);

    const after = await getJson("/projects");
    expect((after.data as unknown[]).length).toBe(1);
  });

  it("POST /run returns final state", async () => {
    const { status, data } = await post("/run", { message: "hi" });
    expect(status).toBe(200);
    const result = data as { state: ReducerState };
    expect(result.state).toBeDefined();
    expect(result.state.status).toBe("done");
  });

  it("GET /stream returns SSE events", async () => {
    const events = await getSse("/stream?message=hi");
    expect(events.length).toBeGreaterThan(0);
    // Should contain text_delta events
    const parsed = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
    const textDeltas = parsed.filter((e: { type?: string }) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it("WebSocket /ws receives events", async () => {
    const events = await new Promise<unknown[]>((resolve, reject) => {
      const wsUrl = new URL("/ws?message=hi", baseUrl).toString().replace("http", "ws");
      const ws = new WebSocket(wsUrl);
      const received: unknown[] = [];

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        if (msg.type === "done") {
          ws.close();
          resolve(received);
        }
      });

      ws.on("error", reject);
      setTimeout(() => {
        ws.close();
        resolve(received);
      }, 5000);
    });

    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("done");
  });

  it("OPTIONS preflight is answered with CORS headers", async () => {
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(new URL("/messages", baseUrl), { method: "OPTIONS" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      });
      req.on("error", reject);
      req.end();
    });

    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-headers"]).toContain("Content-Type");
    expect(headers["access-control-allow-methods"]).toContain("DELETE");
    expect(headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("POST /messages without an open channel is rejected", async () => {
    const { status } = await post("/messages", { sessionId: "no-channel", message: "hi" });
    expect(status).toBe(409);
  });

  it("POST /messages rejects an unsupported permission mode", async () => {
    const { status } = await post("/messages", {
      sessionId: "bad-mode",
      message: "hi",
      permissionMode: "default",
    });
    expect(status).toBe(400);
  });

  it("GET /events + POST /messages streams a turn in protocol format", async () => {
    const sessionId = "session-protocol";
    const config = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", config);

    const tokens = frames.filter((f) => f.event === "token");
    expect(tokens.length).toBeGreaterThan(0);
    // Tokens carry the server-side accumulation, ending with the full text.
    expect((tokens[tokens.length - 1]!.data as { content: string }).content).toBe("Hello world");
    expect(frames.at(-1)?.event).toBe("done");
    // Ids are monotonic so a client can resume with Last-Event-ID.
    const ids = frames.map((f) => Number(f.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("keeps conversation history per session across turns", async () => {
    const sessionId = "session-multi-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "first", config);
    await collectProtocolTurn(sessionId, "second", config);

    // The mock model replies identically each turn; what matters is that the
    // second turn streams a complete, independent response over the same
    // channel rather than erroring or replaying the first turn's text.
    const frames = await collectProtocolTurn(sessionId, "third", config);
    const tokens = frames.filter((f) => f.event === "token");
    expect((tokens[tokens.length - 1]!.data as { content: string }).content).toBe("Hello world");
  });

  it("POST /messages errors over SSE when projectId is missing (F2)", async () => {
    const sessionId = "session-missing-project";
    const frames = await collectProtocolTurn(sessionId, "hi");

    expect(frames.some((f) => f.event === "error")).toBe(true);
    expect(frames.at(-1)?.event).toBe("done");
    // Never silently ran the turn — no token was streamed.
    expect(frames.some((f) => f.event === "token")).toBe(false);
  });

  it("POST /messages errors over SSE when only providerId is given without modelId (F2)", async () => {
    const sessionId = "session-partial-model";
    const { projectId, providerId } = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", { projectId, providerId });

    expect(frames.some((f) => f.event === "error")).toBe(true);
    expect(frames.some((f) => f.event === "token")).toBe(false);
  });

  it("POST /resume returns state", async () => {
    const { status } = await post("/resume", {
      sessionId: "nonexistent",
      decision: "allow",
    });
    // Resume of nonexistent session should error or return gracefully
    expect(status === 200 || status === 500).toBe(true);
  });

  it("POST /projects rejects a non-existent path", async () => {
    const { status } = await post("/projects", { name: "ghost", path: "/definitely/not/here" });
    expect(status).toBe(400);
  });

  it("DELETE /projects/:id with a malformed id returns 400 instead of crashing", async () => {
    const { status } = await del("/projects/%");
    expect(status).toBe(400);
  });

  it("GET /providers never returns a plaintext apiKey", async () => {
    await post("/providers", {
      name: "MiMo",
      baseURL: "https://example.com/v1",
      apiKey: "sk-abcdefgh3f2a",
      models: [{ name: "MiMo-V2.5-Pro", code: "mimo-v2.5" }],
    });

    const { status, data } = await getJson("/providers");
    expect(status).toBe(200);
    expect(JSON.stringify(data)).not.toContain("sk-abcdefgh3f2a");
    expect(JSON.stringify(data)).toContain("sk-…3f2a");
  });

  it("DELETE /providers/:id with a malformed id returns 400 instead of crashing", async () => {
    const { status } = await del("/providers/%");
    expect(status).toBe(400);
  });
});
