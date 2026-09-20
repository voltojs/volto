import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { AuditEntry, ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  textDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  extractBlockText,
} from "@volto/core";
import type { PermissionConfig, PendingToolCall, StepContext, ToolDefinition, ToolResult, ToolResultMessage } from "@volto/core";

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run a shell command",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  requires: ["shell:exec"],
  riskTier: "WRITE_HIGH",
  commandInputs: ["command"],
};

/** A write tool that declares NO command input. */
const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:write"],
  riskTier: "WRITE_HIGH",
};

const allowTest: PermissionConfig = {
  sandbox: "workspace-write",
  approval: "ask",
  rules: [{ toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" }],
};

async function runTool(
  tool: ToolDefinition,
  capabilities: string[],
  permissionConfig: PermissionConfig,
  input: Record<string, unknown>,
): Promise<{ executed: PendingToolCall[]; askCount: number; audit: AuditEntry[] }> {
  const executed: PendingToolCall[] = [];
  const audit: AuditEntry[] = [];
  let askCount = 0;

  const executor: ToolExecutor = async (call): Promise<ToolResult> => {
    executed.push(call);
    return { modelContent: `OK: ${call.name}` };
  };
  const gate = {
    async ask() {
      askCount++;
      return "allow" as const;
    },
  };

  const stepContext: StepContext = { tools: [tool], model: "test-model" };
  const model = createMockModelPort([
    [toolUseStart("call-1", tool.name), toolUseDelta("call-1", JSON.stringify(input)), usage(10, 5), modelDone("tool_use")],
    [textDelta("done"), modelDone("end_turn")],
  ]);

  const runner = createRunner({
    modelPort: model,
    stepContext,
    availableCapabilities: new Set(capabilities),
    permissionConfig,
    approvalGate: gate,
    toolExecutor: executor,
    auditSink: { record: (entry) => void audit.push(entry) },
  });

  const state = await runner.run({ type: "user_message", content: "go" });
  const toolResultMsg = state.messages.find((m) => m.role === "tool") as ToolResultMessage | undefined;
  expect(toolResultMsg).toBeDefined();
  expect(extractBlockText(toolResultMsg!.content.find((c) => c.type === "tool_result")!)).toContain(
    `OK: ${tool.name}`,
  );
  return { executed, askCount, audit };
}

const runBash = (config: PermissionConfig, command: string) =>
  runTool(bashTool, ["shell:exec"], config, { command });

describe("Runner — command prefix rules", () => {
  it("runs a matching command without consulting the approval gate", async () => {
    const { executed, askCount } = await runBash(allowTest, "pnpm test");
    expect(executed.map((call) => call.name)).toEqual(["bash"]);
    expect(askCount).toBe(0);
  });

  it("still asks for a compound command", async () => {
    const { executed, askCount } = await runBash(allowTest, "pnpm test; rm -rf /tmp/x");
    expect(askCount).toBe(1);
    expect(executed.map((call) => call.name)).toEqual(["bash"]);
  });

  it("records which rule auto-allowed the command", async () => {
    const { audit } = await runBash(allowTest, "pnpm test");
    const entry = audit.find((e) => e.kind === "rule_allow");
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe("bash");
    expect(entry!.ruleSummary).toBe("commandPrefix:pnpm test");
    expect(entry!.commandText).toBe("pnpm test");
  });

  it("writes no rule_allow audit entry when the matrix asked instead", async () => {
    const { audit } = await runBash(allowTest, "pnpm test; rm -rf /tmp/x");
    expect(audit.some((e) => e.kind === "rule_allow")).toBe(false);
  });

  it("never applies a command rule to a tool that declares no command input", async () => {
    const ruleForAnyTool: PermissionConfig = {
      sandbox: "workspace-write",
      approval: "ask",
      rules: [{ toolPattern: "*", commandPrefix: ["pnpm", "test"], decision: "allow" }],
    };
    const { askCount } = await runTool(writeTool, ["filesystem:write"], ruleForAnyTool, { path: "a.txt" });
    expect(askCount).toBe(1);
  });
});
