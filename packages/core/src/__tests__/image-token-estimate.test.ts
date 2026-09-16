import { describe, it, expect } from "vitest";
import {
  extractBlockText,
  estimateBlockTokens,
  createHeuristicTokenizer,
  decideCompaction,
  pruneOversizedToolResults,
} from "../index.js";
import type { ImageContent, ToolResultContent, Message } from "../index.js";

const tokenizer = createHeuristicTokenizer();
const img: ImageContent = {
  type: "image",
  source: { type: "ref", id: "att-1", mediaType: "image/png" },
  width: 1024,
  height: 768,
};

describe("image text extraction", () => {
  it("renders a placeholder instead of an empty string", () => {
    expect(extractBlockText(img)).toBe("[image: 1024x768 image/png]");
  });

  it("renders a placeholder without dimensions when they are unknown", () => {
    const bare: ImageContent = { type: "image", source: { type: "ref", id: "a", mediaType: "image/jpeg" } };
    expect(extractBlockText(bare)).toBe("[image: image/jpeg]");
  });

  it("recurses into a tool_result block array", () => {
    const tr: ToolResultContent = {
      type: "tool_result",
      toolUseId: "call-1",
      content: [{ type: "text", text: "chart" }, img],
    };
    expect(extractBlockText(tr)).toBe("chart\n[image: 1024x768 image/png]");
  });
});

describe("image token estimation", () => {
  it("uses the area formula when dimensions are known", () => {
    // ceil(1024 * 768 / 750) = 1049, plus per-block overhead 4
    expect(estimateBlockTokens(img, tokenizer)).toBe(1053);
  });

  it("falls back to a conservative constant without dimensions", () => {
    const bare: ImageContent = { type: "image", source: { type: "ref", id: "a", mediaType: "image/png" } };
    expect(estimateBlockTokens(bare, tokenizer)).toBe(1604);
  });
});

it("renders images as placeholders in the compaction summary prompt", () => {
  const messages: Message[] = [
    { id: "m1", role: "user", content: "look at this" },
    {
      id: "m2",
      role: "tool",
      content: [{
        type: "tool_result",
        toolUseId: "call-1",
        content: [{ type: "text", text: "the chart" }, img],
      }],
    },
  ];

  const decision = decideCompaction(messages, {
    // Threshold forced low so this short history is guaranteed to compact.
    maxTokens: 1,
    // Zero so both messages are compressible; a nonzero keep would preserve
    // the tool result and the summary would never see the image.
    recentKeepCount: 0,
    tokenizer,
  });

  expect(decision.shouldCompact).toBe(true);
  expect(decision.summaryPrompt).toContain("[image: 1024x768 image/png]");
  // The bytes never existed in state, and the id must not leak into a summary
  // the model reads as prose.
  expect(decision.summaryPrompt).not.toContain("att-1");
});

describe("character budget applies to text blocks only", () => {
  it("preserves image blocks when pruning an oversized tool_result", () => {
    const long = "L".repeat(200);
    const msg: Message = {
      id: "t1",
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: "call-1",
          content: [{ type: "text", text: long }, img],
        },
      ],
    };

    const { messages, pruned } = pruneOversizedToolResults([msg], { maxChars: 80 });

    expect(pruned).toHaveLength(1);
    const tool = messages[0]!;
    if (tool.role !== "tool") throw new Error("expected tool message");
    const blocks = tool.content[0]!.type === "tool_result" ? tool.content[0]!.content : [];
    // The text block was head/tail cut; the image is untouched.
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe(img);
    const text = blocks[0]!.type === "text" ? blocks[0]!.text : "";
    expect(text).toContain("omitted");
    expect(text).not.toContain(long);
    // The write-back entry carries the full block array, image included.
    expect(pruned[0]!.content).toEqual(blocks);
  });

  it("is a no-op when only images are present", () => {
    const msg: Message = {
      id: "t1",
      role: "tool",
      content: [{ type: "tool_result", toolUseId: "call-1", content: [img] }],
    };
    const { messages, pruned } = pruneOversizedToolResults([msg], { maxChars: 10 });
    expect(pruned).toEqual([]);
    expect(messages[0]).toBe(msg);
  });
});
