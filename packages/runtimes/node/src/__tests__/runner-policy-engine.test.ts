import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import {
  createMockModelPort,
  textDelta,
  toolUseStart,
  toolUseDelta,
  usage,
  modelDone,
  createDefaultPermissionConfig,
} from "@agent-core/core";
import type { StepContext, ToolDefinition, PendingToolCall, ToolResult, PolicyEngine, ToolResultMessage } from "@agent-core/core";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  requires: ["shell:exec"],
  riskTier: "WRITE_HIGH",
};

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const tools: ToolDefinition[] = [readTool, bashTool];
const ctx: StepContext = { tools, model: "test-model" };
const capabilities = new Set(["filesystem:read", "shell:exec"]);

const okExecutor: ToolExecutor = async (call: PendingToolCall): Promise<ToolResult> => ({
  modelContent: `OK: ${call.name}`,
});

/** Auto-allow approval gate (avoids "requires approvalGate" error) */
const autoAllowGate = { async ask() { return "allow" as const; } };

/** Find a tool_result message for a given tool name */
function findToolResult(messages: Array<{ role: string; content: unknown }>, toolName: string): ToolResultMessage | undefined {
  return messages.find(
    (m): m is ToolResultMessage =>
      m.role === "tool" &&
      Array.isArray(m.content) &&
      m.content.some((c: { toolUseId?: string }) => c.toolUseId !== undefined),
  ) as ToolResultMessage | undefined;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("Runner + PolicyEngine integration", () => {
  describe("core=allow + engine=deny → tool denied (most restrictive wins)", () => {
    it("denies a tool when PolicyEngine says deny even if core allows", async () => {
      const mockModel = createMockModelPort([
        [toolUseStart("call-1", "bash"), toolUseDelta("call-1", '{"cmd":"ls"}'), usage(10, 5), modelDone("tool_use")],
        [textDelta("Tool was denied."), modelDone("end_turn")],
      ]);

      const policyEngine: PolicyEngine = {
        async evaluate(request) {
          if (request.action === "bash") return "deny";
          return "allow";
        },
      };

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        availableCapabilities: capabilities,
        toolExecutor: okExecutor,
        permissionConfig: createDefaultPermissionConfig(),
        approvalGate: autoAllowGate,
        policyEngine,
      });

      const state = await runner.run({ type: "user_message", content: "run ls" });
      expect(state.status).toBe("done");

      const toolResultMsg = state.messages.find(
        (m) => m.role === "tool",
      ) as ToolResultMessage | undefined;
      expect(toolResultMsg).toBeDefined();
      if (toolResultMsg) {
        const block = toolResultMsg.content.find((c) => c.type === "tool_result");
        expect(block).toBeDefined();
        expect(block!.isError).toBe(true);
        expect(block!.content).toContain("denied");
      }
    });
  });

  describe("core=ask + engine=allow → tool asks (most restrictive wins)", () => {
    it("asks for approval when core says ask even if engine allows", async () => {
      const mockModel = createMockModelPort([
        [toolUseStart("call-1", "bash"), toolUseDelta("call-1", '{"cmd":"ls"}'), usage(10, 5), modelDone("tool_use")],
        [textDelta("Done."), modelDone("end_turn")],
      ]);

      const permConfig = createDefaultPermissionConfig();
      const policyEngine: PolicyEngine = {
        async evaluate() { return "allow"; },
      };

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        availableCapabilities: capabilities,
        toolExecutor: okExecutor,
        permissionConfig: permConfig,
        policyEngine,
        approvalGate: {
          async ask() { return "allow" as const; },
        },
      });

      const state = await runner.run({ type: "user_message", content: "run ls" });
      expect(state.status).toBe("done");

      const toolResultMsg = state.messages.find(
        (m) => m.role === "tool",
      ) as ToolResultMessage | undefined;
      expect(toolResultMsg).toBeDefined();
    });
  });

  describe("engine throws → fail-closed deny", () => {
    it("denies a tool when PolicyEngine throws (fail-closed)", async () => {
      const mockModel = createMockModelPort([
        [toolUseStart("call-1", "bash"), toolUseDelta("call-1", '{"cmd":"ls"}'), usage(10, 5), modelDone("tool_use")],
        [textDelta("Tool was denied."), modelDone("end_turn")],
      ]);

      const policyEngine: PolicyEngine = {
        async evaluate() { throw new Error("Policy service unavailable"); },
      };

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        availableCapabilities: capabilities,
        toolExecutor: okExecutor,
        permissionConfig: createDefaultPermissionConfig(),
        approvalGate: autoAllowGate,
        policyEngine,
      });

      const state = await runner.run({ type: "user_message", content: "run ls" });
      expect(state.status).toBe("done");

      const toolResultMsg = state.messages.find(
        (m) => m.role === "tool",
      ) as ToolResultMessage | undefined;
      expect(toolResultMsg).toBeDefined();
      if (toolResultMsg) {
        const block = toolResultMsg.content.find((c) => c.type === "tool_result");
        expect(block).toBeDefined();
        expect(block!.isError).toBe(true);
        expect(block!.content).toContain("denied");
      }
    });
  });

  describe("capability-based rule works end-to-end", () => {
    it("rule matching on capability is now functional (bug fix verification)", async () => {
      const mockModel = createMockModelPort([
        [toolUseStart("call-1", "bash"), toolUseDelta("call-1", '{"cmd":"ls"}'), usage(10, 5), modelDone("tool_use")],
        [textDelta("Done."), modelDone("end_turn")],
      ]);

      const permConfig = createDefaultPermissionConfig();
      permConfig.rules = [
        { capability: "shell:exec", decision: "deny" },
      ];

      const runner = createRunner({
        modelPort: mockModel,
        stepContext: ctx,
        availableCapabilities: capabilities,
        toolExecutor: okExecutor,
        permissionConfig: permConfig,
        approvalGate: autoAllowGate,
      });

      const state = await runner.run({ type: "user_message", content: "run ls" });
      expect(state.status).toBe("done");

      const toolResultMsg = state.messages.find(
        (m) => m.role === "tool",
      ) as ToolResultMessage | undefined;
      expect(toolResultMsg).toBeDefined();
      if (toolResultMsg) {
        const block = toolResultMsg.content.find((c) => c.type === "tool_result");
        expect(block).toBeDefined();
        expect(block!.isError).toBe(true);
        expect(block!.content).toContain("denied");
      }
    });
  });
});
