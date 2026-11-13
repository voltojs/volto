import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@voltojs/core";
import type { ToolDefinition, ToolResult, ModelPort, ModelRequest, SkillRegistry } from "@voltojs/core";

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
      m.content.some(
        (c) =>
          c.type === "tool_result" &&
          c.content.some((b) => b.type === "text" && b.text.includes("Sub-agent found")),
      ),
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

  it("returns a task id without the result text when dispatched in background", async () => {
    // Background dispatch is wired: the tool_result carries the task id and
    // collection instructions, never the (still running) result text.
    const mockModel = createMockModelPort([
      toolCallScript(
        "main-call-1",
        "task",
        JSON.stringify({ message: "Go", run_in_background: true }),
      ),
      // Detached sub-agent's own model call (races the parent's next call;
      // both scripts are plain text so either assignment completes).
      textScript("Sub-agent result text"),
      textScript("Understood, I will collect it later."),
      // Task 9: the turn-end drain feeds the uncollected completion, which
      // reopens the turn — the model gets one more call to fold it in.
      textScript("Folded the background result in."),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      enableTaskTool: true,
    });

    const state = await agent.run("Background task");

    expect(state.status).toBe("done");

    const toolResultMsg = state.messages.find((m) => m.role === "tool") as
      | { content: Array<{ content: string | Array<{ type: string; text?: string }>; isError?: boolean }> }
      | undefined;
    expect(toolResultMsg).toBeDefined();
    const first = toolResultMsg!.content[0]!;
    const firstText =
      typeof first.content === "string"
        ? first.content
        : first.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    expect(first.isError).toBeFalsy();
    expect(firstText).toContain("started in background");
    // No discarded result text leaked into the dispatch tool_result.
    expect(firstText).not.toContain("Sub-agent result text");
    // Task 9: the model never called task_output, so the turn-boundary
    // drain collected the task at end of turn — the record ends
    // "collected" and the result reached the model as a drain notice.
    expect(state.backgroundTasks?.[0]).toMatchObject({ status: "collected" });
    const drainNotice = state.messages.find(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("[background task") &&
        m.content.includes("Sub-agent result text"),
    );
    expect(drainNotice).toBeDefined();
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

// ──────────────────────────────────────────────
// Subagent skill-catalog context layer (plan-018 follow-up)
// ──────────────────────────────────────────────

describe("task sub-agent — skill catalog context layer", () => {
  const registry: SkillRegistry = {
    list: async () => [
      {
        name: "alpha",
        description: "Alpha does things",
        invocation: { modelInvocable: true, userInvocable: true },
      },
      {
        name: "hidden",
        description: "Not for the model",
        invocation: { modelInvocable: false, userInvocable: true },
      },
    ],
    load: async (name: string) =>
      name === "alpha" ? { body: "ALPHA-BODY", baseDir: "/skills/alpha" } : undefined,
  };

  function systemContentsOf(req: ModelRequest): string[] {
    return req.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content);
  }

  it("gives a dispatched subagent the skill-catalog layer when a registry is present", async () => {
    const capturedRequests: ModelRequest[] = [];
    const inner = createMockModelPort([
      // Main agent: dispatch a subagent via the task tool
      toolCallScript("main-call-1", "task", JSON.stringify({ message: "Do research" })),
      // Sub-agent: single text turn
      textScript("Sub-agent done"),
      // Main agent: final text after task tool returns
      textScript("Summary."),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        capturedRequests.push(req);
        yield* inner.stream(req);
      },
    };

    const agent = createAgent({
      modelPort,
      skillRegistry: registry,
      enableTaskTool: true,
    });

    await agent.run("Research this topic");

    // capturedRequests[0] is the main agent's turn (which also gets the
    // catalog — covered elsewhere); capturedRequests[1] is the subagent's
    // single model call.
    const subRequest = capturedRequests[1]!;
    const subSystemContents = systemContentsOf(subRequest);
    expect(
      subSystemContents.some((c) => c.startsWith("Available skills (load full instructions with the skill tool):")),
    ).toBe(true);
    expect(subSystemContents.some((c) => c.includes("- alpha: Alpha does things"))).toBe(true);
    // Non-model-invocable skills must not leak into the subagent's catalog either.
    expect(subSystemContents.some((c) => c.includes("hidden"))).toBe(false);
  });

  // plan-015's "sub-agents start from a clean context" was superseded for HOST
  // instruction layers by spec 2026-11-10 D6 (see sub-agent-instructions.test.ts).
  // What this guard still pins is the shape when the host resolves nothing at
  // all: no layers, so the child's request stays byte-identical to before.
  it("gives a dispatched subagent no contextLayers when the host resolves none (regression guard)", async () => {
    const capturedRequests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("main-call-1", "task", JSON.stringify({ message: "Do research" })),
      textScript("Sub-agent done"),
      textScript("Summary."),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        capturedRequests.push(req);
        yield* inner.stream(req);
      },
    };

    const agent = createAgent({
      modelPort,
      enableTaskTool: true,
      // No skillRegistry — must be byte-identical to today's behavior.
    });

    await agent.run("Research this topic");

    const subRequest = capturedRequests[1]!;
    // The only system message is the built-in sub-agent role prompt — no host
    // system prompt leaked in, and no catalog layer without a registry.
    const systemTexts = subRequest.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(systemTexts).toHaveLength(1);
    expect(systemTexts[0]).toContain("sub-agent");
    expect(systemTexts[0]).not.toContain("Research this topic");
  });

  it("gives a dispatched subagent no catalog layer when no skill is model-invocable", async () => {
    const capturedRequests: ModelRequest[] = [];
    const inner = createMockModelPort([
      toolCallScript("main-call-1", "task", JSON.stringify({ message: "Do research" })),
      textScript("Sub-agent done"),
      textScript("Summary."),
    ]);
    const modelPort: ModelPort = {
      async *stream(req) {
        capturedRequests.push(req);
        yield* inner.stream(req);
      },
    };

    const nonInvocableRegistry: SkillRegistry = {
      list: async () => [
        {
          name: "manual-only",
          description: "User-invoked only",
          invocation: { modelInvocable: false, userInvocable: true },
        },
      ],
      load: async () => undefined,
    };

    const agent = createAgent({
      modelPort,
      skillRegistry: nonInvocableRegistry,
      enableTaskTool: true,
    });

    await agent.run("Research this topic");

    const subRequest = capturedRequests[1]!;
    // The only system message is the built-in role prompt; a non-invocable
    // skill produces no catalog content in it.
    const systemTexts = subRequest.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(systemTexts).toHaveLength(1);
    expect(systemTexts[0]).toContain("sub-agent");
    expect(systemTexts[0]).not.toContain("manual-only");
  });
});
