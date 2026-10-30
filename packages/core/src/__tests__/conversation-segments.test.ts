import { describe, expect, it } from "vitest";
import { groupConversationBlocks } from "../view-projection.js";
import type { ConversationBlock } from "../view-projection.js";

const text = (t: string): ConversationBlock => ({ type: "text", text: t });
const tool = (id: string): ConversationBlock => ({
  type: "tool_call",
  call: { id, name: "bash", args: {} },
});
const reasoning = (t: string): ConversationBlock => ({ type: "reasoning", text: t });

describe("groupConversationBlocks", () => {
  it("returns one answer segment for plain text", () => {
    expect(groupConversationBlocks([text("a")]).map((s) => s.kind)).toEqual(["answer"]);
  });

  it("splits answer/activity/answer and keeps order", () => {
    const segments = groupConversationBlocks([text("a"), tool("1"), tool("2"), text("b")]);
    expect(segments.map((s) => s.kind)).toEqual(["answer", "activity", "answer"]);
    expect(segments[1]!.blocks).toHaveLength(2);
    expect(segments[2]!.blocks).toEqual([text("b")]);
  });

  it("keeps activity as its own segment when it opens the message", () => {
    expect(
      groupConversationBlocks([reasoning("r"), text("a"), tool("1")]).map((s) => s.kind),
    ).toEqual(["activity", "answer", "activity"]);
  });

  it("returns an empty array for no blocks", () => {
    expect(groupConversationBlocks([])).toEqual([]);
  });
});
