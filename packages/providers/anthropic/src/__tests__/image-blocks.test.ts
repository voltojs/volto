import { describe, it, expect } from "vitest";
import { toAnthropicMessages } from "../model-port.js";
import type { Message } from "@volto/core";

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
