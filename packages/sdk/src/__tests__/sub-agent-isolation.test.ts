import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@agent-core/core";
import type { ToolDefinition, ToolResult } from "@agent-core/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const echoToolDef: ToolDefinition = {
  name: "echo",
  description: "Echo back the input message",
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

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("task sub-agent — context isolation", () => {
  it("should create an isolated sub-agent via the task tool", async () => {
    // The SDK's enableTaskTool=true auto-creates a task tool.
    // When the main agent calls "task", the sub-agent executor creates a fresh runner.
    // We use a combined mock that handles both main and sub model calls.

    const combinedMock = createMockModelPort([
      // Main agent: tool_use for task
      toolCallScript("main-call-1", "task", JSON.stringify({ message: "Do research" })),
      // Sub-agent: text response (the task tool creates a new runner that calls the model)
      textScript("Sub-agent found 3 articles about the topic"),
      // Main agent: final text after task tool returns
      textScript("Based on the sub-agent's research, here's the summary."),
    ]);

    const agent = createAgent({
      modelPort: combinedMock,
      tools: [createEchoTool()],
      capabilities: new Set(["test:echo"]),
      enableTaskTool: true,
    });

    const state = await agent.run("Research this topic");

    // The final assistant message should contain the summary
    const lastMsg = state.messages[state.messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");

    // Verify the task tool was used (we should see a tool_result from it)
    const toolResults = state.messages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // The tool result should contain the sub-agent's output
    const taskResult = toolResults.find((m) =>
      m.content.some((c) => c.type === "tool_result" && c.content.includes("Sub-agent found")),
    );
    expect(taskResult).toBeDefined();
  });

  it("should return error result when sub-agent model errors", async () => {
    const failingMock = createMockModelPort([
      toolCallScript("main-call-1", "task", JSON.stringify({ message: "Fail task" })),
      // Sub-agent: model error
      [{ type: "error" as const, error: "Sub-agent model error", retriable: false }],
      // Main agent: receives error as tool_result
      textScript("The sub-agent reported an error."),
    ]);

    const agent = createAgent({
      modelPort: failingMock,
      enableTaskTool: true,
    });

    const state = await agent.run("Do a failing task");

    // Should complete without throwing
    expect(state.status).toBe("done");
    // Should have a tool result with error
    const toolResults = state.messages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("should not have task tool in sub-agent's tool set (no recursion)", async () => {
    // If the sub-agent tries to call "task", it should get an error
    // because the task tool is filtered out of the sub-agent's tool set.
    const mockModel = createMockModelPort([
      // Main agent: call task
      toolCallScript("c1", "task", JSON.stringify({ message: "Try to recurse" })),
      // Sub-agent: tries to call task again → gets error → falls back to text
      toolCallScript("c2", "task", JSON.stringify({ message: "Nested task" })),
      // Sub-agent: text after error
      textScript("I don't have a task tool available."),
      // Main agent: final
      textScript("Done."),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      enableTaskTool: true,
    });

    const state = await agent.run("Try to recurse");

    // Should complete (the sub-agent's task call fails gracefully)
    expect(state.status).toBe("done");
  });
});
