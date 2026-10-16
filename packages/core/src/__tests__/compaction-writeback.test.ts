import { describe, it, expect } from "vitest";
import { step, createInitialState } from "../reducer.js";
import type { ReducerState, StepContext } from "../reducer.js";
import type { Effect } from "../effect.js";
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

  it("delivers preserved images in a dedicated user message right after the string summary (D5 v1.2)", () => {
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

    // Insert position, pins and emit semantics are unchanged; the images
    // carrier sits immediately after the summary (insertAt + 1).
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "sum-1-images", "c"]);

    // D5 v1.2: the summary is ALWAYS the plain string.
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.role).toBe("system");
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");

    // The carrier: user role, marker verbatim immediately before each image.
    const imagesMsg = state.messages.find((m) => m.id === "sum-1-images")!;
    expect(imagesMsg.role).toBe("user");
    const blocks = imagesMsg.content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: 800x600 image/png]",
    });
    expect(blocks[1]).toEqual(img1 as unknown as ContentBlock);
    expect(blocks[2]).toEqual({
      type: "text",
      text: "[image preserved from compressed conversation: image/jpeg]",
    });
    expect(blocks[3]).toEqual(img2 as unknown as ContentBlock);

    const emit = effects.find((e) => e.type === "emit" && e.event?.type === "compaction");
    expect(emit).toBeDefined();
  });

  it("keeps the summary a byte-identical plain string and adds no images message when preservedImages is absent", () => {
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
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    // Review Focus 1: pin the EXACT string, not a containment check.
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");
  });

  it("keeps the byte-identical string path and adds no images message when preservedImages is an empty array", () => {
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
    expect(state.messages.map((m) => m.id)).toEqual(["sys", "sum-1", "c"]);
    const sum = state.messages.find((m) => m.id === "sum-1")!;
    expect(sum.content).toBe("[Earlier conversation summary]\ncheckpoint");
  });

  it("drops stale pins on the summary id and its images carrier (defensive)", () => {
    const { state } = step(
      { ...base(span()), pinnedMessageIds: ["sum-1", "sum-1-images", "ghost"] },
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
        preservedImages: [img1] as ContentBlock[],
      },
      ctx,
    );
    expect(state.pinnedMessageIds).toEqual(["ghost"]);
  });

  it("carries preserved image ref metadata (not bytes) on the compaction event", () => {
    const { effects } = step(
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
    const emit = effects.find(
      (e): e is Extract<Effect, { type: "emit" }> =>
        e.type === "emit" && e.event.type === "compaction",
    )!;
    const data = emit.event.data as {
      preservedImages?: Array<{ id: string; mediaType: string; width?: number; height?: number }>;
    };
    // Durable transcript replay needs the carrier's SHAPE, not its bytes:
    // ref id / mediaType / dims only, in preservedImages order.
    expect(data.preservedImages).toEqual([
      { id: "att-1", mediaType: "image/png", width: 800, height: 600 },
      { id: "att-2", mediaType: "image/jpeg" },
    ]);
    // No image bytes may leak into the durable event.
    expect(JSON.stringify(data)).not.toContain("base64");
    expect(JSON.stringify(data)).not.toContain("data:image");
  });

  it("omits preservedImages from the compaction event when nothing survived", () => {
    const { effects } = step(
      base(span()),
      {
        type: "compaction_applied",
        summaryId: "sum-1",
        summaryText: "checkpoint",
        replacedIds: ["a", "b"],
      },
      ctx,
    );
    const emit = effects.find(
      (e): e is Extract<Effect, { type: "emit" }> =>
        e.type === "emit" && e.event.type === "compaction",
    )!;
    // Backward-compat pin: without images the event is byte-identical to
    // the pre-carrier shape — no preservedImages key at all.
    expect("preservedImages" in emit.event.data).toBe(false);
    expect(Object.keys(emit.event.data).sort()).toEqual([
      "replacedCount",
      "replacedIds",
      "summaryId",
      "summaryText",
    ]);
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
