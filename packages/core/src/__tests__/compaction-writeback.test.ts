import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { ContentBlock, ImageContent, Message } from "../state.js";
import type { Id } from "../ports.js";

const idPort: Id = (() => {
  let n = 0;
  return { next: () => `n${++n}` };
})();
const ctx: StepContext = { tools: [], model: "m", id: idPort };

function base(messages: Message[]): ReducerState {
  return { ...createInitialState(), messages, status: "idle" };
}

describe("compaction_applied", () => {
  it("replaces the selected span with one summary at the earliest position", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "a", role: "user", content: "old1" },
      { id: "b", role: "user", content: "old2" },
      { id: "c", role: "user", content: "recent" },
    ];
    const { state, effects } = step(
      base(messages),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
      },
      ctx,
    );
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.role).toBe("system");
    expect(String(sum.content)).toContain("[Earlier conversation summary]");
    expect(String(sum.content)).toContain("checkpoint");
    const emit = effects.find((e) => e.type === "emit" && e.event?.type === "compaction");
    expect(emit).toBeDefined();
  });

  it("drops replaced pins and ignores unknown ids", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "a", role: "user", content: "pinned old" },
      { id: "c", role: "user", content: "recent" },
    ];
    const { state } = step(
      { ...base(messages), pinnedMessageIds: ["a", "ghost"] },
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "s",
        replacedIds: ["a", "missing"],
      },
      ctx,
    );
    expect(state.pinnedMessageIds).toEqual(["ghost"]);
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
  });
});

describe("compaction_applied — preservedImages (F-212)", () => {
  const img1: ImageContent = {
    type: "image",
    source: { type: "ref", id: "att-1", mediaType: "image/png" },
    width: 800,
    height: 600,
  };
  const img2: ImageContent = {
    type: "image",
    source: { type: "ref", id: "att-2", mediaType: "image/jpeg" },
  };

  function span(): Message[] {
    return [
      { id: "sys", role: "system", content: "S" },
      { id: "a", role: "user", content: "old1" },
      { id: "b", role: "user", content: "old2" },
      { id: "c", role: "user", content: "recent" },
    ];
  }

  it("builds a block-array summary: text, then a verbatim marker before each preserved image", () => {
    const { state, effects } = step(
      base(span()),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
        preservedImages: [img1, img2] as ContentBlock[],
      },
      ctx,
    );

    // Insert position, pins and emit semantics are unchanged.
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.role).toBe("system");

    const blocks = sum.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "[Earlier conversation summary]\ncheckpoint",
    });
    // Markers verbatim per spec D5, each immediately before its image block.
    expect(blocks[1]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: 800x600 image/png]",
    });
    expect(blocks[2]).toEqual(img1 as unknown as ContentBlock);
    expect(blocks[3]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: image/jpeg]",
    });
    expect(blocks[4]).toEqual(img2 as unknown as ContentBlock);

    const emit = effects.find((e) => e.type === "emit" && e.event?.type === "compaction");
    expect(emit).toBeDefined();
  });

  it("keeps the summary a byte-identical plain string when preservedImages is absent", () => {
    const { state } = step(
      base(span()),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
      },
      ctx,
    );
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    // Review Focus 1: pin the EXACT string, not a containment check.
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");
  });

  it("falls back to the byte-identical string path when preservedImages is an empty array", () => {
    const { state } = step(
      base(span()),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
        preservedImages: [],
      },
      ctx,
    );
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");
  });
});

describe("tool_results_pruned", () => {
  it("rewrites tool_result content by toolCallId", () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "S" },
      { id: "t", role: "tool", content: [{ type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "LONG" }] }] },
    ];
    const { state } = step(
      base(messages),
      {
        type: "tool_results_pruned",
        entries: [{ toolCallId: "call-1", charsBefore: 4, charsAfter: 2, content: "PR" }],
      },
      ctx,
    );
    const tool = state.messages.find((m) => m.role === "tool")!;
    const block = (tool.content as Array<{ type: string; content: Array<{ type: string; text: string }> }>)[0]!;
    expect(block.content).toEqual([{ type: "text", text: "PR" }]);
  });
});
