/**
 * Long-horizon regression: the agent has NO default step cap.
 *
 * Step count is a property of the task, not a budget. A 30-round tool turn
 * must run to completion under the defaults — the loop ends when the model
 * stops calling tools, the user cancels, or a resource budget fires. Only an
 * explicit `maxIterations` may bound it (see runner-terminal-errors.test.ts
 * for the visible-error contract when that opt-in cap is hit).
 */

import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import {
  createInitialState,
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@voltojs/core";
import type {
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
        data: { turn: number; reason: string; error?: string };
      })
    | undefined;
}

describe("long-turn default", () => {
  it("a 30-round turn completes with no step cap", async () => {
    const scripts = Array.from({ length: 30 }, (_, i) =>
      toolCallScript(`call_${i}`, "read_file", JSON.stringify({ path: `f${i}.ts` })),
    );
    scripts.push(textScript("finished after 30 rounds"));
    const mockModel = createMockModelPort(scripts);
    const { recorded, chatStore } = createRecorderStore();
    let executions = 0;

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor: async () => {
        executions++;
        return { modelContent: "contents" };
      },
      availableCapabilities: capabilities,
      initialState: createInitialState(),
      chatStore,
      chatSessionId: "s1",
    });

    const state = await runner.run({ type: "user_message", content: "long task" });

    expect(executions).toBe(30);
    expect(mockModel.callCount).toBe(31);
    expect(state.iterationCount).toBe(31);
    expect(state.status).toBe("done");
    const turnEnd = findTurnEnd(recorded);
    expect(turnEnd!.data).toEqual({ turn: 0, reason: "done" });
    expect(recorded.some((e) => e.type === "error")).toBe(false);
  });
});
