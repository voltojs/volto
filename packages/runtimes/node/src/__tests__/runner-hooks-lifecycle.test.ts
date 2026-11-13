/**
 * T10 Task 3 — runner wiring for the four new hook lifecycle points
 * (spec 2026-10-17-hooks-host-surface, D3 / §4.2, F-031 / F-032 / F-033).
 *
 * Coverage:
 *  (a) userPromptSubmit (F-031): deny → status done, ZERO model requests,
 *      `[prompt rejected by hook: <reason>]` verbatim in the final messages;
 *      continue → one normal turn.
 *  (b) preCompact (F-032): deny → passthrough (original messages intact, no
 *      summarization call) + `preCompact_skipped` event with `{ reason }`,
 *      turn completes; continue → compaction proceeds (regression);
 *      compactInfo ctx fields asserted at both outcomes.
 *  (c) subagentStop / notification (F-033): deny-form outcomes fed at the
 *      observe-only points produce ZERO state change (negative witness —
 *      final state deep-equals the continue-hook scenario); ctx fields
 *      (childSessionId / notification.kind) correct.
 *  (d) observe-only hook FAILURE surfacing (spec §6): a thrown handler or
 *      a deny outcome at subagentStop / notification emits a raw
 *      `hook_error` EventSink event (lifecycle + error) and never denies —
 *      state deep-equals the continue scenario, turn completes.
 *
 * Timeout-safe wiring (hook timeouts hanging the turn) is pinned in Task 2's
 * runCommandHook tests — not re-tested here.
 */
import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  textDelta,
  usage,
  modelDone,
  createCharTokenizer,
  createInitialState,
  createDefaultPermissionConfig,
} from "@voltojs/core";
import type {
  Hook,
  HookContext,
  HookOutcome,
  Message,
  ModelEvent,
  ModelPort,
  ModelRequest,
  StepContext,
  ReducerState,
  CompactionConfig,
  ToolDefinition,
  EventSink,
  ApprovalGate,
} from "@voltojs/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const ctx: StepContext = { tools: [], model: "test-model" };

/**
 * Model port that records every request and replays a script of event
 * sequences. `requests.length === 0` is the "no model call happened"
 * witness for the userPromptSubmit deny path.
 */
function captureModelPort(scripts: ModelEvent[][]): ModelPort & {
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(req);
      const events = scripts[index++];
      if (!events) throw new Error(`captureModelPort: no script for call ${index - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

/** Capture sink: records every event the runner forwards raw. */
function captureSink(): {
  sink: EventSink;
  events: Array<{ type: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const sink: EventSink = { emit: (e) => { events.push(e); } };
  return { sink, events };
}

/** Hook factory: records every ctx it saw, returns a fixed outcome. */
function recordingHook(
  name: string,
  lifecycle: Hook["lifecycle"],
  outcome: HookOutcome,
): { hook: Hook; ctxs: HookContext[] } {
  const ctxs: HookContext[] = [];
  return {
    hook: {
      name,
      lifecycle,
      handler: (hookCtx): HookOutcome => {
        ctxs.push(hookCtx);
        return outcome;
      },
    },
    ctxs,
  };
}

/** Flat text projection of a message list (mirrors runner-compaction.test.ts). */
function flattenText(messages: ReadonlyArray<{ content: unknown }>): string {
  return messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((c: { type: string; text?: string; content?: unknown }) =>
                c.type === "text"
                  ? c.text ?? ""
                  : c.type === "tool_result"
                    ? Array.isArray(c.content)
                      ? (c.content as Array<{ type: string; text?: string }>)
                          .map((b) => (b.type === "text" ? b.text ?? "" : ""))
                          .join("")
                      : ""
                    : "",
              )
              .join("")
          : "",
    )
    .join("|");
}

function makeMessages(n: number, prefix: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${prefix}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0
        ? `${prefix}-user-${i}`
        : [{ type: "text", text: `${prefix}-asst-${i}` }],
    } as Message);
  }
  return out;
}

function makeInitial(messages: Message[]): ReducerState {
  return {
    messages,
    pendingTools: [],
    status: "idle",
    tokenBudget: undefined,
    tokensUsed: 0,
    maxIterations: 20,
    iterationCount: 0,
    readFiles: [],
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
    queuedUserInputs: [],
    toolCallCount: 0,
    maxToolCalls: undefined,
    maxCostDollars: undefined,
    maxTokensPerTurn: undefined,
    maxWallclockMs: undefined,
    maxLoopCount: undefined,
    selfCorrectionCount: 0,
    maxSelfCorrections: undefined,
    loopInterventionCount: 0,
    loopRemindedCount: 0,
  };
}

/** The compaction scenario: system + 20 alternating old messages. */
function compactionInitialState(): ReducerState {
  const systemMsg: Message = { id: "m1", role: "system", content: "you are helpful" };
  return makeInitial([systemMsg, ...makeMessages(20, "old")]);
}

const compaction: CompactionConfig = {
  tokenizer: createCharTokenizer(1),
  maxTokens: 50,
  recentKeepCount: 2,
};

// ──────────────────────────────────────────────
// (a) userPromptSubmit — F-031
// ──────────────────────────────────────────────

describe("T10 Task 3 — userPromptSubmit (F-031)", () => {
  it("deny → turn never starts: status done, zero model requests, rejection text verbatim", async () => {
    const port = captureModelPort([]);
    const { hook, ctxs } = recordingHook("deny-prompt", "userPromptSubmit", {
      action: "deny",
      reason: "not before coffee",
    });

    const runner = createRunner({
      modelPort: port,
      stepContext: ctx,
      sessionId: "sess-1",
      hooks: [hook],
    });

    const final = await runner.run({ type: "user_message", content: "please run everything" });

    expect(final.status).toBe("done");
    expect(port.requests).toHaveLength(0);

    // Verbatim spec §4.2 template in the final messages.
    const userTexts = final.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userTexts).toContain("[prompt rejected by hook: not before coffee]");
    // The rejected prompt itself never entered the conversation.
    expect(userTexts).not.toContain("please run everything");

    // ctx carried sessionId + prompt.
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.lifecycle).toBe("userPromptSubmit");
    expect(ctxs[0]!.sessionId).toBe("sess-1");
    expect(ctxs[0]!.prompt).toBe("please run everything");
  });

  it("continue → one normal turn", async () => {
    const port = captureModelPort([textScript("ack")]);
    const { hook, ctxs } = recordingHook("allow-prompt", "userPromptSubmit", {
      action: "continue",
    });

    const runner = createRunner({
      modelPort: port,
      stepContext: ctx,
      sessionId: "sess-1",
      hooks: [hook],
    });

    const final = await runner.run({ type: "user_message", content: "hello" });

    expect(final.status).toBe("done");
    expect(port.requests).toHaveLength(1);
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.prompt).toBe("hello");
    // The assistant replied — the turn ran normally.
    expect(final.messages.some((m) => m.role === "assistant")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// (b) preCompact — F-032
// ──────────────────────────────────────────────

describe("T10 Task 3 — preCompact (F-032)", () => {
  it("deny → passthrough: no summary call, original history intact, preCompact_skipped event, turn completes", async () => {
    // Only the MAIN call is scripted — a summarization call would exhaust
    // the script and throw, so the single call doubles as the witness.
    const port = captureModelPort([textScript("ack")]);
    const { sink, events } = captureSink();
    const { hook, ctxs } = recordingHook("deny-compact", "preCompact", {
      action: "deny",
      reason: "archive first",
    });

    const runner = createRunner({
      modelPort: port,
      stepContext: ctx,
      initialState: compactionInitialState(),
      compaction,
      hooks: [hook],
      eventSink: sink,
    });

    const final = await runner.run({ type: "user_message", content: "now-user" });

    expect(final.status).toBe("done");
    // Passthrough: only the main call ran — no summarization call.
    expect(port.requests).toHaveLength(1);
    const mainText = flattenText(port.requests[0]!.messages);
    expect(mainText).not.toContain("[Earlier conversation summary]");
    // Every original history message survived byte-identical (all 20;
    // even indices are user-role, odd are assistant-role).
    for (let i = 0; i < 20; i++) {
      expect(mainText).toContain(i % 2 === 0 ? `old-user-${i}` : `old-asst-${i}`);
    }

    // State likewise untouched by compaction.
    const stateText = flattenText(final.messages);
    expect(stateText).not.toContain("[Earlier conversation summary]");

    // The skip is announced to the UI with the hook's reason, verbatim.
    const skipped = events.find((e) => e.type === "preCompact_skipped");
    expect(skipped, "preCompact_skipped event must be emitted").toBeDefined();
    expect(skipped!.data).toEqual({ reason: "archive first" });

    // ctx carried the compaction facts.
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.lifecycle).toBe("preCompact");
    expect(ctxs[0]!.compactInfo!.compressibleCount).toBe(19);
    expect(ctxs[0]!.compactInfo!.currentTokens).toBeGreaterThan(0);

    // Reference-identity passthrough witness through the public API: a
    // re-entrant compactNow() hits the same deny and leaves state.messages
    // as the SAME array reference (no write-back feed ran).
    const msgsBefore = runner.getState().messages;
    expect(await runner.compactNow()).toBeNull();
    expect(runner.getState().messages).toBe(msgsBefore);
  });

  it("continue → compaction proceeds (summary written back)", async () => {
    const port = captureModelPort([
      textScript("SUMMARY-OF-OLD-MESSAGES"),
      textScript("ack"),
    ]);
    const { sink, events } = captureSink();
    const { hook, ctxs } = recordingHook("allow-compact", "preCompact", {
      action: "continue",
    });

    const runner = createRunner({
      modelPort: port,
      stepContext: ctx,
      initialState: compactionInitialState(),
      compaction,
      hooks: [hook],
      eventSink: sink,
    });

    const final = await runner.run({ type: "user_message", content: "now-user" });

    expect(final.status).toBe("done");
    // Summarization call + main call — compaction ran as before.
    expect(port.requests).toHaveLength(2);
    const summary = final.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[Earlier conversation summary]"),
    );
    expect(summary, "summary message must be written back").toBeDefined();
    // No skip event on the continue path.
    expect(events.find((e) => e.type === "preCompact_skipped")).toBeUndefined();

    // ctx fields asserted on the continue path too.
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.compactInfo!.compressibleCount).toBeGreaterThan(0);
    expect(ctxs[0]!.compactInfo!.currentTokens).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
// (c) subagentStop / notification — F-033
// ──────────────────────────────────────────────

const taskTool: ToolDefinition = {
  name: "task",
  description: "Dispatch a sub-agent",
  inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  requires: [],
  riskTier: "WRITE_LOW",
};

const taskCtx: StepContext = { tools: [taskTool], model: "test-model" };

/** Sync subagent dispatch result: carries the child session id (tools/agent contract). */
const taskExecutor: ToolExecutor = async () => ({
  modelContent: "child done",
  displayMetadata: { taskId: "bg-1", background: false, sessionId: "child-77" },
});

function taskScript(): ModelEvent[][] {
  return [toolCallScript("t1", "task", '{"message":"do it"}'), textScript("done.")];
}

const writeTool: ToolDefinition = {
  name: "edit_file",
  description: "edit a file",
  inputSchema: { type: "object", properties: {}, required: [] },
  requires: [],
  riskTier: "WRITE_HIGH", // default policy → ask
};

describe("T10 Task 3 — subagentStop / notification observe-only points (F-033)", () => {
  it("subagentStop: deny-form outcome produces ZERO state change; ctx carries childSessionId", async () => {
    const runOnce = async (outcome: HookOutcome) => {
      const { hook, ctxs } = recordingHook("subagent-observe", "subagentStop", outcome);
      const runner = createRunner({
        modelPort: createMockModelPort(taskScript()),
        stepContext: taskCtx,
        toolExecutor: taskExecutor,
        availableCapabilities: new Set(),
        sessionId: "sess-1",
        hooks: [hook],
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, ctxs };
    };

    const denied = await runOnce({ action: "deny", reason: "hijack attempt" });
    const continued = await runOnce({ action: "continue" });

    // Negative witness: the deny-form outcome changed NOTHING.
    expect(denied.final).toEqual(continued.final);
    expect(denied.final.status).toBe("done");

    // ctx fields: fired exactly once, with the child session id + status.
    expect(denied.ctxs).toHaveLength(1);
    expect(denied.ctxs[0]!.lifecycle).toBe("subagentStop");
    expect(denied.ctxs[0]!.sessionId).toBe("sess-1");
    expect(denied.ctxs[0]!.subagentInfo).toEqual({
      childSessionId: "child-77",
      status: "completed",
    });
    expect(continued.ctxs).toHaveLength(1);
    expect(continued.ctxs[0]!.subagentInfo).toEqual({
      childSessionId: "child-77",
      status: "completed",
    });
  });

  it("notification (budget_warning): deny-form outcome produces ZERO state change; ctx kind correct", async () => {
    const runOnce = async (outcome: HookOutcome) => {
      const { hook, ctxs } = recordingHook("notify", "notification", outcome);
      // Cost threshold breached mid-stream — same scenario as
      // runner-cost-budget.test.ts.
      const pricing = { "test-model": { inputPer1M: 10, outputPer1M: 30 } };
      const runner = createRunner({
        modelPort: createMockModelPort([
          [usage(100, 100), textDelta("Done"), modelDone("end_turn")],
        ]),
        stepContext: ctx,
        availableCapabilities: new Set(),
        pricing,
        initialState: createInitialState({ maxCostDollars: 0.001 }),
        sessionId: "sess-1",
        hooks: [hook],
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, ctxs };
    };

    const denied = await runOnce({ action: "deny", reason: "quiet" });
    const continued = await runOnce({ action: "continue" });

    expect(denied.final.status).toBe("done");
    // Negative witness: the deny-form outcome changed NOTHING.
    expect(denied.final).toEqual(continued.final);

    expect(denied.ctxs.length).toBeGreaterThan(0);
    expect(denied.ctxs[0]!.lifecycle).toBe("notification");
    expect(denied.ctxs[0]!.sessionId).toBe("sess-1");
    expect(denied.ctxs[0]!.notification).toEqual({ kind: "budget_warning" });
  });

  it("notification (approval_requested): deny-form outcome produces ZERO state change; ctx kind correct", async () => {
    const runOnce = async (outcome: HookOutcome) => {
      const { hook, ctxs } = recordingHook("notify", "notification", outcome);
      const gate: ApprovalGate = { ask: async () => "allow" };
      const runner = createRunner({
        modelPort: createMockModelPort([
          toolCallScript("c1", "edit_file", "{}"),
          textScript("done"),
        ]),
        stepContext: { tools: [writeTool], model: "test-model" },
        availableCapabilities: new Set(),
        toolExecutor: async () => ({ modelContent: "ok" }),
        permissionConfig: createDefaultPermissionConfig(),
        approvalGate: gate,
        sessionId: "sess-1",
        hooks: [hook],
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, ctxs };
    };

    const denied = await runOnce({ action: "deny", reason: "quiet" });
    const continued = await runOnce({ action: "continue" });

    expect(denied.final.status).toBe("done");
    // Negative witness: the deny-form outcome changed NOTHING — the tool
    // still executed and the turn closed identically.
    expect(denied.final).toEqual(continued.final);

    expect(denied.ctxs.length).toBeGreaterThan(0);
    expect(denied.ctxs[0]!.lifecycle).toBe("notification");
    expect(denied.ctxs[0]!.notification).toEqual({ kind: "approval_requested" });
  });
});

// ──────────────────────────────────────────────
// (d) hook_error surfacing at the observe-only points — spec §6
//     ("只观察点的 hook 失败 → 记 EventSink hook_error 事件，不 deny").
// ──────────────────────────────────────────────

describe("T10 final review — observe-only hook failures surface as hook_error (spec §6)", () => {
  it("subagentStop: THROWN handler → hook_error event with lifecycle + error message; state deep-equals the continue scenario; turn completes", async () => {
    const runOnce = async (hook: Hook) => {
      const { sink, events } = captureSink();
      const runner = createRunner({
        modelPort: createMockModelPort(taskScript()),
        stepContext: taskCtx,
        toolExecutor: taskExecutor,
        availableCapabilities: new Set(),
        sessionId: "sess-1",
        hooks: [hook],
        eventSink: sink,
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, events };
    };

    const throwing: Hook = {
      name: "broken-observer",
      lifecycle: "subagentStop",
      handler: () => {
        throw new Error("observer exploded");
      },
    };
    const { hook: continueHook } = recordingHook("ok-observer", "subagentStop", {
      action: "continue",
    });

    const thrown = await runOnce(throwing);
    const continued = await runOnce(continueHook);

    // The failure is surfaced as a hook_error event (spec §6)...
    const err = thrown.events.find((e) => e.type === "hook_error");
    expect(err, "hook_error event must be emitted").toBeDefined();
    expect(err!.data).toEqual({ lifecycle: "subagentStop", error: "observer exploded" });

    // ...and it changed NOTHING else: final state deep-equals the continue
    // scenario (negative witness) and the turn completed normally.
    expect(thrown.final).toEqual(continued.final);
    expect(thrown.final.status).toBe("done");
    // The continue path emits no hook_error.
    expect(continued.events.find((e) => e.type === "hook_error")).toBeUndefined();
  });

  it("subagentStop: deny outcome (fail-closed failure signal) → hook_error event with the deny reason; state unchanged", async () => {
    const runOnce = async (hook: Hook) => {
      const { sink, events } = captureSink();
      const runner = createRunner({
        modelPort: createMockModelPort(taskScript()),
        stepContext: taskCtx,
        toolExecutor: taskExecutor,
        availableCapabilities: new Set(),
        sessionId: "sess-1",
        hooks: [hook],
        eventSink: sink,
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, events };
    };

    const denied: Hook = {
      name: "cfg:subagentStop:0",
      lifecycle: "subagentStop",
      // Command hooks resolve (never throw) — a deny here means the hook
      // failed its observational job (timeout / non-zero exit).
      handler: () => ({ action: "deny", reason: "hook \"audit\" failed: timed out after 10000ms" }),
    };
    const { hook: continueHook } = recordingHook("ok-observer", "subagentStop", {
      action: "continue",
    });

    const deniedRun = await runOnce(denied);
    const continued = await runOnce(continueHook);

    // Deny at an observe-only point = failure signal → hook_error with the
    // reason verbatim (never a deny).
    const err = deniedRun.events.find((e) => e.type === "hook_error");
    expect(err, "hook_error event must be emitted for a deny outcome").toBeDefined();
    expect(err!.data).toEqual({
      lifecycle: "subagentStop",
      error: 'hook "audit" failed: timed out after 10000ms',
    });

    // State unchanged — the deny did not deny anything.
    expect(deniedRun.final).toEqual(continued.final);
    expect(deniedRun.final.status).toBe("done");
  });

  it("notification: THROWN handler and deny outcome both surface hook_error with the notification lifecycle; state unchanged", async () => {
    const runOnce = async (handler: Hook["handler"]) => {
      const { sink, events } = captureSink();
      const pricing = { "test-model": { inputPer1M: 10, outputPer1M: 30 } };
      const runner = createRunner({
        modelPort: createMockModelPort([
          [usage(100, 100), textDelta("Done"), modelDone("end_turn")],
        ]),
        stepContext: ctx,
        availableCapabilities: new Set(),
        pricing,
        initialState: createInitialState({ maxCostDollars: 0.001 }),
        sessionId: "sess-1",
        hooks: [{ name: "notify", lifecycle: "notification", handler }],
        eventSink: sink,
      });
      const final = await runner.run({ type: "user_message", content: "go" });
      return { final, events };
    };

    const thrown = await runOnce(() => {
      throw new Error("notify observer died");
    });
    const deniedRun = await runOnce(() => ({ action: "deny", reason: "notify failed: exit 1" }));
    const continued = await runOnce(() => ({ action: "continue" }));

    const thrownErr = thrown.events.find((e) => e.type === "hook_error");
    expect(thrownErr, "hook_error for the thrown handler").toBeDefined();
    expect(thrownErr!.data).toEqual({ lifecycle: "notification", error: "notify observer died" });

    const deniedErr = deniedRun.events.find((e) => e.type === "hook_error");
    expect(deniedErr, "hook_error for the deny outcome").toBeDefined();
    expect(deniedErr!.data).toEqual({ lifecycle: "notification", error: "notify failed: exit 1" });

    // Neither failure shape changed state — both deep-equal the continue
    // scenario, and the budget_exceeded turn closed identically.
    expect(thrown.final).toEqual(continued.final);
    expect(deniedRun.final).toEqual(continued.final);
    expect(continued.events.find((e) => e.type === "hook_error")).toBeUndefined();
  });
});
