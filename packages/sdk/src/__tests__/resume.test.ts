import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createMemoryStore } from "@voltojs/store-memory";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@voltojs/core";
import type {
  ToolDefinition,
  ToolResult,
  ApprovalGate,
  TranscriptEventInput,
} from "@voltojs/core";
import type { Tool } from "@voltojs/tools-common";

const dangerousTool: ToolDefinition = {
  name: "dangerous_op",
  description: "A tool gated by HITL approval",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: ["test:danger"],
  riskTier: "WRITE_HIGH",
};

function makeDangerousTool(): Tool {
  return {
    definition: dangerousTool,
    handler: async (): Promise<ToolResult> => ({
      modelContent: "operation completed",
    }),
  };
}


describe("SDK resume() — positive paths", () => {
  it("HITL ask → checkpoint → in-memory resume('allow') executes the tool and continues", async () => {
    const mockModel = createMockModelPort([
      // call 1: model asks for the dangerous tool
      toolCallScript("c1", "dangerous_op", "{}"),
      // call 2: model wraps up after tool result
      textScript("done after approval"),
    ]);

    // Gate that defers by returning "deny" first time (forcing the SDK to
    // checkpoint), but we use the in-memory resume path instead — so set up
    // a gate that throws to prove it is bypassed once resume() pre-authorizes.
    const gate: ApprovalGate = {
      ask: async () => {
        // Should never be called for this test path — the gate's "ask" is
        // invoked inside the runner during the *first* execution, before
        // we call resume(). To exercise resume() we need the runner to be
        // in waiting_for_approval; we do this by making the gate defer
        // until resume by returning a pending-style promise.
        return new Promise<"allow" | "deny">(() => {
          /* never resolves — runner stays in waiting_for_approval */
        });
      },
    };

    const store = createMemoryStore();
    const agent = createAgent({
      modelPort: mockModel,
      tools: [makeDangerousTool()],
      capabilities: new Set(["test:danger"]),
      approvalGate: gate,
      sessionStore: store,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
    });

    // Fire the first turn but don't await — the runner will park in
    // waiting_for_approval because the gate never resolves.
    const runPromise = agent.run("do it");
    // Wait a tick for the runner to reach waiting_for_approval and checkpoint.
    await new Promise((r) => setTimeout(r, 30));

    // The session must have been persisted.
    const saved = await store.list();
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const sessionId = saved[0]!.id;

    // Resume with allow — should bypass the gate, execute the tool, and
    // re-call the model for the final text.
    const finalState = await agent.resume(sessionId, "allow");
    expect(finalState.status).toBe("done");
    // Final assistant message should contain the wrap-up text.
    const last = finalState.messages[finalState.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    const lastText = Array.isArray(last.content)
      ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      : "";
    expect(lastText).toContain("done after approval");

    // Allow the orphaned runPromise to settle (it was abandoned because we
    // resumed via a fresh runner; the gate's pending promise keeps the
    // original alive, so we just don't await it here).
    void runPromise;
  });

  it("resume('nonexistent') from a fresh agent throws Session not found", async () => {
    const mockModel = createMockModelPort([textScript("never used")]);
    const agent = createAgent({ modelPort: mockModel });
    await expect(agent.resume("does-not-exist", "allow")).rejects.toThrow(
      "Session not found",
    );
  });

  it("cross-process resume: a fresh agent with the same store can resume a checkpoint", async () => {
    // 1) First agent process: trigger checkpoint via deferred gate.
    const sharedStore = createMemoryStore();

    const model1 = createMockModelPort([
      toolCallScript("c1", "dangerous_op", "{}"),
      textScript("not reached in first agent"),
    ]);
    const deferredGate: ApprovalGate = {
      ask: () => new Promise<"allow" | "deny">(() => {}),
    };
    const agent1 = createAgent({
      modelPort: model1,
      tools: [makeDangerousTool()],
      capabilities: new Set(["test:danger"]),
      approvalGate: deferredGate,
      sessionStore: sharedStore,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
    });
    const dangling1 = agent1.run("first round");
    await new Promise((r) => setTimeout(r, 30));

    const snapshots = await sharedStore.list();
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const sessionId = snapshots[0]!.id;

    // 2) Second agent process: brand new agent instance (simulating a
    //    process restart), shares only the store and model script.
    const model2 = createMockModelPort([
      // call 1 from fresh agent: post-approval final reply
      textScript("resumed in a brand new agent"),
    ]);
    const agent2 = createAgent({
      modelPort: model2,
      tools: [makeDangerousTool()],
      capabilities: new Set(["test:danger"]),
      sessionStore: sharedStore,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
    });

    const finalState = await agent2.resume(sessionId, "allow");
    expect(finalState.status).toBe("done");
    const last = finalState.messages[finalState.messages.length - 1]!;
    const lastText = Array.isArray(last.content)
      ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      : "";
    expect(lastText).toContain("resumed in a brand new agent");

    void dangling1;
  });
});

describe("SDK resume() — settle-window steering", () => {
  it("a steer landing inside resume()'s settle window stays visible to getState", async () => {
    // The resumed turn's `return state` snapshot binds BEFORE resume()'s own
    // finally (recordTurnEnd → awaited recorder flush), so a steer landing
    // in that window reaches only the Runner's live state until the
    // end-of-turn commit re-absorbs it — otherwise the message vanishes from
    // getState() AND from the next turn's carry-forward (the same never-lost
    // invariant as run()/stream()'s settle window).
    const mockModel = createMockModelPort([
      toolCallScript("c1", "dangerous_op", "{}"),
      textScript("done after approval"),
    ]);
    const gate: ApprovalGate = {
      ask: () => new Promise<"allow" | "deny">(() => {}),
    };

    const sessionStore = createMemoryStore();
    let steered = false;
    const agent: ReturnType<typeof createAgent> = createAgent({
      modelPort: mockModel,
      tools: [makeDangerousTool()],
      capabilities: new Set(["test:danger"]),
      approvalGate: gate,
      sessionStore,
      permissionConfig: { sandbox: "workspace-write", approval: "ask" },
      chatStore: {
        // The turn_end flush runs inside resume()'s finally — between the
        // `return state` snapshot and the end-of-turn commit — so a steer
        // issued here lands pre-commit, exactly like the gateway's
        // turn_end → latch-release window.
        async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
          if (!steered && batch.some((event) => event.type === "turn_end")) {
            steered = true;
            agent.steer("late resume steer");
          }
        },
      },
      chatSessionId: "chat-resume-settle",
    });

    const runPromise = agent.run("do it");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saved = await sessionStore.list();
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const sessionId = saved[0]!.id;

    const finalState = await agent.resume(sessionId, "allow");
    // The steer must actually have landed inside resume()'s settle window.
    expect(steered).toBe(true);
    expect(finalState.status).toBe("done");

    // The queue must be visible through getState() — the same lastFinalState
    // the next turn's carry-forward reads, so this pins never-lost too.
    const queued = agent.getState().queuedUserInputs;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe("late resume steer");

    void runPromise;
  });
});
