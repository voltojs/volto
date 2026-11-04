import { afterEach, describe, expect, it } from "vitest";
import { createWiredAgent } from "../wiring.js";
import { startTestServer, type TestServer } from "./helpers.js";

/**
 * D10 gateway contract: a message that lands while a session's turn latch is
 * held is STEERED into the owning turn and acked `202 { queued: true }` —
 * never a BUSY rejection, never a second concurrent turn, never a 202 for a
 * message the gateway could not deliver. An idle session still starts a
 * normal turn exactly as before.
 *
 * The settle window (spec scenario D: `turn_end` pushed, `session.running`
 * not yet released) and the cold window (latch held, first turn's agent not
 * yet built) are both constructed deterministically — a delayed transcript
 * flush widens the former, a gated agent factory holds the latter — so every
 * assertion below runs against real HTTP/SSE behavior, not timing luck.
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

/** Poll until `predicate` holds; fails loudly instead of passing silently. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** Protocol `error` frames (the BUSY rejection rides one of these). */
function errorFrames(server: TestServer): unknown[] {
  return server.rawFrames().filter((frame) => frame.event === "error");
}

/** A `steering_queued` transcript event carrying `content`. */
function sawSteeringQueued(server: TestServer, content: string): boolean {
  return server
    .events()
    .some((event) => event.type === "steering_queued" && event.data["content"] === content);
}

describe("POST /messages steering (D10)", () => {
  it("POST /messages during a running turn queues it and streams steering_queued (no BUSY)", async () => {
    // Slow model: the first turn stays in flight, holding the latch, while
    // the second message arrives.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let modelStreaming!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      modelStreaming = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream() {
          modelStreaming();
          yield { type: "text_delta", text: "thinking…" };
          await turnGate;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    // The model is streaming: latch held, agent built — mid-turn is certain.
    await modelStarted;

    const second = await postMessage(server, "second message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });

    // The steered message announces itself on the live channel with its id.
    await waitFor(
      () => sawSteeringQueued(server, "second message"),
      "steering_queued frame for the mid-turn message",
    );
    const queued = server
      .events()
      .find((event) => event.type === "steering_queued" && event.data["content"] === "second message");
    expect(typeof queued?.data["id"]).toBe("string");
    // No BUSY, no error frame of any kind, and no second turn opened.
    expect(errorFrames(server)).toEqual([]);
    expect(JSON.stringify(server.rawFrames())).not.toContain("BUSY");
    expect(server.turnCount()).toBe(1);

    releaseTurn();
    await server.captureMessages();
  });

  it("POST /messages when idle starts a turn as before", async () => {
    const server = await boot();
    await server.openEvents();

    const res = await postMessage(server, "hello");
    expect(res.status).toBe(202);
    // The normal path's ack — no `queued` flag, the turn actually runs.
    expect((await res.json()) as unknown).toEqual({
      sessionId: server.sessionId,
      accepted: true,
    });

    const messages = await server.captureMessages();
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    expect(server.turnCount()).toBe(1);
    expect(errorFrames(server)).toEqual([]);
  });

  it("a message sent after turn_end but before latch release is queued, not dropped", async () => {
    // The recorder's awaited final flush sits between the `turn_end` emit and
    // the latch release; delaying every append widens that settle window to a
    // deterministic ~500ms, so the POST below is guaranteed to land inside it.
    const server = await boot({ appendEventsDelayMs: 500 });
    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    // Resolves on `turn_end`; the latch is still held by the pending flush.
    await server.captureMessages();

    const second = await postMessage(server, "settle message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });

    // Not dropped: the settled agent queued it and announced it on the wire.
    await waitFor(
      () => sawSteeringQueued(server, "settle message"),
      "steering_queued frame for the settle-window message",
    );
    expect(errorFrames(server)).toEqual([]);
    expect(JSON.stringify(server.rawFrames())).not.toContain("BUSY");
    expect(server.turnCount()).toBe(1);
  });

  it("waits out the first turn's build window and steers instead of dropping (cold window)", async () => {
    // Gate the per-session agent build: turn 1 parks in
    // `running=true, agent=null` until the test releases it.
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let buildParking!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      buildParking = resolve;
    });
    let builds = 0;
    // The model parks too, so the channel stays alive to observe the
    // steering_queued frame regardless of how the timing plays out.
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const server = await boot({
      agentFactory: async (opts) => {
        builds += 1;
        // Call #1 is createServer's own legacy agent; the session's first
        // turn build is what the cold window is made of.
        if (builds > 1) {
          buildParking();
          await buildGate;
        }
        return createWiredAgent(opts);
      },
      modelPort: {
        async *stream() {
          yield { type: "text_delta", text: "thinking…" };
          await turnGate;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await buildStarted; // latch held, agent still null

    // Sent while the route must take the cold-window branch; released well
    // inside STEER_AGENT_WAIT_MS so the wait observes the agent materialize.
    const second = postMessage(server, "early follow-up");
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    releaseBuild();

    const res = await second;
    expect(res.status).toBe(202);
    expect((await res.json()) as unknown).toEqual({ queued: true });
    await waitFor(
      () => sawSteeringQueued(server, "early follow-up"),
      "steering_queued frame for the cold-window message",
    );
    expect(errorFrames(server)).toEqual([]);
    expect(server.turnCount()).toBe(1);

    releaseTurn();
    await server.captureMessages();
  });

  it("answers a retryable non-2xx when the first turn's agent never materializes", async () => {
    // Same gated build as above, never released while the second POST waits:
    // past the bound the route must stop waiting with a defined error — a
    // 202 here would be a 202 followed by a drop.
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let buildParking!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      buildParking = resolve;
    });
    let builds = 0;
    const server = await boot({
      agentFactory: async (opts) => {
        builds += 1;
        if (builds > 1) {
          buildParking();
          await buildGate;
        }
        return createWiredAgent(opts);
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await buildStarted;

    const res = await postMessage(server, "second message");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { queued?: unknown; error?: unknown };
    expect(body.queued).toBeUndefined();
    expect(typeof body.error).toBe("string");
    expect((body.error as string).length).toBeGreaterThan(0);
    expect(errorFrames(server)).toEqual([]);

    // Let turn 1 finish so teardown is clean.
    releaseBuild();
    await server.captureMessages();
  });
});
