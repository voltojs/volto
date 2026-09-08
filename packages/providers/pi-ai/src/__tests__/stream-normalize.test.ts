import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ModelEvent } from "@volto/core";
import { normalizeStream } from "../stream-normalize.js";
import { readReplayEnvelope } from "../replay.js";

const model = "test-model";

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe("normalizeStream", () => {
  it("normalizes a thinking + toolCall response with stopReason toolUse", async () => {
    const faux = fauxProvider();
    const fauxModel = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage(
        [fauxThinking("Let me think about this."), fauxToolCall("echo", { text: "hi" })],
        { stopReason: "toolUse" },
      ),
    ]);

    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const stream = faux.provider.streamSimple(fauxModel, context);

    const events = await collect(normalizeStream(stream, model));
    const types = events.map((e) => e.type);

    // thinking deltas normalize to reasoning_delta.
    expect(types).toContain("reasoning_delta");

    // tool_use_start must carry a non-empty toolName, taken from
    // partial.content[contentIndex] since toolcall_start itself has no name.
    const startEvent = events.find((e) => e.type === "tool_use_start");
    expect(startEvent).toBeDefined();
    if (startEvent?.type !== "tool_use_start") throw new Error("unreachable");
    expect(startEvent.toolName).toBe("echo");
    expect(typeof startEvent.toolCallId).toBe("string");
    expect(startEvent.toolCallId.length).toBeGreaterThan(0);

    // tool_use_delta events carry the same toolCallId and non-empty argument fragments.
    const deltaEvents = events.filter((e) => e.type === "tool_use_delta");
    expect(deltaEvents.length).toBeGreaterThan(0);
    for (const delta of deltaEvents) {
      if (delta.type !== "tool_use_delta") throw new Error("unreachable");
      expect(delta.toolCallId).toBe(startEvent.toolCallId);
    }

    // usage event precedes done.
    const usageIndex = types.indexOf("usage");
    const doneIndex = types.indexOf("done");
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(usageIndex);

    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type !== "done") throw new Error("unreachable");
    expect(doneEvent.stopReason).toBe("tool_use");

    // done.meta is the Task 2 replay envelope, keyed to this model, and must
    // survive a round trip through readReplayEnvelope.
    const envelope = readReplayEnvelope(doneEvent.meta, model);
    expect(envelope).toBeDefined();
    expect(envelope?.blocks).toHaveLength(2);
    expect(envelope?.blocks[0]?.type).toBe("reasoning");
    expect(envelope?.blocks[1]?.type).toBe("tool_use");
  });

  it("normalizes an error response into an error ModelEvent instead of throwing", async () => {
    const faux = fauxProvider();
    const fauxModel = faux.getModel();

    faux.setResponses([
      fauxAssistantMessage("partial output", {
        stopReason: "error",
        errorMessage: "upstream exploded",
      }),
    ]);

    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const stream = faux.provider.streamSimple(fauxModel, context);

    const events = await collect(normalizeStream(stream, model));

    // Must not throw: iterating to completion above already proves that.
    // Exactly one error event, no done event.
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    expect(events.some((e) => e.type === "done")).toBe(false);

    const errorEvent = errorEvents[0];
    if (errorEvent?.type !== "error") throw new Error("unreachable");
    expect(errorEvent.error).toBe("upstream exploded");
    expect(errorEvent.retriable).toBe(false);
  });

  it("marks an aborted stream as non-retriable", async () => {
    const faux = fauxProvider();
    const fauxModel = faux.getModel();
    const controller = new AbortController();

    faux.setResponses([
      fauxAssistantMessage("won't finish", { stopReason: "aborted" }),
    ]);

    const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
    controller.abort();
    const stream = faux.provider.streamSimple(fauxModel, context, { signal: controller.signal });

    const events = await collect(normalizeStream(stream, model));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== "error") throw new Error("unreachable");
    expect(errorEvent.retriable).toBe(false);
  });
});
