import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { createRunner } from "../runner.js";
import { textScript, createCharTokenizer } from "@volto/core";
import type {
  Message,
  ModelPort,
  ModelRequest,
  ModelEvent,
  StepContext,
  ReducerState,
  CompactionConfig,
  PromptAnchorState,
  EventSink,
} from "@volto/core";

function createSpyModelPort(script: ModelEvent[][]): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  let index = 0;
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push(req);
      const events = script[index++];
      if (!events) throw new Error(`spy port: no script for call ${index - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

const ctx: StepContext = { tools: [], model: "test-model" };

/** The exact hash the Runner computes for the static `ctx` above. */
const HEADER_HASH = crypto
  .createHash("sha256")
  .update(JSON.stringify({ systemLayers: [], tools: [], params: { model: "test-model" } }))
  .digest("hex")
  .slice(0, 16);

function initialState(): ReducerState {
  const messages: Message[] = [{ id: "sys", role: "system", content: "you are helpful" }];
  for (let i = 0; i < 20; i++) {
    if (i % 2 === 0) {
      messages.push({ id: `old-${i}`, role: "user", content: `old-user-${i}` });
    } else {
      messages.push({
        id: `old-${i}`,
        role: "assistant",
        content: [{ type: "text", text: `old-asst-${i}` }],
      });
    }
  }
  return {
    messages,
    pendingTools: [],
    status: "idle",
    tokenBudget: undefined,
    tokensUsed: 0,
    maxIterations: 20,
    iterationCount: 0,
    readFiles: [],
    _accumulatedText: "",
    _accumulatedReasoning: "",
    _accumulatedToolCalls: [],
    _toolResultBuffer: {},
    queuedUserInputs: [],
    toolCallCount: 0,
    maxToolCalls: undefined,
    maxCostDollars: undefined,
    maxTokensPerTurn: undefined,
    maxWallclockMs: undefined,
    maxLoopCount: undefined,
    selfCorrectionCount: 0,
    maxSelfCorrections: undefined,
    loopInterventionCount: 0,
    loopRemindedCount: 0,
  };
}

const compaction: CompactionConfig = {
  tokenizer: createCharTokenizer(1),
  maxTokens: 50,
  recentKeepCount: 2,
};

describe("Runner — provider-usage anchor", () => {
  it("uses a trusted anchor instead of the absolute message estimate", async () => {
    const history = initialState().messages;
    const anchorState: PromptAnchorState = {
      anchor: {
        totalTokens: 30,
        messageIndex: history.length,
        headerHash: HEADER_HASH,
        trusted: true,
      },
    };
    const spy = createSpyModelPort([textScript("ok", 30, 5)]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sink: EventSink = { emit(event) { events.push(event as never); } };
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: initialState(),
      compaction,
      promptAnchor: anchorState,
      eventSink: sink,
    });

    await runner.run({ type: "user_message", content: "hi" });

    // Absolute estimate is far over 50; the anchor plus the short new user
    // message stays under, so no summarization call happens.
    expect(spy.calls).toHaveLength(1);
    const calibration = events.find((e) => e.type === "tokenizer_calibration");
    expect(calibration?.data.source).toBe("anchor");
  });

  it("falls back to the absolute estimate when the anchor is untrusted", async () => {
    const history = initialState().messages;
    const anchorState: PromptAnchorState = {
      anchor: {
        totalTokens: 30,
        messageIndex: history.length,
        headerHash: HEADER_HASH,
        trusted: false,
      },
    };
    const spy = createSpyModelPort([textScript("SUMMARY"), textScript("ok", 30, 5)]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sink: EventSink = { emit(event) { events.push(event as never); } };
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: initialState(),
      compaction,
      promptAnchor: anchorState,
      eventSink: sink,
    });

    await runner.run({ type: "user_message", content: "hi" });

    expect(spy.calls).toHaveLength(2);
    const calibration = events.find((e) => e.type === "tokenizer_calibration");
    expect(calibration?.data.source).toBe("absolute");
  });
  it("summarizes when a trusted anchor is over the threshold even with no prunable results", async () => {
    const messages: Message[] = [
      { id: "sys", role: "system", content: "sys" },
      { id: "u1", role: "user", content: "hi" },
    ];
    const anchorState: PromptAnchorState = {
      anchor: {
        totalTokens: 100,
        messageIndex: messages.length,
        headerHash: HEADER_HASH,
        trusted: true,
      },
    };
    const spy = createSpyModelPort([textScript("SUMMARY"), textScript("ok")]);
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: { ...initialState(), messages },
      compaction,
      promptAnchor: anchorState,
    });

    await runner.run({ type: "user_message", content: "hi" });

    // Absolute estimate is under the threshold, but the trusted anchor is
    // over it; with no prunable result the summary must still run.
    expect(spy.calls).toHaveLength(2);
  });

});
