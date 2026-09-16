import { describe, it, expect } from "vitest";
import { step, createInitialState, normalizeToolResultContent } from "../index.js";
import type { ReducerState } from "../index.js";
import type { ToolResultBlock } from "../index.js";

const ctx = { tools: [] };

function stateWithPendingTool(): ReducerState {
  const base = createInitialState();
  return {
    ...base,
    status: "executing_tools",
    messages: [
      { id: "m1", role: "user", content: "read the chart" },
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "/c.png" } }],
      },
    ],
    pendingTools: [{ id: "call-1", name: "read_file", input: { path: "/c.png" } }],
  };
}

describe("normalizeToolResultContent", () => {
  it("wraps a plain string into a single text block", () => {
    expect(normalizeToolResultContent("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("passes a block array through unchanged", () => {
    const blocks: ToolResultBlock[] = [
      { type: "text", text: "chart" },
      { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" }, width: 800, height: 600 },
    ];
    expect(normalizeToolResultContent(blocks)).toEqual(blocks);
  });
});

describe("reducer tool_result normalization", () => {
  it("stores a string tool result as a one-element text block array", () => {
    const { state } = step(stateWithPendingTool(), {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read_file",
      result: { modelContent: "plain text result" },
    }, ctx);
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const block = (toolMsg as { content: Array<{ type: string; content: ToolResultBlock[] }> }).content[0];
    expect(block?.content).toEqual([{ type: "text", text: "plain text result" }]);
  });

  it("keeps image blocks intact and never stores base64 in state", () => {
    const blocks: ToolResultBlock[] = [
      { type: "text", text: "a bar chart" },
      { type: "image", source: { type: "ref", id: "att-9", mediaType: "image/png" }, width: 1024, height: 768 },
    ];
    const { state } = step(stateWithPendingTool(), {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read_file",
      result: { modelContent: blocks },
    }, ctx);
    const serialized = JSON.stringify(state);
    expect(serialized).toContain("att-9");
    expect(serialized).not.toMatch(/data:image|iVBORw0/);
  });
});
