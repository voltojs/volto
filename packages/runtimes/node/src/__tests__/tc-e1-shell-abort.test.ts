import { describe, it, expect } from "vitest";
import type { StepContext, ToolDefinition } from "@voltojs/core";
import {
  createMockModelPort,
  toolUseStart,
  toolUseDelta,
  modelDone,
  textDelta,
} from "@voltojs/core";
import { createBashTool, CAP_SHELL_EXEC } from "@voltojs/tools-shell";
import { createRunner } from "../runner.js";
import { createShellToolExecutor } from "../shell-tool-executor.js";
import { createNodeShell } from "../shell.js";

const bashDef: ToolDefinition = createBashTool({
  async *exec() {
    yield { type: "exit" as const, code: 0 };
  },
} as Parameters<typeof createBashTool>[0]).definition;
const ctx: StepContext = { tools: [bashDef], model: "test" };
const caps = new Set([CAP_SHELL_EXEC]);

describe("TC-E1: Shell 取消全链路（AbortSignal 端到端）", () => {
  it("AbortSignal propagates from Runner → shell-tool-executor → bash → shell.exec → child.kill", async () => {
    const ac = new AbortController();
    const shell = createNodeShell();

    const model = createMockModelPort([
      [
        toolUseStart("c1", "bash"),
        toolUseDelta("c1", '{"command":"sleep 30"}'),
        modelDone("tool_use"),
      ],
      // If abort fires before the second model call, MockModelPort yields error.
      [textDelta("Cancelled."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createShellToolExecutor({ shell }),
      abortSignal: ac.signal,
    });

    // Abort after 50ms — "sleep 30" must be killed well before 30 s.
    setTimeout(() => ac.abort(), 50);

    const start = Date.now();
    const finalState = await runner.run({
      type: "user_message",
      content: "run long command",
    });
    const elapsed = Date.now() - start;

    expect(finalState.status).toBe("done");
    // Must complete in < 5 s, not the full 30 s of "sleep 30".
    expect(elapsed).toBeLessThan(5000);
  });
});
