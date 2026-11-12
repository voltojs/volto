import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModelPort, textScript, toolCallScript } from "@volto/core";
import type { ModelRequest, UserMessage } from "@volto/core";
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
 * Task 10 (D13): queued messages must survive an instance swap — a
 * config-change rebuild and a cold start both fold the durable steering
 * events back into the new instance's seed, including a steer that lands
 * while the rebuild itself is still building its replacement.
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

/** POST an arbitrary JSON body (e.g. an approval decision) to the server. */
function postJson(server: TestServer, pathName: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${pathName}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

  it("runTurn called directly in the cold window reports instead of dropping the message", async () => {
    // Gate the per-session build so turn 1 parks in `running=true, agent=null`
    // — the cold window — while a direct runTurn call arrives for "second".
    // The registry path has no HTTP response to answer with, so the refusal
    // must reach the client as an SSE error frame instead of vanishing.
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
      steerAgentWaitMs: 50,
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
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await buildStarted; // latch held, agent still null

    // Bypass POST /messages (whose own bounded wait would answer 503) and
    // hit the registry entry point directly — the path that used to swallow
    // the message via `session.agent?.steer(...)` with agent=null.
    await server.registry.runTurn(server.sessionId, "second", server.turnConfig);

    // The observable outcome: an error frame carrying the agentStarting copy
    // reaches the SSE client (protocol frames only ever show up in
    // rawFrames(), never in events()).
    await waitFor(
      () => server.rawFrames().some((frame) => frame.event === "error"),
      "agentStarting error frame",
    );
    const errors = server
      .rawFrames()
      .filter((frame) => frame.event === "error") as Array<{ data: { message: string } }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data.message).toBe(t(DEFAULT_LOCALE, "server.error.agentStarting"));

    // And no second turn started behind the report: the session's only build
    // request is still turn 1's, and turn 1 has not even begun streaming.
    expect(builds).toBe(2);
    expect(server.turnCount()).toBe(0);

    // Let turn 1 finish: still exactly one turn.
    releaseBuild();
    await server.captureMessages();
    expect(server.turnCount()).toBe(1);
    expect(turnEndCount(server)).toBe(1);
    expect(builds).toBe(2);
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

  it("an auto-flush turn rebuilds for a permission remembered during the previous turn", async () => {
    // Turn 1's bash call parks at the approval; allowing it WITH remember
    // writes a permission rule and flags the session dirty. The follow-up
    // message lands in the settle window and must ride the auto-flush turn —
    // which has to pass the same config/permission rebuild gate as a normal
    // turn, so the remembered rule reaches it and the same command executes
    // without a second approval ask.
    const marker = "volto-flush-rebuild-4d1e";
    const command = `echo ${marker}`;
    const modelPort = createMockModelPort([
      // Turn 1: run the command (parks at the approval), then close.
      toolCallScript("call-1", "bash", JSON.stringify({ command })),
      textScript("first turn done"),
      // The flush-delivered turn: run the SAME command again.
      toolCallScript("call-2", "bash", JSON.stringify({ command })),
      textScript("flush turn done"),
    ]);
    let builds = 0;
    const server = await boot({
      // Delayed appends widen the settle window deterministically (the same
      // construction as the captureHistory scenario above).
      appendEventsDelayMs: 500,
      modelPort,
      agentFactory: async (opts) => {
        builds += 1;
        return createWiredAgent(opts);
      },
    });
    // createServer builds its own legacy agent before boot() returns — from
    // here on, only the session's own constructions are counted.
    const buildsAtBoot = builds;

    await server.openEvents();
    const connected = server.rawFrames().find((frame) => frame.event === "connected");
    const approvalToken = (connected?.data as { token: string }).token;
    expect(typeof approvalToken).toBe("string");

    // ── Turn 1: bash parks at the approval; allow + remember ──
    const first = await postMessageAs(server, "run the echo command", { permissionMode: "ask" });
    expect(first.status).toBe(202);
    await waitFor(
      () => server.events().some((event) => event.type === "approval_asked"),
      "approval_asked for turn 1's bash call",
    );
    const callId = server.events().find((event) => event.type === "approval_asked")!.data["callId"];
    expect(typeof callId).toBe("string");

    const remember = await postJson(server, "/approvals", {
      sessionId: server.sessionId,
      callId,
      decision: "allow",
      token: approvalToken,
      remember: { prefixTokens: 1 },
    });
    expect(remember.status).toBe(202);
    const rememberBody = (await remember.json()) as {
      remembered?: unknown;
      rememberError?: unknown;
    };
    expect(rememberBody.rememberError).toBeUndefined();
    expect(rememberBody.remembered).toBeDefined();

    await server.captureMessages();
    expect(turnEndCount(server)).toBe(1);

    // ── Settle window: queue the follow-up the flush loop must deliver ──
    const second = await postMessageAs(server, "run it again", { permissionMode: "ask" });
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    await waitFor(
      () => sawSteeringQueued(server, "run it again"),
      "steering_queued frame for the settle-window message",
    );

    // The flush turn opens only after the loop's rebuild gate has run.
    await waitFor(() => server.turnCount() >= 2, "auto-flush turn_start");

    // The gate rebuilt the agent before the flush turn streamed: turn 1's
    // build plus the flush-loop rebuild. Without the gate the factory runs
    // once and the flush turn reuses the stale agent.
    expect(builds - buildsAtBoot).toBe(2);

    // The remembered rule reaches the flush-delivered turn: it completes
    // with no second approval ask, and both turns really executed the
    // command (two tool_results carrying the marker output).
    await waitFor(() => turnEndCount(server) >= 2, "auto-flush turn_end");
    expect(turnEndCount(server)).toBe(2);
    expect(server.events().filter((event) => event.type === "approval_asked")).toHaveLength(1);
    expect(
      server
        .events()
        .filter(
          (event) => event.type === "tool_result" && JSON.stringify(event.data).includes(marker),
        ),
    ).toHaveLength(2);
    expect(errorFrames(server)).toEqual([]);

    // The flush turn's transcript writes are delayed too — let them land
    // before teardown removes the temp config dir out from under them.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
  });
});

// ── Task 10 (D13) helpers ─────────────────────────────────────────────

/** POST /messages with extra body fields (e.g. an alternate model binding). */
function postMessageAs(
  server: TestServer,
  message: string,
  extra: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${server.url}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: server.sessionId, message, ...server.turnConfig, ...extra }),
  });
}

/**
 * A second provider/model binding: a different providerId/modelId makes
 * `sameConfig()` false, which is what forces the config-change rebuild the
 * D13 tests seed a queue across.
 */
async function createAlternateBinding(
  server: TestServer,
): Promise<{ providerId: string; modelId: string }> {
  const created = (await (
    await fetch(`${server.url}/providers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "alternate-provider",
        models: [{ name: "alternate-model", code: "alternate-model" }],
      }),
    })
  ).json()) as { id: string; models: Array<{ id: string }> };
  return { providerId: created.id, modelId: created.models[0]!.id };
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
 * Poll until `needle` is durable in the transcript — i.e. the recorder's
 * fire-and-forget flush has landed. Every D13 fold below reads only writes
 * this helper has already observed, so the read-vs-flush ordering is
 * deterministic rather than timing luck.
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
 * Poll the durable transcript for the `steering_queued{id}` entry carrying
 * this content and return its id.
 *
 * The rebuild-window steer's OWNING stream channel has already closed by
 * the time it lands (its turn's `for await` ended), so the live
 * `steering_queued` frame is queued into a channel nobody drains — the
 * durable record is the contract the D13 fold reads, and the only
 * observable one at that seam.
 */
async function waitForQueuedId(
  server: TestServer,
  content: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await findTranscript(server.configDir, `"content":"${content}"`);
    if (file) {
      const text = await fs.readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        // A poll can catch a line mid-write — skip it like the store's own
        // reader does rather than failing the test over a torn read.
        let parsed: { event?: { type?: string; data?: { id?: unknown; content?: unknown } } };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.event?.type === "steering_queued" && parsed.event.data?.content === content) {
          const id = parsed.event.data.id;
          if (typeof id === "string") return id;
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForQueuedId: no durable steering_queued for "${content}"`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the current turn's terminal record is durable, then yield once
 * more. `turn_end` is written by the awaited flush inside the Runner's
 * finally, so observing it on disk means that flush landed; everything
 * between it and the latch release (hooks, history capture, the settle
 * check) is a microtask chain that runs before this helper's next poll
 * fires. The extra tick is the belt for that hand-off: the POST that
 * follows must be ACCEPTED (idle), never steered into the just-settled
 * turn.
 */
async function waitForTurnDurable(server: TestServer): Promise<void> {
  await waitForTranscript(server, '"type":"turn_end"');
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe("D13 — queued messages survive rebuild and cold start", () => {
  it("rebuild preserves pending queued messages", async () => {
    // Scenario I: a message queues on the live instance mid-turn, the turn
    // is then cancelled with the message still queued, and the settle-time
    // flush reads a state that omits the queue field (the documented
    // "nothing provably queued" stance — the same read a never-run agent
    // throws from), so no flush turn runs: from here the queue exists only
    // in the durable transcript. The next turn requests a different model;
    // its config-change rebuild must fold the pending entry into the NEW
    // instance's seed, and the next boundary must deliver it.
    let queueInvisible = false;
    const seeds: Array<UserMessage[] | undefined> = [];
    let firstModelStreaming!: () => void;
    const firstModelStarted = new Promise<void>((resolve) => {
      firstModelStreaming = resolve;
    });
    const requests: ModelRequest[] = [];
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "text_delta", text: "thinking…" };
            firstModelStreaming();
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
        seeds.push(opts?.initialQueuedInputs);
        const agent = await createWiredAgent(opts);
        // Hide the queue from the gateway's settle-time read (the documented
        // "state omits the queue field -> nothing provably queued" stance):
        // the message then survives to idle for the next rebuild to recover.
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

    // Turn 1 parks in its model call so the queue can land mid-turn.
    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await firstModelStarted;

    // Queued on the live instance — D10's 202 plus the stamped id. The
    // steer must land BEFORE the model completes: model_done(end_turn)
    // drains a non-empty queue within the same turn (reducer D11 family).
    const second = await postMessage(server, "queued message");
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({ queued: true });
    await waitFor(() => sawSteeringQueued(server, "queued message"), "steering_queued frame");
    const queuedId = server
      .events()
      .find(
        (event) => event.type === "steering_queued" && event.data["content"] === "queued message",
      )?.data["id"];
    expect(typeof queuedId).toBe("string");

    // Cancel the parked turn with the message still queued: turn 1 closes
    // with NO flush turn (the settle read sees no queue), leaving the entry
    // pending on disk for the next rebuild to recover.
    queueInvisible = true;
    const cancel = await interrupt(server);
    expect(cancel.status).toBe(202);
    await server.captureMessages();
    await waitForTurnDurable(server);
    queueInvisible = false;

    // A different model binding -> sameConfig() false -> config-change rebuild.
    const alternate = await createAlternateBinding(server);
    const third = await postMessageAs(server, "config change message", alternate);
    expect(third.status).toBe(202);
    expect((await third.json()) as unknown).toEqual({
      sessionId: server.sessionId,
      accepted: true,
    });

    // Turn 2 opens on the NEW instance and delivers at that boundary — no
    // third turn is needed, the opening already drained the seed.
    await waitFor(() => turnEndCount(server) >= 2, "config-change turn");
    expect(server.turnCount()).toBe(2);
    expect(turnEndCount(server)).toBe(2);

    // The fold reached the new instance: createAgent holds the seed by
    // reference (Task 7) and copies it into state at the first Runner's
    // construction — exact UserMessage array, original id, FIFO intact.
    expect(seeds).toHaveLength(3); // legacy agent + turn 1 + the rebuild
    expect(seeds[1]).toEqual([]);
    expect(seeds[2]).toEqual([{ id: queuedId, role: "user", content: "queued message" }]);

    // Delivered on the next boundary: announced with the original id ...
    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);
    // ... and the model call carries the queued message ahead of the new input.
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages.slice(-2).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "queued message" },
      { role: "user", content: "config change message" },
    ]);
    expect(errorFrames(server)).toEqual([]);
  });

  it("steer during the rebuild window is captured by the rebuild fold", async () => {
    // The rebuild-window race: the config-change rebuild's primary fold has
    // already read the transcript by the time the agent factory runs, so a
    // steer landing inside the gated build reaches only the OUTGOING
    // instance — whose steering_queued flushes asynchronously
    // (fire-and-forget). The rebuild must re-read after construction and
    // fold it into the new instance's seed before the first turn claims it.
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let rebuildBuilding!: () => void;
    const rebuildStarted = new Promise<void>((resolve) => {
      rebuildBuilding = resolve;
    });
    let builds = 0;
    const seeds: Array<UserMessage[] | undefined> = [];
    const requests: ModelRequest[] = [];
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      agentFactory: async (opts) => {
        builds += 1;
        seeds.push(opts?.initialQueuedInputs);
        // Build #1 is createServer's legacy agent and #2 the first turn's,
        // so #3 is the config-change rebuild this test parks inside.
        if (builds === 3) {
          rebuildBuilding();
          await buildGate;
        }
        return createWiredAgent(opts);
      },
    });

    await server.openEvents();

    const first = await postMessage(server, "first message");
    expect(first.status).toBe(202);
    await server.captureMessages();
    await waitForTurnDurable(server);

    // Config change: accepted (idle), latch held, rebuild parked inside its
    // build — the primary fold has already read the transcript by now.
    const alternate = await createAlternateBinding(server);
    const second = await postMessageAs(server, "config change message", alternate);
    expect(second.status).toBe(202);
    expect((await second.json()) as unknown).toEqual({
      sessionId: server.sessionId,
      accepted: true,
    });
    await rebuildStarted;

    // The steer lands on the OUTGOING instance while its replacement builds.
    const third = await postMessage(server, "window message");
    expect(third.status).toBe(202);
    expect((await third.json()) as unknown).toEqual({ queued: true });
    // Durable, not announced: the steer reached the OUTGOING instance whose
    // stream channel has already closed, so only its fire-and-forget
    // recorder flush carries the entry — waiting for exactly that record is
    // also the precondition the post-construction re-read needs.
    const queuedId = await waitForQueuedId(server, "window message");

    releaseBuild();

    // Turn 2 opens on the NEW instance and delivers the window steer.
    await waitFor(() => turnEndCount(server) >= 2, "config-change turn");
    expect(builds).toBe(3);
    expect(server.turnCount()).toBe(2);
    expect(turnEndCount(server)).toBe(2);

    // The post-construction re-read folded the steer into the seed array
    // the new instance holds by reference — the primary fold predates it.
    expect(seeds[2]).toEqual([{ id: queuedId, role: "user", content: "window message" }]);

    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages.slice(-2).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "window message" },
      { role: "user", content: "config change message" },
    ]);
    expect(errorFrames(server)).toEqual([]);
  });

  it("cold start seeds the pending queue from the persisted transcript", async () => {
    // Phase 1 — leave a pending queue durable: the message queues
    // mid-turn, the turn is cancelled with it still queued, and the
    // settle-time flush reads a state that omits the queue field — so the
    // transcript keeps the entry exactly like a process that died between
    // queue and drain.
    let queueInvisible = false;
    const seeds: Array<UserMessage[] | undefined> = [];
    let warmupStreaming!: () => void;
    const warmupStarted = new Promise<void>((resolve) => {
      warmupStreaming = resolve;
    });
    const requests: ModelRequest[] = [];
    const server = await boot({
      modelPort: {
        async *stream(request: ModelRequest) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "text_delta", text: "thinking…" };
            warmupStreaming();
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
        seeds.push(opts?.initialQueuedInputs);
        const agent = await createWiredAgent(opts);
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
    const queuedId = server
      .events()
      .find(
        (event) =>
          event.type === "steering_queued" && event.data["content"] === "queued for restart",
      )?.data["id"];
    expect(typeof queuedId).toBe("string");

    queueInvisible = true;
    const cancel = await interrupt(server);
    expect(cancel.status).toBe(202);
    await server.captureMessages();
    await waitForTurnDurable(server);
    queueInvisible = false;

    // Phase 2 — a FRESH session id over the same durable transcript: the
    // gateway's cold-start path (no in-memory history, no agent) must fold
    // the pending queue into the new instance's seed.
    const source = await findTranscript(server.configDir, "queued for restart");
    expect(source).not.toBeNull();
    await fs.copyFile(source!, path.join(server.configDir, "cold-session.jsonl"));

    await server.openEvents("cold-session");
    const cold = await fetch(`${server.url}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "cold-session",
        message: "hello after restart",
        ...server.turnConfig,
      }),
    });
    expect(cold.status).toBe(202);
    expect((await cold.json()) as unknown).toEqual({
      sessionId: "cold-session",
      accepted: true,
    });

    // Frames reset with the channel: only the cold turn ran — its opening
    // already drained the seed, so there is no flush turn.
    await waitFor(() => turnEndCount(server) >= 1, "cold turn");
    expect(server.turnCount()).toBe(1);
    expect(turnEndCount(server)).toBe(1);

    // The fold reached the new instance (legacy + warmup + cold builds).
    expect(seeds).toHaveLength(3);
    expect(seeds[2]).toEqual([{ id: queuedId, role: "user", content: "queued for restart" }]);

    const delivered = server.events().find((event) => event.type === "steering_delivered");
    expect(delivered?.data["ids"]).toEqual([queuedId]);
    expect(requests).toHaveLength(2);
    expect(
      requests[1]!.messages.slice(-2).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "queued for restart" },
      { role: "user", content: "hello after restart" },
    ]);
    expect(errorFrames(server)).toEqual([]);
  });
});
