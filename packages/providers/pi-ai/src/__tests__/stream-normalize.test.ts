import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ModelEvent } from "@volto/core";
import { normalizeStream } from "../stream-normalize.js";
import { readReplayEnvelope } from "../replay.js";

// Minimal partial AssistantMessage builder for hand-rolled stream events.
// Only the fields normalizeStream actually reads (content, usage, stopReason,
// errorMessage) matter; the rest are filled with plausible placeholders.
function fauxPartial(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api" as AssistantMessage["api"],
    provider: "test-provider" as AssistantMessage["provider"],
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function* asAsyncIterable(
  events: AssistantMessageEvent[],
): AsyncIterable<AssistantMessageEvent> {
  for (const event of events) {
    yield event;
  }
}

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

    const context = { messages: [{ id: "m2", role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const stream = faux.provider.streamSimple(fauxModel, normalizeContext(context));

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

  it("marks a protocol without cache support as unsupported", async () => {
    const message = fauxAssistantMessage("hi");
    const events: AssistantMessageEvent[] = [
      { type: "done", reason: "stop", message },
    ];

    const normalized = await collect(normalizeStream(asAsyncIterable(events), model, "none"));
    const usageEvent = normalized.find((event) => event.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      cacheReporting: "unsupported",
    });
  });

  it("marks usage without cache buckets as not-reported", async () => {
    const message = fauxAssistantMessage("hi");
    const usage = { ...message.usage } as Record<string, unknown>;
    delete usage["cacheRead"];
    delete usage["cacheWrite"];
    const events: AssistantMessageEvent[] = [
      {
        type: "done",
        reason: "stop",
        message: { ...message, usage: usage as unknown as AssistantMessage["usage"] },
      },
    ];

    const normalized = await collect(normalizeStream(asAsyncIterable(events), model));
    const usageEvent = normalized.find((event) => event.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      cacheReporting: "not-reported",
    });
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

    const context = { messages: [{ id: "m3", role: "user" as const, content: "hi", timestamp: Date.now() }] };
    const stream = faux.provider.streamSimple(fauxModel, normalizeContext(context));

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

    const context = { messages: [{ id: "m4", role: "user" as const, content: "hi", timestamp: Date.now() }] };
    controller.abort();
    const stream = faux.provider.streamSimple(fauxModel, normalizeContext(context), { signal: controller.signal });

    const events = await collect(normalizeStream(stream, model));
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== "error") throw new Error("unreachable");
    expect(errorEvent.retriable).toBe(false);
  });

  it("attributes interleaved tool_use_delta events to their own contentIndex block, not a cached one", async () => {
    // Two tool calls open concurrently at contentIndex 0 and 1, with their
    // toolcall_start/delta events interleaved rather than run contiguously.
    // A regression that caches "the current block" instead of re-reading
    // event.partial.content[event.contentIndex] per event would attribute
    // call B's argument fragments to call A (or vice versa).
    const callA = { type: "toolCall" as const, id: "call-a-id", name: "search", arguments: {} };
    const callB = { type: "toolCall" as const, id: "call-b-id", name: "write_file", arguments: {} };

    const events: AssistantMessageEvent[] = [
      { type: "toolcall_start", contentIndex: 0, partial: fauxPartial([callA]) },
      { type: "toolcall_start", contentIndex: 1, partial: fauxPartial([callA, callB]) },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"query":',
        partial: fauxPartial([callA, callB]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"path":',
        partial: fauxPartial([callA, callB]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '"cats"}',
        partial: fauxPartial([callA, callB]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '"a.txt"}',
        partial: fauxPartial([callA, callB]),
      },
    ];

    const normalized = await collect(normalizeStream(asAsyncIterable(events), model));
    const deltaEvents = normalized.filter((e) => e.type === "tool_use_delta");
    expect(deltaEvents).toHaveLength(4);

    const forA = deltaEvents.filter(
      (e) => e.type === "tool_use_delta" && e.toolCallId === "call-a-id",
    );
    const forB = deltaEvents.filter(
      (e) => e.type === "tool_use_delta" && e.toolCallId === "call-b-id",
    );

    const argsFor = (events: typeof deltaEvents) =>
      events
        .map((e) => (e.type === "tool_use_delta" ? e.argumentsDelta : ""))
        .join("");

    expect(argsFor(forA)).toBe('{"query":"cats"}');
    expect(argsFor(forB)).toBe('{"path":"a.txt"}');
  });

  it("falls back to a synthesized message when the error assistant message has no errorMessage", async () => {
    // fauxAssistantMessage always sets errorMessage when given one, and there
    // is no faux helper to omit it while still producing an error-reason
    // event, so this hand-rolls the AssistantMessageEvent directly (the
    // function's public contract is "consumes AsyncIterable<AssistantMessageEvent>",
    // so this is a legitimate way to drive it without going through pi-ai's
    // streaming machinery).
    const errorMessage = fauxPartial([]);
    // Explicitly confirm errorMessage is absent, matching api-notes.md item 5
    // (errorMessage is optional on AssistantMessage).
    expect(errorMessage.errorMessage).toBeUndefined();

    const events: AssistantMessageEvent[] = [
      { type: "error", reason: "error", error: errorMessage },
    ];

    const normalized = await collect(normalizeStream(asAsyncIterable(events), model));
    const errorEvent = normalized.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== "error") throw new Error("unreachable");
    expect(errorEvent.error).toBe("pi-ai stream error");
    expect(errorEvent.retriable).toBe(false);
  });
});
