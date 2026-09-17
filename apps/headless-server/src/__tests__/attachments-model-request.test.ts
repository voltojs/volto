/**
 * The last mile of the upload path: an attachment the gateway stored must be
 * the one the Runner resolves when it assembles the ModelRequest.
 *
 * Every other attachment test stops at the HTTP boundary or the SSE frame.
 * That is exactly where this link broke: the gateway wrote to
 * VOLTO_CONFIG_DIR/attachments while createAgent's default store read from
 * ~/.volto/attachments, so the image silently degraded to
 * "[image unavailable: <id>]" on the request surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock, Message, ModelPort, ModelRequest } from "@volto/core";
import { startTestServer, type TestServer } from "./helpers.js";

/** 1×1 PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: TestServer;
let requests: ModelRequest[];

/** Records the assembled request, then ends the turn like IDLE_MODEL does. */
function capturingModelPort(sink: ModelRequest[]): ModelPort {
  return {
    async *stream(request: ModelRequest) {
      sink.push(request);
      yield { type: "text_delta", text: "" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

/**
 * Blocks of the turn's own user message — the last one, since context layers
 * are injected as earlier user messages.
 */
function userBlocks(messages: Message[]): ContentBlock[] {
  const user = messages.filter((m) => m.role === "user").at(-1);
  return Array.isArray(user?.content) ? user.content : [];
}

beforeEach(async () => {
  requests = [];
  server = await startTestServer({ modelPort: capturingModelPort(requests) });
});

afterEach(async () => {
  await server.close();
});

describe("uploaded attachments on the model request", () => {
  it("resolves the ref to base64 bytes instead of an unavailable placeholder", async () => {
    await server.openEvents(server.sessionId);

    const upload = (await (
      await fetch(`${server.url}/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: server.sessionId,
          data: PNG_B64,
          mimeType: "image/png",
        }),
      })
    ).json()) as { id: string };

    const res = await fetch(`${server.url}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: server.sessionId,
        message: "what is this",
        attachments: [upload.id],
        ...server.turnConfig,
      }),
    });
    expect(res.status).toBe(202);

    await server.captureMessages();

    expect(requests).toHaveLength(1);
    const blocks = userBlocks(requests[0]!.messages);

    // The bytes themselves must be on the wire, carrying the upload's mime
    // type. Dimensions are absent by a separate, known gap: AttachmentStore
    // .get() returns no metadata, so POST /messages cannot stamp the ref
    // with width/height.
    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: PNG_B64 },
    });

    // And the degradation path must not have fired.
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts).toEqual(["what is this"]);
  });
});
