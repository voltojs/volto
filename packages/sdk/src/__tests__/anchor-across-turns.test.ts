import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { EventSink, ModelPort, ModelRequest, ModelEvent } from "@voltojs/core";

/**
 * A model that always reports the same provider usage. With a 1M window and
 * ~100k usage the anchor is trusted, and no compaction fires; the only
 * observable is the calibration event's source.
 */
function usagePort(usageIn: number, usageOut: number): ModelPort & { calls: number } {
  const port = {
    calls: 0,
    async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
      port.calls += 1;
      yield { type: "text_delta", text: "ok" };
      yield { type: "usage", inputTokens: usageIn, outputTokens: usageOut };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  return port as ModelPort & { calls: number };
}

describe("anchored compaction budget — cross-turn sharing", () => {
  it("reuses turn 1's provider anchor on turn 2", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sink: EventSink = { emit(event) { events.push(event as never); } };
    const port = usagePort(100_000, 1_000);

    const agent = createAgent({
      modelPort: port,
      contextWindow: 1_000_000,
      compaction: { recentKeepCount: 2 },
      eventSink: sink,
    });

    await agent.run("one");
    await agent.run("two");

    const calibrations = events.filter((e) => e.type === "tokenizer_calibration");
    expect(calibrations.length).toBe(2);
    expect(calibrations[0]!.data.source).toBe("absolute");
    expect(calibrations[1]!.data.source).toBe("anchor");
  });
});
