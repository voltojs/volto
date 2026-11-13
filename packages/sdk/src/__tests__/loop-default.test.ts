/**
 * The no-progress guard is ON by default.
 *
 * Rationale (2026-10-23): long-horizon tasks are bounded by resources and
 * progress, not by a step count. The loop ladder's repeat tier is advisory
 * (it never blocks a call), so enabling it by default cannot cut a legitimate
 * long task short; it only nudges a model that is spinning.
 *
 * These tests drive the real createAgent() facade and assert what reaches the
 * provider-bound requests.
 */

import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  renderLoopIntervention,
  renderLoopReminder,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type {
  Message,
  ModelEvent,
  ModelPort,
  ModelRequest,
  ToolDefinition,
  ToolResult,
} from "@voltojs/core";

const echoDef: ToolDefinition = {
  name: "echo",
  description: "Echo the message back",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  requires: ["test:echo"],
  riskTier: "READ_ONLY",
};

/** Always fails, so three identical rounds form an error chain. */
function failingEchoTool() {
  return {
    definition: echoDef,
    handler: async (_input: Record<string, unknown>): Promise<ToolResult> => ({
      modelContent: "boom",
      isError: true,
    }),
  };
}

function captureModelPort(scripts: ModelEvent[][]): {
  modelPort: ModelPort;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const inner = createMockModelPort(scripts);
  return {
    requests,
    modelPort: {
      async *stream(req) {
        requests.push(req);
        yield* inner.stream(req);
      },
    },
  };
}

/** Text of every user-role message, tolerating block-array content. */
function userTexts(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(""),
    )
    .join("\n");
}

const FAILING_ROUNDS = [
  toolCallScript("c1", "echo", JSON.stringify({ message: "x" })),
  toolCallScript("c2", "echo", JSON.stringify({ message: "x" })),
  toolCallScript("c3", "echo", JSON.stringify({ message: "x" })),
];

describe("loop ladder default", () => {
  it("reminds / intervenes at K=3 without an explicit maxLoopCount", async () => {
    const { modelPort, requests } = captureModelPort([
      ...FAILING_ROUNDS,
      textScript("changed approach"),
    ]);

    const agent = createAgent({
      modelPort,
      tools: [failingEchoTool()],
      capabilities: new Set(["test:echo"]),
    });
    const state = await agent.run("keep calling echo");

    expect(state.status).toBe("done");
    expect(requests).toHaveLength(4);

    // The K-1 reminder (error chain, K=3) fires before round 3 …
    expect(userTexts(requests[2]!.messages)).toContain(
      renderLoopReminder({ toolName: "echo", consecutiveCount: 2, kind: "error" }),
    );
    // … and the K=3 intervention reaches the request AFTER the third batch.
    expect(userTexts(requests[3]!.messages)).toContain(
      renderLoopIntervention({ toolName: "echo", consecutiveCount: 3 }),
    );
  });

  it("maxLoopCount: 0 disables the ladder entirely", async () => {
    const { modelPort, requests } = captureModelPort([
      ...FAILING_ROUNDS,
      textScript("finished"),
    ]);

    const agent = createAgent({
      modelPort,
      tools: [failingEchoTool()],
      capabilities: new Set(["test:echo"]),
      maxLoopCount: 0,
    });
    await agent.run("go");

    const all = requests.map((r) => userTexts(r.messages)).join("\n");
    expect(all).not.toContain("[LOOP REMINDER]");
    expect(all).not.toContain("[LOOP INTERVENTION]");
  });
});
