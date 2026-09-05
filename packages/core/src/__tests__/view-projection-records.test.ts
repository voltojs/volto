import { describe, it, expect } from "vitest";
import { buildTurnRecords, toTrajectoryView } from "../view-projection.js";
import type { TranscriptEvent } from "../index.js";

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

const SIMPLE_TURN = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "hi" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 200,
    type: "assistant_message",
    data: {
      content: [{ type: "text", text: "hello" }],
      reasoning: "thinking",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      ttftMs: 30,
      durationMs: 80,
    },
    turn: 1,
    step: 1,
  },
  { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
]);

describe("buildTurnRecords", () => {
  it("brackets a turn and nests its step", () => {
    const [turn] = buildTurnRecords(SIMPLE_TURN);

    expect(turn!.turn).toBe(1);
    expect(turn!.startedAt).toBe(100);
    expect(turn!.endedAt).toBe(210);
    expect(turn!.reason).toBe("done");
    expect(turn!.userInput).toEqual([{ origin: "direct", content: "hi", time: 110 }]);
    expect(turn!.steps).toHaveLength(1);
    expect(turn!.steps[0]!.startedAt).toBe(120);
    expect(turn!.steps[0]!.endedAt).toBe(200);
    expect(turn!.steps[0]!.headerHash).toBe("h1");
  });

  it("carries reasoning, usage and timing onto the assistant record", () => {
    const [turn] = buildTurnRecords(SIMPLE_TURN);
    const assistant = turn!.steps[0]!.assistant!;

    expect(assistant.reasoning).toBe("thinking");
    expect(assistant.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(assistant.ttftMs).toBe(30);
    expect(assistant.durationMs).toBe(80);
  });

  it("pairs a tool result back onto its call by callId", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } }],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: { path: "a" } }, turn: 1, step: 1 },
      {
        time: 180,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "file body", isError: false, durationMs: 40, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const call = buildTurnRecords(events)[0]!.steps[0]!.toolCalls[0]!;
    expect(call).toMatchObject({
      callId: "c1",
      name: "read_file",
      input: { path: "a" },
      orderInBatch: 0,
      startedAt: 140,
      content: "file body",
      isError: false,
      durationMs: 40,
    });
  });

  it("sorts parallel tool calls by orderInBatch regardless of arrival", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 120,
        type: "assistant_message",
        data: { content: [], stopReason: "tool_use", durationMs: 5 },
        turn: 1,
        step: 1,
      },
      { time: 130, type: "tool_call", data: { callId: "c2", name: "b", input: {} }, turn: 1, step: 1 },
      { time: 131, type: "tool_call", data: { callId: "c1", name: "a", input: {} }, turn: 1, step: 1 },
      {
        time: 140,
        type: "tool_result",
        data: { callId: "c2", name: "b", content: "second", isError: false, orderInBatch: 1 },
        turn: 1,
        step: 1,
      },
      {
        time: 150,
        type: "tool_result",
        data: { callId: "c1", name: "a", content: "first", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const calls = buildTurnRecords(events)[0]!.steps[0]!.toolCalls;
    expect(calls.map((c) => c.callId)).toEqual(["c1", "c2"]);
  });

  it("leaves an unfinished tool call without result fields", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "assistant_message", data: { content: [], stopReason: "tool_use", durationMs: 5 }, turn: 1, step: 1 },
      { time: 130, type: "tool_call", data: { callId: "c1", name: "slow", input: {} }, turn: 1, step: 1 },
    ]);

    const call = buildTurnRecords(events)[0]!.steps[0]!.toolCalls[0]!;
    expect(call.content).toBeUndefined();
    expect(call.isError).toBeUndefined();
  });

  it("attaches approval to the call it gated, pending until a decision arrives", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "assistant_message", data: { content: [], stopReason: "tool_use", durationMs: 5 }, turn: 1, step: 1 },
      { time: 130, type: "tool_call", data: { callId: "c1", name: "bash", input: {} }, turn: 1, step: 1 },
      { time: 135, type: "approval_asked", data: { callId: "c1", name: "bash", riskTier: "WRITE_HIGH" }, turn: 1, step: 1 },
    ]);

    // approval_asked alone: the gate is open but no decision has been made —
    // a pending approval must not read back as "allowed".
    expect(buildTurnRecords(events)[0]!.steps[0]!.toolCalls[0]!.approval).toEqual({
      riskTier: "WRITE_HIGH",
      decision: undefined,
    });

    const decided = log([
      ...events,
      { time: 140, type: "approval_decision", data: { callId: "c1", decision: "allow" }, turn: 1, step: 1 },
    ]);
    expect(buildTurnRecords(decided)[0]!.steps[0]!.toolCalls[0]!.approval).toEqual({
      riskTier: "WRITE_HIGH",
      decision: "allow",
    });
  });

  it("records retries and the model error on the step", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "model_retry", data: { attempt: 1, delayMs: 500, error: "429" }, turn: 1, step: 1 },
      { time: 130, type: "model_error", data: { error: "gave up", retriable: false }, turn: 1, step: 1 },
    ]);

    const step = buildTurnRecords(events)[0]!.steps[0]!;
    expect(step.retries).toEqual([{ attempt: 1, delayMs: 500, error: "429", time: 120 }]);
    expect(step.error).toEqual({ message: "gave up", errorKind: undefined, retriable: false });
  });

  it("links a sub-agent call to its child session", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "assistant_message", data: { content: [], stopReason: "tool_use", durationMs: 5 }, turn: 1, step: 1 },
      { time: 130, type: "tool_call", data: { callId: "c1", name: "task", input: {} }, turn: 1, step: 1 },
      { time: 135, type: "subagent_started", data: { childSessionId: "s1-sub-9", label: "task", depth: 1 }, turn: 1, step: 1 },
      {
        time: 200,
        type: "tool_result",
        data: { callId: "c1", name: "task", content: "sub done", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(buildTurnRecords(events)[0]!.steps[0]!.toolCalls[0]!.childSessionId).toBe("s1-sub-9");
  });

  // A live session (b4n4zfntc, seq 38-49) produced this exact order: the SDK
  // appends `subagent_started` straight to the store the moment the task tool
  // begins, while the parent runner flushes its buffered turn preamble and
  // `tool_call` at batch end — so the subagent_started precedes the very
  // turn_start it belongs to, carrying a later wall-clock time than the
  // buffered events that follow it. The linkage must survive the inversion.
  const OUT_OF_ORDER_SUBAGENT = log([
    // Direct SDK append — on disk before anything of the turn it belongs to.
    { time: 4001, type: "subagent_started", data: { childSessionId: "child-1", label: "task", depth: 1 }, turn: 4 },
    // ── The parent runner's batch-end flush ──
    { time: 1000, type: "turn_start", data: { turn: 4 }, turn: 4 },
    { time: 1000, type: "user_message", data: { content: "请使用 task 工具派一个子代理去调研：README.md 里写了什么？" }, turn: 4 },
    {
      time: 1001,
      type: "request_header",
      data: {
        hash: "h4",
        systemLayers: [],
        tools: [{ name: "task", description: "delegate a sub-agent", schema: { type: "object" } }],
        params: {},
      },
      turn: 4,
      step: 1,
    },
    { time: 1001, type: "model_call_start", data: { headerHash: "h4" }, turn: 4, step: 1 },
    {
      time: 4000,
      type: "assistant_message",
      data: {
        content: [{ type: "tool_use", id: "call_1", name: "task", input: { message: "README.md 里写了什么？" } }],
        stopReason: "tool_use",
        ttftMs: 1112,
        durationMs: 3488,
      },
      turn: 4,
      step: 1,
    },
    {
      time: 4000,
      type: "tool_call",
      data: { callId: "call_1", name: "task", input: { message: "README.md 里写了什么？" } },
      turn: 4,
      step: 1,
    },
    {
      time: 45000,
      type: "tool_result",
      data: {
        callId: "call_1",
        name: "task",
        content: "## README.md 总结\n\n项目是一个笔记应用……",
        isError: false,
        durationMs: 40733,
        orderInBatch: 0,
      },
      turn: 4,
      step: 1,
    },
    { time: 45000, type: "subagent_finished", data: { childSessionId: "child-1", isError: false, durationMs: 40733 }, turn: 4 },
    { time: 45000, type: "model_call_start", data: { headerHash: "h4" }, turn: 4, step: 2 },
    {
      time: 53000,
      type: "assistant_message",
      data: { content: [{ type: "text", text: "子代理的调研结论如下。" }], stopReason: "end_turn", durationMs: 7900 },
      turn: 4,
      step: 2,
    },
    { time: 53001, type: "turn_end", data: { turn: 4, reason: "done" }, turn: 4 },
  ]);

  it("links a subagent_started that lands before its buffered tool_call flush", () => {
    const records = buildTurnRecords(OUT_OF_ORDER_SUBAGENT);
    // The stray subagent_started opens a turn shell of its own before
    // turn_start re-opens turn 4; the real record is the one with steps.
    const turn = records.find((t) => t.turn === 4 && t.steps.length > 0)!;
    const call = turn.steps[0]!.toolCalls[0]!;

    expect(call.name).toBe("task");
    expect(call.childSessionId).toBe("child-1");

    const row = toTrajectoryView(records, OUT_OF_ORDER_SUBAGENT).rows.find((r) => r.kind === "subagent");
    expect(row).toBeDefined();
    expect(row!.childSessionId).toBe("child-1");
  });

  it("separates steering input from direct input", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "start" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 130, type: "steering_queued", data: { content: "wait" }, turn: 1, step: 1 },
    ]);

    expect(buildTurnRecords(events)[0]!.userInput).toEqual([
      { origin: "direct", content: "start", time: 110 },
      { origin: "queued", content: "wait", time: 130 },
    ]);
  });

  it("splits multiple turns", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
      { time: 200, type: "turn_start", data: { turn: 2 }, turn: 2 },
      { time: 210, type: "turn_end", data: { turn: 2, reason: "cancelled" }, turn: 2 },
    ]);

    const turns = buildTurnRecords(events);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns[1]!.reason).toBe("cancelled");
  });

  it("reuses the object identity of closed turns when given prev", () => {
    const first = buildTurnRecords(SIMPLE_TURN);
    const extended = log([
      ...SIMPLE_TURN.map(({ seq: _seq, ...rest }) => rest),
      { time: 300, type: "turn_start", data: { turn: 2 }, turn: 2 },
    ]);
    const second = buildTurnRecords(extended, first);

    expect(Object.is(second[0], first[0])).toBe(true);
    expect(second).toHaveLength(2);
  });

  it("produces the same value with or without prev", () => {
    const withPrev = buildTurnRecords(SIMPLE_TURN, buildTurnRecords(SIMPLE_TURN));
    expect(withPrev).toEqual(buildTurnRecords(SIMPLE_TURN));
  });

  it("ignores a prev that does not match the events", () => {
    const foreign = buildTurnRecords(
      log([
        { time: 1, type: "turn_start", data: { turn: 99 }, turn: 99 },
        { time: 2, type: "turn_end", data: { turn: 99, reason: "done" }, turn: 99 },
      ]),
    );
    expect(buildTurnRecords(SIMPLE_TURN, foreign)).toEqual(buildTurnRecords(SIMPLE_TURN));
  });

  // Pre-Task-3 logs: the runner closed a paused turn with a turn_end at the
  // pause and resume() appended the post-decision events after that bracket
  // with no new turn_start. The end time survives the extension, so identity
  // reuse must be gated by the structural watermark, not by endedAt alone.
  const PAUSED_TURN = log([
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
    { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    {
      time: 130,
      type: "assistant_message",
      data: {
        content: [{ type: "tool_use", id: "c1", name: "bash", input: { cmd: "deploy" } }],
        stopReason: "tool_use",
        durationMs: 10,
      },
      turn: 1,
      step: 1,
    },
    { time: 140, type: "tool_call", data: { callId: "c1", name: "bash", input: { cmd: "deploy" } }, turn: 1, step: 1 },
    { time: 150, type: "approval_asked", data: { callId: "c1", name: "bash", riskTier: "WRITE_HIGH" }, turn: 1, step: 1 },
    { time: 160, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);

  const RESUMED_TURN = log([
    ...PAUSED_TURN.map(({ seq: _seq, ...rest }) => rest),
    { time: 200, type: "approval_decision", data: { callId: "c1", decision: "allow" }, turn: 1, step: 1 },
    {
      time: 210,
      type: "tool_result",
      data: { callId: "c1", name: "bash", content: "deployed", isError: false, durationMs: 50, orderInBatch: 0 },
      turn: 1,
      step: 1,
    },
    { time: 220, type: "model_call_start", data: { headerHash: "h2" }, turn: 1, step: 2 },
    {
      time: 300,
      type: "assistant_message",
      data: { content: [{ type: "text", text: "done" }], stopReason: "end_turn", durationMs: 80 },
      turn: 1,
      step: 2,
    },
  ]);

  it("rebuilds a turn extended after its turn_end instead of reusing a stale prev", () => {
    const prev = buildTurnRecords(PAUSED_TURN);
    expect(prev).toHaveLength(1);
    expect(prev[0]!.steps).toHaveLength(1); // the stale shape the log was paused with

    const records = buildTurnRecords(RESUMED_TURN, prev);

    expect(Object.is(records[0], prev[0])).toBe(false);
    expect(records[0]!.steps).toHaveLength(2);
    expect(records[0]!.steps[1]!.assistant!.content).toEqual([{ type: "text", text: "done" }]);
    expect(records[0]!.steps[0]!.toolCalls[0]!.approval).toEqual({ riskTier: "WRITE_HIGH", decision: "allow" });
  });

  it("produces the same resumed turn with or without prev", () => {
    expect(buildTurnRecords(RESUMED_TURN, buildTurnRecords(PAUSED_TURN))).toEqual(
      buildTurnRecords(RESUMED_TURN),
    );
  });

  it("returns an empty array for an empty log", () => {
    expect(buildTurnRecords([])).toEqual([]);
  });
});
