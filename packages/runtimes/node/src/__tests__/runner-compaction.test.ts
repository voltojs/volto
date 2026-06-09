import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import {
  textScript,
  createCharTokenizer,
} from "@agent-core/core";
import type {
  Message,
  ModelPort,
  ModelRequest,
  ModelEvent,
  StepContext,
  ReducerState,
  CompactionConfig,
} from "@agent-core/core";

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
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0
        ? `${prefix}-user-${i}`
        : [{ type: "text", text: `${prefix}-asst-${i}` }],
    } as Message);
  }
  return out;
}

describe("Runner — compaction wiring", () => {
  it("issues a summarization call before the main call, then sends [system, summary, ...recent] to the main call", async () => {
    // Build a long history that will exceed the 200-token threshold once a
    // system message and a long user turn are added.
    const history = makeMessages(20, "old"); // 20 alternating messages
    const systemMsg: Message = { role: "system", content: "you are helpful" };
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
      _accumulatedToolCalls: [],
      _toolResultBuffer: {},
      queuedUserInputs: [],
      toolCallCount: 0,
      maxToolCalls: undefined,
      maxCostDollars: undefined,
      maxWallclockMs: undefined,
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
    // Summary sits immediately after system, BEFORE any user/assistant messages.
    expect(main[1]!.role).toBe("system");
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
});
