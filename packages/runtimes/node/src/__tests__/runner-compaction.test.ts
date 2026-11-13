import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import {
  textScript,
  createCharTokenizer,
} from "@voltojs/core";
import type {
  Message,
  ModelPort,
  ModelRequest,
  ModelEvent,
  StepContext,
  ReducerState,
  CompactionConfig,
  TranscriptEventInput,
  Id,
} from "@voltojs/core";

/**
 * A spy ModelPort that records every request's messages and replays a script
 * of event sequences. Lets us assert the exact `messages` array the model
 * received on each call — essential for verifying compaction reorders the
 * summary correctly and that summarization runs out-of-band.
 */
function createSpyModelPort(script: ModelEvent[][]): ModelPort & {
  calls: Array<{ messages: Message[]; tools: number }>;
} {
  const calls: Array<{ messages: Message[]; tools: number }> = [];
  let index = 0;
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push({ messages: req.messages, tools: req.tools.length });
      const events = script[index++];
      if (!events) throw new Error(`spy port: no script for call ${index - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

const ctx: StepContext = { tools: [], model: "test-model" };

function makeMessages(n: number, prefix: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${prefix}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0
        ? `${prefix}-user-${i}`
        : [{ type: "text", text: `${prefix}-asst-${i}` }],
    } as Message);
  }
  return out;
}

/** Build a `role: "tool"` message carrying one oversized tool_result block. */
function makeToolResult(id: string, toolUseId: string, content: string): Message {
  return {
    id,
    role: "tool",
    content: [{ type: "tool_result", toolUseId, content: [{ type: "text", text: content }] }],
  } as Message;
}

function makeInitial(messages: Message[], overrides: Partial<ReducerState> = {}): ReducerState {
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
    ...overrides,
  };
}

function flattenText(messages: Message[]): string {
  return messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((c) =>
                c.type === "text"
                  ? c.text
                  : c.type === "tool_result"
                    ? c.content
                        .map((b) => (b.type === "text" ? b.text : ""))
                        .join("")
                    : "",
              )
              .join("")
          : "",
    )
    .join("|");
}

describe("Runner — compaction wiring", () => {
  it("issues a summarization call before the main call, then sends [system, summary(user), ...recent] to the main call", async () => {
    // Build a long history that will exceed the 200-token threshold once a
    // system message and a long user turn are added.
    const history = makeMessages(20, "old"); // 20 alternating messages
    const systemMsg: Message = { id: "m1", role: "system", content: "you are helpful" };
    const initial: ReducerState = {
      messages: [systemMsg, ...history],
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

    const spy = createSpyModelPort([
      // Call 1: summarization — returns plain summary text
      textScript("SUMMARY-OF-OLD-MESSAGES"),
      // Call 2: main reply
      textScript("ack"),
    ]);

    const compaction: CompactionConfig = {
      tokenizer: createCharTokenizer(1), // 1 char ≈ 1 token, makes it cheap to overflow
      maxTokens: 50,
      recentKeepCount: 2,
    };

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: initial,
      compaction,
    });

    await runner.run({ type: "user_message", content: "now-user" });

    expect(spy.calls).toHaveLength(2);
    // First call: summarization — no tools, single synthetic user message.
    expect(spy.calls[0]!.tools).toBe(0);
    expect(spy.calls[0]!.messages).toHaveLength(1);
    expect(spy.calls[0]!.messages[0]!.role).toBe("user");

    // Second call: main request, with rewritten messages.
    const main = spy.calls[1]!.messages;
    // System must lead.
    expect(main[0]!.role).toBe("system");
    expect(main[0]!.content).toBe("you are helpful");
    // The summary is a USER message: a system-role summary would be hoisted
    // ahead of the static context layers by the ContextAssembler and break
    // the provider prefix cache. It still sits before the remaining history.
    expect(main[1]!.role).toBe("user");
    expect(typeof main[1]!.content === "string" ? main[1]!.content : "").toContain(
      "[Earlier conversation summary]",
    );
    expect(typeof main[1]!.content === "string" ? main[1]!.content : "").toContain(
      "SUMMARY-OF-OLD-MESSAGES",
    );
    // Verify compression happened — main request must be strictly shorter
    // than the original [system, ...20 old, new-user] history (= 22 msgs).
    // It can still contain a few `old-*` near-term messages (recentKeepCount=2),
    // but the overall count must shrink.
    expect(main.length).toBeLessThan(22);
    // Count `old-*` occurrences in main: must be ≤ recentKeepCount (2 here),
    // proving the bulk of the old history was dropped.
    const oldCount = main.filter((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => (c.type === "text" ? c.text : "")).join("")
            : "";
      return text.startsWith("old-");
    }).length;
    expect(oldCount).toBeLessThanOrEqual(2);
    // The fresh user input must be present somewhere in the main request.
    const flat = main
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => (c.type === "text" ? c.text : "")).join("")
            : "",
      )
      .join("|");
    expect(flat).toContain("now-user");
  });

  it("records a compaction transcript event with the replaced count and summary", async () => {
    const history = makeMessages(20, "old");
    const systemMsg: Message = { id: "m2", role: "system", content: "you are helpful" };
    const initial: ReducerState = {
      messages: [systemMsg, ...history],
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

    const spy = createSpyModelPort([
      textScript("SUMMARY-OF-OLD-MESSAGES"),
      textScript("ack"),
    ]);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    // `appendEvents` must accept TranscriptEventInput[]: the looser {type,data}
    // shape is NOT assignable to TranscriptStore.appendEvents (TS2322) and
    // would fail the typecheck gate. Cast on push, mirroring the existing
    // fixture in runner.test.ts.
    const chatStore = {
      async appendEvents(_sessionId: string, batch: TranscriptEventInput[]) {
        events.push(...(batch as unknown as Array<{ type: string; data: Record<string, unknown> }>));
      },
    };

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: initial,
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 50,
        recentKeepCount: 2,
      },
      chatStore,
      chatSessionId: "chat-1",
    });

    await runner.run({ type: "user_message", content: "now-user" });

    const compactionEvent = events.find((e) => e.type === "compaction");
    expect(compactionEvent).toBeDefined();
    expect(compactionEvent!.data.summaryText).toBe("SUMMARY-OF-OLD-MESSAGES");
    // 19 equals the number of dropped messages
    // (`decision.compressibleMessages.length`). Pinning the literal catches a
    // regression that reported the total message count or the kept count.
    expect(compactionEvent!.data.replacedCount).toBe(19);
  });

  it("skips compaction when below the threshold", async () => {
    const spy = createSpyModelPort([textScript("hi")]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      compaction: {
        tokenizer: createCharTokenizer(4),
        maxTokens: 1_000_000, // very high — never triggers
        recentKeepCount: 4,
      },
    });

    await runner.run({ type: "user_message", content: "hello" });

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.messages).toHaveLength(1);
    expect(spy.calls[0]!.messages[0]!.role).toBe("user");
  });

  it("passes pinnedMessageIds into decideCompaction and keeps pinned messages in the main request", async () => {
    const history = makeMessages(20, "old");
    const pinnedMsg: Message = { id: "pin-me", role: "user", content: "CRITICAL PINNED" };
    const systemMsg: Message = { id: "sys", role: "system", content: "sys" };
    const messages = [systemMsg, pinnedMsg, ...history];

    const spy = createSpyModelPort([
      textScript("SUM"),
      textScript("ok"),
    ]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages, { pinnedMessageIds: ["pin-me"] }),
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 40,
        recentKeepCount: 2,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    // Summarization call + main call
    expect(spy.calls).toHaveLength(2);
    const main = spy.calls[1]!.messages;
    // The pinned message must survive compaction into the main request.
    expect(flattenText(main)).toContain("CRITICAL PINNED");
  });

  it("prunes oversized tool results and skips summarization when pressure is gone", async () => {
    // A single huge tool_result blows the budget; after head/tail pruning the
    // history fits, so no summarization call should be issued.
    const huge = "X".repeat(2000);
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      { id: "u1", role: "user", content: "q" } as Message,
      makeToolResult("tr1", "call-1", huge),
    ];

    const spy = createSpyModelPort([textScript("ack")]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: { emit(event) { events.push(event as never); } },
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 500,
        recentKeepCount: 4,
        toolResultMaxChars: 100,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    // Prune alone brought the surface under budget — no summarization call.
    expect(spy.calls).toHaveLength(1);
    const main = spy.calls[0]!.messages;
    expect(flattenText(main)).toContain("omitted");
    // The original huge run must not ride along verbatim.
    expect(flattenText(main)).not.toContain(huge);
    const prune = events.find((e) => e.type === "tool_results_pruned");
    const entries = prune?.data.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.savedTokens).toBeGreaterThan(0);
    expect(entries[0]!.cacheResetTokens).toBeGreaterThan(0);
  });

  it("does not prune when prunePolicy is off", async () => {
    const huge = "X".repeat(2000);
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      { id: "u1", role: "user", content: "q" } as Message,
      makeToolResult("tr1", "call-1", huge),
    ];
    const spy = createSpyModelPort([textScript("SUMMARY"), textScript("ack")]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: { emit(event) { events.push(event as never); } },
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 500,
        recentKeepCount: 4,
        toolResultMaxChars: 100,
        prunePolicy: "off",
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    expect(events.some((e) => e.type === "tool_results_pruned")).toBe(false);
    expect(spy.calls).toHaveLength(2);
  });

  it("prunes oversized tool results, then still summarizes when over threshold", async () => {
    // Many medium messages + one huge tool_result: pruning shrinks the tool
    // dump but the remaining history still exceeds the threshold, so a
    // summarization call must follow. recentKeepCount=3 keeps the tool_result
    // (plus the two trailing user turns) out of the compressible set, so its
    // pruned content is visible in the main request.
    const huge = "Y".repeat(2000);
    const old = makeMessages(15, "old");
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      ...old,
      makeToolResult("tr1", "call-1", huge),
      { id: "u-recent", role: "user", content: "recent-user" } as Message,
    ];

    const spy = createSpyModelPort([
      textScript("SUMMARY"),
      textScript("ack"),
    ]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 300,
        recentKeepCount: 3,
        toolResultMaxChars: 100,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    // Still over threshold after prune → summarization + main.
    expect(spy.calls).toHaveLength(2);
    // Summarization call is first, no tools.
    expect(spy.calls[0]!.tools).toBe(0);
    const main = spy.calls[1]!.messages;
    // Pruned tool content (recent-kept) rides in the main request.
    expect(flattenText(main)).toContain("omitted");
    expect(flattenText(main)).not.toContain(huge);
    // Summary is present.
    expect(flattenText(main)).toContain("[Earlier conversation summary]");
  });

  it("returns the pruned surface when summarization fails after a prune", async () => {
    const huge = "Z".repeat(2000);
    const old = makeMessages(15, "old");
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      ...old,
      makeToolResult("tr1", "call-1", huge),
      { id: "u-recent", role: "user", content: "recent-user" } as Message,
    ];

    // Summarization script yields an error event; main call still runs.
    const spy = createSpyModelPort([
      [ { type: "error", error: "summarizer down", retriable: false } as ModelEvent ],
      textScript("ack"),
    ]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 300,
        recentKeepCount: 2,
        toolResultMaxChars: 100,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    // Error path → pruned-but-unsummarized surface on the main call.
    expect(spy.calls).toHaveLength(2);
    const main = spy.calls[1]!.messages;
    expect(flattenText(main)).toContain("omitted");
    expect(flattenText(main)).not.toContain("[Earlier conversation summary]");
  });

  it("feeds compaction_applied so state.messages shrinks after the turn step", async () => {
    const history = makeMessages(20, "old");
    const systemMsg: Message = { id: "m1", role: "system", content: "you are helpful" };
    const initial = makeInitial([systemMsg, ...history]);
    const initialCount = initial.messages.length;

    // Deterministic Id port so we can assert the summary id is not hardcoded.
    let idN = 0;
    const idPort: Id = { next: () => `id-${++idN}` };
    const ctxWithId: StepContext = { ...ctx, id: idPort };

    const spy = createSpyModelPort([
      textScript("SUMMARY-OF-OLD-MESSAGES"),
      textScript("ack"),
    ]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctxWithId,
      initialState: initial,
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 50,
        recentKeepCount: 2,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    const finalState = runner.getState();
    // State must have shrunk relative to initial + user + assistant.
    expect(finalState.messages.length).toBeLessThan(initialCount + 2);

    // State must contain a summary message whose id came from the Id port.
    const summary = finalState.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[Earlier conversation summary]"),
    );
    expect(summary).toBeDefined();
    expect(summary!.id).not.toBe("compaction-summary");
    expect(summary!.id).toMatch(/^id-/);

    // The main request and state must agree on the summary identity.
    const main = spy.calls[1]!.messages;
    const mainSummary = main.find(
      (m) => typeof m.content === "string" && m.content.includes("[Earlier conversation summary]"),
    );
    expect(mainSummary).toBeDefined();
    expect(mainSummary!.id).toBe(summary!.id);
  });

  it("keeps pruned tool results in state even when summarization fails", async () => {
    const huge = "Z".repeat(2000);
    const old = makeMessages(15, "old");
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      ...old,
      makeToolResult("tr1", "call-1", huge),
      { id: "u-recent", role: "user", content: "recent-user" } as Message,
    ];

    // Summarization script yields an error; main call still runs.
    const spy = createSpyModelPort([
      [{ type: "error", error: "summarizer down", retriable: false } as ModelEvent],
      textScript("ack"),
    ]);

    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 300,
        recentKeepCount: 2,
        toolResultMaxChars: 100,
      },
    });

    await runner.run({ type: "user_message", content: "now-user" });

    const finalState = runner.getState();
    // The prune write-back must survive the failed summarization: state's
    // tool_result content is the pruned text, not the original huge dump.
    const flatState = flattenText(finalState.messages);
    expect(flatState).toContain("omitted");
    expect(flatState).not.toContain(huge);
    // No summary was written back.
    expect(flatState).not.toContain("[Earlier conversation summary]");
  });
  it("writes the full original before pruning when pruneSpill is on", async () => {
    const huge = "Z".repeat(2_000);
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      makeToolResult("tr1", "call-1", huge),
    ];
    const writes: Array<{ sessionId: string; toolCallId: string; text: string }> = [];
    const spy = createSpyModelPort([textScript("ack")]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: { emit(event) { events.push(event as never); } },
      spill: {
        store: {
          async write(input) {
            writes.push(input);
            return { relativePath: "spill/s/call-1.txt" };
          },
        },
      },
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 500,
        recentKeepCount: 4,
        toolResultMaxChars: 100,
        pruneSpill: true,
      },
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe(huge);
    expect(flattenText(spy.calls[0]!.messages)).toContain("full output saved to");
  });

  it("skips the prune entry when the pruneSpill write fails", async () => {
    const huge = "Z".repeat(2_000);
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      makeToolResult("tr1", "call-1", huge),
    ];
    const spy = createSpyModelPort([textScript("SUMMARY"), textScript("ack")]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: { emit(event) { events.push(event as never); } },
      spill: {
        store: {
          async write() {
            throw new Error("disk full");
          },
        },
      },
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 500,
        recentKeepCount: 4,
        toolResultMaxChars: 100,
        pruneSpill: true,
      },
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(events.some((e) => e.type === "spill_failed")).toBe(true);
    expect(events.some((e) => e.type === "tool_results_pruned")).toBe(false);
    expect(spy.calls).toHaveLength(2);
  });

  it("does not prune a result that is already in spill form", async () => {
    const messages = [
      { id: "sys", role: "system", content: "sys" } as Message,
      makeToolResult("tr1", "call-1", "N".repeat(2_000)),
      makeToolResult("tr2", "call-2", "full output saved to spill/x.txt " + "S".repeat(2_000)),
    ];
    const writes: Array<{ toolCallId: string }> = [];
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const spy = createSpyModelPort([textScript("SUMMARY"), textScript("ack")]);
    const runner = createRunner({
      modelPort: spy,
      stepContext: ctx,
      initialState: makeInitial(messages),
      eventSink: { emit(event) { events.push(event as never); } },
      spill: {
        store: {
          async write(input) {
            writes.push(input);
            return { relativePath: "spill/s/x.txt" };
          },
        },
      },
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 500,
        recentKeepCount: 4,
        toolResultMaxChars: 100,
        pruneSpill: true,
      },
    });

    await runner.run({ type: "user_message", content: "go" });

    expect(writes.map((w) => w.toolCallId)).toEqual(["call-1"]);
    const prune = events.find((e) => e.type === "tool_results_pruned");
    const entries = prune?.data.entries as Array<{ toolCallId: string }>;
    expect(entries.map((e) => e.toolCallId)).toEqual(["call-1"]);
  });

});
