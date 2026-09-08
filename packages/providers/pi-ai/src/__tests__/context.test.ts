import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRequest } from "@volto/core";
import { toReplayEnvelope } from "../replay.js";
import { toPiContext } from "../context.js";

const model = "test-model";

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [],
    tools: [],
    ...overrides,
  };
}

describe("toPiContext", () => {
  it("merges system messages into systemPrompt, in order, joined by blank lines", () => {
    const req = baseRequest({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "system", content: "Never lie." },
        { role: "user", content: "hi" },
      ],
    });

    const ctx = toPiContext(req, model);

    expect(ctx.systemPrompt).toBe("Be concise.\n\nNever lie.");
    expect(ctx.messages).toHaveLength(1);
  });

  it("translates a plain string user message", () => {
    const req = baseRequest({
      messages: [{ role: "user", content: "hello there" }],
    });

    const ctx = toPiContext(req, model);

    const [msg] = ctx.messages;
    expect(msg?.role).toBe("user");
    expect((msg as UserMessage).content).toBe("hello there");
    expect(typeof (msg as UserMessage).timestamp).toBe("number");
  });

  it("translates user content blocks (text + image)", () => {
    const req = baseRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as UserMessage;
    expect(msg.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("round-trips a signed assistant message: signatures reattach to the matching blocks", () => {
    const modelMeta = toReplayEnvelope(
      {
        content: [
          { type: "thinking", thinking: "reasoning..." },
          { type: "text", text: "answer" },
        ],
      } as AssistantMessage,
      model,
    );
    // Manually craft the envelope with real signatures (toReplayEnvelope above
    // only captures signatures present on the faux message, so set them here).
    modelMeta.blocks[0] = { type: "reasoning", thinkingSignature: "think-sig" };
    modelMeta.blocks[1] = { type: "text", textSignature: "text-sig" };

    const req = baseRequest({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "reasoning..." },
            { type: "text", text: "answer" },
          ],
          modelMeta,
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([
      { type: "thinking", thinking: "reasoning...", thinkingSignature: "think-sig" },
      { type: "text", text: "answer", textSignature: "text-sig" },
    ]);
  });

  it("degrades gracefully on foreign replay: reasoning text survives, signature is dropped", () => {
    const req = baseRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "reasoning from another model" }],
          modelMeta: { version: 1, model: "some-other-model", blocks: [] },
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([{ type: "thinking", thinking: "reasoning from another model" }]);
  });

  it("degrades gracefully when modelMeta is absent entirely", () => {
    const req = baseRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } }],
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([
      { type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } },
    ]);
  });

  it("reverse-looks-up toolName for a tool result from an earlier assistant tool_use block", () => {
    const req = baseRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } }],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: "hi", isError: false },
          ],
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const toolResultMsg = ctx.messages[1] as ToolResultMessage;

    expect(toolResultMsg.role).toBe("toolResult");
    expect(toolResultMsg.toolCallId).toBe("call_1");
    expect(toolResultMsg.toolName).toBe("echo");
    expect(toolResultMsg.content).toEqual([{ type: "text", text: "hi" }]);
    expect(toolResultMsg.isError).toBe(false);
  });

  it("throws a descriptive error when a tool_result has no matching prior tool_use block", () => {
    const req = baseRequest({
      messages: [
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_missing", content: "oops", isError: false },
          ],
        },
      ],
    });

    expect(() => toPiContext(req, model)).toThrow(/call_missing/);
  });

  it("passes tool schemas through as-is (inputSchema -> parameters)", () => {
    const req = baseRequest({
      tools: [
        {
          name: "echo",
          description: "Echoes text",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          requires: [],
          riskTier: "READ_ONLY",
        },
      ],
    });

    const ctx = toPiContext(req, model);

    expect(ctx.tools).toEqual([
      {
        name: "echo",
        description: "Echoes text",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });
});
