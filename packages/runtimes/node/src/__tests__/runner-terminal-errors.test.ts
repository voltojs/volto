/**
 * Regression: a turn that stops without the model finishing must say why.
 *
 * Field report: long tasks "just stopped" with no error and no notice. Root
 * cause — the reducer's runaway guard / budget paths terminate the turn by
 * emitting `error` + `done`, but the Runner forwarded that `error` as a RAW,
 * unstamped event. The gateway's SSE framer drops unstamped events, and the
 * transcript recorder never persisted it, so:
 *   - the live UI saw nothing,
 *   - the durable transcript (and a page reload) saw a clean `turn_end: done`,
 *   - the assistant's last tool_use silently never ran.
 *
 * The fix carries the reason into turn_end.error (a transcript field that has
 * existed all along, and that the web projection renders as a trailing error
 * notice). These tests pin that contract, plus the second silent path: a
 * ModelPort stream that ends without `done`/`error` is a truncated response,
 * not a clean end_turn.
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import {
  createInitialState,
  createMockModelPort,
  modelDone,
  textDelta,
  toolCallScript,
  toolUseDelta,
  toolUseStart,
  usage,
} from "@voltojs/core";
import type {
  EventSink,
  StepContext,
  ToolDefinition,
  TranscriptEventInput,
} from "@voltojs/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

function createRecorderStore(): {
  recorded: TranscriptEventInput[];
  chatStore: { appendEvents(_id: string, events: TranscriptEventInput[]): Promise<void> };
} {
  const recorded: TranscriptEventInput[] = [];
  return {
    recorded,
    chatStore: {
      async appendEvents(_id: string, events: TranscriptEventInput[]) {
        recorded.push(...events);
      },
    },
  };
}

function findTurnEnd(recorded: TranscriptEventInput[]) {
  return recorded.find((e) => e.type === "turn_end") as
    | (TranscriptEventInput & {
        time: number;
        data: { turn: number; reason: string; error?: string };
      })
    | undefined;
}

describe("terminal errors are durable and visible", () => {
  it("iteration cap: turn_end carries the reason and the unexecuted call is not dispatched", async () => {
    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"a.ts"}'),
      toolCallScript("call_2", "read_file", '{"path":"b.ts"}'),
      toolCallScript("call_3", "read_file", '{"path":"c.ts"}'),
    ]);
    const sinkEvents: Array<{ type: string; data?: unknown; time?: number }> = [];
    const eventSink: EventSink = {
      emit(event: unknown) {
        sinkEvents.push(event as { type: string; data?: unknown; time?: number });
      },
    };
    const { recorded, chatStore } = createRecorderStore();
    let executions = 0;

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      eventSink,
      toolExecutor: async () => {
        executions++;
        return { modelContent: "contents" };
      },
      availableCapabilities: capabilities,
      initialState: createInitialState({ maxIterations: 2 }),
      chatStore,
      chatSessionId: "s1",
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");
    expect(state.iterationCount).toBe(2);
    // Only the first batch ran; the call the model asked for on the cap-hitting
    // step was never dispatched (that is the "silent stop" users saw).
    expect(executions).toBe(1);
    expect(recorded.some((e) => e.type === "tool_call" && (e.data as Record<string, unknown>)["callId"] === "call_2")).toBe(false);

    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.data.reason).toBe("error");
    expect(turnEnd!.data.error).toBe("Maximum iterations reached");
    // Stamped, so the gateway's frame() keeps it on the live SSE channel.
    expect(typeof turnEnd!.time).toBe("number");

    // The live channel's last event is the same stamped turn_end.
    const liveTurnEnd = sinkEvents.find((e) => e.type === "turn_end");
    expect(liveTurnEnd?.data).toMatchObject({ reason: "error", error: "Maximum iterations reached" });
  });

  it("normal completion still closes with reason done and no error", async () => {
    const mockModel = createMockModelPort([[textDelta("done"), modelDone("end_turn")]]);
    const { recorded, chatStore } = createRecorderStore();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      initialState: createInitialState({ maxIterations: 2 }),
      chatStore,
      chatSessionId: "s1",
    });

    await runner.run({ type: "user_message", content: "go" });

    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data).toEqual({ turn: 0, reason: "done" });
  });

  it("budget_exceeded: turn_end carries the budget reason (not just the log-only event)", async () => {
    const mockModel = createMockModelPort([[usage(100, 100), textDelta("hi"), modelDone("end_turn")]]);
    const { recorded, chatStore } = createRecorderStore();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      pricing: { "test-model": { inputPer1M: 10, outputPer1M: 30 } },
      initialState: createInitialState({ maxCostDollars: 0.001 }),
      chatStore,
      chatSessionId: "s1",
    });

    await runner.run({ type: "user_message", content: "go" });

    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data.reason).toBe("budget_exceeded");
    expect(turnEnd!.data.error).toBe("Cost budget exceeded");
  });

  it("truncated stream with text: the partial answer is kept and the turn closes as an error", async () => {
    // No terminal event — the stream just stops (proxy cut / half-open socket).
    const mockModel = createMockModelPort([[textDelta("partial answer")]]);
    const { recorded, chatStore } = createRecorderStore();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      initialState: createInitialState(),
      chatStore,
      chatSessionId: "s1",
    });

    await runner.run({ type: "user_message", content: "go" });

    const assistant = recorded.find((e) => e.type === "assistant_message");
    expect(assistant).toBeDefined();
    expect((assistant!.data as Record<string, unknown>)["content"]).toEqual([
      { type: "text", text: "partial answer" },
    ]);

    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data.reason).toBe("error");
    expect(turnEnd!.data.error).toMatch(/truncated response/);
  });

  it("empty stream: closes as an error without persisting an empty assistant message", async () => {
    const mockModel = createMockModelPort([[]]);
    const { recorded, chatStore } = createRecorderStore();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      initialState: createInitialState(),
      chatStore,
      chatSessionId: "s1",
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(recorded.some((e) => e.type === "assistant_message")).toBe(false);
    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data.reason).toBe("error");
    expect(turnEnd!.data.error).toMatch(/truncated response/);
  });

  it("truncated stream inside a tool call: no unpaired assistant tool_use is persisted", async () => {
    const mockModel = createMockModelPort([
      [toolUseStart("call_1", "read_file"), toolUseDelta("call_1", '{"path":"a.ts"}')],
    ]);
    const { recorded, chatStore } = createRecorderStore();

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: capabilities,
      initialState: createInitialState(),
      chatStore,
      chatSessionId: "s1",
    });

    const state = await runner.run({ type: "user_message", content: "go" });

    expect(state.status).toBe("done");
    expect(recorded.some((e) => e.type === "assistant_message")).toBe(false);
    expect(recorded.some((e) => e.type === "tool_call")).toBe(false);

    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data.reason).toBe("error");
    expect(turnEnd!.data.error).toMatch(/truncated response/);
  });
});
