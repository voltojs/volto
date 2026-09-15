import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import { createCharTokenizer, textScript } from "@volto/core";
import type { ModelPort, ModelRequest, ModelEvent, Message } from "@volto/core";

/**
 * Spy ModelPort that records every request and replays a script of event
 * sequences. Mirrors the fixture in runner-compaction.test.ts.
 */
function createSpyModelPort(script: ModelEvent[][]): ModelPort & {
  calls: Array<{ messages: Message[] }>;
} {
  const calls: Array<{ messages: Message[] }> = [];
  let index = 0;
  return {
    calls,
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      calls.push({ messages: req.messages });
      const events = script[index++];
      if (!events) throw new Error(`spy port: no script for call ${index - 1}`);
      for (const ev of events) yield ev;
    },
  };
}

/** Build `n` alternating user/assistant messages, each ~30 chars. */
function makeOldMessages(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      out.push({ id: `old-${i}`, role: "user", content: `old-user-${i}-${"a".repeat(20)}` });
    } else {
      out.push({
        id: `old-${i}`,
        role: "assistant",
        content: [{ type: "text", text: `old-asst-${i}-${"b".repeat(20)}` }],
      });
    }
  }
  return out;
}

describe("compactNow", () => {
  it("compactNow shortens state when over threshold", async () => {
    // The permission-boundary reminder the reducer injects on the first
    // turn is ~700 tokens with the char tokenizer, so the threshold must
    // sit above the pre-request total (system + 20 old + reminder + user
    // ≈ 1420) and below the post-turn total (+800-char assistant reply).
    // 1500 keeps auto-compaction quiet during the turn and leaves
    // compactNow real work: ~500 tokens of old history to compress.
    const oldMessages = makeOldMessages(20);
    const longResponse = "x".repeat(800);

    const spy = createSpyModelPort([
      // Call 1: main turn — long response that overflows the threshold.
      textScript(longResponse),
      // Call 2: summarization issued by compactNow.
      textScript("SUMMARY-OF-OLD"),
    ]);

    const agent = createAgent({
      modelPort: spy,
      systemPrompt: "sys",
      initialMessages: oldMessages,
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 1500,
        recentKeepCount: 2,
      },
    });

    await agent.run("hello");

    const beforeCount = agent.getState().messages.length;
    const result = await agent.compactNow();

    expect(result).not.toBeNull();
    expect(result!.replacedCount).toBeGreaterThan(0);
    expect(result!.tokensFreedEstimate).toBeGreaterThan(0);

    const afterState = agent.getState();
    expect(afterState.messages.length).toBeLessThan(beforeCount);
    // A summary message must now exist in the compacted state.
    const hasSummary = afterState.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("[Earlier conversation summary]"),
    );
    expect(hasSummary).toBe(true);
  });

  it("compactNow throws busy when mid-turn", async () => {
    // A model port that blocks until released, so the turn stays in
    // calling_model long enough to assert the busy path.
    let releaseModel!: () => void;
    const hang = new Promise<void>((r) => {
      releaseModel = r;
    });
    let modelCallStarted = false;

    const modelPort: ModelPort = {
      async *stream() {
        modelCallStarted = true;
        await hang;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const agent = createAgent({
      modelPort,
      compaction: {
        tokenizer: createCharTokenizer(1),
        maxTokens: 100,
      },
    });

    const runPromise = agent.run("hello");
    // Wait until the model call is actually in flight.
    while (!modelCallStarted) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await expect(agent.compactNow()).rejects.toThrow(/busy/);

    releaseModel();
    await runPromise;
  });

  it("compactNow returns null when under threshold", async () => {
    const spy = createSpyModelPort([textScript("hi")]);

    const agent = createAgent({
      modelPort: spy,
      systemPrompt: "sys",
      compaction: {
        tokenizer: createCharTokenizer(4),
        maxTokens: 1_000_000,
      },
    });

    await agent.run("hello");

    const result = await agent.compactNow();
    expect(result).toBeNull();
  });

  it("compactNow returns null when no compaction config is set", async () => {
    const spy = createSpyModelPort([textScript("hi")]);

    const agent = createAgent({ modelPort: spy });

    await agent.run("hello");

    const result = await agent.compactNow();
    expect(result).toBeNull();
  });
});
