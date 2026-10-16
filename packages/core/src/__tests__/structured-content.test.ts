import { describe, it, expect } from "vitest";
import { extractBlockText, extractPlainText } from "../text-extract.js";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import type { ContentBlock, Message, StructuredContent, ToolResultBlock, TranscriptEvent } from "../index.js";

function structured(text: string): StructuredContent {
  return { type: "structured", kind: "lsp.locations", data: { count: 1 }, text };
}

function log(entries: Array<Omit<TranscriptEvent, "seq">>): TranscriptEvent[] {
  return entries.map((e, i) => ({ ...e, seq: i }) as TranscriptEvent);
}

describe("extractBlockText — tool_result with interleaved structured blocks", () => {
  it("keeps [text, structured, text] in order via the required text projection", () => {
    const content: ToolResultBlock[] = [
      { type: "text", text: "head" },
      structured("RESULT-STRUCTURED"),
      { type: "text", text: "tail" },
    ];
    expect(extractBlockText({ type: "tool_result", toolUseId: "t1", content })).toBe(
      "head\nRESULT-STRUCTURED\ntail",
    );
  });
});

describe("extractPlainText — structured blocks", () => {
  it("interleaves structured projections with text blocks in order, skipping images", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "before" },
      structured("PLAIN-STRUCTURED"),
      { type: "text", text: "after" },
      { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 8, height: 8 },
    ];
    const msg: Message = { id: "m1", role: "user", content };
    expect(extractPlainText(msg)).toBe("beforePLAIN-STRUCTUREDafter");
  });
});

/** Assistant step whose content interleaves text and structured around a tool call. */
const ASSISTANT_LOG = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "go" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 130,
    type: "assistant_message",
    data: {
      content: [
        { type: "text", text: "Running tool." },
        structured("ASSISTANT-STRUCTURED"),
        { type: "tool_use", id: "c1", name: "grep", input: { pattern: "x" } },
      ],
      stopReason: "tool_use",
      durationMs: 5,
    },
    turn: 1,
    step: 1,
  },
  { time: 140, type: "tool_call", data: { callId: "c1", name: "grep", input: { pattern: "x" } }, turn: 1, step: 1 },
  {
    time: 150,
    type: "tool_result",
    data: {
      callId: "c1",
      name: "grep",
      content: [
        { type: "text", text: "result head" },
        structured("RESULT-STRUCTURED"),
        { type: "image", source: { type: "ref", id: "att-9", mediaType: "image/png" }, width: 4, height: 4 },
      ],
      isError: false,
      durationMs: 10,
      orderInBatch: 0,
    },
    turn: 1,
    step: 1,
  },
  { time: 160, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 2 },
  {
    time: 200,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "done" }], stopReason: "end_turn", durationMs: 5 },
    turn: 1,
    step: 2,
  },
  { time: 210, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
]);

describe("toConversationView — structured blocks in an assistant step", () => {
  const view = toConversationView(buildTurnRecords(ASSISTANT_LOG));

  it("folds the structured projection into the assistant text buffer and message content", () => {
    const message = view.messages.find((m) => m.role === "assistant" && m.content.includes("Running tool."))!;
    expect(message.content).toBe("Running tool.ASSISTANT-STRUCTURED");
    expect(message.blocks).toContainEqual({ type: "text", text: "Running tool.ASSISTANT-STRUCTURED" });
  });

  it("projects a structured tool_result block into the call result, in order, image untouched", () => {
    const call = view.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_call");
    expect(call).toBeDefined();
    expect(call!.type === "tool_call" && call!.call.result).toBe(
      "result head\nRESULT-STRUCTURED\n[image: 4x4 image/png]",
    );
  });
});

/** A user message mixing text, structured and an image ref. */
const USER_LOG = log([
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  {
    time: 110,
    type: "user_message",
    data: {
      content: [
        { type: "text", text: "look" },
        structured("USER-STRUCTURED"),
        { type: "image", source: { type: "ref", id: "att-7", mediaType: "image/png" }, width: 16, height: 16 },
      ],
    },
    turn: 1,
  },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    time: 130,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", durationMs: 5 },
    turn: 1,
    step: 1,
  },
  { time: 140, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 },
]);

describe("toConversationView — structured blocks in a user message", () => {
  const view = toConversationView(buildTurnRecords(USER_LOG));

  it("projects the structured block as a text block, image stays an image ref", () => {
    const message = view.messages.find((m) => m.role === "user")!;
    expect(message.blocks).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "USER-STRUCTURED" },
      { type: "image", attachmentId: "att-7", mediaType: "image/png", width: 16, height: 16 },
    ]);
  });

  it("includes structured text in the copyable content without any image text", () => {
    const message = view.messages.find((m) => m.role === "user")!;
    expect(message.content).toBe("lookUSER-STRUCTURED");
  });
});
