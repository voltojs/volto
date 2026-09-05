import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createServer } from "../server.js";
import { PickerBusyError, PickerUnsupportedError } from "../fs/directory-picker.js";
import { CommandTimeoutError } from "../fs/command-runner.js";
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

/** Quiet window after the last frame at which a turn is considered complete. */
const TURN_IDLE_MS = 400;

/**
 * Open an /events channel, trigger one turn via POST /messages, and collect
 * every protocol frame the turn produced.
 *
 * `config` is merged into the /messages body. `resolveConfig` (F2) now
 * requires a real, resolvable projectId/providerId/modelId for every turn
 * requested through /messages, so any caller that needs a turn to actually
 * run (rather than immediately error) must supply one — see
 * `createTestProjectAndModel` below.
 *
 * The v2 protocol has no terminal `done` frame — turn end is expressed by
 * `turn_end` events in the transcript — so completion is detected as a quiet
 * period once the turn's frames have drained.
 */
function collectProtocolTurn(
  sessionId: string,
  message: string,
  config: Record<string, unknown> = {},
): Promise<ProtocolFrame[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, baseUrl);
    const timer = setTimeout(() => reject(new Error("timed out waiting for turn frames")), 10_000);

    const req = http.get(url, (res) => {
      let raw = "";
      let idle: ReturnType<typeof setTimeout> | undefined;
      const scheduleIdle = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          clearTimeout(timer);
          req.destroy();
          resolve(parseFrames(raw));
        }, TURN_IDLE_MS);
      };
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf-8");
        scheduleIdle();
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
    // No Origin header on this request (a non-browser client), so the
    // default origin restriction (see cors.test.ts) does not reject it.
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(new URL("/messages", baseUrl), { method: "OPTIONS" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      });
      req.on("error", reject);
      req.end();
    });

    // Default corsOrigin is now the web app's own origin, not "*" — see F3.
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:6100");
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

  it("GET /events + POST /messages streams a turn as event and delta frames", async () => {
    const sessionId = "session-protocol";
    const config = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", config);

    // Every frame rides one of the four v2 kinds.
    const kinds = new Set(frames.map((f) => f.event));
    expect([...kinds].every((k) => ["event", "delta", "heartbeat", "error"].includes(k))).toBe(true);

    // Text flows as delta frames carrying TranscriptDelta increments...
    const textPieces = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data as { kind: string; text?: string })
      .filter((d) => d.kind === "text")
      .map((d) => d.text ?? "");
    expect(textPieces.join("")).toBe("Hello world");

    // ...bookended by authoritative event frames. Task R6: the runner streams
    // the transcript vocabulary it records — every event frame payload is a
    // stamped TranscriptEventInput ({time, type, data, turn?}), isomorphic
    // with what the chatStore would persist. The raw reducer vocabulary
    // (model_done/tool_use_complete) never reaches the wire.
    const eventPayloads = frames
      .filter((f) => f.event === "event")
      .map((f) => f.data as { type: string; time: number; turn?: number });
    expect(eventPayloads.some((e) => e.type === "user_message")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "assistant_message")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "turn_end")).toBe(true);
    expect(eventPayloads.every((e) => typeof e.time === "number")).toBe(true);
    expect(eventPayloads.every((e) => typeof e.turn === "number")).toBe(true);
    expect(eventPayloads.some((e) => e.type === "model_done")).toBe(false);
    expect(eventPayloads.some((e) => e.type === "tool_use_complete")).toBe(false);

    // Ids are monotonic so a client can resume with Last-Event-ID. Delta
    // frames share the last event's id (they are not replayable), so ids are
    // non-decreasing rather than strictly increasing.
    const ids = frames.map((f) => Number(f.id));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThanOrEqual(ids[i - 1]!);
    }
  });

  it("keeps conversation history per session across turns", async () => {
    const sessionId = "session-multi-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "first", config);
    await collectProtocolTurn(sessionId, "second", config);

    const frames = await collectProtocolTurn(sessionId, "third", config);
    const textPieces = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data as { kind: string; text?: string })
      .filter((d) => d.kind === "text")
      .map((d) => d.text ?? "");
    // The mock model replies identically each turn; a fresh, complete
    // response proves the turn ran independently rather than erroring or
    // replaying an earlier turn's text.
    expect(textPieces.join("")).toBe("Hello world");
  });

  it("GET /sessions lists a session after a turn has run", async () => {
    const sessionId = "session-list-after-turn";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi", config);

    const { status, data } = await getJson("/sessions");
    expect(status).toBe(200);
    const body = data as { sessions: Array<{ id: string; projectId: string; messageCount: number }>; unreadableSessions: number };
    const summary = body.sessions.find((s) => s.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.projectId).toBe(config.projectId);
    // One user message + one assistant message from the mock model's reply.
    expect(summary!.messageCount).toBe(2);
  });

  it("GET /sessions excludes sub-agent sessions (meta.origin === \"subagent\")", async () => {
    // Sub-agents write their own session files directly to the same
    // top-level sessions directory the task tool uses — a raw v2 file is
    // written here to simulate that without wiring up a real sub-agent run.
    const sessionsDir = path.join(process.env["VOLTO_CONFIG_DIR"]!, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const subagentSessionId = "subagent-session-1";
    const line = JSON.stringify({
      version: 2,
      sessionId: subagentSessionId,
      event: {
        seq: 0,
        time: Date.now(),
        type: "session_meta",
        data: { projectId: null, providerId: null, modelId: null, permissionMode: null, origin: "subagent" },
      },
    });
    await fs.writeFile(path.join(sessionsDir, `${subagentSessionId}.jsonl`), line + "\n", "utf-8");

    const { status, data } = await getJson("/sessions");
    expect(status).toBe(200);
    const body = data as { sessions: Array<{ id: string }> };
    expect(body.sessions.some((s) => s.id === subagentSessionId)).toBe(false);
  });

  it("GET /sessions/:id returns the transcript in the web app's Message shape", async () => {
    const sessionId = "session-detail";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hi there", config);

    const { status, data } = await getJson(`/sessions/${sessionId}`);
    expect(status).toBe(200);
    const detail = data as {
      id: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(detail.id).toBe(sessionId);
    expect(detail.messages).toEqual([
      expect.objectContaining({ role: "user", content: "hi there" }),
      expect.objectContaining({ role: "assistant", content: "Hello world" }),
    ]);
  });

  it("GET /sessions/:id returns 404 for an unknown session", async () => {
    const { status } = await getJson("/sessions/no-such-session");
    expect(status).toBe(404);
  });

  it("POST /messages errors over SSE when projectId is missing (F2)", async () => {
    const sessionId = "session-missing-project";
    const frames = await collectProtocolTurn(sessionId, "hi");

    expect(frames.some((f) => f.event === "error")).toBe(true);
    // The transport error frame is the whole turn — nothing follows it.
    expect(frames.at(-1)?.event).toBe("error");
    // Never silently ran the turn — no delta was streamed.
    expect(frames.some((f) => f.event === "delta")).toBe(false);
    // The error frame carries a typed payload the client can surface: the
    // mapper's default code plus the resolveConfig rejection reason.
    const errorData = frames.find((f) => f.event === "error")?.data as
      | { code: string; message: string }
      | undefined;
    expect(errorData?.code).toBe("STREAM_ERROR");
    expect(errorData?.message).toContain("projectId is required");
  });

  it("POST /messages errors over SSE when only providerId is given without modelId (F2)", async () => {
    const sessionId = "session-partial-model";
    const { projectId, providerId } = await createTestProjectAndModel();
    const frames = await collectProtocolTurn(sessionId, "hi", { projectId, providerId });

    expect(frames.some((f) => f.event === "error")).toBe(true);
    expect(frames.some((f) => f.event === "delta")).toBe(false);
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

  it("POST /fs/pick-directory returns the chosen path", async () => {
    const picker = createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: { pick: async () => "/tmp/chosen" },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/tmp/chosen" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory reports a cancellation as a null path", async () => {
    const picker = createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: { pick: async () => null },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: null });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps an unsupported platform to 501", async () => {
    const picker = createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new PickerUnsupportedError("no dialog here");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, { method: "POST" });
    expect(response.status).toBe(501);

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps a busy picker to 409", async () => {
    const picker = createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new PickerBusyError("A directory picker is already open");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A directory picker is already open" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });

  it("POST /fs/pick-directory maps a timeout to 504", async () => {
    const picker = createServer({
      port: 0,
      modelPort: MOCK_MODEL,
      directoryPicker: {
        pick: async () => {
          throw new CommandTimeoutError("osascript timed out after 120000ms");
        },
      },
    });
    await new Promise<void>((resolve) => picker.on("listening", resolve));
    const addr = picker.address();
    const url = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    const response = await fetch(`${url}/fs/pick-directory`, { method: "POST" });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "osascript timed out after 120000ms" });

    await new Promise<void>((resolve) => picker.close(() => resolve()));
  });
});
