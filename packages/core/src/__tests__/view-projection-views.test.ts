import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import { projectMessages } from "../transcript-projection.js";
import type { TranscriptEvent, ContentBlock } from "../index.js";
import legacy from "./__snapshots__/legacy-ui-messages.json";

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

/** The same conversation the legacy snapshot was generated from. */
const EQUIVALENT_LOG = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "read a.txt then say hi" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 130,
    type: "assistant_message",
    data: {
      content: [
        { type: "text", text: "Sure, reading it." },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } },
      ],
      stopReason: "tool_use",
      durationMs: 10,
    },
    turn: 1,
    step: 1,
  },
  { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: { path: "a.txt" } }, turn: 1, step: 1 },
  {
    time: 180,
    type: "tool_result",
    data: { callId: "c1", name: "read_file", content: "file body", isError: false, durationMs: 40, orderInBatch: 0 },
    turn: 1,
    step: 1,
  },
  { time: 190, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
  {
    time: 200,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "hi" }], stopReason: "end_turn", durationMs: 10 },
    turn: 1,
    step: 2,
  },
  { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
]);

/**
 * A two-step turn where the user steered while step 1's batch was in flight.
 * The reducer drains the queue after the batch's results and before the next
 * model call, so the model saw the steering between step 1 and step 2.
 */
const STEERED_LOG = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 130,
    type: "assistant_message",
    data: {
      content: [
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } },
      ],
      stopReason: "tool_use",
      durationMs: 10,
    },
    turn: 1,
    step: 1,
  },
  { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: { path: "a.txt" } }, turn: 1, step: 1 },
  // Steering arrives BEFORE the result — smaller seq, later position.
  { time: 150, type: "steering_queued", data: { content: "actually wait" }, turn: 1, step: 1 },
  {
    time: 160,
    type: "tool_result",
    data: { callId: "c1", name: "read_file", content: "body", isError: false, orderInBatch: 0 },
    turn: 1,
    step: 1,
  },
  { time: 190, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
  {
    time: 200,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "ok, stopped" }], stopReason: "end_turn", durationMs: 10 },
    turn: 1,
    step: 2,
  },
  { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
]);

/** Joins a projected message's text blocks — the view's `content` equivalent. */
function messageText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("toConversationView — parity with the legacy projection", () => {
  it("produces the same roles, block kinds and text as toUiMessages did", () => {
    const view = toConversationView(buildTurnRecords(EQUIVALENT_LOG));

    expect(view.messages.map((m) => m.role)).toEqual(legacy.map((m: { role: string }) => m.role));
    expect(view.messages.map((m) => m.content)).toEqual(legacy.map((m: { content: string }) => m.content));
    expect(view.messages.map((m) => m.blocks.map((b) => b.type))).toEqual(
      legacy.map((m: { blocks: Array<{ type: string }> }) => m.blocks.map((b) => b.type)),
    );
  });

  it("carries the tool's real output where the legacy live path carried metadata", () => {
    const view = toConversationView(buildTurnRecords(EQUIVALENT_LOG));
    const block = view.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_call");

    expect(block).toBeDefined();
    expect(block!.type === "tool_call" && block!.call.result).toBe("file body");
    expect(block!.type === "tool_call" && block!.call.durationMs).toBe(40);
  });
});

describe("toConversationView", () => {
  it("drops system scaffolding and keeps user/assistant only", () => {
    const view = toConversationView(buildTurnRecords(EQUIVALENT_LOG));
    expect(view.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });

  it("places a steering message between the step that was running and the next one", () => {
    const view = toConversationView(buildTurnRecords(STEERED_LOG));

    // user(go) → assistant(1:1, batch's tool result folded in) → user(steering) → assistant(1:2)
    expect(view.messages.map((m) => m.id)).toEqual(["1:u0", "1:1", "1:q0", "1:2"]);
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(view.messages[2]!.content).toBe("actually wait");
    // The steering still renders after the batch's tool results — folded into step 1's block.
    const step1 = view.messages[1]!;
    expect(step1.blocks.some((b) => b.type === "tool_call" && b.call.result === "body")).toBe(true);
  });

  it("agrees with projectMessages on the order of user and assistant text", () => {
    // Tool results are folded into view blocks, so only user/assistant text compares.
    const fromView = toConversationView(buildTurnRecords(STEERED_LOG)).messages.map(
      (m) => [m.role, m.content] as const,
    );
    const fromProjection = projectMessages(STEERED_LOG)
      .filter((m) => m.role !== "tool")
      .map((m) => [m.role, messageText(m.content)] as const);

    expect(fromView).toEqual(fromProjection);
  });

  it("keeps a steering message at the end of the turn when the turn errors before the next step", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
      { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 140, type: "tool_call", data: { callId: "c1", name: "read_file", input: {} }, turn: 1, step: 1 },
      { time: 150, type: "steering_queued", data: { content: "one more thing" }, turn: 1, step: 1 },
      {
        time: 160,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "body", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
      // The turn dies before step 2 ever starts — no step with startedAt > 150.
      { time: 170, type: "turn_end", data: { turn: 1, reason: "error", error: "boom" }, turn: 1 },
    ]);

    const view = toConversationView(buildTurnRecords(events));
    expect(view.messages.map((m) => m.id)).toEqual(["1:u0", "1:1", "1:q0"]);
    expect(view.messages.at(-1)!.role).toBe("user");
    expect(view.messages.at(-1)!.content).toBe("one more thing");
  });

  it("emits a reasoning block when the model produced thinking", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 120,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "answer" }],
          reasoning: "step by step",
          stopReason: "end_turn",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
    ]);

    const blocks = toConversationView(buildTurnRecords(events)).messages[0]!.blocks;
    expect(blocks[0]).toEqual({ type: "reasoning", text: "step by step" });
    expect(blocks[1]).toEqual({ type: "text", text: "answer" });
  });

  it("marks a message streaming while its step has a partial", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    ]);
    const records = buildTurnRecords(events);
    records[0]!.steps[0]!.partial = { text: "typing", reasoning: "", pendingCalls: [] };

    const message = toConversationView(records).messages[0]!;
    expect(message.isStreaming).toBe(true);
    expect(message.content).toBe("typing");
  });

  it("keeps ids stable as later events arrive", () => {
    const partialLog = EQUIVALENT_LOG.slice(0, 6);
    const before = toConversationView(buildTurnRecords(partialLog)).messages.map((m) => m.id);
    const after = toConversationView(buildTurnRecords(EQUIVALENT_LOG)).messages.map((m) => m.id);

    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("never derives an id from an array index", () => {
    const ids = toConversationView(buildTurnRecords(EQUIVALENT_LOG)).messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["1:u0", "1:1", "1:2"]);
  });
});

import { applyPartial, toTrajectoryView } from "../view-projection.js";

describe("applyPartial", () => {
  const OPEN_STEP = log([
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  ]);

  it("accumulates text deltas onto the open step", () => {
    let records = buildTurnRecords(OPEN_STEP);
    records = applyPartial(records, { kind: "text", text: "he" });
    records = applyPartial(records, { kind: "text", text: "llo" });

    expect(records[0]!.steps[0]!.partial!.text).toBe("hello");
  });

  it("accumulates reasoning separately from text", () => {
    let records = buildTurnRecords(OPEN_STEP);
    records = applyPartial(records, { kind: "reasoning", text: "hmm" });
    records = applyPartial(records, { kind: "text", text: "answer" });

    expect(records[0]!.steps[0]!.partial).toMatchObject({ text: "answer", reasoning: "hmm" });
  });

  it("collects streaming tool-call arguments", () => {
    let records = buildTurnRecords(OPEN_STEP);
    records = applyPartial(records, { kind: "tool_use", callId: "c1", name: "read_file", argumentsDelta: '{"p' });
    records = applyPartial(records, { kind: "tool_use", callId: "c1", argumentsDelta: '":1}' });

    expect(records[0]!.steps[0]!.partial!.pendingCalls).toEqual([
      { callId: "c1", name: "read_file", argumentsDelta: '{"p":1}' },
    ]);
  });

  it("is a no-op when there is no open step", () => {
    const closed = buildTurnRecords(EQUIVALENT_LOG);
    expect(applyPartial(closed, { kind: "text", text: "late" })).toEqual(closed);
  });

  it("is cleared once the authoritative assistant_message arrives", () => {
    let records = buildTurnRecords(OPEN_STEP);
    records = applyPartial(records, { kind: "text", text: "partial" });
    expect(records[0]!.steps[0]!.partial).toBeDefined();

    const completed = buildTurnRecords(
      log([
        ...OPEN_STEP.map(({ seq: _seq, ...rest }) => rest),
        {
          time: 200,
          type: "assistant_message",
          data: { content: [{ type: "text", text: "final" }], stopReason: "end_turn", durationMs: 90 },
          turn: 1,
          step: 1,
        },
      ]),
    );
    expect(completed[0]!.steps[0]!.partial).toBeUndefined();
    expect(completed[0]!.steps[0]!.assistant!.content).toEqual([{ type: "text", text: "final" }]);
  });
});

describe("toTrajectoryView", () => {
  it("numbers rows from 1 and covers every kind that occurred", () => {
    const view = toTrajectoryView(buildTurnRecords(EQUIVALENT_LOG), EQUIVALENT_LOG);

    expect(view.rows[0]!.index).toBe(1);
    expect(view.rows.map((r) => r.index)).toEqual(view.rows.map((_, i) => i + 1));
    expect(new Set(view.rows.map((r) => r.kind))).toEqual(new Set(["user", "assistant", "tool"]));
  });

  it("puts thinking, timing and usage on the assistant row", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 200,
        type: "assistant_message",
        data: {
          content: [{ type: "text", text: "answer" }],
          reasoning: "deep thought",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 },
          ttftMs: 30,
          durationMs: 90,
        },
        turn: 1,
        step: 1,
      },
    ]);

    const row = toTrajectoryView(buildTurnRecords(events), events).rows.find((r) => r.kind === "assistant")!;
    expect(row.thinkingDetail).toBe("deep thought");
    expect(row.outputDetail).toBe("answer");
    expect(row.metrics).toEqual({
      ttftMs: 30,
      durationMs: 90,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 },
    });
  });

  it("summarises a tool-call-only assistant step by its reasoning, then its tool calls", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: {
          content: [
            { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_use", id: "c2", name: "read_file", input: { path: "b.txt" } },
          ],
          reasoning: "need the files first\nsecond line of thought",
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      { time: 210, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
      {
        time: 230,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c3", name: "ls", input: {} }],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 2,
      },
    ]);

    const rows = toTrajectoryView(buildTurnRecords(events), events).rows.filter(
      (r) => r.kind === "assistant",
    );
    // Reasoning narrates the step — its first line leads the summary.
    expect(rows[0]!.summary).toBe("need the files first");
    expect(rows[0]!.thinkingDetail).toBe("need the files first\nsecond line of thought");
    expect(rows[0]!.outputDetail).toBeUndefined();
    // Without reasoning, the step is still described by what it did.
    expect(rows[1]!.summary).toBe("1 tool call");
  });

  it("keeps \"(no text)\" for an assistant step with neither text nor tool calls", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      {
        time: 130,
        type: "assistant_message",
        data: { content: [], stopReason: "end_turn", durationMs: 10 },
        turn: 1,
        step: 1,
      },
    ]);

    const row = toTrajectoryView(buildTurnRecords(events), events).rows.find((r) => r.kind === "assistant")!;
    expect(row.summary).toBe("(no text)");
  });

  it("puts the call arguments and real output on the tool row", () => {
    const row = toTrajectoryView(buildTurnRecords(EQUIVALENT_LOG), EQUIVALENT_LOG).rows.find(
      (r) => r.kind === "tool",
    )!;

    expect(row.inputDetail).toContain("a.txt");
    expect(row.outputDetail).toBe("file body");
    expect(row.durationMs).toBe(40);
    expect(row.isError).toBe(false);
  });

  it("attaches the call-time tool schema from request_header", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      {
        time: 105,
        type: "request_header",
        data: {
          hash: "h1",
          systemLayers: [{ id: "base", text: "be helpful" }],
          tools: [{ name: "read_file", description: "reads", schema: { type: "object", properties: {} } }],
          params: { model: "m1" },
        },
        turn: 1,
        step: 1,
      },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "assistant_message", data: { content: [], stopReason: "tool_use", durationMs: 5 }, turn: 1, step: 1 },
      { time: 130, type: "tool_call", data: { callId: "c1", name: "read_file", input: {} }, turn: 1, step: 1 },
    ]);

    const row = toTrajectoryView(buildTurnRecords(events), events).rows.find((r) => r.kind === "tool")!;
    expect(row.schemaDetail).toContain("read_file");
  });

  it("emits a context row per request_header and a compaction row per compaction", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      {
        time: 105,
        type: "request_header",
        data: { hash: "h1", systemLayers: [{ id: "base", text: "be helpful" }], tools: [], params: {} },
        turn: 1,
        step: 1,
      },
      { time: 106, type: "compaction", data: { replacedCount: 4, summaryText: "earlier stuff" }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    ]);

    const kinds = toTrajectoryView(buildTurnRecords(events), events).rows.map((r) => r.kind);
    expect(kinds).toContain("context");
    expect(kinds).toContain("compaction");
  });

  it("marks a sub-agent row with its child session and does not inline it", () => {
    const events = log([
      { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 110, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
      { time: 120, type: "assistant_message", data: { content: [], stopReason: "tool_use", durationMs: 5 }, turn: 1, step: 1 },
      { time: 130, type: "tool_call", data: { callId: "c1", name: "task", input: {} }, turn: 1, step: 1 },
      { time: 135, type: "subagent_started", data: { childSessionId: "s1-sub-9", label: "task", depth: 1 }, turn: 1, step: 1 },
    ]);

    const row = toTrajectoryView(buildTurnRecords(events), events).rows.find((r) => r.kind === "subagent")!;
    expect(row.childSessionId).toBe("s1-sub-9");
    expect(row.outputDetail).toBeUndefined();
  });

  it("gives every row a unique, index-independent id", () => {
    const rows = toTrajectoryView(buildTurnRecords(EQUIVALENT_LOG), EQUIVALENT_LOG).rows;
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.some((r) => r.id === "c1")).toBe(true);
  });
});
