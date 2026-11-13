import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@voltojs/core";
import type {
  StepContext,
  ToolDefinition,
  PendingToolCall,
  ToolResult,
  TodoItem,
} from "@voltojs/core";

// ──────────────────────────────────────────────
// Fixtures — mirror runner.test.ts harness
// ──────────────────────────────────────────────

const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  description: "Record and update the structured task list",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  requires: ["plan:write"],
  riskTier: "WRITE_LOW",
};

const ctx: StepContext = { tools: [todoWriteTool], model: "test-model" };
const capabilities = new Set(["plan:write"]);

function createMockToolExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return async (call: PendingToolCall): Promise<ToolResult> => {
    const result = results[call.name];
    if (!result) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }
    return result;
  };
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Runner ToolResult.statePatch", () => {
  it("feeds a tool's statePatch.todos through to the reducer (state.todos)", async () => {
    const todos: TodoItem[] = [
      { content: "wire reducer statePatch", status: "completed" },
      { content: "verify runner pass-through", status: "in_progress" },
      { content: "land regression test", status: "pending" },
    ];

    // tool_use args mirror the executor fixture list (the mock ignores
    // args, but a mismatch would hide a broken call-payload path).
    const mockModel = createMockModelPort([
      toolCallScript("call_1", "todo_write", JSON.stringify({ todos })),
      textScript("List recorded."),
    ]);

    // Real tool_result construction: the executor returns the full ToolResult
    // (modelContent + statePatch). Nothing downstream may strip statePatch.
    const toolExecutor = createMockToolExecutor({
      todo_write: {
        modelContent: "Updated todo list: 1 pending, 1 in progress, 1 completed.",
        statePatch: { todos },
      },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
    });

    const finalState = await runner.run({ type: "user_message", content: "Track this work" });

    // Guard the harness: the full tool loop must have run, so a silent
    // no-op (empty todos by accident) cannot pass this test.
    expect(finalState.status).toBe("done");
    expect(finalState.messages).toHaveLength(4); // user, assistant(tool_use), tool_result, assistant(text)
    const toolMsg = finalState.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    // Successful results may omit isError (undefined), never set it true.
    expect(toolMsg!.content[0]).toMatchObject({ type: "tool_result" });
    expect(toolMsg!.content[0]?.isError).toBeFalsy();

    // The point of the test: statePatch must reach the reducer.
    expect(finalState.todos).toEqual(todos);
  });

  it("does not apply statePatch when the tool result is an error", async () => {
    const mockModel = createMockModelPort([
      toolCallScript("call_1", "todo_write", '{"todos":[]}'),
      textScript("Okay."),
    ]);

    const toolExecutor = createMockToolExecutor({
      todo_write: {
        modelContent: "Error: invalid todos",
        isError: true,
        // Even if a buggy executor attaches a patch on the error path,
        // the reducer must ignore it — assert the runner does not launder
        // it into an applied patch either.
        statePatch: {
          todos: [{ content: "should never land", status: "pending" }],
        },
      },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
    });

    const finalState = await runner.run({ type: "user_message", content: "Track this work" });

    // Guard the harness: the error tool_result must actually have been
    // fed back — a skipped tool loop would also leave todos undefined.
    expect(finalState.status).toBe("done");
    expect(finalState.messages).toHaveLength(4); // user, assistant(tool_use), tool_result, assistant(text)
    const toolMsg = finalState.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({ type: "tool_result" });
    expect(toolMsg!.content[0]?.isError).toBeTruthy();

    expect(finalState.todos).toBeUndefined();
  });
});
