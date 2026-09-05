import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import { createAutoAllowGate } from "../approval-gate.js";
// NOTE: createMockModelPort / textDelta / reasoningDelta are re-exported from
// @volto/core's main entry (see src/index.ts), not from the "@volto/core/testing"
// subpath — that subpath only exposes the SessionStore contract test suite
// (testing/store-contract.ts). Importing from "@volto/core/testing" here would
// fail to resolve these symbols.
import {
  createMockModelPort,
  textDelta,
  reasoningDelta,
  toolUseStart,
  toolUseDelta,
  modelDone,
  createDefaultPermissionConfig,
} from "@volto/core";
import type {
  TranscriptEventInput,
  ModelEvent,
  ToolDefinition,
  StepContext,
  SessionSnapshot,
  SessionStore,
  ApprovalGate,
  Hook,
} from "@volto/core";

function fakeChatStore() {
  const events: TranscriptEventInput[] = [];
  return {
    events,
    store: {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...batch);
      },
    },
  };
}

/** A clock that advances 100ms per read — makes timing assertions exact. */
function steppingClock(start = 1000, stepMs = 100) {
  let t = start - stepMs;
  return { now: () => (t += stepMs) };
}

function typesOf(events: TranscriptEventInput[]): string[] {
  return events.map((e) => e.type);
}

function firstOf<T = Record<string, unknown>>(events: TranscriptEventInput[], type: string): T | undefined {
  return events.find((e) => e.type === type)?.data as T | undefined;
}

describe("Runner transcript capture", () => {
  it("brackets the turn and the model call", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 3,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hello" });

    const types = typesOf(events);
    expect(types).toContain("turn_start");
    expect(types).toContain("user_message");
    expect(types).toContain("model_call_start");
    expect(types).toContain("assistant_message");
    expect(types).toContain("turn_end");
    expect(types.indexOf("model_call_start")).toBeLessThan(types.indexOf("assistant_message"));
    expect(events.every((e) => e.turn === 3)).toBe(true);
  });

  it("records the assembled assistant message with its stop reason", async () => {
    const model = createMockModelPort([[textDelta("hello"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const data = firstOf<{ content: unknown; stopReason: string }>(events, "assistant_message");
    expect(data!.content).toEqual([{ type: "text", text: "hello" }]);
    expect(data!.stopReason).toBe("end_turn");
  });

  it("aggregates reasoning deltas into one reasoning field", async () => {
    const model = createMockModelPort([
      [reasoningDelta("let me "), reasoningDelta("think"), textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ reasoning: string }>(events, "assistant_message")!.reasoning).toBe("let me think");
  });

  it("omits reasoning when the model produced none", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ reasoning?: string }>(events, "assistant_message")!.reasoning).toBeUndefined();
  });

  it("computes ttftMs from the first delta and durationMs from the call bracket", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(1000, 100),
    });
    await runner.run({ type: "user_message", content: "hi" });

    // The stepping clock advances exactly 100ms per read and every read this
    // scenario makes is deterministic: turn_start, user_message,
    // callStartedAt (shared by request_header and model_call_start — they no
    // longer take independent readings, see runner.ts), the telemetry
    // model-span anchor (unused here, no telemetry configured, but it still
    // consumes a read), the text delta, and the model_done that closes the
    // call. So these aren't just "positive", they're the exact values. A
    // stale firstDeltaAt/callStartedAt carried over from elsewhere would
    // still happen to be positive but would not land on these numbers.
    const data = firstOf<{ ttftMs?: number; durationMs: number }>(events, "assistant_message");
    expect(data!.ttftMs).toBe(200);
    expect(data!.durationMs).toBe(300);
  });

  it("measures the second model call's ttftMs from its own model_call_start, not a stale reading from the first", async () => {
    // First call streams a reasoning delta before calling a tool (so it has
    // its own firstDeltaAt); second call streams a text delta (so it has its
    // own too). If callStartedAt/firstDeltaAt were not reset between calls
    // (see the "hoist to createRunner() scope, reset per runModelStream()
    // call" contract), the second call's ttftMs would be computed against a
    // stale reading from the first call — which, since the second call's
    // own callStartedAt is chronologically later, comes out negative.
    const model = createMockModelPort([
      [
        reasoningDelta("thinking"),
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "ok" }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(1000, 100),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const assistantMessages = events.filter((e) => e.type === "assistant_message");
    expect(assistantMessages).toHaveLength(2);
    const [first, second] = assistantMessages as Array<
      TranscriptEventInput & { data: { ttftMs?: number } }
    >;
    expect(first!.step).toBe(1);
    expect(second!.step).toBe(2);
    // Both calls happen to land on the same ttftMs (200) with this exact
    // clock schedule — that's a coincidence of the tick count before each
    // call's own delta, not evidence of a shared/leaked reading: each is
    // computed against a different callStartedAt (1200 for call 1, 2200 for
    // call 2). The real regression guard is what a *leaked* reading would
    // produce: if call 2 reused call 1's firstDeltaAt (the `??=` guard
    // skipping its reset), ttftMs would be computed against a reading from
    // BEFORE call 2's own callStartedAt and come out negative — so "exact
    // and positive" together rule that out, "positive" alone would not.
    expect(first!.data.ttftMs).toBe(200);
    expect(second!.data.ttftMs).toBe(200);
    expect(second!.data.ttftMs).toBeGreaterThan(0);
  });

  it("omits ttftMs when the stream produced no delta", async () => {
    const model = createMockModelPort([[{ type: "done", stopReason: "end_turn" } as ModelEvent]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ ttftMs?: number }>(events, "assistant_message")!.ttftMs).toBeUndefined();
  });

  it("carries cache and reasoning token counters through to usage", async () => {
    const model = createMockModelPort([
      [
        textDelta("hi"),
        { type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3 },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ usage: Record<string, number> }>(events, "assistant_message")!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
  });

  it("writes request_header once per turn and reuses its hash", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "ok" }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    // Two model calls in this turn, one header.
    expect(typesOf(events).filter((t) => t === "model_call_start")).toHaveLength(2);
    expect(typesOf(events).filter((t) => t === "request_header")).toHaveLength(1);

    const header = firstOf<{ hash: string; tools: Array<{ name: string }> }>(events, "request_header")!;
    expect(header.tools.map((t) => t.name)).toEqual(["noop"]);
    const starts = events.filter((e) => e.type === "model_call_start");
    expect(starts.every((e) => (e.data as { headerHash: string }).headerHash === header.hash)).toBe(true);
  });

  it("seeds its step counter from initialStep so a resumed turn's model calls continue the numbering", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    // A host rebuilding a Runner mid-turn for a cross-process resume passes
    // the highest step already persisted for the paused turn — here 2 — so
    // this Runner's first model call must be step 3, not 1 (which would
    // collide with the paused turn's existing steps 1..N).
    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "ok" }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 7,
      initialStep: 2,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const starts = events.filter((e) => e.type === "model_call_start");
    expect(starts).toHaveLength(2);
    expect(starts.map((e) => e.step)).toEqual([3, 4]);
    // Everything step-stamped in the turn stays above the seed, and the turn
    // itself is untouched by the step seed.
    expect(events.every((e) => e.step === undefined || e.step >= 3)).toBe(true);
    expect(events.every((e) => e.turn === 7)).toBe(true);
  });

  it("records tool calls and results with their real content", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: '{"a":1}' },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "tool output", displayMetadata: { lineCount: 1 } }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ callId: string; input: unknown }>(events, "tool_call")).toMatchObject({
      callId: "c1",
      name: "noop",
      input: { a: 1 },
    });
    expect(firstOf<Record<string, unknown>>(events, "tool_result")).toMatchObject({
      callId: "c1",
      content: "tool output",
      isError: false,
      orderInBatch: 0,
    });
  });

  it("records a steering message queued mid-turn", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => {
        runner.send({ type: "user_message", content: "wait" });
        return { modelContent: "ok" };
      },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(typesOf(events)).toContain("steering_queued");
  });

  it("records model_error and ends the turn with reason 'error' when the provider yields an error event", async () => {
    // Real providers (packages/providers/anthropic|openai's model-port.ts)
    // yield {type:"error"} for non-2xx responses, aborts, and empty bodies —
    // they do not throw. That path goes through the stream loop, never
    // through runModelStream's catch block, so model_error must be recorded
    // there too or it is silently lost (and turnHadError, only ever set in
    // the catch block before this fix, never gets set either — leaving
    // turn_end lying about how the turn ended). Non-retriable here keeps the
    // test deterministic: a retriable error loops the reducer's own
    // iteration-limited retry (separate from the Runner's retryPolicy, which
    // only applies to thrown exceptions), which is exercised by the
    // provider/runner error-taxonomy tests, not this one.
    const model = createMockModelPort([[{ type: "error", error: "HTTP 500", retriable: false }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const modelError = firstOf<{ error: string; retriable: boolean }>(events, "model_error");
    expect(modelError).toBeDefined();
    expect(modelError!.error).toBe("HTTP 500");
    expect(modelError!.retriable).toBe(false);

    const turnEnd = firstOf<{ reason: string }>(events, "turn_end");
    expect(turnEnd!.reason).toBe("error");
  });

  it("records nothing when no chatStore is configured", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      clock: steppingClock(),
    });
    await expect(runner.run({ type: "user_message", content: "hi" })).resolves.toBeDefined();
  });
});

describe("Runner transcript capture — approval_asked dedup across resume", () => {
  const dangerousTool: ToolDefinition = {
    name: "dangerous_op",
    description: "a WRITE_HIGH tool gated by HITL approval",
    inputSchema: { type: "object", properties: {}, required: [] },
    requires: [],
    riskTier: "WRITE_HIGH",
  };
  const ctx: StepContext = { tools: [dangerousTool], model: "test-model" };

  function oneToolThenDone() {
    return createMockModelPort([
      [toolUseStart("c1", "dangerous_op"), toolUseDelta("c1", "{}"), modelDone("tool_use")],
      [textDelta("done"), modelDone("end_turn")],
    ]);
  }

  function makeSessionStore(): SessionStore & { snapshots: Map<string, SessionSnapshot> } {
    const snapshots = new Map<string, SessionSnapshot>();
    return {
      snapshots,
      async save(s) {
        snapshots.set(s.id, s);
      },
      async load(id) {
        return snapshots.get(id);
      },
      async list() {
        return [...snapshots.values()];
      },
    };
  }

  it("same-process resume (lastRunner.resume() succeeding) writes approval_asked exactly once", async () => {
    // A gate that pauses the in-process run by throwing on its first ask —
    // the checkpoint is already saved by then (checkpoint effects are
    // interpreted before request_approval), so the same Runner instance can
    // still be resumed afterward. This is the ordinary in-process HITL
    // /resume flow: one Runner instance sees both the original ask and the
    // later resume().
    const { store, events } = fakeChatStore();
    const sessionStore = makeSessionStore();
    let asks = 0;
    const pausingGate: ApprovalGate = {
      ask: async () => {
        asks++;
        throw new Error("pause: defer to resume");
      },
    };

    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: pausingGate,
      sessionStore,
      sessionId: "sess-1",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });

    await expect(runner.run({ type: "user_message", content: "go" })).rejects.toThrow("pause");
    expect(asks).toBe(1);

    // Before the fix, resume() unconditionally re-recorded approval_asked
    // here even though this is the SAME Runner instance that already wrote
    // one during interpretEffects — producing two records (2/1 vs
    // approval_decision) for a single ask.
    const final = await runner.resume("sess-1", "allow");
    expect(final.status).toBe("done");

    const asked = events.filter((e) => e.type === "approval_asked");
    const decided = events.filter((e) => e.type === "approval_decision");
    expect(asked).toHaveLength(1);
    expect(decided).toHaveLength(1);
  });

  it("cross-process fallback (a fresh Runner) still writes approval_asked — durability is preserved", async () => {
    // Mirrors the same-process test above, but resume() is driven on a BRAND
    // NEW Runner instance (as the SDK's cross-process fallback does after
    // loading the checkpoint from sessionStore in a fresh process). Its
    // askedToolCallIds set starts empty, so it must still write the record —
    // it may be the only copy that ever reaches the store if the original
    // process never flushed.
    const { store, events } = fakeChatStore();
    const sessionStore = makeSessionStore();
    const pausingGate: ApprovalGate = {
      ask: async () => {
        throw new Error("pause: defer to resume");
      },
    };

    const original = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: pausingGate,
      sessionStore,
      sessionId: "sess-2",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await expect(original.run({ type: "user_message", content: "go" })).rejects.toThrow("pause");

    // Fresh Runner instance — simulates a new process that only has the
    // sessionStore checkpoint to work from, not the original Runner's
    // in-memory askedToolCallIds.
    const resumed = createRunner({
      modelPort: createMockModelPort([[textDelta("done"), modelDone("end_turn")]]),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
      sessionStore,
      sessionId: "sess-2",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    const final = await resumed.resume("sess-2", "allow");
    expect(final.status).toBe("done");

    // One from the original Runner (interpretEffects, before it paused) and
    // one from the fresh resume Runner (its own set was empty) — both must
    // survive, since either process could be the only one that ever flushes.
    const asked = events.filter((e) => e.type === "approval_asked");
    expect(asked).toHaveLength(2);
  });
});

describe("Runner transcript capture — pause/resume turn_end bracketing", () => {
  const dangerousTool: ToolDefinition = {
    name: "dangerous_op",
    description: "a WRITE_HIGH tool gated by HITL approval",
    inputSchema: { type: "object", properties: {}, required: [] },
    requires: [],
    riskTier: "WRITE_HIGH",
  };
  const ctx: StepContext = { tools: [dangerousTool], model: "test-model" };

  function oneToolThenDone() {
    return createMockModelPort([
      [toolUseStart("c1", "dangerous_op"), toolUseDelta("c1", "{}"), modelDone("tool_use")],
      [textDelta("done"), modelDone("end_turn")],
    ]);
  }

  function makeSessionStore(): SessionStore & { snapshots: Map<string, SessionSnapshot> } {
    const snapshots = new Map<string, SessionSnapshot>();
    return {
      snapshots,
      async save(s) {
        snapshots.set(s.id, s);
      },
      async load(id) {
        return snapshots.get(id);
      },
      async list() {
        return [...snapshots.values()];
      },
    };
  }

  /** Gate that parks the run out-of-process: the ask never yields a decision. */
  function pausingGate(): ApprovalGate {
    return {
      ask: async () => {
        throw new Error("pause: defer to resume");
      },
    };
  }

  it("a paused turn records no turn_end — the flushed log ends at approval_asked, hooks still fire", async () => {
    // The gate throws to park the run out-of-process (the checkpoint is
    // already saved by then — checkpoint effects are interpreted before
    // request_approval). A pause is NOT a turn end: the transcript must stay
    // unclosed — no turn_end between the pause and the eventual resume —
    // exactly as it would had the process died mid-turn. The runner-level
    // teardown (session:end hook, cleanup) must still run, though: the turn
    // is parked, not the runner.
    const { store, events } = fakeChatStore();
    const lifecycles: string[] = [];
    const recordingHook: Hook = {
      name: "lifecycle-recorder",
      lifecycle: "session:end",
      handler: async (ctx) => {
        lifecycles.push(ctx.lifecycle);
        return { action: "continue" };
      },
    };

    const runner = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: pausingGate(),
      hooks: [recordingHook],
      sessionStore: makeSessionStore(),
      sessionId: "sess-1",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });

    await expect(runner.run({ type: "user_message", content: "go" })).rejects.toThrow("pause");

    expect(typesOf(events)).not.toContain("turn_end");
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.type).toBe("approval_asked");
    // The pause exit is still a runner exit: session:end fired.
    expect(lifecycles).toEqual(["session:end"]);
  });

  it("resume() appends exactly one turn_end — reason 'done', as the last event", async () => {
    // Cross-process resume shape (the dedup suite's fresh-Runner pattern):
    // the original run() parks at the gate and leaves the turn open; the
    // resuming Runner completes it and writes the one closing bracket. With
    // a clean allow decision the tool executes, the model closes the turn,
    // and the resumed segment's outcome — "done" — is the turn_end reason.
    const { store, events } = fakeChatStore();
    const sessionStore = makeSessionStore();

    const original = createRunner({
      modelPort: oneToolThenDone(),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: pausingGate(),
      sessionStore,
      sessionId: "sess-2",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await expect(original.run({ type: "user_message", content: "go" })).rejects.toThrow("pause");
    expect(typesOf(events)).not.toContain("turn_end");

    const resumed = createRunner({
      modelPort: createMockModelPort([[textDelta("done"), modelDone("end_turn")]]),
      stepContext: ctx,
      toolExecutor: async () => ({ modelContent: "ok" }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
      sessionStore,
      sessionId: "sess-2",
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    const final = await resumed.resume("sess-2", "allow");
    expect(final.status).toBe("done");

    // Exactly one bracket, correctly attributed and correctly reasoned.
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const turnEnd = turnEnds[0]!;
    expect((turnEnd.data as { reason: string }).reason).toBe("done");
    expect(turnEnd.turn).toBe(1);
    expect((turnEnd.data as { turn: number }).turn).toBe(1);

    // The bracket closes the turn: it is the log's last event, and the whole
    // resumed segment (decision, tool execution, closing message) landed
    // before it.
    const lastTypes = typesOf(events);
    expect(lastTypes[lastTypes.length - 1]).toBe("turn_end");
    expect(lastTypes).toContain("approval_decision");
    expect(lastTypes).toContain("tool_result");
    expect(lastTypes.indexOf("assistant_message")).toBeLessThan(lastTypes.length - 1);
  });
});
