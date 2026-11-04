import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRequest, UserMessage } from "@volto/core";
import { DEFAULT_LOCALE, t } from "@volto/i18n";
import { createWiredAgent } from "../wiring.js";
import { startTestServer, type TestServer } from "./helpers.js";

/**
 * D14/D15 gateway contract: `POST /messages/queue` edits or withdraws a
 * QUEUED (not yet delivered) message by id, and the persistence duty splits
 * on `updateQueue`'s outcome (task-7 report §十, authoritative):
 *
 * - "live" — id in a live/carried queue: the Runner's recorder persists
 *   `steering_edited` / `steering_removed` exactly once; the gateway must
 *   persist NOTHING (exactly-once below pins that a second append never
 *   happens).
 * - "seed" — first-construction seed hit (cold session, no recorder): the
 *   GATEWAY appends the event to the chatStore itself, and the append is
 *   awaited before the 200.
 * - "missing" — unknown or already delivered (delivery wins) → 409 with
 *   `code: "QUEUE_ITEM_GONE"`, state untouched.
 *
 * Validation (empty edit content → 400) runs before anything touches the
 * queue, the same discipline as POST /approvals. Every test drives real
 * HTTP against a real server; assertions pin exact status, exact body, and
 * the exact durable events — never "output is empty".
 */

/** Servers started by a test, torn down after it so no handle leaks. */
const servers: TestServer[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers.length = 0;
});

async function boot(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const server = await startTestServer(options);
  servers.push(server);
  return server;
}

function postMessage(server: TestServer, message: string): Promise<Response> {
  return fetch(`${server.url}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: server.sessionId, message, ...server.turnConfig }),
  });
}

/**
 * POST /messages/queue — the route under test. `sessionId` defaults to the
 * test's primary session and is overridable for the cold-session scenario.
 */
function postQueue(
  server: TestServer,
  body: {
    sessionId?: string;
    id: string;
    action: { kind: "edit"; content: string } | { kind: "remove" };
  },
): Promise<Response> {
  return fetch(`${server.url}/messages/queue`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: server.sessionId, ...body }),
  });
}

/** `POST /interrupt` — cancels the turn currently streaming on the session. */
function interrupt(server: TestServer): Promise<Response> {
  return fetch(`${server.url}/interrupt`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: server.sessionId }),
  });
}

/** Poll until `predicate` holds; fails loudly instead of passing silently. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** Protocol `error` frames (the BUSY/steering rejections ride one of these). */
function errorFrames(server: TestServer): unknown[] {
  return server.rawFrames().filter((frame) => frame.event === "error");
}

/** A `steering_queued` transcript event carrying `content`. */
function sawSteeringQueued(server: TestServer, content: string): boolean {
  return server
    .events()
    .some((event) => event.type === "steering_queued" && event.data["content"] === content);
}

/** The id stamped on the `steering_queued` event for `content`. */
function queuedIdFor(server: TestServer, content: string): string | undefined {
  const queued = server
    .events()
    .find((event) => event.type === "steering_queued" && event.data["content"] === content);
  return typeof queued?.data["id"] === "string" ? (queued.data["id"] as string) : undefined;
}

/** First `.jsonl` under the temp config dir whose text contains `needle`. */
async function findTranscript(configDir: string, needle: string): Promise<string | null> {
  const entries = await fs.readdir(configDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = path.join(configDir, entry);
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text.includes(needle)) return file;
  }
  return null;
}

/**
 * Poll until `needle` is durable in the transcript — the recorder's
 * fire-and-forget flush has landed. Reads below only run against writes
 * this helper already observed, so exact-count assertions are deterministic.
 */
async function waitForTranscript(
  server: TestServer,
  needle: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await findTranscript(server.configDir, needle)) !== null) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForTranscript: "${needle}" never reached the transcript`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the turn's terminal record is durable, then yield once more.
 * `turn_end` is written by the awaited flush inside the Runner's finally, so
 * observing it on disk means every earlier record of the turn (including a
 * mid-turn `steering_edited`) is durable too — they share one flush chain.
 * The extra tick lets the settle-time auto-flush decision surface before a
 * test asserts "no second turn started".
 */
async function waitForTurnDurable(server: TestServer): Promise<void> {
  await waitForTranscript(server, '"type":"turn_end"');
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

/** Every parsed event of the primary session's transcript, in file order. */
async function primaryTranscriptEvents(server: TestServer): Promise<
  Array<{ type: string; data: Record<string, unknown> }>
> {
  const file = await findTranscript(server.configDir, '"sessionId":"test-session"');
  expect(file).not.toBeNull();
  return parseEvents(await fs.readFile(file!, "utf8"));
}

/** Parses every complete event line of a transcript; torn tail lines skip. */
function parseEvents(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { event?: { type?: string; data?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue; // a poll can catch a line mid-write — skip it, like the store's reader
    }
    if (parsed.event?.type) events.push({ type: parsed.event.type, data: parsed.event.data ?? {} });
  }
  return events;
}

describe("POST /messages/queue (D14/D15)", () => {
  it("edit on a queued message updates content and persists steering_edited", async () => {
    // Turn 1 parks mid-model so a follow-up queues behind the held latch.
    const requests: ModelRequest[] = [];
    let modelStreaming!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      modelStreaming = resolve;
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          yield { type: "text_delta", text: "thinking…" };
          modelStreaming();
          await turnGate;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();
    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await modelStarted; // turn 1 is inside the model call — mid-turn is certain

    const second = await postMessage(server, "queued message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    await waitFor(() => sawSteeringQueued(server, "queued message"), "steering_queued frame");
    const queuedId = queuedIdFor(server, "queued message");
    expect(typeof queuedId).toBe("string");

    // The route: live path → 200 { ok: true }.
    const res = await postQueue(server, {
      id: queuedId!,
      action: { kind: "edit", content: "edited message" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true });

    // The mutation reached the LIVE queue: end_turn delivers the queue
    // inside the same turn, and the model call carries the EDITED content.
    releaseTurn();
    await server.captureMessages();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toEqual(
      expect.objectContaining({ role: "user", content: "edited message" }),
    );
    expect(errorFrames(server)).toEqual([]);

    // The Runner's recorder persisted the event — EXACTLY ONCE. A second
    // record would mean the gateway appended on the live path too (contract
    // violation); zero would mean the recorder never did.
    await waitForTurnDurable(server);
    const events = await primaryTranscriptEvents(server);
    const edits = events.filter((event) => event.type === "steering_edited");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.data).toEqual({ id: queuedId, content: "edited message" });
  });

  it("remove on a queued message deletes it and persists steering_removed", async () => {
    const requests: ModelRequest[] = [];
    let modelStreaming!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      modelStreaming = resolve;
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          yield { type: "text_delta", text: "thinking…" };
          modelStreaming();
          await turnGate;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();
    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await modelStarted;

    const second = await postMessage(server, "doomed message");
    expect(second.status).toBe(202);
    await waitFor(() => sawSteeringQueued(server, "doomed message"), "steering_queued frame");
    const queuedId = queuedIdFor(server, "doomed message");
    expect(typeof queuedId).toBe("string");

    const res = await postQueue(server, { id: queuedId!, action: { kind: "remove" } });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true });

    // The queue is empty when the turn closes: no continuation call ever
    // receives the withdrawn content, and nothing is announced delivered.
    releaseTurn();
    await server.captureMessages();
    await waitForTurnDurable(server);
    // Give a (buggy) settle-time flush every chance to start, then assert
    // it did not: an intact queue would have auto-run a second turn here.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain("doomed message");
    expect(server.turnCount()).toBe(1);
    expect(server.events().filter((event) => event.type === "steering_delivered")).toEqual([]);
    expect(errorFrames(server)).toEqual([]);

    // The recorder persisted the withdrawal — exactly once, data exact.
    const events = await primaryTranscriptEvents(server);
    const removals = events.filter((event) => event.type === "steering_removed");
    expect(removals).toHaveLength(1);
    expect(removals[0]!.data).toEqual({ id: queuedId });
  });

  it("edit after delivery answers 409 QUEUE_ITEM_GONE", async () => {
    const requests: ModelRequest[] = [];
    let modelStreaming!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      modelStreaming = resolve;
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          yield { type: "text_delta", text: "thinking…" };
          modelStreaming();
          await turnGate;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();
    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await modelStarted;

    const second = await postMessage(server, "delivered message");
    expect(second.status).toBe(202);
    await waitFor(() => sawSteeringQueued(server, "delivered message"), "steering_queued frame");
    const queuedId = queuedIdFor(server, "delivered message");
    expect(typeof queuedId).toBe("string");

    // Let the turn complete so the queue DRAINS — delivery wins from here.
    releaseTurn();
    await server.captureMessages();
    await waitForTurnDurable(server);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toEqual(
      expect.objectContaining({ role: "user", content: "delivered message" }),
    );
    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);

    // A late edit must be refused with the exact decided body …
    const res = await postQueue(server, {
      id: queuedId!,
      action: { kind: "edit", content: "too late" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toEqual({
      error: t(DEFAULT_LOCALE, "server.queue.gone"),
      code: "QUEUE_ITEM_GONE",
    });

    // … and must persist nothing: no steering_edited anywhere in the log.
    const events = await primaryTranscriptEvents(server);
    expect(events.filter((event) => event.type === "steering_edited")).toEqual([]);
  });

  it("edit on a cold session works via queue rebuild", async () => {
    // Phase 1 — leave a pending queue durable: the message queues mid-turn,
    // the turn is cancelled with it still queued, and the settle-time flush
    // reads a state that omits the queue field — so the transcript keeps the
    // entry exactly like a process that died between queue and drain.
    let queueInvisible = false;
    const requests: ModelRequest[] = [];
    let warmupStreaming!: () => void;
    const warmupStarted = new Promise<void>((resolve) => {
      warmupStreaming = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "text_delta", text: "thinking…" };
            warmupStreaming();
            // Park until the cancel signal unwinds the turn — the way a
            // provider rejects its in-flight request when abort fires.
            await new Promise<void>((resolve) => {
              const signal = request.abortSignal;
              if (!signal) return; // never resolves — the test would time out, as it should
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      agentFactory: async (opts) => {
        const agent = await createWiredAgent(opts);
        // Hide the queue from the gateway's settle-time read (the documented
        // "state omits the queue field -> nothing provably queued" stance):
        // the message then survives to idle for the copy below to pick up.
        const realGetState = agent.getState.bind(agent);
        agent.getState = () => {
          const state = realGetState();
          if (!queueInvisible) return state;
          const hidden = { ...state } as { queuedUserInputs?: UserMessage[] };
          delete hidden.queuedUserInputs;
          return hidden as typeof state;
        };
        return agent;
      },
    });

    await server.openEvents();
    const first = await postMessage(server, "warmup message");
    expect(first.status).toBe(202);
    await warmupStarted;

    const second = await postMessage(server, "queued for restart");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    await waitFor(
      () => sawSteeringQueued(server, "queued for restart"),
      "steering_queued frame",
    );
    const queuedId = queuedIdFor(server, "queued for restart");
    expect(typeof queuedId).toBe("string");

    queueInvisible = true;
    const cancel = await interrupt(server);
    expect(cancel.status).toBe(202);
    await server.captureMessages();
    await waitForTurnDurable(server);
    queueInvisible = false;

    // Phase 2 — a FRESH session id over the same durable transcript: no
    // agent instance, no turn ever run. The route must rebuild it (Task 10's
    // queue fold) and hit the SEED path, where the gateway owns the event.
    const source = await findTranscript(server.configDir, "queued for restart");
    expect(source).not.toBeNull();
    const coldId = "cold-session";
    await fs.copyFile(source!, path.join(server.configDir, `${coldId}.jsonl`));

    const res = await postQueue(server, {
      sessionId: coldId,
      id: queuedId!,
      action: { kind: "edit", content: "edited after restart" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true });

    // The GATEWAY's own append (no recorder exists on a seed instance),
    // durable in the cold session's transcript before the 200 — read it
    // back directly, exactly once, with the exact payload.
    const coldEvents = parseEvents(
      await fs.readFile(path.join(server.configDir, `${coldId}.jsonl`), "utf8"),
    );
    const edits = coldEvents.filter((event) => event.type === "steering_edited");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.data).toEqual({ id: queuedId, content: "edited after restart" });

    // The rebuilt queue carries the edit through to delivery: the cold
    // session's first turn folds the transcript (queued + edited) and the
    // model receives the EDITED content, with the original id delivered.
    await server.openEvents(coldId);
    const third = await fetch(`${server.url}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: coldId, message: "hello after restart", ...server.turnConfig }),
    });
    expect(third.status).toBe(202);
    expect((await third.json()) as unknown).toEqual({
      sessionId: coldId,
      accepted: true,
    });
    await server.captureMessages();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.slice(-2).map((message) => ({
      role: message.role,
      content: message.content,
    }))).toEqual([
      { role: "user", content: "edited after restart" },
      { role: "user", content: "hello after restart" },
    ]);
    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);
    expect(errorFrames(server)).toEqual([]);
  });

  it("empty edit content answers 400", async () => {
    const server = await boot();

    // Whitespace-only edit: refused with the decided i18n body — and the
    // validation runs BEFORE the queue is looked up, so a bogus id still
    // yields this 400 rather than a 409.
    const res = await postQueue(server, {
      id: "never-queued",
      action: { kind: "edit", content: "   " },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: t(DEFAULT_LOCALE, "server.queue.emptyContent"),
    });
  });
});
