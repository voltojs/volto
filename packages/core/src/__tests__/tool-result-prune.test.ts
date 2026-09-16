import { describe, it, expect } from "vitest";
import { pruneOversizedToolResults } from "../tool-result-prune.js";
import type { Message } from "../state.js";

function toolResult(id: string, text: string): Message {
  return {
    id,
    role: "tool",
    content: [{ type: "tool_result", toolUseId: "t1", content: [{ type: "text", text }] }],
  };
}

describe("pruneOversizedToolResults", () => {
  it("is a no-op when under budget", () => {
    const msgs = [toolResult("a", "short")];
    const r = pruneOversizedToolResults(msgs, { maxChars: 100 });
    expect(r.pruned).toEqual([]);
    expect(r.messages[0]).toBe(msgs[0]);
  });

  it("keeps head and tail with an omission marker", () => {
    const long = "H".repeat(60) + "M".repeat(200) + "T".repeat(60);
    const r = pruneOversizedToolResults([toolResult("a", long)], { maxChars: 80 });
    const text = JSON.stringify(r.messages[0]);
    expect(r.pruned).toHaveLength(1);
    expect(text).toContain("H".repeat(10));
    expect(text).toContain("T".repeat(10));
    expect(text).toContain("omitted");
    expect(r.pruned[0]!.charsAfter).toBeLessThan(r.pruned[0]!.charsBefore);
  });

  it("does not touch non-tool messages", () => {
    const user: Message = { id: "u", role: "user", content: "x".repeat(500) };
    const r = pruneOversizedToolResults([user], { maxChars: 10 });
    expect(r.messages[0]).toBe(user);
    expect(r.pruned).toEqual([]);
  });

  it("prunes only the oversized tool_result blocks in a multi-block message", () => {
    const msg: Message = {
      id: "a",
      role: "tool",
      content: [
        { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "short" }] },
        { type: "tool_result", toolUseId: "t2", content: [{ type: "text", text: "L".repeat(200) }] },
      ],
    };
    const r = pruneOversizedToolResults([msg], { maxChars: 80 });
    const tool = r.messages[0]!;
    if (tool.role !== "tool") throw new Error("expected tool message");
    expect(tool.content[0]).toBe(msg.content[0]);
    const prunedText = JSON.stringify(tool.content[1]!.content);
    expect(prunedText).not.toContain("L".repeat(200));
    expect(prunedText).toContain("omitted");
    expect(r.pruned).toHaveLength(1);
    expect(r.pruned[0]!.toolCallId).toBe("t2");
  });

  it("counts code points, not UTF-16 code units", () => {
    // "😀" is one code point but two UTF-16 code units.
    const emoji = "😀".repeat(50);
    const r = pruneOversizedToolResults([toolResult("a", emoji)], { maxChars: 40 });
    expect(r.pruned).toHaveLength(1);
    expect(r.pruned[0]!.charsBefore).toBe(50);
    // The pruned head/tail must not split a surrogate pair.
    const tool = r.messages[0]!;
    if (tool.role !== "tool") throw new Error("expected tool message");
    expect(JSON.stringify(tool.content[0]!.content)).not.toContain("\uFFFD");
  });

  it("is deterministic and immutable", () => {
    const long = "A".repeat(120);
    const msgs = [toolResult("a", long), toolResult("b", "short")];
    const first = pruneOversizedToolResults(msgs, { maxChars: 50 });
    const second = pruneOversizedToolResults(msgs, { maxChars: 50 });
    expect(first.messages).toEqual(second.messages);
    expect(first.pruned).toEqual(second.pruned);
    // Original message objects are not mutated.
    const original = msgs[0]!;
    if (original.role !== "tool") throw new Error("expected tool message");
    expect(original.content[0]!.content).toEqual([{ type: "text", text: long }]);
    // Untouched message keeps its reference.
    expect(first.messages[1]).toBe(msgs[1]);
  });
});
