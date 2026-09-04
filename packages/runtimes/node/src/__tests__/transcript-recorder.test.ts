import { describe, it, expect, vi } from "vitest";
import { createTranscriptRecorder } from "../transcript-recorder.js";
import type { TranscriptEventInput } from "@volto/core";

function fakeStore() {
  const batches: TranscriptEventInput[][] = [];
  return {
    batches,
    store: {
      async appendEvents(_sessionId: string, events: TranscriptEventInput[]) {
        batches.push(events);
      },
    },
  };
}

describe("createTranscriptRecorder", () => {
  it("buffers events and writes them as one batch on flush", async () => {
    const { store, batches } = fakeStore();
    const recorder = createTranscriptRecorder({
      store,
      sessionId: "s1",
      turn: 2,
      now: () => 1000,
    });

    recorder.record("turn_start", { turn: 2 });
    recorder.record("user_message", { content: "hi" });
    expect(batches).toHaveLength(0);

    await recorder.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("stamps time from the injected clock and turn from options", async () => {
    const { store, batches } = fakeStore();
    let tick = 500;
    const recorder = createTranscriptRecorder({
      store,
      sessionId: "s1",
      turn: 7,
      now: () => tick++,
    });

    recorder.record("turn_start", { turn: 7 });
    recorder.record("user_message", { content: "hi" });
    await recorder.flush();

    expect(batches[0]![0]).toMatchObject({ time: 500, turn: 7, type: "turn_start" });
    expect(batches[0]![1]).toMatchObject({ time: 501, turn: 7, type: "user_message" });
  });

  it("attaches step when supplied", async () => {
    const { store, batches } = fakeStore();
    const recorder = createTranscriptRecorder({ store, sessionId: "s1", turn: 1, now: () => 1 });

    recorder.record("model_call_start", { headerHash: "h" }, { step: 3 });
    await recorder.flush();

    expect(batches[0]![0]!.step).toBe(3);
  });

  it("is a no-op when no store is configured", async () => {
    const recorder = createTranscriptRecorder({ store: undefined, sessionId: "s1", turn: 1, now: () => 1 });
    expect(recorder.enabled).toBe(false);
    recorder.record("turn_start", { turn: 1 });
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("is a no-op when no sessionId is configured", async () => {
    const { store, batches } = fakeStore();
    const recorder = createTranscriptRecorder({ store, sessionId: undefined, turn: 1, now: () => 1 });
    recorder.record("turn_start", { turn: 1 });
    await recorder.flush();
    expect(batches).toHaveLength(0);
  });

  it("swallows a store failure instead of throwing into the main loop", async () => {
    const recorder = createTranscriptRecorder({
      store: { async appendEvents() { throw new Error("disk full"); } },
      sessionId: "s1",
      turn: 1,
      now: () => 1,
    });

    recorder.record("turn_start", { turn: 1 });
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  it("drops the buffer after a failed flush so events are not written twice", async () => {
    const appendEvents = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const recorder = createTranscriptRecorder({
      store: { appendEvents },
      sessionId: "s1",
      turn: 1,
      now: () => 1,
    });

    recorder.record("turn_start", { turn: 1 });
    await recorder.flush();
    recorder.record("turn_end", { turn: 1, reason: "done" });
    await recorder.flush();

    expect(appendEvents).toHaveBeenCalledTimes(2);
    expect(appendEvents.mock.calls[1]![1]).toHaveLength(1);
  });

  it("flush with an empty buffer does not call the store", async () => {
    const { store, batches } = fakeStore();
    const recorder = createTranscriptRecorder({ store, sessionId: "s1", turn: 1, now: () => 1 });
    await recorder.flush();
    expect(batches).toHaveLength(0);
  });
});
