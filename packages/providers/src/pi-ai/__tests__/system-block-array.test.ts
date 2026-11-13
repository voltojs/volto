import { describe, expect, it } from "vitest";
import type { Model as PiModel } from "@earendil-works/pi-ai";
import type { Message, ModelRequest } from "@voltojs/core";
import { toPiContext } from "../context.js";

/**
 * pi-ai's Context.systemPrompt is a STRING — there is no system-image
 * surface. Core state can carry a BLOCK-ARRAY system message (the
 * compaction image-preservation summary lands one behind a documented
 * cast, spec 2026-10-16 D5), so the context builder must project it to an
 * honest string instead of joining raw blocks ("[object Object]" garbage).
 */

/** 1×1 PNG — the resolved wire shape resolveImageRefs hands the port. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MARKER = "[image preserved from compressed conversation: 1x1 image/png]";

// Minimal fake Model, only the fields toPiContext reads (id/api/provider).
const model = {
  id: "test-model",
  api: "test-api",
  provider: "test-provider",
} as unknown as PiModel<"test-api">;

/** The exact post-compaction summary message shape (reducer D5 block array). */
const SUMMARY_SYSTEM_MESSAGE = {
  id: "summary-1",
  role: "system",
  content: [
    {
      type: "text",
      text: "[Earlier conversation summary]\nCheckpoint: the user shared a dashboard screenshot.",
    },
    { type: "text", text: MARKER },
    {
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: PNG_B64 },
      width: 1,
      height: 1,
    },
  ],
} as unknown as Message;

function baseRequest(messages: Message[]): ModelRequest {
  return { messages, tools: [] };
}

describe("pi-ai system block-array projection", () => {
  it("projects a block-array system message to an honest string: marker text and image placeholder, never object garbage or bytes", () => {
    const ctx = toPiContext(baseRequest([SUMMARY_SYSTEM_MESSAGE]), model);

    expect(typeof ctx.systemPrompt, "systemPrompt must be a string").toBe("string");
    const text = ctx.systemPrompt as string;
    // The summary text and the marker survive verbatim.
    expect(text).toContain(
      "[Earlier conversation summary]\nCheckpoint: the user shared a dashboard screenshot.",
    );
    expect(text).toContain(MARKER);
    // The image block degrades to the extractBlockText placeholder.
    expect(text).toContain("[image: 1x1 image/png]");
    // Honest degradation: no "[object Object]" garbage, no image bytes
    // pretending to ride the text-only system prompt.
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain(PNG_B64);
  });

  it("merges a string system message and a projected block-array one, in order (regression + projection)", () => {
    const ctx = toPiContext(
      baseRequest([
        { id: "m1", role: "system", content: "Be concise." },
        SUMMARY_SYSTEM_MESSAGE,
      ]),
      model,
    );

    expect(ctx.systemPrompt?.startsWith("Be concise.\n\n")).toBe(true);
    expect(ctx.systemPrompt).toContain(MARKER);
  });
});
