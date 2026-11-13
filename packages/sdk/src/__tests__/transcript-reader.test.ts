import { describe, it, expect } from "vitest";
import { readConversation, readTrajectory } from "../transcript-reader.js";
import type { TranscriptEvent, TranscriptReader } from "@voltojs/core";

const EVENTS: TranscriptEvent[] = [
  { seq: 0, time: 100, type: "turn_start", data: { turn: 1 }, turn: 1 },
  { seq: 1, time: 110, type: "user_message", data: { content: "hi" }, turn: 1 },
  { seq: 2, time: 120, type: "model_call_start", data: { headerHash: "h1" }, turn: 1, step: 1 },
  {
    seq: 3,
    time: 200,
    type: "assistant_message",
    data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 80 },
    turn: 1,
    step: 1,
  },
] as TranscriptEvent[];

function reader(events: TranscriptEvent[] = EVENTS): TranscriptReader {
  return { async readEvents() { return events; } };
}

describe("readConversation", () => {
  it("returns the chat feed for a session", async () => {
    const view = await readConversation(reader(), "s1");
    expect(view.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(view.messages[1]!.content).toBe("hello");
  });

  it("returns an empty view for a session with no events", async () => {
    expect(await readConversation(reader([]), "s1")).toEqual({ messages: [] });
  });

  it("propagates a reader failure instead of swallowing it", async () => {
    const failing: TranscriptReader = {
      async readEvents() { throw new Error("disk gone"); },
    };
    await expect(readConversation(failing, "s1")).rejects.toThrow("disk gone");
  });
});

describe("readTrajectory", () => {
  it("returns numbered audit rows for a session", async () => {
    const view = await readTrajectory(reader(), "s1");
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows[0]!.index).toBe(1);
  });

  it("propagates a reader failure instead of swallowing it", async () => {
    const failing: TranscriptReader = {
      async readEvents() { throw new Error("disk gone"); },
    };
    await expect(readTrajectory(failing, "s1")).rejects.toThrow("disk gone");
  });
});
