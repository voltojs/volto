/**
 * SDK steering surface (spec 2026-11-04 D4/D11/D14/D15):
 * AgentInstance.steer / AgentInstance.updateQueue and the
 * CreateAgentOptions.initialQueuedInputs rebuild seed.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, textDelta, modelDone } from "@voltojs/core";
import type {
  ModelPort,
  ModelEvent,
  UserMessage,
  ContentBlock,
  TranscriptEventInput,
} from "@voltojs/core";

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

  it("steer when idle queues into the settled state without opening a new turn", async () => {
    const model = createMockModelPort([[textDelta("answer"), modelDone("end_turn")]]);
    const agent = createAgent({ modelPort: model });
    await agent.run("first turn");
    expect(model.callCount).toBe(1);

    // steer NEVER opens a turn (fix-round contract): with no turn in flight
    // the message is queued into the settled state and waits for the host's
    // turn-boundary drain (steering_flush / the next turn's opening flush).
    agent.steer("queued while idle");
    expect(model.callCount).toBe(1);
    expect(agent.getState().status).toBe("done");
    expect(agent.getState().queuedUserInputs).toHaveLength(1);
    expect(agent.getState().queuedUserInputs[0]!.content).toBe("queued while idle");
  });

  it("a steer landing after the turn settles stays visible to getState", async () => {
    // Task 9's settle-flush loop drains exactly via getState().
    // queuedUserInputs + steering_flush turns, so the queued entry must
    // survive the final-state commit (commitLateDelivery).
    const model = createMockModelPort([
      [textDelta("answer"), modelDone("end_turn")],
      [textDelta("flushed"), modelDone("end_turn")],
    ]);
    const agent = createAgent({ modelPort: model });
    await agent.run("first turn");

    agent.steer("late steer");
    const queued = agent.getState().queuedUserInputs;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe("late steer");

    // The drain loop's steering_flush turn delivers it with its id intact.
    const final = await agent.run({ type: "steering_flush" });
    expect(
      final.messages.some((m) => m.id === queued[0]!.id && m.content === "late steer"),
    ).toBe(true);
    expect(final.queuedUserInputs).toHaveLength(0);
  });

  it("a steer sent during the claim gap is buffered into the turn's queue instead of being lost", async () => {
    const model = createGatedModel([
      [textDelta("first"), modelDone("end_turn")],
      [textDelta("second"), modelDone("end_turn")],
    ]);
    const seeded: UserMessage[] = [{ id: "s1", role: "user", content: "seeded" }];
    const agent = createAgent({ modelPort: model, initialQueuedInputs: seeded });

    const runPromise = agent.run("hi");
    // Same synchronous span as the turn claim: no Runner exists yet, so the
    // steer is buffered (never dropped, never opened as its own turn).
    agent.steer("steered during the claim gap");
    // The seed/missing judgment stays consistent while buffering is active:
    // a seed id still resolves to "seed" and lands in the seed array.
    expect(
      agent.updateQueue({ type: "steering_edit", id: "s1", content: "edited" }),
    ).toBe("seed");
    expect(seeded[0]!.content).toBe("edited");

    await waitUntil(() => model.callCount === 1, "model call in flight");
    // The buffered steer materialized into the turn's queue (the edited
    // seed rode the opening flush ahead of "hi"), and is targetable as
    // "live" — a just-materialized entry is never "missing".
    const queued = agent.getState().queuedUserInputs;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe("steered during the claim gap");
    expect(
      agent.updateQueue({
        type: "steering_edit",
        id: queued[0]!.id,
        content: "rewritten",
      }),
    ).toBe("live");
    expect(agent.getState().queuedUserInputs[0]!.content).toBe("rewritten");

    model.openGate();
    const final = await runPromise;
    const texts = final.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.indexOf("edited")).toBeLessThan(texts.indexOf("hi"));
    expect(final.queuedUserInputs).toHaveLength(0);
  });

  it("updateQueue resolves a carried-forward id during the claim gap instead of reporting missing", async () => {
    const model = createGatedModel([
      [modelDone("max_tokens")],
      [textDelta("ok"), modelDone("end_turn")],
    ]);
    const agent = createAgent({ modelPort: model, maxIterations: 1 });

    // Turn one closes at the iteration cap with the steered entry still
    // queued — it rides into turn two via the carry-forward.
    const turn1 = agent.run("hi");
    await waitUntil(() => model.callCount === 1, "model call in flight");
    agent.steer("steered in turn one");
    const carriedId = agent.getState().queuedUserInputs[0]!.id;
    model.openGate();
    await turn1;
    expect(agent.getState().queuedUserInputs.map((m) => m.id)).toEqual([carriedId]);

    const turn2 = agent.run("second");
    // Claim gap: the carried queue is the live source. A deliverable id
    // must never report "missing" — the gateway would fail a valid edit
    // while the message is delivered anyway.
    expect(
      agent.updateQueue({ type: "steering_edit", id: carriedId, content: "edited" }),
    ).toBe("live");
    const final = await turn2;
    // The buffered edit landed before the opening flush delivered the entry.
    expect(final.messages.find((m) => m.id === carriedId)?.content).toBe("edited");
  });

  it("updateQueue reports missing for a delivered seed id during the claim gap without mutating the seed", async () => {
    const seeded: UserMessage[] = [{ id: "s1", role: "user", content: "seeded" }];
    const model = createMockModelPort([
      [textDelta("one"), modelDone("end_turn")],
      [textDelta("two"), modelDone("end_turn")],
    ]);
    const agent = createAgent({ modelPort: model, initialQueuedInputs: seeded });
    // The opening flush delivers s1 — the seed array is dormant from here on.
    await agent.run("hi");
    expect(agent.getState().messages.some((m) => m.id === "s1")).toBe(true);

    const turn2 = agent.run("second");
    // Claim gap: s1 is already delivered ("delivery wins") — reporting
    // "seed" would ghost-edit the host's seed array.
    expect(
      agent.updateQueue({ type: "steering_edit", id: "s1", content: "ghost" }),
    ).toBe("missing");
    expect(seeded).toEqual([{ id: "s1", role: "user", content: "seeded" }]);
    await turn2;
  });

  it("a buffered claim-gap edit/remove is delivered by id and recorded exactly once", async () => {
    const events: TranscriptEventInput[] = [];
    const model = createMockModelPort([
      [modelDone("max_tokens")],
      [textDelta("ok"), modelDone("end_turn")],
    ]);
    const seeded: UserMessage[] = [
      { id: "s1", role: "user", content: "keep" },
      { id: "s2", role: "user", content: "drop" },
    ];
    const agent = createAgent({
      modelPort: model,
      initialQueuedInputs: seeded,
      maxIterations: 1,
      chatStore: {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      },
      chatSessionId: "chat-1",
    });
    // Turn one closes at the iteration cap with the queue intact.
    await agent.run({
      type: "file_changed",
      watchId: "w1",
      events: [{ type: "change", path: "a.ts" }],
    });

    const turn2 = agent.run("hi");
    expect(
      agent.updateQueue({ type: "steering_edit", id: "s1", content: "kept (edited)" }),
    ).toBe("live");
    expect(agent.updateQueue({ type: "steering_remove", id: "s2" })).toBe("live");
    const final = await turn2;

    // Delivered by id at the opening: the edit's content, the removal gone.
    expect(final.messages.find((m) => m.id === "s1")?.content).toBe("kept (edited)");
    expect(final.messages.some((m) => m.id === "s2")).toBe(false);
    // Exactly one durable record each — the Runner's recorder persists the
    // buffered mutations at materialization (Task 11: "live" = the gateway
    // persists nothing).
    expect(events.filter((e) => e.type === "steering_edited")).toHaveLength(1);
    expect(events.filter((e) => e.type === "steering_removed")).toHaveLength(1);
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

  it("editing a queued message with attachments preserves the attachment blocks", async () => {
    // D16: an edit replaces only the text surface — the entry's non-text
    // blocks (attachments) ride along after the new text, on BOTH the seed
    // path (no Runner yet) and the live path (running Runner).
    const imageA: ContentBlock = {
      type: "image",
      source: { type: "ref", id: "att-a", mediaType: "image/png" },
      width: 8,
      height: 8,
    };
    const imageB: ContentBlock = {
      type: "image",
      source: { type: "ref", id: "att-b", mediaType: "image/jpeg" },
      width: 4,
      height: 4,
    };
    const events: TranscriptEventInput[] = [];
    const model = createGatedModel([[textDelta("ok"), modelDone("end_turn")]]);
    const seeded: UserMessage[] = [
      { id: "q1", role: "user", content: [{ type: "text", text: "seed 图文" }, imageA] },
      { id: "q2", role: "user", content: "seed 纯文本" },
      { id: "q3", role: "user", content: [{ type: "text", text: "live 图文" }, imageB] },
      { id: "q4", role: "user", content: "live 纯文本" },
    ];
    const agent = createAgent({
      modelPort: model,
      initialQueuedInputs: seeded,
      chatStore: {
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          events.push(...batch);
        },
      },
      chatSessionId: "chat-1",
    });

    // Seed path (no state source exists yet): the host array receives the
    // merged content — text first, attachment preserved after it.
    expect(
      agent.updateQueue({ type: "steering_edit", id: "q1", content: "改过的 seed 图文" }),
    ).toBe("seed");
    expect(seeded[0]!.content).toEqual([
      { type: "text", text: "改过的 seed 图文" },
      imageA,
    ]);
    // A pure-text entry edits byte-for-byte unchanged — still a plain string.
    expect(
      agent.updateQueue({ type: "steering_edit", id: "q2", content: "改过的 seed 纯文本" }),
    ).toBe("seed");
    expect(seeded[1]!.content).toBe("改过的 seed 纯文本");

    // A file_changed turn opens WITHOUT flushing the queue, so every entry
    // is still editable while the first model call is gated — the live path.
    const turn = agent.run({
      type: "file_changed",
      watchId: "w1",
      events: [{ type: "change", path: "a.ts" }],
    });
    await waitUntil(() => model.callCount === 1, "model call in flight");
    expect(
      agent.updateQueue({ type: "steering_edit", id: "q3", content: "改过的 live 图文" }),
    ).toBe("live");
    expect(
      agent.getState().queuedUserInputs.find((m) => m.id === "q3")!.content,
    ).toEqual([{ type: "text", text: "改过的 live 图文" }, imageB]);
    expect(
      agent.updateQueue({ type: "steering_edit", id: "q4", content: "改过的 live 纯文本" }),
    ).toBe("live");
    expect(
      agent.getState().queuedUserInputs.find((m) => m.id === "q4")!.content,
    ).toBe("改过的 live 纯文本");

    model.openGate();
    const final = await turn;
    // Delivered at the end_turn continuation, merged content intact and in
    // order: text first, then the original attachment block.
    expect(final.messages.find((m) => m.id === "q1")!.content).toEqual([
      { type: "text", text: "改过的 seed 图文" },
      imageA,
    ]);
    expect(final.messages.find((m) => m.id === "q2")!.content).toBe(
      "改过的 seed 纯文本",
    );
    expect(final.messages.find((m) => m.id === "q3")!.content).toEqual([
      { type: "text", text: "改过的 live 图文" },
      imageB,
    ]);
    expect(final.messages.find((m) => m.id === "q4")!.content).toBe(
      "改过的 live 纯文本",
    );

    // The durable record mirrors the merged content — the web's queue fold
    // reads steering_edited, so what the host persists must carry the blocks.
    const edited = events.filter((e) => e.type === "steering_edited");
    expect(edited.map((e) => (e.data as { id: string }).id).sort()).toEqual([
      "q3",
      "q4",
    ]);
    expect(
      edited.find((e) => (e.data as { id: string }).id === "q3")!.data,
    ).toEqual({
      id: "q3",
      content: [{ type: "text", text: "改过的 live 图文" }, imageB],
    });
  });
});
