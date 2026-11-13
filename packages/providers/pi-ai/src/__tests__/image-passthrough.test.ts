import { describe, expect, it } from "vitest";
import type {
  Model as PiModel,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai";

import type { Message, ModelRequest } from "@voltojs/core";
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

/** Wire-shape image produced by the Runner's resolveImageRefs. */
const img = {
  type: "image" as const,
  source: { type: "base64" as const, mediaType: "image/png", data: "iVBORw0KGgo=" },
};

describe("pi-ai image passthrough", () => {
  it("carries an image block from a user message into the pi-ai context", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "what is this" }, img],
        } as unknown as Message,
      ],
    });

    const ctx = toPiContext(req, model);
    const json = JSON.stringify(ctx);
    expect(json).toContain("iVBORw0KGgo=");
    expect(json).toContain("image");

    // Assert real pi-ai structure, not just a substring: ImageContent is
    // { type: "image", data, mimeType } (dist/types.d.ts), mapped from the
    // wire shape's source.data / source.mediaType.
    const msg = ctx.messages[0] as PiUserMessage;
    expect(msg.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("carries an image block returned from a tool into the pi-ai context", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "screenshot", input: {} }],
        },
        {
          id: "m2",
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-1",
              content: [{ type: "text", text: "chart" }, img],
            },
          ],
        } as unknown as Message,
      ],
    });

    const ctx = toPiContext(req, model);
    expect(JSON.stringify(ctx)).toContain("iVBORw0KGgo=");

    const toolResult = ctx.messages.find(
      (m): m is PiToolResultMessage => m.role === "toolResult",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toEqual([
      { type: "text", text: "chart" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("is deterministic", () => {
    const req = baseRequest({
      messages: [
        { id: "m1", role: "user", content: [img] } as unknown as Message,
      ],
    });
    expect(JSON.stringify(toPiContext(req, model))).toBe(
      JSON.stringify(toPiContext(req, model)),
    );
  });

  it("throws on an unresolved user-image ref instead of emitting a useless payload", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m1",
          role: "user",
          content: [
            { type: "image", source: { type: "ref", id: "att-1", mediaType: "image/png" } },
          ],
        } as unknown as Message,
      ],
    });

    // A ref reaching the provider means the Runner's resolve step was
    // skipped; emitting it as-is would silently ship a useless payload.
    expect(() => toPiContext(req, model)).toThrow(/ref|unresolved/i);
  });

  it("throws on an unresolved tool-result image ref as well", () => {
    const req = baseRequest({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "screenshot", input: {} }],
        },
        {
          id: "m2",
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolUseId: "call-1",
              content: [
                { type: "image", source: { type: "ref", id: "att-2", mediaType: "image/png" } },
              ],
            },
          ],
        } as unknown as Message,
      ],
    });

    expect(() => toPiContext(req, model)).toThrow(/ref|unresolved/i);
  });
});
