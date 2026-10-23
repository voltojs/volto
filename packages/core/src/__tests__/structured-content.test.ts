import { describe, it, expect } from "vitest";
import { extractBlockText, extractPlainText } from "../text-extract.js";
import { buildTurnRecords, toConversationView } from "../view-projection.js";
import { pruneOversizedToolResults } from "../index.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
  StructuredContent,
  TextContent,
  ToolResultBlock,
  TranscriptEvent,
} from "../index.js";

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

// ──────────────────────────────────────────────
// pruneOversizedToolResults — structured budget + degrade semantics (D4)
// ──────────────────────────────────────────────

function toolMessage(content: ToolResultBlock[]): Message {
  return {
    id: "m-tool",
    role: "tool",
    content: [{ type: "tool_result", toolUseId: "t1", content }],
  };
}

function resultBlocks(messages: Message[]): ToolResultBlock[] {
  const msg = messages.find((m) => m.role === "tool");
  expect(msg).toBeDefined();
  const block = msg!.role === "tool" ? msg!.content[0] : undefined;
  expect(block?.type).toBe("tool_result");
  return block!.type === "tool_result" ? block!.content : [];
}

const IMAGE: ImageContent = {
  type: "image",
  source: { type: "ref", id: "att-1", mediaType: "image/png" },
  width: 8,
  height: 8,
};

describe("pruneOversizedToolResults — structured blocks", () => {
  it("(a) in-budget structured passes through with the same object reference", () => {
    const s = structured("in budget");
    const t: TextContent = { type: "text", text: "also in budget" };
    const { messages, pruned } = pruneOversizedToolResults([toolMessage([t, s])], {
      maxChars: 20,
    });
    const blocks = resultBlocks(messages);
    expect(blocks[1]).toBe(s);
    expect(blocks[0]).toBe(t);
    expect(pruned).toHaveLength(0);
  });

  it("(b) over-budget structured degrades to a plain text block, cut like a text block", () => {
    const body = "structured-body-".repeat(10); // 160 code points
    const s = structured(body);
    const { messages, pruned } = pruneOversizedToolResults([toolMessage([s])], {
      maxChars: 20,
    });
    const blocks = resultBlocks(messages);
    // No structured shell survives the cut: post-cut data would be incomplete.
    expect(blocks.every((b) => b.type !== "structured")).toBe(true);
    expect(blocks).toHaveLength(1);
    // Head/tail cut is byte-identical to what a text block with the same
    // projection would get.
    const { messages: textRef } = pruneOversizedToolResults(
      [toolMessage([{ type: "text", text: body }])],
      { maxChars: 20 },
    );
    expect(blocks).toEqual(resultBlocks(textRef));
    expect((blocks[0] as TextContent).type).toBe("text");
    expect((blocks[0] as TextContent).text).toContain("[omitted");
    // The pruned report counts the structured text projection.
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.toolCallId).toBe("t1");
    expect(pruned[0]!.charsBefore).toBe(160);
  });

  it("(c) boundary: exactly at budget untouched, one code point over degrades and cuts", () => {
    const atBudget = structured("x".repeat(20));
    const overBudget = structured("x".repeat(21));
    const { messages: untouched } = pruneOversizedToolResults(
      [toolMessage([atBudget])],
      { maxChars: 20 },
    );
    expect(resultBlocks(untouched)[0]).toBe(atBudget);

    const { messages: cut } = pruneOversizedToolResults([toolMessage([overBudget])], {
      maxChars: 20,
    });
    const blocks = resultBlocks(cut);
    expect(blocks.every((b) => b.type !== "structured")).toBe(true);
    expect((blocks[0] as TextContent).text).toContain("[omitted 9 chars]");
  });

  it("(d) interleaved [text, structured-over, image]: only the structured degrades, order preserved", () => {
    const t: TextContent = { type: "text", text: "head text" };
    const s = structured("S".repeat(100));
    const { messages } = pruneOversizedToolResults([toolMessage([t, s, IMAGE])], {
      maxChars: 20,
    });
    const blocks = resultBlocks(messages);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toBe(t);
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[2]).toBe(IMAGE);
    expect(blocks.map((b) => b.type)).toEqual(["text", "text", "image"]);
  });
});
