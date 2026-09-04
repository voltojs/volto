import { describe, it, expect } from "vitest";
import { projectMessages, projectMessageEntries } from "../transcript-projection.js";
import type { TranscriptEvent, Message } from "../index.js";

/** Builds a stored event; seq is assigned in array order by the helper below. */
function log(
  entries: Array<Omit<TranscriptEvent, "seq">>,
): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

describe("projectMessages", () => {
  it("projects a plain user → assistant exchange", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 10 },
        turn: 1,
        step: 1,
      },
      { time: 4, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
    ]);

    const expected: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ];
    expect(projectMessages(events)).toEqual(expected);
  });

  it("orders parallel tool results by orderInBatch, not by arrival", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: {
          content: [
            { type: "tool_use", id: "c1", name: "read_file", input: {} },
            { type: "tool_use", id: "c2", name: "list_dir", input: {} },
          ],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      // c2 finishes FIRST but is index 1 in the batch.
      {
        time: 4,
        type: "tool_result",
        data: { callId: "c2", name: "list_dir", content: "a,b", isError: false, orderInBatch: 1 },
        turn: 1,
        step: 1,
      },
      {
        time: 5,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const messages = projectMessages(events);
    expect(messages.slice(2)).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: "text", isError: false }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c2", content: "a,b", isError: false }] },
    ]);
  });

  it("places a steering message after the batch's tool results, not at its own seq", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      { time: 2, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 3,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 10,
        },
        turn: 1,
        step: 1,
      },
      // Steering arrives DURING tool execution — lower seq than the result.
      { time: 4, type: "steering_queued", data: { content: "actually wait" }, turn: 1, step: 1 },
      {
        time: 5,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const messages = projectMessages(events);
    // The reducer flushes [...tool results, ...queuedUserInputs] — the steering
    // message lands AFTER the tool result despite having the smaller seq.
    expect(messages.slice(2)).toEqual([
      { role: "tool", content: [{ type: "tool_result", toolUseId: "c1", content: "text", isError: false }] },
      { role: "user", content: "actually wait" },
    ]);
  });

  it("ignores compaction, request_header and other log-only events", () => {
    const events = log([
      { time: 1, type: "turn_start", data: { turn: 1 }, turn: 1 },
      {
        time: 2,
        type: "request_header",
        data: { hash: "abc", systemLayers: [], tools: [], params: {} },
        turn: 1,
      },
      { time: 3, type: "user_message", data: { content: "hi" }, turn: 1 },
      { time: 4, type: "compaction", data: { replacedCount: 3, summaryText: "..." }, turn: 1 },
      { time: 5, type: "model_call_start", data: { headerHash: "abc" }, turn: 1, step: 1 },
      { time: 6, type: "context_assembled", data: { layerOrigins: [] }, turn: 1, step: 1 },
      {
        time: 7,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 10 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessages(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
    ]);
  });

  it("keeps an errored tool result in history with isError set", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "bash", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      {
        time: 3,
        type: "tool_result",
        data: { callId: "c1", name: "bash", content: "boom", isError: true, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessages(events).at(-1)).toEqual({
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "c1", content: "boom", isError: true }],
    });
  });

  it("accumulates across turns", () => {
    const events = log([
      { time: 1, type: "user_message", data: { content: "one" }, turn: 1 },
      {
        time: 2,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "1" }], stopReason: "end_turn", durationMs: 1 },
        turn: 1,
        step: 1,
      },
      { time: 3, type: "user_message", data: { content: "two" }, turn: 2 },
      {
        time: 4,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "2" }], stopReason: "end_turn", durationMs: 1 },
        turn: 2,
        step: 1,
      },
    ]);

    expect(projectMessages(events).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("returns an empty array for an empty log", () => {
    expect(projectMessages([])).toEqual([]);
  });
});

describe("projectMessageEntries", () => {
  it("pairs each projected message with the time of the event that produced it", () => {
    const events = log([
      { time: 10, type: "user_message", data: { content: "hi" }, turn: 1 },
      {
        time: 20,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 5 },
        turn: 1,
        step: 1,
      },
    ]);

    expect(projectMessageEntries(events)).toEqual([
      { message: { role: "user", content: "hi" }, time: 10 },
      {
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "end_turn" },
        time: 20,
      },
    ]);
  });

  it("stays aligned with projectMessages under steering reordering", () => {
    const events = log([
      { time: 10, type: "user_message", data: { content: "go" }, turn: 1 },
      {
        time: 20,
        type: "assistant_message",
        data: {
          content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
          stopReason: "tool_use",
          durationMs: 5,
        },
        turn: 1,
        step: 1,
      },
      { time: 30, type: "steering_queued", data: { content: "wait" }, turn: 1, step: 1 },
      {
        time: 40,
        type: "tool_result",
        data: { callId: "c1", name: "read_file", content: "text", isError: false, orderInBatch: 0 },
        turn: 1,
        step: 1,
      },
    ]);

    const entries = projectMessageEntries(events);
    expect(entries.map((e) => e.message)).toEqual(projectMessages(events));
    // Steering sits after the tool result, so its time runs backwards here —
    // that is correct: position follows the reducer, not the clock.
    expect(entries.map((e) => e.time)).toEqual([10, 20, 40, 30]);
  });
});
