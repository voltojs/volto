import { describe, it, expect, vi, afterEach } from "vitest";
import { createAnthropicModelPort } from "../model-port.js";
import type { Message, ModelRequest } from "@volto/core";

/**
 * System-role messages are text-only on Anthropic's wire: `system` takes a
 * string (or text blocks with cache_control), never images. Core state can
 * carry a BLOCK-ARRAY system message — the compaction image-preservation
 * summary lands one behind a documented cast (spec 2026-10-16 D5) — so the
 * port must project it to an honest string instead of shipping the raw
 * block array (which stringifies to "[object Object]" garbage on the wire).
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

/** Capture the request body the port actually sends, then end the stream. */
async function captureRequestBody(req: ModelRequest): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  const port = createAnthropicModelPort({ apiKey: "k" });
  for await (const _ of port.stream(req)) {
    // consume
  }
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic system block-array projection", () => {
  it("projects a block-array system message to an honest string: marker text and image placeholder, never object garbage or bytes", async () => {
    const body = await captureRequestBody({
      messages: [SUMMARY_SYSTEM_MESSAGE],
      tools: [],
      model: "claude-sonnet-4-20250514",
    });

    const system = body["system"];
    expect(typeof system, "system must be a string on the wire").toBe("string");
    const text = system as string;
    // The summary text and the marker survive verbatim.
    expect(text).toContain("[Earlier conversation summary]\nCheckpoint: the user shared a dashboard screenshot.");
    expect(text).toContain(MARKER);
    // The image block degrades to the extractBlockText placeholder.
    expect(text).toContain("[image: 1x1 image/png]");
    // Honest degradation: no "[object Object]" garbage, no image bytes
    // pretending to ride the text-only system field.
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain(PNG_B64);
  });

  it("projects through the cache-control path the same way", async () => {
    const body = await captureRequestBody({
      messages: [SUMMARY_SYSTEM_MESSAGE],
      tools: [],
      model: "claude-sonnet-4-20250514",
      cacheBreakpoints: [0],
    });

    const system = body["system"] as Array<{ type: string; text: string }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]?.type).toBe("text");
    expect(system[0]?.text).toContain(MARKER);
    expect(system[0]?.text).toContain("[image: 1x1 image/png]");
    expect(system[0]?.text).not.toContain("[object Object]");
    expect(system[0]?.text).not.toContain(PNG_B64);
  });

  it("leaves a plain string system message byte-identical (regression)", async () => {
    const body = await captureRequestBody({
      messages: [{ id: "m1", role: "system", content: "Be concise." }],
      tools: [],
      model: "claude-sonnet-4-20250514",
    });

    expect(body["system"]).toBe("Be concise.");
  });
});
