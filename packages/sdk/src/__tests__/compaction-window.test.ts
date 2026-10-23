/**
 * Window-aware compaction (P0) + summarizer usage accounting (P1).
 *
 * The old host default compacted every model at a fixed 60k tokens — on a
 * 1M-token model that fires at ~6% occupancy, rewrites history and destroys
 * the provider prefix cache for no reason. createAgent now derives the
 * threshold from the model window (0.6 × (window − max output)) unless the
 * caller pins `compaction.maxTokens`.
 *
 * These tests drive the real createAgent loop with a stateful ModelPort:
 * pre-compaction calls keep requesting the same tool; the summarization call
 * is recognized by its synthetic prompt id; the post-compaction call sees the
 * summary and ends the turn.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type {
  ModelPort,
  ModelRequest,
  ToolDefinition,
  TranscriptEventInput,
} from "@volto/core";
import type { Tool } from "@volto/tools-common";

const ECHO_DEF: ToolDefinition = {
  name: "echo",
  description: "Return a fixed-size payload",
  inputSchema: { type: "object", properties: {} },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

function echoTool(chars: number): Tool {
  return {
    definition: ECHO_DEF,
    handler: async () => ({ modelContent: "x".repeat(chars) }),
  };
}

function captureStore(): {
  events: TranscriptEventInput[];
  store: { appendEvents(_id: string, batch: TranscriptEventInput[]): Promise<void> };
} {
  const events: TranscriptEventInput[] = [];
  return {
    events,
    store: {
      async appendEvents(_id: string, batch: TranscriptEventInput[]) {
        events.push(...batch);
      },
    },
  };
}

const SUMMARY_PREFIX = "[Earlier conversation summary]";

function makePort(contextWindow: number, maxToolRounds: number): {
  port: ModelPort;
  requests: ModelRequest[];
} {
  let rounds = 0;
  const requests: ModelRequest[] = [];
  const port: ModelPort = {
    async *stream(req) {
      requests.push(req);

      // Summarization call: one synthetic user message, no tools.
      if (req.messages.length === 1 && req.messages[0]?.id === "compaction-summary-prompt") {
        yield { type: "usage", inputTokens: 100, outputTokens: 20 };
        yield { type: "text_delta", text: "SUMMARY" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }

      // The post-compaction request carries the summary → finish the turn.
      if (
        req.messages.some(
          (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX),
        )
      ) {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }

      // Keep making progress so the conversation crosses the threshold — but
      // stop eventually so a broken threshold derivation fails instead of
      // looping forever.
      rounds += 1;
      if (rounds > maxToolRounds) {
        yield { type: "text_delta", text: "stop" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      yield { type: "usage", inputTokens: 100, outputTokens: 10 };
      yield { type: "tool_use_start", toolCallId: `c${rounds}`, toolName: "echo" };
      yield { type: "tool_use_delta", toolCallId: `c${rounds}`, argumentsDelta: "{}" };
      yield { type: "done", stopReason: "tool_use" };
    },
    async describeModel() {
      return { model: "test-model", contextWindow };
    },
  };
  return { port, requests };
}

describe("window-aware compaction", () => {
  it("compacts on a small window and records the summarizer usage", async () => {
    // 10k window → 0.6 × 10k = 6k threshold; ~2k-char tool results cross it.
    const { port, requests } = makePort(10_000, 40);
    const transcript = captureStore();

    const agent = createAgent({
      modelPort: port,
      tools: [echoTool(2_000)],
      capabilities: new Set(["test:echo"]),
      contextWindow: 10_000,
      compaction: { recentKeepCount: 1, windowRatio: 0.6, headroomTokens: 1_000 },
      chatStore: transcript.store,
      chatSessionId: "window-compaction",
    });
    const state = await agent.run("go");

    expect(state.status).toBe("done");
    const compaction = transcript.events.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect((compaction!.data as { replacedCount: number }).replacedCount).toBeGreaterThan(0);
    // P1: the summarizer's usage is no longer invisible.
    expect((compaction!.data as { usage?: unknown }).usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
    // The post-compaction main call really carried the summary.
    expect(
      requests.some((req) =>
        req.messages.some(
          (m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_PREFIX),
        ),
      ),
    ).toBe(true);
  });

  it("does not compact a long turn that fits comfortably in a large window", async () => {
    // 100k window → 60k threshold; 20 rounds × ~2k-char results stay far below.
    const { port } = makePort(100_000, 20);
    const transcript = captureStore();

    const agent = createAgent({
      modelPort: port,
      tools: [echoTool(2_000)],
      capabilities: new Set(["test:echo"]),
      contextWindow: 100_000,
      compaction: { recentKeepCount: 1 },
      chatStore: transcript.store,
      chatSessionId: "window-no-compaction",
    });
    const state = await agent.run("go");

    expect(state.status).toBe("done");
    expect(transcript.events.some((e) => e.type === "compaction")).toBe(false);
  });
});
