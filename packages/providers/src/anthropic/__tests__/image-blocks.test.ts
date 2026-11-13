import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../model-port.js";
import type { Message } from "@voltojs/core";

const img = {
  type: "image" as const,
  source: { type: "base64" as const, mediaType: "image/png", data: "iVBORw0KGgo=" },
};

describe("anthropic image mapping", () => {
  it("passes image blocks through inside tool_result content", () => {
    const messages = [
      {
        id: "m1",
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "chart" }, img] }],
      },
    ] as unknown as Message[];

    const out = toAnthropicMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    const toolResult = out[0]!.content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("passes image blocks through inside a user message", () => {
    const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: "what is this" }, img] }] as unknown as Message[];
    const out = toAnthropicMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(out[0]!.content[1]).toMatchObject({ type: "image", source: { type: "base64" } });
  });
});

// D3 matrix (spec §2): Anthropic tool_result content takes text/image only,
// so a structured block degrades to a text block carrying its text
// projection — never silently dropped, never sent as a fake native shape.
describe("anthropic structured block degradation", () => {
  const projection = "a.ts:1:1 definition of foo";
  const structured = {
    type: "structured" as const,
    kind: "lsp.locations",
    data: { locations: [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 } } }] },
    text: projection,
  };

  it("degrades a structured tool_result block to an exact text block", () => {
    const messages = [
      {
        id: "m1",
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call-1", content: [structured] }],
      },
    ] as unknown as Message[];

    const out = toAnthropicMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    const toolResult = out[0]!.content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content[0]).toEqual({ type: "text", text: projection });
  });

  it("keeps the structured projection in order among text blocks", () => {
    const messages = [
      {
        id: "m1",
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: [{ type: "text", text: "before" }, structured, { type: "text", text: "after" }],
          },
        ],
      },
    ] as unknown as Message[];

    const out = toAnthropicMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    const toolResult = out[0]!.content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: projection },
      { type: "text", text: "after" },
    ]);
  });

  // Counter-proof: a tool_result containing ONLY a structured block must not
  // fall into the unknown-type default (which would emit "[image omitted]").
  it("does not drop a tool_result whose only block is structured", () => {
    const messages = [
      {
        id: "m1",
        role: "tool",
        content: [{ type: "tool_result", toolUseId: "call-1", content: [structured] }],
      },
    ] as unknown as Message[];

    const out = toAnthropicMessages(messages) as Array<{ content: Array<Record<string, unknown>> }>;
    const toolResult = out[0]!.content[0] as { content: Array<Record<string, unknown>> };
    expect(toolResult.content).toHaveLength(1);
    const text = toolResult.content[0]!.text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(projection);
  });
});
