import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model as PiModel, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import type { Message, ModelRequest } from "@volto/core";
import { toReplayEnvelope } from "../replay.js";
import { toPiContext } from "../context.js";

const modelId = "test-model";
// Minimal fake Model, only the fields toPiContext/mapAssistantMessage reads
// (id/api/provider), for stamping onto outgoing assistant messages.
const model = {
  id: modelId,
  api: "test-api",
  provider: "test-provider",
} as unknown as PiModel<"test-api">;

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
        { id: "m1", role: "system", content: "Be concise." },
        { id: "m2", role: "system", content: "Never lie." },
        { id: "m3", role: "user", content: "hi" },
      ],
    });

    const ctx = toPiContext(req, model);

    expect(ctx.systemPrompt).toBe("Be concise.\n\nNever lie.");
    expect(ctx.messages).toHaveLength(1);
  });

  it("translates a plain string user message", () => {
    const req = baseRequest({
      messages: [{ id: "m4", role: "user", content: "hello there" }],
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
          id: "m5",
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              // Wire shape from the Runner's resolveImageRefs; core state
              // stays ref-only, so the request surface carries this as an
              // untyped cast (same boundary as production).
              source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        } as unknown as Message,
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as UserMessage;
    expect(msg.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
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
      modelId,
    );
    // Manually craft the envelope with real signatures (toReplayEnvelope above
    // only captures signatures present on the faux message, so set them here).
    modelMeta.blocks[0] = { type: "reasoning", thinkingSignature: "think-sig" };
    modelMeta.blocks[1] = { type: "text", textSignature: "text-sig" };

    const req = baseRequest({
      messages: [
        {
          id: "m6",
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
          id: "m7",
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

  it("degrades gracefully when source.modelId disagrees with the current model, even if modelMeta looks valid", () => {
    const modelMeta = toReplayEnvelope(
      { content: [{ type: "thinking", thinking: "reasoning..." }] } as AssistantMessage,
      modelId,
    );
    modelMeta.blocks[0] = { type: "reasoning", thinkingSignature: "think-sig" };

    const req = baseRequest({
      messages: [
        {
          id: "m8",
          role: "assistant",
          content: [{ type: "reasoning", text: "reasoning..." }],
          modelMeta,
          source: { modelId: "some-other-model" },
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([{ type: "thinking", thinking: "reasoning..." }]);
  });

  it("trusts a valid envelope when source is absent entirely", () => {
    const modelMeta = toReplayEnvelope(
      { content: [{ type: "text", text: "answer" }] } as AssistantMessage,
      modelId,
    );
    modelMeta.blocks[0] = { type: "text", textSignature: "text-sig" };

    const req = baseRequest({
      messages: [
        {
          id: "m9",
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          modelMeta,
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([{ type: "text", text: "answer", textSignature: "text-sig" }]);
  });

  it("does not treat a differing source.providerId as foreign replay", () => {
    // providerId 是溯源字段（spec 2026-09-26 D3）：volto 的 provider 配置 id
    // 与 pi-ai 目录的 model.provider 不是同一套词汇，拿它判定外部性会把每条
    // 历史消息判成 foreign、静默丢掉签名 thinking 块。签名必须留下。
    const modelMeta = toReplayEnvelope(
      { content: [{ type: "text", text: "answer" }] } as AssistantMessage,
      modelId,
    );
    modelMeta.blocks[0] = { type: "text", textSignature: "text-sig" };

    const req = baseRequest({
      messages: [
        {
          id: "m9b",
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          modelMeta,
          source: { providerId: "some-other-provider", modelId },
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const msg = ctx.messages[0] as AssistantMessage;

    expect(msg.content).toEqual([{ type: "text", text: "answer", textSignature: "text-sig" }]);
  });

  it("degrades gracefully when modelMeta is absent entirely", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m10",
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
          id: "m11",
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } }],
        },
        {
          id: "m12",
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: [{ type: "text", text: "hi" }], isError: false },
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

  it("drops (does not throw for) a tool_result with no matching prior tool_use block", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m13",
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_missing", content: [{ type: "text", text: "oops" }], isError: false },
          ],
        },
      ],
    });

    expect(() => toPiContext(req, model)).not.toThrow();
    expect(toPiContext(req, model).messages).toHaveLength(0);
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

  it("drops a tool result whose originating assistant tool_use message is absent (e.g. compacted away), without throwing", () => {
    const req = baseRequest({
      messages: [
        { id: "m14", role: "user", content: "run it" },
        {
          id: "m15",
          role: "tool",
          content: [{ type: "tool_result", toolUseId: "missing-call", content: [{ type: "text", text: "result text" }] }],
        },
      ],
    });

    expect(() => toPiContext(req, model)).not.toThrow();
    const ctx = toPiContext(req, model);
    const toolResultMessages = ctx.messages.filter((m) => m.role === "toolResult");
    expect(toolResultMessages).toHaveLength(0);
  });

  it("keeps a tool result whose originating assistant tool_use message is present", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m16",
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "hi" } }],
          stopReason: "tool_use",
        },
        {
          id: "m17",
          role: "tool",
          content: [{ type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "result text" }] }],
        },
      ],
    });

    const ctx = toPiContext(req, model);
    const toolResultMessages = ctx.messages.filter(
      (m): m is ToolResultMessage => m.role === "toolResult",
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolName).toBe("echo");
  });

  it("throws on a ref-sourced image block instead of sending it as malformed base64 data", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m18",
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: {
                type: "ref",
                id: "att-9",
                mediaType: "image/png",
              },
            },
          ],
        },
      ],
    });

    // A ref reaching the provider means the Runner's resolveImageRefs step
    // was skipped. Throwing surfaces a broken pipeline; silently dropping
    // the block would look like a model that cannot read images.
    expect(() => toPiContext(req, model)).toThrow(/ref|unresolved/i);
  });
});
