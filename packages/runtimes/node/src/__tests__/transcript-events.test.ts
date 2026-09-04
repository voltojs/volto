import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
// NOTE: createMockModelPort / textDelta / reasoningDelta are re-exported from
// @volto/core's main entry (see src/index.ts), not from the "@volto/core/testing"
// subpath — that subpath only exposes the SessionStore contract test suite
// (testing/store-contract.ts). Importing from "@volto/core/testing" here would
// fail to resolve these symbols.
import { createMockModelPort, textDelta, reasoningDelta } from "@volto/core";
import type { TranscriptEventInput, ModelEvent } from "@volto/core";

function fakeChatStore() {
  const events: TranscriptEventInput[] = [];
  return {
    events,
    store: {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...batch);
      },
    },
  };
}

/** A clock that advances 100ms per read — makes timing assertions exact. */
function steppingClock(start = 1000, stepMs = 100) {
  let t = start - stepMs;
  return { now: () => (t += stepMs) };
}

function typesOf(events: TranscriptEventInput[]): string[] {
  return events.map((e) => e.type);
}

function firstOf<T = Record<string, unknown>>(events: TranscriptEventInput[], type: string): T | undefined {
  return events.find((e) => e.type === type)?.data as T | undefined;
}

describe("Runner transcript capture", () => {
  it("brackets the turn and the model call", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 3,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hello" });

    const types = typesOf(events);
    expect(types).toContain("turn_start");
    expect(types).toContain("user_message");
    expect(types).toContain("model_call_start");
    expect(types).toContain("assistant_message");
    expect(types).toContain("turn_end");
    expect(types.indexOf("model_call_start")).toBeLessThan(types.indexOf("assistant_message"));
    expect(events.every((e) => e.turn === 3)).toBe(true);
  });

  it("records the assembled assistant message with its stop reason", async () => {
    const model = createMockModelPort([[textDelta("hello"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const data = firstOf<{ content: unknown; stopReason: string }>(events, "assistant_message");
    expect(data!.content).toEqual([{ type: "text", text: "hello" }]);
    expect(data!.stopReason).toBe("end_turn");
  });

  it("aggregates reasoning deltas into one reasoning field", async () => {
    const model = createMockModelPort([
      [reasoningDelta("let me "), reasoningDelta("think"), textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ reasoning: string }>(events, "assistant_message")!.reasoning).toBe("let me think");
  });

  it("omits reasoning when the model produced none", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ reasoning?: string }>(events, "assistant_message")!.reasoning).toBeUndefined();
  });

  it("computes ttftMs from the first delta and durationMs from the call bracket", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(1000, 100),
    });
    await runner.run({ type: "user_message", content: "hi" });

    // The stepping clock advances exactly 100ms per read and every read this
    // scenario makes is deterministic (turn_start, user_message,
    // request_header, model_call_start's callStartedAt, the text delta, the
    // model_done that closes the call) — so these aren't just "positive",
    // they're the exact values. A stale firstDeltaAt/callStartedAt carried
    // over from elsewhere would still happen to be positive but would not
    // land on these numbers.
    const data = firstOf<{ ttftMs?: number; durationMs: number }>(events, "assistant_message");
    expect(data!.ttftMs).toBe(300);
    expect(data!.durationMs).toBe(400);
  });

  it("measures the second model call's ttftMs from its own model_call_start, not a stale reading from the first", async () => {
    // First call streams a reasoning delta before calling a tool (so it has
    // its own firstDeltaAt); second call streams a text delta (so it has its
    // own too). If callStartedAt/firstDeltaAt were not reset between calls
    // (see the "hoist to createRunner() scope, reset per runModelStream()
    // call" contract), the second call's ttftMs would be computed against a
    // stale reading from the first call — which, since the second call's
    // own callStartedAt is chronologically later, comes out negative.
    const model = createMockModelPort([
      [
        reasoningDelta("thinking"),
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "ok" }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(1000, 100),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const assistantMessages = events.filter((e) => e.type === "assistant_message");
    expect(assistantMessages).toHaveLength(2);
    const [first, second] = assistantMessages as Array<
      TranscriptEventInput & { data: { ttftMs?: number } }
    >;
    expect(first!.step).toBe(1);
    expect(second!.step).toBe(2);
    expect(first!.data.ttftMs).toBe(300);
    // Exact, not just positive: a leaked callStartedAt/firstDeltaAt from the
    // first call would make this negative (the first call's reading is
    // chronologically earlier than the second call's own callStartedAt).
    expect(second!.data.ttftMs).toBe(200);
    expect(second!.data.ttftMs).toBeGreaterThan(0);
  });

  it("omits ttftMs when the stream produced no delta", async () => {
    const model = createMockModelPort([[{ type: "done", stopReason: "end_turn" } as ModelEvent]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ ttftMs?: number }>(events, "assistant_message")!.ttftMs).toBeUndefined();
  });

  it("carries cache and reasoning token counters through to usage", async () => {
    const model = createMockModelPort([
      [
        textDelta("hi"),
        { type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3 },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ usage: Record<string, number> }>(events, "assistant_message")!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
  });

  it("writes request_header once per turn and reuses its hash", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "ok" }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    // Two model calls in this turn, one header.
    expect(typesOf(events).filter((t) => t === "model_call_start")).toHaveLength(2);
    expect(typesOf(events).filter((t) => t === "request_header")).toHaveLength(1);

    const header = firstOf<{ hash: string; tools: Array<{ name: string }> }>(events, "request_header")!;
    expect(header.tools.map((t) => t.name)).toEqual(["noop"]);
    const starts = events.filter((e) => e.type === "model_call_start");
    expect(starts.every((e) => (e.data as { headerHash: string }).headerHash === header.hash)).toBe(true);
  });

  it("records tool calls and results with their real content", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: '{"a":1}' },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => ({ modelContent: "tool output", displayMetadata: { lineCount: 1 } }),
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(firstOf<{ callId: string; input: unknown }>(events, "tool_call")).toMatchObject({
      callId: "c1",
      name: "noop",
      input: { a: 1 },
    });
    expect(firstOf<Record<string, unknown>>(events, "tool_result")).toMatchObject({
      callId: "c1",
      content: "tool output",
      isError: false,
      orderInBatch: 0,
    });
  });

  it("records a steering message queued mid-turn", async () => {
    const model = createMockModelPort([
      [
        { type: "tool_use_start", toolCallId: "c1", toolName: "noop" },
        { type: "tool_use_delta", toolCallId: "c1", argumentsDelta: "{}" },
        { type: "done", stopReason: "tool_use" },
      ],
      [textDelta("done"), { type: "done", stopReason: "end_turn" }],
    ]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: {
        tools: [
          {
            name: "noop",
            description: "does nothing",
            inputSchema: { type: "object", properties: {} },
            requires: [],
            riskTier: "READ_ONLY",
          },
        ],
        model: "test-model",
      },
      toolExecutor: async () => {
        runner.send({ type: "user_message", content: "wait" });
        return { modelContent: "ok" };
      },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    expect(typesOf(events)).toContain("steering_queued");
  });

  it("records model_error and ends the turn with reason 'error' when the provider yields an error event", async () => {
    // Real providers (packages/providers/anthropic|openai's model-port.ts)
    // yield {type:"error"} for non-2xx responses, aborts, and empty bodies —
    // they do not throw. That path goes through the stream loop, never
    // through runModelStream's catch block, so model_error must be recorded
    // there too or it is silently lost (and turnHadError, only ever set in
    // the catch block before this fix, never gets set either — leaving
    // turn_end lying about how the turn ended). Non-retriable here keeps the
    // test deterministic: a retriable error loops the reducer's own
    // iteration-limited retry (separate from the Runner's retryPolicy, which
    // only applies to thrown exceptions), which is exercised by the
    // provider/runner error-taxonomy tests, not this one.
    const model = createMockModelPort([[{ type: "error", error: "HTTP 500", retriable: false }]]);
    const { store, events } = fakeChatStore();

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      chatStore: store,
      chatSessionId: "chat-1",
      turn: 1,
      clock: steppingClock(),
    });
    await runner.run({ type: "user_message", content: "hi" });

    const modelError = firstOf<{ error: string; retriable: boolean }>(events, "model_error");
    expect(modelError).toBeDefined();
    expect(modelError!.error).toBe("HTTP 500");
    expect(modelError!.retriable).toBe(false);

    const turnEnd = firstOf<{ reason: string }>(events, "turn_end");
    expect(turnEnd!.reason).toBe("error");
  });

  it("records nothing when no chatStore is configured", async () => {
    const model = createMockModelPort([[textDelta("hi"), { type: "done", stopReason: "end_turn" }]]);
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [], model: "test-model" },
      clock: steppingClock(),
    });
    await expect(runner.run({ type: "user_message", content: "hi" })).resolves.toBeDefined();
  });
});
