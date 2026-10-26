import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
// NOTE: createMockModelPort/textDelta are exported from "@volto/core" itself
// (re-exported from its internal ./testing/mock-model-port.js). The package's
// "./testing" subpath export maps only to store-contract.js, which does not
// include them — importing from "@volto/core/testing" does not compile.
import { createMockModelPort, textDelta, textScript, toolCallScript } from "@volto/core";
import type { TranscriptEventInput } from "@volto/core";

function fakeChatStore() {
  const bySession = new Map<string, TranscriptEventInput[]>();
  return {
    bySession,
    store: {
      async appendEvents(sessionId: string, events: TranscriptEventInput[]) {
        const list = bySession.get(sessionId) ?? [];
        list.push(...events);
        bySession.set(sessionId, list);
      },
    },
  };
}

describe("createAgent transcript orchestration", () => {
  it("records session_meta once at construction", async () => {
    const { store, bySession } = fakeChatStore();
    createAgent({
      modelPort: createMockModelPort([]),
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: "p1", providerId: "v1", modelId: "m1", permissionMode: "plan" },
    });

    await new Promise((r) => setTimeout(r, 0));
    const events = bySession.get("chat-1") ?? [];
    const sessionMetas = events.filter((e) => e.type === "session_meta");
    expect(sessionMetas).toHaveLength(1);
    // session_meta is session-level, not turn-scoped — nothing should stamp
    // a `turn` on it, unlike everything else in the log.
    expect(sessionMetas[0]!.turn).toBeUndefined();
  });

  it("does not re-append messages at the end of a turn", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]),
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
    });

    await agent.run("hello");

    const events = bySession.get("chat-1") ?? [];
    // Exactly one assistant_message — the Runner's. No turn-end bulk replay.
    expect(events.filter((e) => e.type === "assistant_message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
  });

  // NOTE: a throwing ModelPort does NOT reject runner.run() — the Runner
  // normalizes that into a reducer "model_error" input (see
  // stream-early-break.test.ts), and errors never interrupt the main loop.
  // A throwing `resolveContextLayers` is the genuine rejection path this
  // code exists for: the Runner is never even constructed for that turn.
  // It also doubles as coverage for the turn-numbering bug this test guards
  // against (see both cases below).

  it("records a turn_end with reason error and turn 1 when the very first turn's resolveContextLayers throws", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: createMockModelPort([]),
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      resolveContextLayers: async () => {
        throw new Error("layers exploded");
      },
    });

    await agent.run("hello").catch(() => {});

    const events = bySession.get("chat-1") ?? [];
    const turnEnd = events.find(
      (e) => e.type === "turn_end" && (e.data as { error?: string }).error !== undefined,
    );
    expect(turnEnd).toBeDefined();
    expect((turnEnd!.data as { reason: string }).reason).toBe("error");
    expect((turnEnd!.data as { error: string }).error).toContain("layers exploded");
    // A first-turn failure must record turn 1, never turn 0.
    expect(turnEnd!.turn).toBe(1);
    expect((turnEnd!.data as { turn: number }).turn).toBe(1);
  });

  it("records a turn_end with reason error and turn 2 when createNextRunner rejects after a prior successful turn", async () => {
    const { store, bySession } = fakeChatStore();
    // Per-turn createNextRunner rejection: the config layer is read once per
    // turn claim, so a getter can blow up on turn 2 after turn 1 succeeded.
    // (resolveContextLayers is once-per-conversation and cannot fail turn 2.)
    let configReads = 0;
    const agent = createAgent({
      modelPort: createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]),
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      config: {
        config: {
          get reasoningStrategy(): "emit" {
            configReads++;
            if (configReads > 1) throw new Error("layers exploded");
            return "emit";
          },
        },
        resolvedFrom: {},
      },
      resolveContextLayers: async () => [],
    });

    await agent.run("first turn");
    await agent.run("second turn").catch(() => {});

    const events = bySession.get("chat-1") ?? [];
    const turnEnd = events.find(
      (e) => e.type === "turn_end" && (e.data as { error?: string }).error !== undefined,
    );
    expect(turnEnd).toBeDefined();
    expect((turnEnd!.data as { error: string }).error).toContain("layers exploded");
    // Must be attributed to turn 2 (the failing turn), never turn 1 (the
    // prior, already-successful turn) — that was the exact bug: turnCounter
    // used to be incremented only after the later awaits, so a rejection
    // there left it pointing at the previous turn.
    expect(turnEnd!.turn).toBe(2);
    expect((turnEnd!.data as { turn: number }).turn).toBe(2);
  });

  it("records an error event, not a duplicate turn_end, when a Runner exists and run() rejects", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: createMockModelPort([textScript("unreachable")]),
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
      hooks: [
        {
          name: "boom-hook",
          lifecycle: "session:start",
          handler: async () => {
            throw new Error("boom");
          },
        },
      ],
    });

    await agent.run("hi").catch(() => {});

    const events = bySession.get("chat-1") ?? [];
    // The Runner's own try/finally already recorded turn_end for this turn —
    // exactly one, and it must not carry an error message (that's the SDK's
    // job, via a separate `error` event).
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect((turnEnds[0]!.data as { error?: string }).error).toBeUndefined();

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toContain("boom");
  });

  it("gives a sub-agent its own session, linked to the parent, and never leaks its output into the parent session", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: createMockModelPort([
        // main agent spawns a sub-agent via the task tool
        toolCallScript("call-1", "task", JSON.stringify({ message: "research" })),
        // sub-agent's own reply
        textScript("sub finished"),
        // main agent's final reply
        textScript("main done"),
      ]),
      enableTaskTool: true,
      chatStore: store,
      chatSessionId: "parent-1",
    });

    await agent.run("hi");

    const parentEvents = bySession.get("parent-1") ?? [];
    const started = parentEvents.find((e) => e.type === "subagent_started");
    const finished = parentEvents.find((e) => e.type === "subagent_finished");
    expect(started).toBeDefined();
    expect(finished).toBeDefined();

    const childSessionId = (started!.data as { childSessionId: string }).childSessionId;
    expect(childSessionId).toBe((finished!.data as { childSessionId: string }).childSessionId);
    expect((finished!.data as { isError: boolean }).isError).toBe(false);

    // The parent session must never contain the sub-agent's own output.
    const parentAssistantTexts = parentEvents
      .filter((e) => e.type === "assistant_message")
      .flatMap((e) => (e.data as { content: Array<{ type: string; text?: string }> }).content)
      .map((c) => c.text ?? "")
      .join("|");
    expect(parentAssistantTexts).not.toContain("sub finished");

    // The child session is a real, independent session: its first event is
    // its own session_meta, carrying origin + parentSessionId, and its own
    // turn's events (including the sub-agent's actual output) land there.
    const childEvents = bySession.get(childSessionId) ?? [];
    expect(childEvents[0]?.type).toBe("session_meta");
    const meta = childEvents[0]!.data as { origin?: string; parentSessionId?: string };
    expect(meta.origin).toBe("subagent");
    expect(meta.parentSessionId).toBe("parent-1");

    const childAssistantMessages = childEvents.filter((e) => e.type === "assistant_message");
    expect(childAssistantMessages).toHaveLength(1);
    const childText = (childAssistantMessages[0]!.data as { content: Array<{ type: string; text?: string }> })
      .content.map((c) => c.text ?? "")
      .join("");
    expect(childText).toContain("sub finished");
  });

  it("never writes an orphaned sub-agent session when chatStore is set but chatSessionId is not", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: createMockModelPort([
        toolCallScript("call-1", "task", JSON.stringify({ message: "research" })),
        textScript("sub finished"),
        textScript("main done"),
      ]),
      enableTaskTool: true,
      chatStore: store,
      // chatSessionId intentionally omitted — there is no parent session to
      // link a child to, so no session (parent OR child) should be written
      // at all, and in particular no "undefined-sub-…" child session.
    });

    await agent.run("hi");

    expect(bySession.size).toBe(0);
  });

  it("works with no chatStore configured", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]),
    });
    await expect(agent.run("hello")).resolves.toBeDefined();
  });
});
