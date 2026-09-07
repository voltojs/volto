import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createServer } from "../server.js";
import { PickerBusyError, PickerUnsupportedError } from "../fs/directory-picker.js";
import { CommandTimeoutError } from "../fs/command-runner.js";
import {
  applyPartial,
  buildTurnRecords,
  createMockModelPort,
  textScript,
  toConversationView,
  toolCallScript,
} from "@volto/core";
import type {
  ConversationMessage,
  ModelPort,
  ReducerState,
  TranscriptDelta,
  TranscriptEvent,
  TranscriptEventInput,
  TurnRecord,
} from "@volto/core";

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

function post(path: string, body: unknown, base: string = baseUrl): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
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
  base: string = baseUrl,
): Promise<ProtocolFrame[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
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
      post("/messages", { sessionId, message, ...config }, base).catch(reject);
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

let sessionCounter = 0;

/**
 * Creates a project/provider/model, opens an /events channel, and runs one
 * turn on a fresh session id — the "session that has already run a turn"
 * precondition several tests need (e.g. the PATCH /sessions/:id rename
 * tests). Factored out of the steps `GET /sessions lists a session after a
 * turn has run` already used, since no such helper existed yet in this file.
 */
async function startSessionWithOneTurn(): Promise<string> {
  const sessionId = `session-one-turn-${++sessionCounter}`;
  const config = await createTestProjectAndModel();
  await collectProtocolTurn(sessionId, "hi", config);
  return sessionId;
}

function getJson(path: string, base: string = baseUrl): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), (res) => {
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

/**
 * Boots a dedicated server instance on an ephemeral port with its own model
 * port — the pattern the directory-picker tests use. Project/provider ids
 * created through any server in this file resolve here too: those stores are
 * file-backed under VOLTO_CONFIG_DIR and re-read on every call.
 */
async function startEphemeralServer(
  modelPort: ModelPort,
): Promise<{ base: string; close(): Promise<void> }> {
  const instance = createServer({ port: 0, modelPort });
  await new Promise<void>((resolve) => instance.on("listening", resolve));
  const addr = instance.address();
  const base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  return { base, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

/** Resolves once `pred` holds (polling every 25ms); rejects after `timeoutMs`. */
async function until(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Opens a raw /events SSE channel and collects every protocol frame into
 * `frames` — parsed incrementally, keeping any incomplete trailing block
 * buffered — until `stop()` destroys the connection. Unlike
 * `collectProtocolTurn` this never triggers a turn and never resolves on its
 * own: the caller decides when to abort, which is what the reconnection
 * regression needs.
 */
function openEventChannel(
  sessionId: string,
  lastEventId: string | undefined,
  base: string,
): { frames: ProtocolFrame[]; opened: Promise<void>; stop(): void } {
  const frames: ProtocolFrame[] = [];
  const url = new URL(`/events?sessionId=${encodeURIComponent(sessionId)}`, base);
  let signalOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    signalOpen = resolve;
  });

  const handleResponse = (res: http.IncomingMessage): void => {
    signalOpen();
    let raw = "";
    res.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf-8");
      const blocks = raw.split("\n\n");
      raw = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.includes("event: ")) continue; // the ": connected" comment
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const idx = line.indexOf(": ");
          if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
        }
        frames.push({
          id: fields["id"] ?? "",
          event: fields["event"] ?? "",
          data: JSON.parse(fields["data"] ?? "null"),
        });
      }
    });
    res.on("error", () => {
      // The deliberate destroy() below surfaces here — expected, not a failure.
    });
  };

  const req =
    lastEventId !== undefined
      ? http.get(url, { headers: { "last-event-id": lastEventId } }, handleResponse)
      : http.get(url, handleResponse);
  req.on("error", () => {
    // Same story on the request side: destroy() rejects the socket.
  });

  return { frames, opened, stop: () => req.destroy() };
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

  it("GET /skills lists discovered skills with their invocation flags", async () => {
    const response = await fetch(`${baseUrl}/skills`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      skills: Array<{ name: string; description: string; modelInvocable: boolean; userInvocable: boolean }>;
    };
    expect(Array.isArray(body.skills)).toBe(true);
    for (const skill of body.skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.modelInvocable).toBe("boolean");
      expect(typeof skill.userInvocable).toBe("boolean");
    }
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

  it("GET /skills?projectId= scopes discovery to that project's directory", async () => {
    // Build a project directory with a skill that exists ONLY here — never
    // under the process cwd this test suite runs from — so a passing
    // assertion can only be explained by the projectId path actually
    // resolving to this directory, not by coincidentally reusing the
    // process-cwd scan.
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-skills-project-"));
    const skillDir = path.join(projectDir, ".claude", "skills", "task11-fixture-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: task11-fixture-skill",
        "description: Fixture skill that only exists under the test project directory.",
        "---",
        "Fixture body.",
        "",
      ].join("\n"),
    );

    const project = await post("/projects", { name: "skills-fixture-project", path: projectDir });
    expect(project.status).toBe(201);
    const projectId = (project.data as { id: string }).id;

    // The process-wide default (no projectId) must NOT see the fixture skill —
    // otherwise the two code paths would be indistinguishable.
    const defaultResponse = await getJson("/skills");
    const defaultBody = defaultResponse.data as { skills: Array<{ name: string }> };
    expect(defaultBody.skills.some((s) => s.name === "task11-fixture-skill")).toBe(false);

    // The project-scoped request must see it.
    const scopedResponse = await getJson(`/skills?projectId=${encodeURIComponent(projectId)}`);
    expect(scopedResponse.status).toBe(200);
    const scopedBody = scopedResponse.data as { skills: Array<{ name: string }> };
    expect(scopedBody.skills.some((s) => s.name === "task11-fixture-skill")).toBe(true);
  });

  it("GET /skills?projectId=<unknown> returns 404 without falling back to the process cwd", async () => {
    const { status, data } = await getJson("/skills?projectId=nonexistent");
    expect(status).toBe(404);
    expect(data).toEqual({ error: "Unknown project: nonexistent" });
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

  // §九 P2-1: the live/history consistency gate. The SSE stream and the
  // session store are two transports for the same transcript; this proves a
  // client that projects the stream exactly the way apps/web does lands on
  // the very conversation the server persists — deep-equal, including every
  // tool_call.result folded back into its call.
  it("reconstructs the stored ConversationView from the live event/delta stream (consistency gate)", { timeout: 15_000 }, async () => {
    // A tool-calling turn needs a scripted model — the shared MOCK_MODEL is
    // text-only — so this boots its own server (the picker tests' pattern).
    // `ls` is READ_ONLY, so the default permission policy (READ_ONLY: allow)
    // executes it without an approval round-trip.
    const toolModel = createMockModelPort([
      toolCallScript("call-gate-1", "ls", JSON.stringify({ path: "." })),
      textScript("done"),
    ]);
    const toolServer = await startEphemeralServer(toolModel);
    try {
      const base = toolServer.base;
      const sessionId = "session-consistency-gate";
      const project = await post("/projects", { name: "gate-project", path: process.cwd() }, base);
      const provider = await post(
        "/providers",
        { name: "gate-provider", models: [{ name: "gate-model", code: "gate-model" }] },
        base,
      );
      const config = {
        projectId: (project.data as { id: string }).id,
        providerId: (provider.data as { id: string }).id,
        modelId: (provider.data as { models: Array<{ id: string }> }).models[0]!.id,
      };

      const frames = await collectProtocolTurn(sessionId, "list this directory", config, base);

      // Premise: the turn really did call a tool and got a result back.
      const eventTypes = frames
        .filter((f) => f.event === "event")
        .map((f) => (f.data as { type: string }).type);
      expect(eventTypes).toContain("tool_call");
      expect(eventTypes).toContain("tool_result");

      // The live reconstruction, exactly the way apps/web does it: event
      // frames are the authoritative transcript (seq synthesized by arrival
      // index — the projection never reads seq), delta frames fold into the
      // open step as streaming partials that the next authoritative event
      // supersedes.
      const liveEvents: TranscriptEvent[] = [];
      let records: TurnRecord[] = [];
      for (const frame of frames) {
        if (frame.event === "event") {
          liveEvents.push({ ...(frame.data as TranscriptEventInput), seq: liveEvents.length });
          records = buildTurnRecords(liveEvents, records);
        } else if (frame.event === "delta") {
          records = applyPartial(records, frame.data as TranscriptDelta);
        }
      }
      const live = toConversationView(records);

      // The history side: what GET /sessions/:id projects from the persisted
      // transcript (readConversation = toConversationView(buildTurnRecords)).
      const detail = await getJson(`/sessions/${sessionId}`, base);
      expect(detail.status).toBe(200);
      const stored = (detail.data as { messages: ConversationMessage[] }).messages;

      // THE GATE: deep equality between the live view and the stored view.
      expect(live.messages).toEqual(stored);

      // The tool result the gate exists to cover is real tool output, not a
      // metadata summary.
      const calls = live.messages
        .flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === "tool_call" ? [b.call] : []));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("ls");
      expect(calls[0]!.isError).toBe(false);
      expect(calls[0]!.result).toContain("package.json");
    } finally {
      await toolServer.close();
    }
  });

  // §九 P2-2: deltas are not replayable — a client reconnecting with
  // Last-Event-ID must receive only authoritative event frames, and must not
  // lose any of them while it was away.
  it("replays only event frames (never deltas) to a client reconnecting with Last-Event-ID", { timeout: 15_000 }, async () => {
    // The shared MOCK_MODEL streams its two text deltas back-to-back, so TCP
    // would likely coalesce the whole turn into one chunk and a "mid-turn"
    // abort would land after the fact. A dedicated server whose model pauses
    // after the first delta makes the mid-stream abort deterministic.
    const slowModel: ModelPort = {
      async *stream() {
        yield { type: "text_delta", text: "Hello" };
        await new Promise((resolve) => setTimeout(resolve, 250));
        yield { type: "text_delta", text: " world" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const slowServer = await startEphemeralServer(slowModel);
    try {
      const base = slowServer.base;
      const sessionId = "session-delta-replay";
      // Project/provider ids resolve on any server in this file — the stores
      // are file-backed under VOLTO_CONFIG_DIR and re-read per call.
      const config = await createTestProjectAndModel();

      // ── Connection A: attach, trigger the turn, abort mid-stream. ──
      const channelA = openEventChannel(sessionId, undefined, base);
      await channelA.opened;
      const postResult = await post("/messages", { sessionId, message: "hi", ...config }, base);
      expect(postResult.status).toBe(202);
      await until(
        () => channelA.frames.some((f) => f.event === "delta"),
        5_000,
        "timed out waiting for the first delta frame",
      );
      channelA.stop();

      // Premise guards: the abort really landed mid-stream — deltas had
      // arrived, the turn had not ended.
      expect(channelA.frames.some((f) => f.event === "delta")).toBe(true);
      expect(
        channelA.frames.some(
          (f) => f.event === "event" && (f.data as { type?: string }).type === "turn_end",
        ),
      ).toBe(false);

      // Let the turn finish: poll the durable transcript until the assistant
      // reply has been recorded (user + assistant = 2 messages). By this
      // point every text delta has already been pushed, so the reconnect
      // below can only ever see event frames.
      await until(
        async () => {
          const { status, data } = await getJson(`/sessions/${sessionId}`, base);
          return status === 200 && (data as { messages: unknown[] }).messages.length >= 2;
        },
        5_000,
        "timed out waiting for the turn to persist its messages",
      );

      // ── Connection B: reconnect with Last-Event-ID. ──
      // A well-behaved client advances its cursor on replayable (event)
      // frames only — delta frames deliberately repeat the last event's id so
      // they never advance it. The cursor here sits on the first event frame
      // connection A had processed (turn_start), so everything authoritative
      // from user_message onward must come back.
      const lastEventId = channelA.frames.find((f) => f.event === "event")!.id;
      const channelB = openEventChannel(sessionId, lastEventId, base);
      await channelB.opened;
      await until(
        () =>
          channelB.frames.some(
            (f) => f.event === "event" && (f.data as { type?: string }).type === "turn_end",
          ),
        10_000,
        "timed out waiting for turn_end on the reconnected channel",
      );
      channelB.stop();

      const replayed = channelB.frames;

      // THE GATE: nothing the reconnect delivers is a delta frame. The replay
      // buffer only ever holds event frames, and by the time B attached the
      // turn had finished streaming — so every frame here is a replay.
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.every((f) => f.event === "event")).toBe(true);

      // Nothing authoritative was lost while A was away: the turn's key
      // events all came back.
      const replayedTypes = replayed.map((f) => (f.data as { type?: string }).type);
      expect(replayedTypes).toContain("user_message");
      expect(replayedTypes).toContain("assistant_message");
      expect(replayedTypes).toContain("turn_end");

      // The authoritative assistant_message carries the full reply on its own
      // — a client that lost every delta still reconstructs it.
      const assistant = replayed.find(
        (f) => (f.data as { type?: string }).type === "assistant_message",
      )!.data as TranscriptEventInput;
      const assistantContent = assistant.data as { content: Array<{ type: string; text?: string }> };
      expect(
        assistantContent.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      ).toBe("Hello world");

      // Replay semantics: only frames strictly newer than the cursor.
      expect(replayed.every((f) => Number(f.id) > Number(lastEventId))).toBe(true);
    } finally {
      await slowServer.close();
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

  it("GET /sessions includes the stored title", async () => {
    const sessionId = "session-with-title";
    const config = await createTestProjectAndModel();
    await collectProtocolTurn(sessionId, "hello", config);

    const response = await fetch(`${baseUrl}/sessions`);
    const body = (await response.json()) as { sessions: Array<{ id: string; title: string }> };
    const session = body.sessions.find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(typeof session!.title).toBe("string");
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
    const { status, data } = await getJson("/sessions/no-such-session");
    expect(status).toBe(404);
    expect((data as { error: string }).error).toContain("no-such-session");
  });

  describe("DELETE /sessions/:id", () => {
    it("removes the session from the list and the detail endpoint", async () => {
      const sessionId = await startSessionWithOneTurn();
      const response = await fetch(`${baseUrl}/sessions/${sessionId}`, { method: "DELETE" });
      expect(response.status).toBe(204);

      const list = await fetch(`${baseUrl}/sessions`);
      const body = (await list.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.some((s) => s.id === sessionId)).toBe(false);

      const detail = await fetch(`${baseUrl}/sessions/${sessionId}`);
      expect(detail.status).toBe(404);
    });

    it("404s an unknown session", async () => {
      const response = await fetch(`${baseUrl}/sessions/nope`, { method: "DELETE" });
      expect(response.status).toBe(404);
      // Asserting the status alone would still pass if the route were deleted
      // entirely (the server's catch-all also 404s) — pin the body too, so
      // this actually verifies the DELETE handler ran its own not-found check.
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("nope");
    });
  });

  describe("PATCH /sessions/:id", () => {
    it("stores a title that the list endpoint reads back", async () => {
      const sessionId = await startSessionWithOneTurn();
      const patch = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "重构上下文注入" }),
      });
      expect(patch.status).toBe(204);

      const list = await fetch(`${baseUrl}/sessions`);
      const body = (await list.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.find((s) => s.id === sessionId)?.title).toBe("重构上下文注入");
    });

    it("rejects an empty or over-long title", async () => {
      const sessionId = await startSessionWithOneTurn();
      for (const title of ["", "x".repeat(201)]) {
        const response = await fetch(`${baseUrl}/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
        expect(response.status).toBe(400);
      }
    });

    it("404s an unknown session", async () => {
      const response = await fetch(`${baseUrl}/sessions/nope`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(response.status).toBe(404);
    });

    it("preserves the session's other meta fields (projectId/providerId/modelId/permissionMode)", async () => {
      const sessionId = await startSessionWithOneTurn();
      const before = await getJson(`/sessions/${sessionId}`);
      const beforeDetail = before.data as {
        projectId?: string;
        providerId?: string;
        modelId?: string;
        permissionMode?: string;
      };

      const patch = await fetch(`${baseUrl}/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "renamed" }),
      });
      expect(patch.status).toBe(204);

      const after = await getJson(`/sessions/${sessionId}`);
      const afterDetail = after.data as {
        projectId?: string;
        providerId?: string;
        modelId?: string;
        permissionMode?: string;
      };
      expect(afterDetail.projectId).toBe(beforeDetail.projectId);
      expect(afterDetail.providerId).toBe(beforeDetail.providerId);
      expect(afterDetail.modelId).toBe(beforeDetail.modelId);
      expect(afterDetail.permissionMode).toBe(beforeDetail.permissionMode);
    });
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
