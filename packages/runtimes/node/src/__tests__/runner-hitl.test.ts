import { describe, it, expect } from "vitest";
import type {
  ToolDefinition,
  StepContext,
  PendingToolCall,
  ToolResult,
  SessionSnapshot,
  SessionStore,
  ApprovalGate,
} from "@volto/core";
import {
  createMockModelPort,
  toolUseStart,
  toolUseDelta,
  modelDone,
  textDelta,
  createDefaultPermissionConfig,
} from "@volto/core";
import { createRunner } from "../runner.js";
import { createAutoAllowGate } from "../approval-gate.js";

const writeTool: ToolDefinition = {
  name: "edit_file",
  description: "edit a file",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: [],
  riskTier: "WRITE_HIGH", // default policy → "ask"
};

const ctx: StepContext = { tools: [writeTool], model: "test" };

/** Model: one WRITE_HIGH tool_use, then a closing text turn. */
function oneToolThenDone() {
  return createMockModelPort([
    [toolUseStart("c1", "edit_file"), toolUseDelta("c1", "{}"), modelDone("tool_use")],
    [textDelta("done"), modelDone("end_turn")],
  ]);
}

function countingExecutor(): { exec: (c: PendingToolCall) => Promise<ToolResult>; count: () => number } {
  let n = 0;
  return {
    exec: async () => {
      n++;
      return { modelContent: "ok" };
    },
    count: () => n,
  };
}

/** A gate that records how many times it was asked. */
function recordingGate(decision: "allow" | "deny"): ApprovalGate & { asks: () => number } {
  let asks = 0;
  return {
    ask: async () => {
      asks++;
      return decision;
    },
    asks: () => asks,
  };
}

describe("Runner HITL — ask closure", () => {
  it("AC: WRITE_HIGH tool, auto-allow → tool executes once and run reaches done", async () => {
    const { exec, count } = countingExecutor();
    const gate = recordingGate("allow");
    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: gate,
    });

    const final = await runner.run({ type: "user_message", content: "go" });

    expect(final.status).toBe("done");
    expect(count()).toBe(1); // approved tool actually ran (closure closed)
    expect(gate.asks()).toBe(1); // asked exactly once — no re-prompt loop
    expect(final.pendingTools).toHaveLength(0);
  });

  it("AC: deny → tool does not run and the model is re-called", async () => {
    const { exec, count } = countingExecutor();
    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: recordingGate("deny"),
    });

    const final = await runner.run({ type: "user_message", content: "go" });

    expect(count()).toBe(0); // denied → never executed
    expect(final.status).toBe("done"); // model was re-called and finished the turn
    const denyMsg = final.messages.find(
      (m) => m.role === "tool" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && b.isError),
    );
    expect(denyMsg).toBeDefined();
  });
});

describe("Runner HITL — checkpoint + resume", () => {
  it("AC: pause writes a checkpoint to the store", async () => {
    const saved: SessionSnapshot[] = [];
    const store: SessionStore = {
      async save(s) {
        saved.push(s);
      },
      async load() {
        return undefined;
      },
      async list() {
        return [];
      },
    };

    // A gate that pauses out-of-process: deny is irrelevant — we only want to
    // observe the checkpoint emitted on request_approval. Use a gate that
    // throws-free allow so the run also completes.
    const { exec } = countingExecutor();
    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
      sessionStore: store,
      sessionId: "sess-1",
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(saved.length).toBeGreaterThanOrEqual(1);
    const cp = saved[0]!;
    expect(cp.id).toBe("sess-1");
    expect(cp.state.status).toBe("waiting_for_approval");
    expect(cp.state.pendingApprovalTool?.id).toBe("c1");
  });

  it("AC (D-4): an injected Clock makes checkpoint timestamps deterministic", async () => {
    const saved: SessionSnapshot[] = [];
    const store: SessionStore = {
      async save(s) {
        saved.push(s);
      },
      async load() {
        return undefined;
      },
      async list() {
        return [];
      },
    };

    const { exec } = countingExecutor();
    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
      sessionStore: store,
      sessionId: "sess-clock",
      clock: { now: () => 4242 }, // seeded clock → deterministic createdAt
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved.every((s) => s.createdAt === 4242)).toBe(true);
  });

  it("AC: resume(id, allow) yields a final state equivalent to the never-interrupted run", async () => {
    // 1) Never-interrupted baseline: auto-allow gate drives it to done in-process.
    const baselineExec = countingExecutor();
    const baseline = await createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: baselineExec.exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
    }).run({ type: "user_message", content: "go" });

    // 2) Interrupted run: a gate that "pauses" by leaving the decision to resume.
    //    We capture the checkpoint, then resume on a fresh runner.
    const store = (() => {
      const m = new Map<string, SessionSnapshot>();
      const s: SessionStore = {
        async save(snap) {
          m.set(snap.id, snap);
        },
        async load(id) {
          return m.get(id);
        },
        async list() {
          return [...m.values()];
        },
      };
      return s;
    })();

    // Pausing gate: never resolves in-process — instead we drive resume manually.
    // Model here only emits the tool_use turn; the closing turn is consumed on resume.
    const pausingModel = oneToolThenDone();
    const pauseExec = countingExecutor();
    let pauseAsks = 0;
    const pausingGate: ApprovalGate = {
      // Return a promise that resolves to deny only if ever called more than once;
      // first call we throw to abort the in-process loop after the checkpoint.
      ask: async () => {
        pauseAsks++;
        throw new Error("pause: defer to resume");
      },
    };

    const interrupted = createRunner({
      modelPort: pausingModel,
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: pauseExec.exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: pausingGate,
      sessionStore: store,
      sessionId: "sess-2",
    });

    // The pausing gate throws; the run rejects, but the checkpoint was already saved.
    await expect(interrupted.run({ type: "user_message", content: "go" })).rejects.toThrow("pause");
    expect(pauseAsks).toBe(1);
    expect(pauseExec.count()).toBe(0); // not executed before approval
    const cp = await store.load("sess-2");
    expect(cp?.state.status).toBe("waiting_for_approval");

    // 3) Resume on a fresh runner with the closing model turn available.
    const resumeExec = countingExecutor();
    const resumed = createRunner({
      modelPort: createMockModelPort([[textDelta("done"), modelDone("end_turn")]]),
      stepContext: ctx,
      availableCapabilities: new Set(),
      toolExecutor: resumeExec.exec,
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
      sessionStore: store,
      sessionId: "sess-2",
    });

    const final = await resumed.resume("sess-2", "allow");

    expect(resumeExec.count()).toBe(1); // approved tool ran exactly once on resume
    expect(final.status).toBe(baseline.status); // equivalent terminal status
    expect(final.status).toBe("done");
    // Equivalent message shape: both end with the assistant's closing text.
    const lastBaseline = baseline.messages[baseline.messages.length - 1]!;
    const lastResumed = final.messages[final.messages.length - 1]!;
    expect(lastResumed.role).toBe(lastBaseline.role);
  });
});
