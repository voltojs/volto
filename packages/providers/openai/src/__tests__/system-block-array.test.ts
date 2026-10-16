import { describe, it, expect } from "vitest";
import { toOpenAiMessages } from "../model-port.js";
import type { Message } from "@volto/core";

/**
 * Chat Completions system messages are text-only on the wire: `image_url`
 * parts are accepted in user messages only. Core state can carry a
 * BLOCK-ARRAY system message — the compaction image-preservation summary
 * lands one behind a documented cast (spec 2026-10-16 D5) — so the mapper
 * must project it to an honest string instead of shipping core's raw block
 * shapes (which the API rejects, and which once stringified become
 * "[object Object]" garbage).
 */

/** 1×1 PNG — the resolved wire shape resolveImageRefs hands the port. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MARKER = "[image preserved from compressed conversation: 1x1 image/png]";

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

describe("openai system block-array projection", () => {
  it("projects a block-array system message to an honest string: marker text and image placeholder, never object garbage or bytes", () => {
    const out = toOpenAiMessages([SUMMARY_SYSTEM_MESSAGE]) as Array<{
      role: string;
      content: unknown;
    }>;

    expect(out).toHaveLength(1);
    const system = out[0]!;
    expect(system.role).toBe("system");
    expect(typeof system.content, "system content must be a string on the wire").toBe("string");
    const text = system.content as string;
    // The summary text and the marker survive verbatim.
    expect(text).toContain(
      "[Earlier conversation summary]\nCheckpoint: the user shared a dashboard screenshot.",
    );
    expect(text).toContain(MARKER);
    // The image block degrades to the extractBlockText placeholder.
    expect(text).toContain("[image: 1x1 image/png]");
    // Honest degradation: no "[object Object]" garbage, no image bytes
    // pretending to ride the text-only system role.
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain(PNG_B64);
  });

  it("leaves a plain string system message byte-identical (regression)", () => {
    const out = toOpenAiMessages([{ id: "m1", role: "system", content: "Be concise." }]) as Array<{
      role: string;
      content: unknown;
    }>;

    expect(out[0]).toEqual({ role: "system", content: "Be concise." });
  });
});
