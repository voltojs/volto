import { describe, it, expect } from "vitest";
import {
  runHookPipeline,
  type Hook,
  type HookOutcome,
  type HookContext,
} from "../hooks.js";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@volto/core";
import type { ToolDefinition, ToolResult } from "@volto/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

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

function makeHook(
  name: string,
  lifecycle: string,
  handler: (ctx: HookContext) => HookOutcome | Promise<HookOutcome>,
): Hook {
  return { name, lifecycle: lifecycle as Hook["lifecycle"], handler };
}

// ──────────────────────────────────────────────
// runHookPipeline tests
// ──────────────────────────────────────────────

describe("runHookPipeline", () => {
  it("returns continue when no hooks registered", async () => {
    const outcome = await runHookPipeline([], "preToolUse", {});
    expect(outcome).toEqual({ action: "continue" });
  });

  it("returns continue when all hooks continue", async () => {
    const hooks: Hook[] = [
      makeHook("a", "preToolUse", () => ({ action: "continue" })),
      makeHook("b", "preToolUse", () => ({ action: "continue" })),
    ];
    const outcome = await runHookPipeline(hooks, "preToolUse", {});
    expect(outcome).toEqual({ action: "continue" });
  });

  it("first deny short-circuits — subsequent hooks not called", async () => {
    let hookBCalled = false;
    const hooks: Hook[] = [
      makeHook("a", "preToolUse", () => ({ action: "deny", reason: "blocked" })),
      makeHook("b", "preToolUse", () => {
        hookBCalled = true;
        return { action: "continue" };
      }),
    ];
    const outcome = await runHookPipeline(hooks, "preToolUse", {});
    expect(outcome).toEqual({ action: "deny", reason: "blocked" });
    expect(hookBCalled).toBe(false);
  });

  it("modify merges patches — later hooks see modified input", async () => {
    const hooks: Hook[] = [
      makeHook("a", "preToolUse", () => ({
        action: "modify",
        patch: { input: { message: "modified-a" } },
      })),
      makeHook("b", "preToolUse", (ctx) => ({
        action: "modify",
        patch: { input: { message: `${ctx.toolCall?.input["message"]}-b` } },
      })),
    ];
    const outcome = await runHookPipeline(hooks, "preToolUse", {
      toolCall: { id: "1", name: "echo", input: { message: "original" } },
    });
    expect(outcome).toEqual({
      action: "modify",
      patch: { input: { message: "modified-a-b" } },
    });
  });

  it("only runs hooks matching the lifecycle", async () => {
    let preHookCalled = false;
    let postHookCalled = false;
    const hooks: Hook[] = [
      makeHook("pre", "preToolUse", () => { preHookCalled = true; return { action: "continue" }; }),
      makeHook("post", "postToolUse", () => { postHookCalled = true; return { action: "continue" }; }),
    ];
    await runHookPipeline(hooks, "preToolUse", {});
    expect(preHookCalled).toBe(true);
    expect(postHookCalled).toBe(false);
  });

  it("async hooks work correctly", async () => {
    const hooks: Hook[] = [
      makeHook("async", "preToolUse", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { action: "deny", reason: "async blocked" };
      }),
    ];
    const outcome = await runHookPipeline(hooks, "preToolUse", {});
    expect(outcome).toEqual({ action: "deny", reason: "async blocked" });
  });
});

// ──────────────────────────────────────────────
// Runner integration tests
// ──────────────────────────────────────────────

describe("Runner hooks integration (M13)", () => {
  it("preToolUse deny → tool not executed, model gets error, loop continues", async () => {
    let toolExecuted = false;
    const denyHook: Hook = {
      name: "deny-echo",
      lifecycle: "preToolUse",
      handler: (ctx) => {
        if (ctx.toolCall?.name === "echo") {
          return { action: "deny", reason: "hook blocked echo" };
        }
        return { action: "continue" };
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"should be blocked"}'),
      textScript("tool was denied"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      tools: [
        {
          definition: echoToolDef,
          handler: async (input) => {
            toolExecuted = true;
            return { modelContent: `echo: ${String(input["message"])}` };
          },
        },
      ],
      capabilities: new Set(["test:echo"]),
      hooks: [denyHook],
    });

    const state = await agent.run("echo hello");
    expect(state.status).toBe("done");
    expect(toolExecuted).toBe(false);
    expect(mockModel.callCount).toBe(2);
    // Tool result is isError — model sees denial and responds. Index 3, not
    // 2: createAgent always resolves a permissionConfig (defaulted when not
    // given), so the reducer injects a permission-boundary reminder message
    // ahead of the real user turn on index 0, shifting everything after it.
    // tool_result content is a block array since Task 1: [{ type:"text", text }].
    const toolResultMsg = state.messages[3] as unknown as {
      content: Array<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
    };
    expect(toolResultMsg.content[0]!.isError).toBe(true);
    const textBlock = toolResultMsg.content[0]!.content.find((b) => b.type === "text")!;
    expect(textBlock.text).toContain("hook blocked echo");
  });

  it("preToolUse modify → modified input passed to tool executor", async () => {
    const modifyHook: Hook = {
      name: "modify-echo",
      lifecycle: "preToolUse",
      handler: (ctx) => {
        if (ctx.toolCall?.name === "echo") {
          return {
            action: "modify",
            patch: { input: { message: "modified-input" } },
          };
        }
        return { action: "continue" };
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"original"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      tools: [
        {
          definition: echoToolDef,
          handler: async (input) => ({
            modelContent: `echo: ${String(input["message"])}`,
          }),
        },
      ],
      capabilities: new Set(["test:echo"]),
      hooks: [modifyHook],
    });

    const state = await agent.run("echo hello");
    expect(state.status).toBe("done");
    // Index 3: see the permission-boundary reminder note above.
    const toolResultMsg = state.messages[3] as unknown as {
      content: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const textBlock = toolResultMsg.content[0]!.content.find((b) => b.type === "text")!;
    expect(textBlock.text).toContain("modified-input");
  });

  it("postToolUse modify → redacted output fed to reducer", async () => {
    const redactHook: Hook = {
      name: "redact",
      lifecycle: "postToolUse",
      handler: (ctx) => {
        if (ctx.toolCall?.name === "echo" && ctx.toolResult) {
          return {
            action: "modify",
            patch: {
              result: { modelContent: "REDACTED" },
            },
          };
        }
        return { action: "continue" };
      },
    };

    const mockModel = createMockModelPort([
      toolCallScript("c1", "echo", '{"message":"secret"}'),
      textScript("done"),
    ]);

    const agent = createAgent({
      modelPort: mockModel,
      tools: [createEchoTool()],
      capabilities: new Set(["test:echo"]),
      hooks: [redactHook],
    });

    const state = await agent.run("echo secret");
    expect(state.status).toBe("done");
    // Index 3: see the permission-boundary reminder note above.
    const toolResultMsg = state.messages[3] as unknown as {
      content: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const textBlock = toolResultMsg.content[0]!.content.find((b) => b.type === "text")!;
    expect(textBlock.text).toBe("REDACTED");
  });

  it("session:start and session:end hooks are called", async () => {
    const called: string[] = [];
    const hooks: Hook[] = [
      makeHook("start", "session:start", () => { called.push("session:start"); return { action: "continue" }; }),
      makeHook("end", "session:end", () => { called.push("session:end"); return { action: "continue" }; }),
    ];

    const mockModel = createMockModelPort([textScript("hi")]);
    const agent = createAgent({
      modelPort: mockModel,
      hooks,
    });

    await agent.run("hello");
    expect(called).toContain("session:start");
    expect(called).toContain("session:end");
  });

  it("backward compat — no hooks, createAgent works as before", async () => {
    const mockModel = createMockModelPort([textScript("no hooks")]);
    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("hello");
    expect(state.status).toBe("done");
  });

  it("turn:start and turn:end hooks are called during a run", async () => {
    const called: string[] = [];
    const hooks: Hook[] = [
      makeHook("t-start", "turn:start", () => { called.push("turn:start"); return { action: "continue" }; }),
      makeHook("t-end", "turn:end", () => { called.push("turn:end"); return { action: "continue" }; }),
    ];

    const mockModel = createMockModelPort([textScript("hi")]);
    const agent = createAgent({ modelPort: mockModel, hooks });
    await agent.run("hello");
    expect(called).toContain("turn:start");
    expect(called).toContain("turn:end");
  });

  it("deterministic hooks produce replayable (state, effects) deep-equal", async () => {
    const callLog: string[] = [];
    const hooks: Hook[] = [
      makeHook("tracer", "preToolUse", (ctx) => {
        callLog.push(`pre:${ctx.toolCall?.name}`);
        return { action: "continue" };
      }),
      makeHook("tracer-post", "postToolUse", (ctx) => {
        callLog.push(`post:${ctx.toolCall?.name}`);
        return { action: "continue" };
      }),
    ];

    const mockScript = [
      toolCallScript("c1", "echo", '{"message":"test"}'),
      textScript("done"),
    ];

    // Run 1
    callLog.length = 0;
    const seqId = (): { next: () => string } => {
      let n = 0;
      return { next: () => `id-${++n}` };
    };
    const agent1 = createAgent({
      modelPort: createMockModelPort([...mockScript]),
      tools: [createEchoTool()],
      capabilities: new Set(["test:echo"]),
      hooks,
      id: seqId(),
    });
    const state1 = await agent1.run("echo test");
    const log1 = [...callLog];

    // Run 2 — same deterministic hooks, same mock model, same id sequence
    callLog.length = 0;
    const agent2 = createAgent({
      modelPort: createMockModelPort([...mockScript]),
      tools: [createEchoTool()],
      capabilities: new Set(["test:echo"]),
      hooks,
      id: seqId(),
    });
    const state2 = await agent2.run("echo test");
    const log2 = [...callLog];

    // Hook call sequence identical
    expect(log1).toEqual(log2);
    // Message structure identical (replayable)
    expect(state1.messages.length).toBe(state2.messages.length);
    for (let i = 0; i < state1.messages.length; i++) {
      expect(state1.messages[i]).toEqual(state2.messages[i]);
    }
  });
});
