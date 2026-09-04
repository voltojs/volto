import { describe, it, expect } from "vitest";
import { projectConversation } from "@/lib/projection";
import type { TranscriptEventInput } from "@volto/sdk/sse";

const EVENTS: TranscriptEventInput[] = [
  { time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { time: 110, type: "user_message", data: { content: "hi" }, turn: 1 },
  { time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
];

describe("projectConversation", () => {
  it("renders a streaming assistant message from deltas alone", () => {
    const view = projectConversation(EVENTS, [
      { kind: "text", text: "he" },
      { kind: "text", text: "llo" },
    ]);

    const assistant = view.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("hello");
    expect(assistant.isStreaming).toBe(true);
  });

  it("replaces the partial once the authoritative event lands", () => {
    const completed: TranscriptEventInput[] = [
      ...EVENTS,
      {
        time: 200,
        type: "assistant_message",
        data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 80 },
        turn: 1,
        step: 1,
      },
    ];

    const view = projectConversation(completed, []);
    const assistant = view.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("hello");
    expect(assistant.isStreaming).toBeUndefined();
  });

  it("keeps message ids stable as events accumulate", () => {
    const before = projectConversation(EVENTS, []).messages.map((m) => m.id);
    const after = projectConversation(
      [...EVENTS, { time: 300, type: "turn_end", data: { turn: 1, reason: "done" }, turn: 1 }],
      [],
    ).messages.map((m) => m.id);

    expect(after.slice(0, before.length)).toEqual(before);
  });
});
