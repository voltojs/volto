import { describe, it, expect } from "vitest";
import { createEventMapper, formatSSEFrame } from "../event-mapper.js";
import { SSEFrameType } from "../types.js";
import type { TranscriptEventInput } from "@volto/core";

const ASSISTANT: TranscriptEventInput = {
  time: 200,
  type: "assistant_message",
  data: { content: [{ type: "text", text: "hello" }], stopReason: "end_turn", durationMs: 80 },
  turn: 1,
  step: 1,
};

describe("createEventMapper", () => {
  it("wraps a transcript event verbatim, converting nothing", () => {
    const mapper = createEventMapper({ now: () => 1 });
    const frame = mapper.event(ASSISTANT);

    expect(frame.event).toBe(SSEFrameType.EVENT);
    expect(frame.data).toEqual(ASSISTANT);
  });

  it("assigns monotonic ids to event frames for Last-Event-ID replay", () => {
    const mapper = createEventMapper({ startId: 10, now: () => 1 });
    expect(mapper.event(ASSISTANT).id).toBe("11");
    expect(mapper.event(ASSISTANT).id).toBe("12");
  });

  it("wraps a delta without consuming an id", () => {
    const mapper = createEventMapper({ now: () => 1 });
    mapper.event(ASSISTANT);
    const delta = mapper.delta({ kind: "text", text: "hi" });

    expect(delta.event).toBe(SSEFrameType.DELTA);
    expect(delta.data).toEqual({ kind: "text", text: "hi" });
    // Deltas are not replayable — they must not advance the replay cursor.
    expect(mapper.event(ASSISTANT).id).toBe("2");
  });

  it("keeps no accumulated text of its own", () => {
    const mapper = createEventMapper({ now: () => 1 });
    expect("getAccumulatedText" in mapper).toBe(false);
    expect("resetTurn" in mapper).toBe(false);
  });

  it("builds a transport-level error frame", () => {
    const mapper = createEventMapper({ now: () => 1 });
    const frame = mapper.error("connection lost", "STREAM_ERROR");

    expect(frame.event).toBe(SSEFrameType.ERROR);
    expect(frame.data).toMatchObject({ code: "STREAM_ERROR", message: "connection lost" });
  });

  it("builds a heartbeat frame", () => {
    const mapper = createEventMapper({ now: () => 42 });
    expect(mapper.heartbeat().data).toEqual({ timestamp: 42 });
  });

  it("builds a connected frame carrying the token verbatim", () => {
    const mapper = createEventMapper({ now: () => 1 });
    const frame = mapper.connected("secret-token");

    expect(frame.event).toBe(SSEFrameType.CONNECTED);
    expect(frame.data).toEqual({ token: "secret-token" });
  });

  it("a connected frame does not consume an id, same as heartbeat", () => {
    const mapper = createEventMapper({ now: () => 1 });
    mapper.event(ASSISTANT);
    mapper.connected("secret-token");
    // Deltas/connected/heartbeat share the last authoritative event's id —
    // replay only ever needs to resume from an EVENT frame.
    expect(mapper.event(ASSISTANT).id).toBe("2");
  });
});

describe("formatSSEFrame", () => {
  it("serialises id, event and data", () => {
    const mapper = createEventMapper({ now: () => 1 });
    const wire = formatSSEFrame(mapper.event(ASSISTANT));

    expect(wire).toContain("id: 1\n");
    expect(wire).toContain(`event: ${SSEFrameType.EVENT}\n`);
    expect(wire.endsWith("\n\n")).toBe(true);
  });
});
