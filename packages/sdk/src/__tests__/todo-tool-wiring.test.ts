import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import {
  createMockModelPort,
  textScript,
  toolCallScript,
} from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";

// ──────────────────────────────────────────────
// createAgent default wiring for todo_write
// ──────────────────────────────────────────────
//
// Harness mirrors create-agent.test.ts: wrap createMockModelPort in a
// capturing ModelPort so the test can assert on the exact tool list the
// ContextAssembler handed the model — that list is already
// capability-gated (filterVisibleTools), so seeing `todo_write` there
// proves both that the tool is registered AND that `plan:write` landed
// in availableCapabilities (the tool's `requires` is [CAP_PLAN_WRITE];
// without the capability the tool would be filtered out).

describe("createAgent todo_write wiring", () => {
  it("registers todo_write and plan:write by default (visible in model request even with empty host capabilities)", async () => {
    const capturedRequests: ModelRequest[] = [];
    const inner = createMockModelPort([textScript("ok")]);
    const modelPort: ModelPort = {
      async *stream(req) {
        capturedRequests.push(req);
        yield* inner.stream(req);
      },
    };

    // Empty host capabilities on purpose — if createAgent did not add
    // plan:write itself, capability gating would hide todo_write and this
    // assertion would fail.
    const agent = createAgent({
      modelPort,
      capabilities: new Set<string>(),
    });

    const state = await agent.run("hello");
    expect(state.status).toBe("done");

    expect(capturedRequests).toHaveLength(1);
    const names = capturedRequests[0]!.tools.map((t) => t.name);
    expect(names).toContain("todo_write");
  });

  it("routes a model todo_write call through the executor and returns a statePatch result", async () => {
    const mockModel = createMockModelPort([
      toolCallScript(
        "c1",
        "todo_write",
        JSON.stringify({
          todos: [
            { content: "write the brief", status: "completed" },
            { content: "register the tool", status: "in_progress" },
          ],
        }),
      ),
      textScript("todos recorded"),
    ]);

    const agent = createAgent({ modelPort: mockModel });
    const state = await agent.run("plan the work");

    expect(state.status).toBe("done");
    expect(mockModel.callCount).toBe(2);
    // permission reminder, user, assistant(tool_use), tool_result, assistant(text)
    expect(state.messages).toHaveLength(5);

    const toolResult = state.messages[3];
    expect(toolResult).toMatchObject({ role: "tool" });
    const text = JSON.stringify(toolResult);
    expect(text).toContain("Updated todo list");
    expect(text).toContain("0 pending, 1 in progress, 1 completed");
  });
});
