import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { TranscriptEvent } from "../index.js";
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

  it("places a steering message after the batch's tool results", () => {
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
      // Steering arrives BEFORE the result — smaller seq, later position.
      { time: 150, type: "steering_queued", data: { content: "actually wait" }, turn: 1, step: 1 },
      {
        time: 160,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "body", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const roles = toConversationView(buildTurnRecords(events)).messages.map((m) => m.role);
    // user(go) → assistant(tool_use) → user(steering, after the batch)
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(toConversationView(buildTurnRecords(events)).messages.at(-1)!.content).toBe("actually wait");
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
