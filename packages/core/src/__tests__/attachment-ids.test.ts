import { describe, it, expect } from "vitest";
import { collectAttachmentIds } from "../transcript-projection.js";
import type { TranscriptEvent } from "../ports.js";

function event(type: string, data: unknown, seq: number): TranscriptEvent {
  return { seq, time: 1, type: type as TranscriptEvent["type"], data: data as never };
}

describe("collectAttachmentIds", () => {
  it("collects nested refs from user, tool result and compaction payloads", () => {
    const events = [
      event("user_message", {
        content: [{ type: "image", source: { type: "ref", id: "a", mediaType: "image/png" } }, { type: "text", text: "hi" }],
      }, 0),
      event("tool_result", {
        callId: "c1",
        content: [
          { type: "text", text: "ok" },
          { type: "image", source: { type: "ref", id: "b", mediaType: "image/png" } },
        ],
      }, 1),
      event("compaction", {
        preservedImages: [{ type: "image", source: { type: "ref", id: "a", mediaType: "image/png" } }],
      }, 2),
      event("assistant_message", {
        content: [{ type: "image", source: { type: "base64", data: "x", mediaType: "image/png" } }],
      }, 3),
    ];
    expect(collectAttachmentIds(events).sort()).toEqual(["a", "b"]);
  });

  it("returns [] for events with no images", () => {
    expect(collectAttachmentIds([event("user_message", { content: "hello" }, 0)])).toEqual([]);
  });
});
