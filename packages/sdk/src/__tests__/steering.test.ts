/**
 * SDK steering surface (spec 2026-11-04 D4/D11/D14/D15):
 * AgentInstance.steer / AgentInstance.updateQueue and the
 * CreateAgentOptions.initialQueuedInputs rebuild seed.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textDelta, modelDone } from "@volto/core";
import type {
  ModelPort,
  ModelEvent,
  UserMessage,
  TranscriptEventInput,
} from "@volto/core";

/** Poll until `predicate` is true or the deadline elapses. */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

/**
 * A model port whose calls block until openGate() so a turn stays in
 * flight while the test steers into it. Calls after openGate() run free.
 */
function createGatedModel(scripts: ModelEvent[][]): ModelPort & {
  callCount: number;
  openGate(): void;
} {
  let calls = 0;
  let open = false;
  const waiters: Array<() => void> = [];
  return {
    get callCount() {
      return calls;
    },
    async *stream(): AsyncGenerator<ModelEvent> {
      const index = calls++;
      if (!open) await new Promise<void>((resolve) => waiters.push(resolve));
      yield* scripts[index] ?? [textDelta("ok"), modelDone("end_turn")];
    },
    openGate(): void {
      open = true;
      while (waiters.length > 0) waiters.shift()!();
    },
  } as unknown as ModelPort & { callCount: number; openGate(): void };
}

describe("createAgent steering", () => {
  it("steer during an in-flight turn queues it without opening a new turn", async () => {
    const model = createGatedModel([
      [textDelta("first"), modelDone("end_turn")],
      [textDelta("second"), modelDone("end_turn")],
    ]);
    const agent = createAgent({ modelPort: model });

    const runPromise = agent.run("hi");
    await waitUntil(() => model.callCount === 1, "model call in flight");

    agent.steer("steered mid-turn");
    const queued = agent.getState().queuedUserInputs;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe("steered mid-turn");
    // The steer did not open a turn: no second model call was made.
    expect(model.callCount).toBe(1);

    model.openGate();
    const final = await runPromise;
    // Delivered inside the SAME turn by the end_turn continuation (D3):
    // tail is [assistant(first), user(steered), assistant(second)].
    expect(final.messages.slice(-3).map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("steer when idle opens a normal turn", async () => {
    const model = createMockModelPort([[textDelta("answer"), modelDone("end_turn")]]);
    const agent = createAgent({ modelPort: model });

    agent.steer("hello from idle");
    await waitUntil(() => model.callCount === 1, "model called");
    await waitUntil(() => agent.getState().status === "done", "turn completed");

    expect(model.callCount).toBe(1);
    expect(
      agent.getState().messages.some((m) => m.content === "hello from idle"),
    ).toBe(true);
    expect(agent.getState().queuedUserInputs).toHaveLength(0);
  });

  it("initialQueuedInputs seeds queuedUserInputs and survives resetTurnForNextInput", async () => {
    const seeded: UserMessage[] = [
      { id: "s1", role: "user", content: "seeded one" },
      { id: "s2", role: "user", content: "seeded two" },
    ];
    // Call 1 stops at max_tokens with the iteration limit reached, so turn
    // one closes WITHOUT draining the queue; call 2 answers turn two.
    const model = createMockModelPort([
      [modelDone("max_tokens")],
      [textDelta("ok"), modelDone("end_turn")],
    ]);
    const agent = createAgent({
      modelPort: model,
      initialQueuedInputs: seeded,
      maxIterations: 1,
    });

    // A file_changed turn opens without flushing the queue (unlike
    // user_message / steering_flush), so the seeded entries must ride
    // through the whole turn untouched.
    await agent.run({
      type: "file_changed",
      watchId: "w1",
      events: [{ type: "change", path: "a.ts" }],
    });
    expect(agent.getState().queuedUserInputs.map((m) => m.id)).toEqual([
      "s1",
      "s2",
    ]);

    // resetTurnForNextInput carries the queue into turn two, which delivers
    // it ahead of the new message with the ORIGINAL ids (D11b).
    const final = await agent.run("hi");
    const ids = final.messages.map((m) => m.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    const newIndex = final.messages.findIndex((m) => m.content === "hi");
    expect(ids.indexOf("s1")).toBeLessThan(newIndex);
    expect(ids.indexOf("s2")).toBeLessThan(newIndex);
    expect(final.queuedUserInputs).toHaveLength(0);
  });

  it("updateQueue reports live and mutates the running state", async () => {
    const model = createGatedModel([
      [textDelta("first"), modelDone("end_turn")],
      [textDelta("second"), modelDone("end_turn")],
    ]);
    const agent = createAgent({ modelPort: model });

    const runPromise = agent.run("hi");
    await waitUntil(() => model.callCount === 1, "model call in flight");

    agent.steer("queued one");
    const queuedId = agent.getState().queuedUserInputs[0]!.id;

    // Membership check + delivery happen in one synchronous span: the
    // return value is already there when the call returns.
    expect(
      agent.updateQueue({
        type: "steering_edit",
        id: queuedId,
        content: "edited one",
      }),
    ).toBe("live");
    const afterEdit = agent.getState().queuedUserInputs;
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0]).toMatchObject({ id: queuedId, content: "edited one" });

    expect(
      agent.updateQueue({ type: "steering_remove", id: queuedId }),
    ).toBe("live");
    expect(agent.getState().queuedUserInputs).toHaveLength(0);

    model.openGate();
    await runPromise;
  });

  it("updateQueue reports seed and mutates the seed array", () => {
    const seed: UserMessage[] = [
      { id: "s1", role: "user", content: "one" },
      { id: "s2", role: "user", content: "two" },
    ];
    const agent = createAgent({
      modelPort: createMockModelPort([]),
      initialQueuedInputs: seed,
    });

    // No runner exists yet — the seed array IS the queue; mutations land
    // in it in place so the next construction picks them up.
    expect(
      agent.updateQueue({ type: "steering_edit", id: "s1", content: "edited" }),
    ).toBe("seed");
    expect(seed).toEqual([
      { id: "s1", role: "user", content: "edited" },
      { id: "s2", role: "user", content: "two" },
    ]);

    expect(agent.updateQueue({ type: "steering_remove", id: "s2" })).toBe(
      "seed",
    );
    expect(seed.map((m) => m.id)).toEqual(["s1"]);
  });

  it("updateQueue reports missing for an unknown or delivered id", async () => {
    const model = createMockModelPort([
      [textDelta("ok"), modelDone("end_turn")],
    ]);
    const agent = createAgent({
      modelPort: model,
      initialQueuedInputs: [{ id: "s1", role: "user", content: "seeded" }],
    });

    // The turn's opening flush delivers s1 — a delivered id can no longer
    // be edited or withdrawn ("delivery wins"), even though it still sits
    // in the seed array the host passed in.
    const final = await agent.run("hi");
    expect(final.queuedUserInputs).toHaveLength(0);

    expect(
      agent.updateQueue({ type: "steering_edit", id: "s1", content: "late" }),
    ).toBe("missing");
    expect(agent.updateQueue({ type: "steering_remove", id: "nope" })).toBe(
      "missing",
    );
  });

  it("steer landing after the turn settles still persists steering_queued", async () => {
    const events: TranscriptEventInput[] = [];
    const model = createMockModelPort([
      [textDelta("hi"), modelDone("end_turn")],
    ]);
    const agent = createAgent({
      modelPort: model,
      chatStore: {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      },
      chatSessionId: "chat-1",
    });

    for await (const ev of agent.stream("hello")) {
      if (ev.type === "turn_end") {
        // The turn's run loop has ended and its recorder already flushed;
        // the consumer is still attached, so steer() routes to
        // lastRunner.send() exactly like the gateway's settle window.
        await new Promise((r) => setTimeout(r, 10));
        agent.steer("late steering");
      }
    }

    // The queued record must reach the persisted transcript — the durable
    // log is what the queue-rebuild fold consumes downstream.
    const queued = events.find((e) => e.type === "steering_queued");
    expect(queued).toBeDefined();
    expect(queued!.data).toMatchObject({ content: "late steering" });
    // ...and the queue must stay visible to the next turn's carry-forward.
    const pending = agent.getState().queuedUserInputs;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe((queued!.data as { id: string }).id);
  });
});
