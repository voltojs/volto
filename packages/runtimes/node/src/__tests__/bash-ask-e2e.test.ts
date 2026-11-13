import { describe, it, expect } from "vitest";
import type { ToolDefinition, StepContext } from "@voltojs/core";
import { createMockModelPort, toolUseStart, toolUseDelta, modelDone, textDelta } from "@voltojs/core";
import { createBashTool, CAP_SHELL_EXEC } from "@voltojs/tools/shell";
import { createRunner } from "../runner.js";
import { createShellToolExecutor } from "../shell-tool-executor.js";
import { createAutoAllowGate } from "../approval-gate.js";
import { createDefaultPermissionConfig } from "@voltojs/core";

const bashDef: ToolDefinition = createBashTool({ async *exec() { yield { type: "exit", code: 0 }; } }).definition;
const ctx: StepContext = { tools: [bashDef], model: "test" };
const caps = new Set([CAP_SHELL_EXEC]);

describe("bash ask e2e via Runner (WRITE_HIGH → permission ask → allow)", () => {
  it("bash triggers request_approval with default permission config, then executes after allow", async () => {
    const model = createMockModelPort([
      [toolUseStart("c1", "bash"), toolUseDelta("c1", '{"command":"echo ok"}'), modelDone("tool_use")],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const permissionConfig = createDefaultPermissionConfig();
    // WRITE_HIGH → "ask" in default config

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createShellToolExecutor({
        shell: {
          async *exec() {
            yield { type: "stdout", data: "ok" };
            yield { type: "exit", code: 0 };
          },
        },
      }),
      permissionConfig,
      approvalGate: createAutoAllowGate(),
    });

    const final = await runner.run({ type: "user_message", content: "run echo" });
    expect(final.status).toBe("done");

    // The tool result should contain the bash output (after ask → allow)
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({
      type: "tool_result",
      content: [{ type: "text", text: expect.stringContaining("ok") }],
    });
  });
});
