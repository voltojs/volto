import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
// NOTE: createMockModelPort/textDelta are exported from "@volto/core" itself
// (re-exported from its internal ./testing/mock-model-port.js). The package's
// "./testing" subpath export maps only to store-contract.js, which does not
// include them — importing from "@volto/core/testing" does not compile.
import { createMockModelPort, textDelta } from "@volto/core";
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
    expect(events.filter((e) => e.type === "session_meta")).toHaveLength(1);
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

  it("records a turn_end with reason error when the turn throws", async () => {
    const { store, bySession } = fakeChatStore();
    const agent = createAgent({
      modelPort: {
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error("provider exploded");
        },
      },
      chatStore: store,
      chatSessionId: "chat-1",
      chatMeta: { projectId: null, providerId: null, modelId: null, permissionMode: null },
    });

    await agent.run("hello").catch(() => {});

    const events = bySession.get("chat-1") ?? [];
    const turnEnd = events.find((e) => e.type === "turn_end");
    expect(turnEnd).toBeDefined();
    expect((turnEnd!.data as { reason: string }).reason).toBe("error");
  });

  it("works with no chatStore configured", async () => {
    const agent = createAgent({
      modelPort: createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]),
    });
    await expect(agent.run("hello")).resolves.toBeDefined();
  });
});
