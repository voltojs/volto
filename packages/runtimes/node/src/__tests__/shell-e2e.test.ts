import { describe, it, expect } from "vitest";
import type { StepContext, ToolDefinition } from "@voltojs/core";
import { createMockModelPort, toolUseStart, toolUseDelta, modelDone, textDelta } from "@voltojs/core";
import { createBashTool, CAP_SHELL_EXEC } from "@voltojs/tools-shell";
import { createRunner } from "../runner.js";
import { createShellToolExecutor } from "../shell-tool-executor.js";

const shellToolDefs: ToolDefinition[] = [
  createBashTool({ async *exec() { yield { type: "stdout", data: "hello from bash" }; yield { type: "exit", code: 0 }; } }).definition,
];
const ctx: StepContext = { tools: shellToolDefs, model: "test" };
const caps = new Set([CAP_SHELL_EXEC]);

describe("shell end-to-end via Runner (executor + reducer loop)", () => {
  it("bash tool dispatches through executor and result feeds back to model", async () => {
    const model = createMockModelPort([
      [toolUseStart("c1", "bash"), toolUseDelta("c1", '{"command":"echo hello"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createShellToolExecutor({ shell: { async *exec() { yield { type: "stdout", data: "hello from bash" }; yield { type: "exit", code: 0 }; } } }),
    });

    const final = await runner.run({ type: "user_message", content: "run echo" });
    expect(final.status).toBe("done");
    // The tool result should be in the messages
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "c1",
      content: [{ type: "text", text: expect.stringContaining("hello from bash") }],
    });
  });

  it("bash tool denied when shell:exec capability is absent (capability gating via Runner)", async () => {
    const model = createMockModelPort([
      [toolUseStart("c1", "bash"), toolUseDelta("c1", '{"command":"echo hello"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: new Set(["filesystem:read"]), // no shell:exec
      toolExecutor: createShellToolExecutor({ shell: { async *exec() {} } }),
    });

    const final = await runner.run({ type: "user_message", content: "run echo" });
    expect(final.status).toBe("done");
    // Tool result should be an error (routed via capability check)
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({ isError: true });
  });
});
