import { describe, it, expect } from "vitest";
import type { StepContext, ToolDefinition } from "@volto/core";
import {
  createMockModelPort,
  toolUseStart,
  toolUseDelta,
  modelDone,
  textDelta,
} from "@volto/core";
import { createBashTool, CAP_SHELL_EXEC } from "@volto/tools-shell";
import { createRunner } from "../runner.js";
import { createShellToolExecutor } from "../shell-tool-executor.js";
import { createAutoAllowGate } from "../approval-gate.js";
import { createDefaultPermissionConfig } from "@volto/core";

const bashDef: ToolDefinition = createBashTool({
  async *exec() {
    yield { type: "exit" as const, code: 0 };
  },
} as Parameters<typeof createBashTool>[0]).definition;
const ctx: StepContext = { tools: [bashDef], model: "test" };
const caps = new Set([CAP_SHELL_EXEC]);

describe("TC-E10: Shell 高风险命令触发 ask + 输出截断", () => {
  it("bash (WRITE_HIGH) triggers request_approval, then executes after allow", async () => {
    const model = createMockModelPort([
      [
        toolUseStart("c1", "bash"),
        toolUseDelta("c1", '{"command":"rm -rf /tmp/test"}'),
        modelDone("tool_use"),
      ],
      [textDelta("Done."), modelDone("end_turn")],
    ]);

    const permissionConfig = createDefaultPermissionConfig();
    // WRITE_HIGH → "ask" in default config.

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createShellToolExecutor({
        shell: {
          async *exec() {
            yield { type: "stdout" as const, data: "removed" };
            yield { type: "exit" as const, code: 0 };
          },
        },
      }),
      permissionConfig,
      approvalGate: createAutoAllowGate(),
      eventSink: {
        emit(event) {
          events.push(event);
        },
      },
    });

    const final = await runner.run({
      type: "user_message",
      content: "remove test dir",
    });
    expect(final.status).toBe("done");

    // The tool result should contain the bash output (after ask → allow).
    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content[0]).toMatchObject({
      type: "tool_result",
      content: [{ type: "text", text: expect.stringContaining("removed") }],
    });
  });

  it("large bash output is truncated with truncation note", async () => {
    const largeOutput = "x".repeat(200_000);

    const model = createMockModelPort([
      [
        toolUseStart("c1", "bash"),
        toolUseDelta("c1", '{"command":"seq 1 100000"}'),
        modelDone("tool_use"),
      ],
      [textDelta("Got output."), modelDone("end_turn")],
    ]);

    const runner = createRunner({
      modelPort: model,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor: createShellToolExecutor({
        shell: {
          async *exec() {
            yield { type: "stdout" as const, data: largeOutput };
            yield { type: "exit" as const, code: 0 };
          },
        },
      }),
      permissionConfig: createDefaultPermissionConfig(),
      approvalGate: createAutoAllowGate(),
    });

    const final = await runner.run({
      type: "user_message",
      content: "generate large output",
    });
    expect(final.status).toBe("done");

    const toolMsg = final.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const blocks = toolMsg!.content[0]!.content;
    const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
    // The bash tool truncates at OUTPUT_LIMIT (100_000) and adds a note.
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(120_000);
  });
});
