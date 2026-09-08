/**
 * End-to-end regression guard: real createAgent() + real createStore()
 * (@volto/store-jsonl) through a turn that both calls a tool and has
 * context layers configured, reading the actual JSONL file back off disk.
 *
 * Every other test for this feature stubs out one half of the pipeline
 * (a fake chatStore, a fake agentFactory, or no tool calls at all) — this
 * test exercises the real Runner -> chatStore -> JSONL file path so a gap
 * like "sub-agent trajectory capture was never wired" (see the design spec's
 * "已知缺口" note) would be caught by a top-level-agent regression here too,
 * had it affected the top-level path instead.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createAgent } from "@volto/sdk";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
  textDelta,
  reasoningDelta,
  projectMessages,
} from "@volto/core";
import type { ToolDefinition, ToolResult } from "@volto/core";
import { createStore, scopeToWorkspace } from "@volto/store-jsonl";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trajectory-e2e-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/**
 * Trajectory writes fire without awaiting them ("best-effort, never throws
 * into the main loop") — so agent.run() resolving does not guarantee every
 * event has landed on disk yet. Poll the raw file until all expected event
 * types show up (or time out), rather than asserting immediately after
 * run() returns.
 */
async function readTrajectoryEventTypesEventually(
  filePath: string,
  expected: string[],
  timeoutMs = 2000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string[] = [];
  for (;;) {
    const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
    const lines = raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { version: number; event: { type: string } });
    lastSeen = lines
      .filter((line) => line.version === 2)
      .map((line) => line.event.type);
    if (expected.every((type) => lastSeen.includes(type))) return lastSeen;
    if (Date.now() > deadline) return lastSeen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const echoToolDef: ToolDefinition = {
  name: "echo",
  description: "Echo back the input",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

function createEchoTool() {
  return {
    definition: echoToolDef,
    handler: async (input: Record<string, unknown>): Promise<ToolResult> => ({
      modelContent: `echo: ${String(input["message"])}`,
    }),
  };
}

describe("trajectory capture — real chatStore end to end", () => {
  it("writes model_call_start/assistant_message/tool_call/tool_result/turn_end event lines to the real JSONL file", async () => {
    const store = createStore({ directory: tempDir });
    const chatStore = scopeToWorkspace(store, null);

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"hi"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      tools: [createEchoTool()],
      capabilities: new Set(["test:echo"]),
      chatStore,
      chatSessionId: "e2e-s1",
      resolveContextLayers: async () => [{ id: "test-layer", text: "Be terse" }],
    });

    const finalState = await agent.run("hi");
    expect(finalState.status).toBe("done");

    // Message-level view via the store's own reader + core's projection.
    const record = await store.readSession("e2e-s1");
    expect(record).toBeDefined();
    expect(projectMessages(record!.events).length).toBeGreaterThan(0);

    // Raw JSONL file: workspacePath is null, so the file lives at the top
    // level of `directory` (mirrors packages/stores/jsonl/src/__tests__/store.test.ts).
    const filePath = path.join(tempDir, "e2e-s1.jsonl");
    const expectedTypes = ["model_call_start", "assistant_message", "tool_call", "tool_result", "turn_end"];
    const trajectoryEventTypes = await readTrajectoryEventTypesEventually(filePath, expectedTypes);

    expect(trajectoryEventTypes).toContain("model_call_start");
    expect(trajectoryEventTypes).toContain("assistant_message");
    expect(trajectoryEventTypes).toContain("tool_call");
    expect(trajectoryEventTypes).toContain("tool_result");
    expect(trajectoryEventTypes).toContain("turn_end");
  });

  it("persists reasoning, timing and full token usage on the assistant_message line", async () => {
    const store = createStore({ directory: tempDir });
    const chatStore = scopeToWorkspace(store, null);

    // A single model call that streams reasoning deltas, text, and a usage
    // event carrying every optional TokenUsage field — the mock model is the
    // only place this data can originate, and `textScript`/`toolCallScript`
    // don't exercise reasoning or the cache/reasoning token counters, so this
    // scripts the call directly.
    const mockModel = createMockModelPort([
      [
        reasoningDelta("let me "),
        reasoningDelta("think"),
        textDelta("done"),
        { type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3 },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      chatStore,
      chatSessionId: "e2e-s2",
      resolveContextLayers: async () => [{ id: "test-layer", text: "Be terse" }],
    });

    const finalState = await agent.run("hi");
    expect(finalState.status).toBe("done");

    const filePath = path.join(tempDir, "e2e-s2.jsonl");
    await readTrajectoryEventTypesEventually(filePath, ["assistant_message"]);

    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { version: number; event: { type: string; data: unknown } });

    const assistant = lines
      .filter((line) => line.version === 2)
      .map((line) => line.event)
      .find((e) => e.type === "assistant_message");

    expect(assistant).toBeDefined();
    const data = assistant!.data as {
      durationMs: number;
      content: Array<{ type: string; text?: string }>;
      usage?: Record<string, number>;
    };
    expect(typeof data.durationMs).toBe("number");

    // Reasoning is now a content block (first, before text/tool_use blocks)
    const reasoningBlock = data.content.find((block) => block.type === "reasoning");
    expect(reasoningBlock).toBeDefined();
    expect(reasoningBlock?.text).toBe("let me think");

    expect(data.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
  });
});
