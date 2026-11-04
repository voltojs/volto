import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "@volto/core";
import { DEFAULT_LOCALE, t } from "@volto/i18n";
import { createWiredAgent } from "../wiring.js";
import { startTestServer, type TestServer } from "./helpers.js";

/**
 * D10 gateway contract: a message that lands while a session's turn latch is
 * held is STEERED into the owning turn and acked `202 { queued: true }` —
 * never a BUSY rejection, never a second concurrent turn, never a 202 for a
 * message the gateway could not deliver. An idle session still starts a
 * normal turn exactly as before.
 *
 * Task 9 (D2/D3): steering is only half the contract — a turn that SETTLES
 * with messages still queued must auto-run them as a follow-up turn before
 * the latch releases (cancel → flush, settle-window steer → flush), and a
 * queue that never drains must stop at the round cap with a visible error
 * rather than hold the session forever.
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

/** Number of terminal `turn_end` transcript events seen so far. */
function turnEndCount(server: TestServer): number {
  return server.events().filter((event) => event.type === "turn_end").length;
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

  it("steer landing during captureHistory is delivered by the settle-time flush", async () => {
    // The recorder's awaited final flush sits between the `turn_end` emit and
    // the latch release; delaying every append widens that settle window to a
    // deterministic ~500ms, so the POST below is guaranteed to land inside it
    // — after `turn_end`, before captureHistory, latch still held. That is
    // also pre-commit: run()'s `return state` snapshot is already bound, so
    // the steer reaches only the Runner's live state until the end-of-turn
    // commit re-absorbs it (Task 7's commitLateDelivery guarantee — the exact
    // window this test pins).
    const requests: ModelRequest[] = [];
    // The queue exactly as the auto-flush loop's condition reads it: a
    // steering_flush claim only happens when `getState().queuedUserInputs`
    // was non-empty one check earlier, so this snapshot is the contract pin.
    const flushOpenQueues: unknown[] = [];
    const server = await boot({
      appendEventsDelayMs: 500,
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          yield { type: "text_delta", text: "" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      agentFactory: async (opts) => {
        const agent = await createWiredAgent(opts);
        const originalStream = agent.stream.bind(agent);
        agent.stream = (input, streamOpts) => {
          if (typeof input === "object" && input.type === "steering_flush") {
            flushOpenQueues.push(agent.getState().queuedUserInputs);
          }
          return originalStream(input, streamOpts);
        };
        return agent;
      },
    });
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
    expect(JSON.stringify(server.rawFrames())).not.toContain("BUSY");
    const queuedId = server
      .events()
      .find(
        (event) => event.type === "steering_queued" && event.data["content"] === "settle message",
      )
      ?.data["id"];
    expect(typeof queuedId).toBe("string");

    // The settle-time flush must consume it: a second turn opens with normal
    // framing and its model call takes the queued message as the opening
    // input — proof it survived the carry-forward into the flush claim
    // (nothing dropped between the settle steer and this turn).
    await waitFor(() => turnEndCount(server) >= 2, "settle-time flush turn");
    expect(server.turnCount()).toBe(2);
    expect(turnEndCount(server)).toBe(2);
    expect(errorFrames(server)).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)).toEqual(
      expect.objectContaining({ role: "user", content: "settle message" }),
    );

    // Task 7 contract pin: the queue was visible through getState() at the
    // exact point the flush loop's condition reads it — with the ORIGINAL
    // id, so delivery below can match it.
    expect(flushOpenQueues).toHaveLength(1);
    expect(flushOpenQueues[0]).toEqual([
      expect.objectContaining({ id: queuedId, content: "settle message" }),
    ]);

    // Delivery announced with the original id.
    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);

    // The flush turn's own recorder flush is delayed too — let it land
    // before teardown removes the temp config dir out from under it.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
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

  it("cancel with queued messages auto-runs a new turn delivering them in order", async () => {
    // Turn 1 parks inside its model call so two follow-ups can queue behind
    // the held latch. The park unwinds on the cancel signal — the way a
    // provider rejects its in-flight request when the abort fires — so the
    // turn closes as cancelled with both messages still queued.
    const requests: ModelRequest[] = [];
    let modelStreaming!: () => void;
    const firstModelStreaming = new Promise<void>((resolve) => {
      modelStreaming = resolve;
    });
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (requests.length > 1) {
            // The auto-flush round: it must simply run to completion.
            yield { type: "text_delta", text: "flushed" };
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "text_delta", text: "thinking…" };
          modelStreaming();
          await new Promise<void>((resolve) => {
            const signal = request.abortSignal;
            if (!signal) return; // never resolves — the test would time out, as it should
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await firstModelStreaming;

    const second = await postMessage(server, "second message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    const third = await postMessage(server, "third message");
    expect(third.status).toBe(202);
    expect((await third.json()) as unknown).toEqual({ queued: true });
    await waitFor(
      () =>
        ["second message", "third message"].every((content) =>
          sawSteeringQueued(server, content),
        ),
      "steering_queued frames for both mid-turn messages",
    );

    // Stop the session: turn 1 unwinds as cancelled with the queue intact —
    // the queued messages must then ride a second, automatically started
    // turn instead of waiting for the user's next message.
    const cancel = await interrupt(server);
    expect(cancel.status).toBe(202);

    await waitFor(() => turnEndCount(server) >= 2, "auto flush turn after cancel");

    // Normal turn framing: exactly two turn_start / turn_end pairs, and the
    // first turn is the one the cancel closed.
    expect(server.turnCount()).toBe(2);
    const turnEnds = server.events().filter((event) => event.type === "turn_end");
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]!.data["reason"]).toBe("cancelled");
    expect(errorFrames(server)).toEqual([]);

    // The model ran a second time, and both queued messages opened that
    // turn as its tail inputs — FIFO, in arrival order.
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages.slice(-2).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "second message" },
      { role: "user", content: "third message" },
    ]);

    // Delivery announced with the queued ids, in the order they queued.
    const queuedIds = server
      .events()
      .filter((event) => event.type === "steering_queued")
      .map((event) => event.data["id"]);
    expect(queuedIds).toHaveLength(2);
    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual(queuedIds);

    // Let the flush turn's transcript write land before teardown removes the
    // temp config dir out from under it.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  });

  it("the auto-turn loop stops at the cap and reports an error event", async () => {
    // A stub whose queue never drains: every condition check sees a pending
    // message, so only the round cap can stop the loop — and stopping must
    // surface as a protocol error event, not a hang and not a silent stop.
    let turn = 0;
    const server = await boot({
      agentFactory: (() => ({
        async *stream() {
          turn += 1;
          yield { type: "turn_start", data: { turn }, time: Date.now() };
          yield { type: "turn_end", data: { turn, reason: "done" }, time: Date.now() };
        },
        getState: () => ({
          messages: [],
          queuedUserInputs: [{ id: "stuck", role: "user", content: "never delivered" }],
        }),
      })) as never,
    });

    await server.openEvents();

    const res = await postMessage(server, "hello");
    expect(res.status).toBe(202);

    await waitFor(() => errorFrames(server).length > 0, "auto-turn cap error frame");

    // Exactly one main turn + 50 flush rounds: the cap stopped the loop, and
    // the cap report is the only error on the wire.
    expect(server.turnCount()).toBe(51);
    expect(turnEndCount(server)).toBe(51);
    const capErrors = errorFrames(server);
    expect(capErrors).toHaveLength(1);
    expect((capErrors[0] as { data: { message: string } }).data.message).toBe(
      t(DEFAULT_LOCALE, "server.steer.autoTurnLimit"),
    );
  });

  it("POST /interrupt during the auto-flush turn cancels it instead of letting it run out", async () => {
    // Same settle-window construction as scenario D, but the flush round's
    // model parks on ITS OWN abort signal: Stop must reach the auto-started
    // turn — each flush round binds its own AbortController (the main turn's
    // controller belongs to the turn that already ended).
    const requests: ModelRequest[] = [];
    let flushStreaming!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      flushStreaming = resolve;
    });
    const server = await boot({
      appendEventsDelayMs: 500,
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (requests.length > 1) {
            // The auto-flush round: park until the interrupt signal fires.
            yield { type: "text_delta", text: "flushing…" };
            flushStreaming();
            await new Promise<void>((resolve) => {
              const signal = request.abortSignal;
              if (!signal) return; // never resolves — the test would time out, as it should
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "text_delta", text: "" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await server.captureMessages();

    const second = await postMessage(server, "settle message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    await waitFor(
      () => sawSteeringQueued(server, "settle message"),
      "steering_queued frame for the settle-window message",
    );

    // The flush round has claimed the latch and is inside its model call.
    await flushStarted;

    const cancel = await interrupt(server);
    expect(cancel.status).toBe(202);

    // The flush round closes as cancelled — not run to completion — and the
    // loop stops there (its queue drained at the flush turn's open).
    await waitFor(() => turnEndCount(server) >= 2, "interrupted flush turn_end");
    const turnEnds = server.events().filter((event) => event.type === "turn_end");
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[1]!.data["reason"]).toBe("cancelled");
    expect(server.turnCount()).toBe(2);
    expect(errorFrames(server)).toEqual([]);

    // Let the flush turn's delayed recorder flush land before teardown
    // removes the temp config dir out from under it.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
  });
});
