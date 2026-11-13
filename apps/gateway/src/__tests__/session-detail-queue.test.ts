/**
 * Task 3 — `GET /sessions/:id` carries the undelivered steering queue.
 *
 * The web queue dock only sees entries that arrive as live SSE frames; after
 * a page reload it needs the server's durable answer. The detail route folds
 * the raw event log into `queuedMessages` (FIFO, with each entry's enqueue
 * time) so a cold load can seed the dock, and drops those same entries from
 * `messages`: the route is the chat feed, and a still-queued message must not
 * render as already sent (D16). The view projection itself keeps parking an
 * undelivered entry at its turn's end (spec scenario H) for its other
 * consumers, so the split belongs to this route.
 *
 * The transcript is written straight through the jsonl store (no live turn),
 * because the fold only needs a persisted log: `turn_start` → `user_message`
 * → `steering_queued` (+ `steering_delivered` for the delivered case).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelPort } from "@voltojs/core";
import { createStore as createJsonlStore, type JsonlSessionStore } from "@voltojs/stores/jsonl";
import { createServer, type HeadlessServer } from "../server.js";

/** Minimal model port for the legacy shared agent — no turn runs in these tests. */
const IDLE_MODEL: ModelPort = {
  async *stream() {
    yield { type: "text_delta", text: "" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

/** Deterministic base timestamp: the fold carries the event's own `time`. */
const T0 = 1_700_000_000_000;

interface DetailMessage {
  id: string;
  role: string;
  content: unknown;
  timestamp: number;
}

interface DetailResponse {
  messages: DetailMessage[];
  queuedMessages?: Array<{ id: string; content: unknown; time: number }>;
}

describe("GET /sessions/:id — undelivered steering queue", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;
  let server: HeadlessServer;
  let store: JsonlSessionStore;
  let baseUrl: string;
  let launchToken: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-session-detail-queue-"));
    // createServer writes its auth secret and creates its default chat store
    // under the config dir — point it at this test's temp dir so nothing
    // touches the real ~/.volto.
    previousConfigDir = process.env["VOLTO_CONFIG_DIR"];
    process.env["VOLTO_CONFIG_DIR"] = configDir;
    // The store the server defaults to: <config dir>/sessions. Seeded below
    // with a null workspace path, which readSession resolves by scanning every
    // workspace directory (and the top level).
    store = createJsonlStore({ directory: path.join(configDir, "sessions") });
    server = await createServer({ port: 0, modelPort: IDLE_MODEL });
    launchToken = server.launchToken;
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfigDir === undefined) delete process.env["VOLTO_CONFIG_DIR"];
    else process.env["VOLTO_CONFIG_DIR"] = previousConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function fetchDetail(sessionId: string): Promise<{ status: number; body: DetailResponse }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`/sessions/${encodeURIComponent(sessionId)}`, baseUrl);
      const req = http.request(
        url,
        {
          method: "GET",
          // A one-off agent + `Connection: close` keeps no socket alive, so
          // server.close() in afterEach resolves immediately.
          agent: false,
          headers: { Authorization: `Bearer ${launchToken}`, Connection: "close" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as DetailResponse });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  /** A minimal closed-form opening turn: no model call, just the user message. */
  async function seedOpening(sessionId: string): Promise<void> {
    await store.appendEvents(null, sessionId, [
      { time: T0, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: T0 + 10, type: "user_message", data: { content: "first" }, turn: 1 },
    ]);
  }

  it("returns the undelivered queue and keeps it out of messages", async () => {
    const sessionId = "detail-queue-pending";
    await seedOpening(sessionId);
    await store.appendEvents(null, sessionId, [
      { time: T0 + 20, type: "steering_queued", data: { id: "q1", content: "later" }, turn: 1 },
      { time: T0 + 30, type: "steering_queued", data: { id: "q2", content: "even later" }, turn: 1 },
    ]);

    const { status, body } = await fetchDetail(sessionId);

    expect(status).toBe(200);
    // FIFO is the fold's order — no extra sorting. `time` is the
    // `steering_queued` event's own time, not the read time.
    expect(body.queuedMessages).toEqual([
      { id: "q1", content: "later", time: T0 + 20 },
      { id: "q2", content: "even later", time: T0 + 30 },
    ]);
    // The chat feed carries only what was actually sent (D16) — the pending
    // entries live in the dock, never in the transcript flow.
    expect(body.messages.map((message) => message.content)).toEqual(["first"]);
  });

  it("returns an empty queue after delivery, with the message appearing once", async () => {
    const sessionId = "detail-queue-delivered";
    await seedOpening(sessionId);
    await store.appendEvents(null, sessionId, [
      { time: T0 + 20, type: "steering_queued", data: { id: "q1", content: "later" }, turn: 1 },
      { time: T0 + 40, type: "steering_delivered", data: { ids: ["q1"] }, turn: 1 },
    ]);

    const { status, body } = await fetchDetail(sessionId);

    expect(status).toBe(200);
    expect("queuedMessages" in body).toBe(true);
    expect(body.queuedMessages).toEqual([]);
    // Delivery realizes the entry into the feed exactly once: the pending
    // filter no longer matches it, and nothing duplicates it.
    expect(body.messages.filter((message) => message.content === "later")).toHaveLength(1);
  });

  it("returns [] for a session that never queued anything", async () => {
    const sessionId = "detail-queue-never";
    await seedOpening(sessionId);

    const { status, body } = await fetchDetail(sessionId);

    expect(status).toBe(200);
    // Always present: the client reads the field without a fallback branch.
    expect("queuedMessages" in body).toBe(true);
    expect(body.queuedMessages).toEqual([]);
  });

  it("orders the feed by send time when a delivered entry sits after a later message", async () => {
    const sessionId = "detail-queue-order";
    // The delivery anchor is the model call the drain fed (step 2), but the
    // entry was sent (t=T0+130) before step 1's reply (t=T0+140). The view
    // projection therefore emits it after that reply while stamping it with
    // its enqueue time — the route must hand back send order (D16), which is
    // also what the client's timestamp merge assumes.
    await store.appendEvents(null, sessionId, [
      { time: T0, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: T0 + 110, type: "user_message", data: { content: "first" }, turn: 1 },
      {
        time: T0 + 140,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "step one" }],
          stopReason: "tool_use",
          durationMs: 30,
        },
        turn: 1,
        step: 1,
      },
      { time: T0 + 130, type: "steering_queued", data: { id: "q1", content: "later" }, turn: 1 },
      { time: T0 + 150, type: "steering_delivered", data: { ids: ["q1"] }, turn: 1 },
      {
        time: T0 + 160,
        type: "model_call_start",
        data: { headerHash: "h2" },
        turn: 1,
        step: 2,
      },
      {
        time: T0 + 170,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "step two" }],
          stopReason: "end_turn",
          durationMs: 10,
        },
        turn: 1,
        step: 2,
      },
    ]);

    const { status, body } = await fetchDetail(sessionId);

    expect(status).toBe(200);
    expect(body.queuedMessages).toEqual([]);
    // `q1` before the t=T0+140 reply: the send position D16 requires.
    expect(body.messages.map((message) => message.content)).toEqual([
      "first",
      "later",
      "step one",
      "step two",
    ]);
    // And the list is timestamp-monotonic, the precondition of the client's
    // timestamp merge.
    const timestamps = body.messages.map((message) => message.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });
});
