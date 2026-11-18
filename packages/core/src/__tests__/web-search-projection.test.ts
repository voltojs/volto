import { describe, it, expect } from "vitest";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { ConversationBlock, ConversationToolCall, TranscriptEvent } from "../index.js";

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

function singleCall(displayMetadata: Record<string, unknown> | undefined): ConversationToolCall {
  const events = log([
    { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
    { time: 110, type: "user_message", data: { content: "search" }, turn: 1 },
    { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
    {
      time: 130,
      type: "assistant_message",
      data: {
        content: [
          { type: "text", text: "searching" },
          { type: "tool_use", id: "c1", name: "web_search", input: { query: "q" } },
        ],
        stopReason: "tool_use",
        durationMs: 10,
      },
      turn: 1,
      step: 1,
    },
    {
      time: 140,
      type: "tool_call",
      data: { callId: "c1", name: "web_search", input: { query: "q" } },
      turn: 1,
      step: 1,
    },
    {
      time: 180,
      type: "tool_result",
      data: {
        callId: "c1",
        name: "web_search",
        content: "1. T — https://e.com",
        isError: false,
        durationMs: 120,
        orderInBatch: 0,
        ...(displayMetadata === undefined ? {} : { displayMetadata }),
      },
      turn: 1,
      step: 1,
    },
    { time: 190, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
  ]);

  const view = toConversationView(buildTurnRecords(events));
  for (const message of view.messages) {
    for (const block of message.blocks as ConversationBlock[]) {
      if (block.type === "tool_call") return block.call;
    }
  }
  throw new Error("no tool_call block projected");
}

describe("toConversationView — web search report", () => {
  it("projects displayMetadata.webSearch onto the conversation tool call", () => {
    const call = singleCall({
      webSearch: {
        sourceId: "glm",
        sourceLabel: "GLM",
        query: "q",
        count: 1,
        durationMs: 120,
        hits: [{ title: "T", url: "https://e.com" }],
      },
    });
    expect(call.search).toEqual({
      sourceId: "glm",
      sourceLabel: "GLM",
      query: "q",
      count: 1,
      durationMs: 120,
      hits: [{ title: "T", url: "https://e.com" }],
    });
  });

  it("omits the field when the tool reported nothing", () => {
    expect(singleCall(undefined).search).toBeUndefined();
    expect(singleCall({}).search).toBeUndefined();
  });

  it("omits the field when the metadata is malformed", () => {
    expect(singleCall({ webSearch: { hits: "nope" } }).search).toBeUndefined();
    expect(singleCall({ webSearch: { hits: [{ title: 1, url: "https://e.com" }] } }).search).toBeUndefined();
  });
});
