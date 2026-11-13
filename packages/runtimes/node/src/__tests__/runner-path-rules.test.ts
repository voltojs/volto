import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  textDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  extractBlockText,
} from "@voltojs/core";
import type {
  StepContext,
  ToolDefinition,
  PendingToolCall,
  ToolResult,
  ToolResultMessage,
  PermissionConfig,
} from "@voltojs/core";

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "Write a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:write"],
  riskTier: "WRITE_HIGH",
  pathInputs: ["path"],
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  requires: ["shell:exec"],
  riskTier: "WRITE_HIGH",
};

const ctx: StepContext = { tools: [writeTool, bashTool], model: "test-model" };
const capabilities = new Set(["filesystem:write", "shell:exec"]);
const autoAllowGate = { async ask() { return "allow" as const; } };

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "volto-runner-path-"));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

/** Run one tool call through the Runner and hand back what the executor saw. */
async function runOneCall(
  permissionConfig: PermissionConfig,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ executed: PendingToolCall[]; isError: boolean; text: string }> {
  const executed: PendingToolCall[] = [];
  const executor: ToolExecutor = async (call): Promise<ToolResult> => {
    executed.push(call);
    return { modelContent: `OK: ${call.name}` };
  };

  const model = createMockModelPort([
    [toolUseStart("call-1", toolName), toolUseDelta("call-1", JSON.stringify(input)), usage(10, 5), modelDone("tool_use")],
    [textDelta("done"), modelDone("end_turn")],
  ]);

  const runner = createRunner({
    modelPort: model,
    stepContext: ctx,
    availableCapabilities: capabilities,
    permissionConfig,
    approvalGate: autoAllowGate,
    toolExecutor: executor,
    pathRoot: root,
  });

  const state = await runner.run({ type: "user_message", content: "go" });
  const toolResultMsg = state.messages.find((m) => m.role === "tool") as ToolResultMessage | undefined;
  const block = toolResultMsg?.content.find((c) => c.type === "tool_result");
  return {
    executed,
    isError: block?.isError === true,
    text: block === undefined ? "" : extractBlockText(block),
  };
}

describe("Runner — path rules", () => {
  it("denies a write whose resolved path matches a deny rule", async () => {
    const { executed, isError, text } = await runOneCall(
      { sandbox: "workspace-write", approval: "ask", rules: [{ pathPattern: "**/.env", decision: "deny" }] },
      "write_file",
      { path: "src/.env" },
    );
    expect(executed).toHaveLength(0);
    expect(isError).toBe(true);
    expect(text).toContain("write_file");
  });

  it("still executes a write whose path does not match", async () => {
    const { executed } = await runOneCall(
      { sandbox: "workspace-write", approval: "ask", rules: [{ pathPattern: "**/.env", decision: "deny" }] },
      "write_file",
      { path: "src/ok.txt" },
    );
    expect(executed.map((call) => call.name)).toEqual(["write_file"]);
  });

  it("follows a symlink when matching, so link/secret.txt cannot dodge a deny rule", async () => {
    await fs.symlink(outside, path.join(root, "link"));
    const { executed } = await runOneCall(
      {
        sandbox: "workspace-write",
        approval: "ask",
        rules: [{ pathPattern: "**/outside/**", decision: "deny" }],
      },
      "write_file",
      { path: "link/secret.txt" },
    );
    expect(executed).toHaveLength(0);
  });

  it("resolves a symlink inside the workspace so src/** matches through it", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.symlink(path.join(root, "src"), path.join(root, "alias"));
    const { executed } = await runOneCall(
      { sandbox: "workspace-write", approval: "ask", rules: [{ pathPattern: "src/**", decision: "deny" }] },
      "write_file",
      { path: "alias/x.txt" },
    );
    expect(executed).toHaveLength(0);
  });

  it("leaves a tool that declares no path inputs untouched", async () => {
    const { executed } = await runOneCall(
      { sandbox: "workspace-write", approval: "ask", rules: [{ pathPattern: "**", decision: "deny" }] },
      "bash",
      { command: "rm -rf src" },
    );
    expect(executed.map((call) => call.name)).toEqual(["bash"]);
  });

  it("cannot be widened above the sandbox ceiling", async () => {
    const { executed } = await runOneCall(
      {
        sandbox: "read-only",
        approval: "never",
        rules: [{ toolName: "write_file", pathPattern: "src/**", decision: "allow" }],
      },
      "write_file",
      { path: "src/ok.txt" },
    );
    expect(executed).toHaveLength(0);
  });

  it("runs unchanged when no parameter rule exists", async () => {
    const { executed } = await runOneCall(
      { sandbox: "workspace-write", approval: "never" },
      "write_file",
      { path: "src/.env" },
    );
    expect(executed.map((call) => call.name)).toEqual(["write_file"]);
  });
});
