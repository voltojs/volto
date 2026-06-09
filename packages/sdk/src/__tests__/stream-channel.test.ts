import { describe, it, expect } from "vitest";
import { createStreamChannel } from "../stream-channel.js";

const ev = (type: string) => ({ type, data: {} as Record<string, unknown> });

describe("createStreamChannel", () => {
  it("queues events emitted before the consumer polls, in order", async () => {
    const ch = createStreamChannel();
    ch.eventSink.emit(ev("a"));
    ch.eventSink.emit(ev("b"));
    ch.done();

    const seen: string[] = [];
    for await (const e of ch.events()) seen.push(e.type);
    expect(seen).toEqual(["a", "b"]);
  });

  it("delivers an event emitted while the consumer is awaiting", async () => {
    const ch = createStreamChannel();
    const gen = ch.events();

    const pending = gen.next(); // consumer parks on the empty queue
    ch.eventSink.emit(ev("live"));
    const first = await pending;
    expect(first.done).toBe(false);
    expect(first.value.type).toBe("live");
  });

  it("terminates the generator when done() is called while awaiting", async () => {
    const ch = createStreamChannel();
    const gen = ch.events();

    const pending = gen.next();
    ch.done();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("drains queued events before observing done()", async () => {
    const ch = createStreamChannel();
    ch.eventSink.emit(ev("x"));
    ch.done();

    const gen = ch.events();
    expect((await gen.next()).value?.type).toBe("x");
    expect((await gen.next()).done).toBe(true);
  });

  it("preserves interleaved emit/consume ordering", async () => {
    const ch = createStreamChannel();
    const gen = ch.events();

    ch.eventSink.emit(ev("1"));
    expect((await gen.next()).value?.type).toBe("1");

    const parked = gen.next();
    ch.eventSink.emit(ev("2"));
    expect((await parked).value?.type).toBe("2");

    ch.done();
    expect((await gen.next()).done).toBe(true);
  });
});
