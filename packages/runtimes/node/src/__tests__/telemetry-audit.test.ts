import { describe, it, expect } from "vitest";
import type { ToolDefinition, PermissionConfig, ApprovalGate } from "@voltojs/core";
import {
  createMockModelPort,
  toolUseStart,
  toolUseDelta,
  modelDone,
  textDelta,
  createDefaultPermissionConfig,
} from "@voltojs/core";
import { createRunner } from "../runner.js";
import type { AuditEntry, AuditSink } from "../runner.js";

/** Stub tool for low-risk testing */
const stubTool: ToolDefinition = {
  name: "stub_tool",
  description: "A stub tool",
  inputSchema: { type: "object", properties: { input: { type: "string" } } },
  requires: ["stub"],
  riskTier: "READ_ONLY",
};

/** Stub tool for high-risk testing */
const highRiskTool: ToolDefinition = {
  name: "write_tool",
  description: "A high-risk write tool",
  inputSchema: { type: "object", properties: { data: { type: "string" } } },
  requires: ["stub"],
  riskTier: "WRITE_HIGH",
};

const stubExecutor = async () => ({
  modelContent: "ok",
  displayMetadata: { stub: true },
});

function createCollectingAuditSink(): AuditSink & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(entry: AuditEntry) { entries.push(entry); },
  };
}

function createPermissionAskAll(): PermissionConfig {
  return {
    ...createDefaultPermissionConfig(),
    // Force "ask" for every tool regardless of risk tier (a wildcard rule
    // outranks the sandbox/approval matrix).
    rules: [{ toolPattern: "*", decision: "ask" }],
  };
}

const interactiveGate: ApprovalGate = {
  async ask() { return "allow"; },
};

const denyGate: ApprovalGate = {
  async ask() { return "deny"; },
};

describe("Runner audit entries", () => {
  describe("approval decisions", () => {
    it("records approval entry with decision=allow when gate allows", async () => {
      const sink = createCollectingAuditSink();
      const model = createMockModelPort([
        [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"x"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [stubTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: stubExecutor,
        permissionConfig: createPermissionAskAll(),
        approvalGate: interactiveGate,
        auditSink: sink,
        sessionId: "test-session",
      });

      await runner.run({ type: "user_message", content: "go" });

      const approvalEntries = sink.entries.filter((e) => e.kind === "approval");
      expect(approvalEntries).toHaveLength(1);
      expect(approvalEntries[0]!.decision).toBe("allow");
      expect(approvalEntries[0]!.toolName).toBe("stub_tool");
      expect(approvalEntries[0]!.sessionId).toBe("test-session");
      expect(approvalEntries[0]!.timestamp).toBeGreaterThan(0);
    });

    it("records approval entry with decision=deny when gate denies", async () => {
      const sink = createCollectingAuditSink();
      const model = createMockModelPort([
        [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"x"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [stubTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: stubExecutor,
        permissionConfig: createPermissionAskAll(),
        approvalGate: denyGate,
        auditSink: sink,
      });

      await runner.run({ type: "user_message", content: "go" });

      const approvalEntries = sink.entries.filter((e) => e.kind === "approval");
      expect(approvalEntries).toHaveLength(1);
      expect(approvalEntries[0]!.decision).toBe("deny");
    });
  });

  describe("high-risk tool execution", () => {
    it("records high_risk_exec entry for WRITE_HIGH tool", async () => {
      const sink = createCollectingAuditSink();
      const model = createMockModelPort([
        [toolUseStart("t1", "write_tool"), toolUseDelta("t1", '{"data":"test"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [highRiskTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: stubExecutor,
        auditSink: sink,
      });

      await runner.run({ type: "user_message", content: "go" });

      const highRiskEntries = sink.entries.filter((e) => e.kind === "high_risk_exec");
      expect(highRiskEntries).toHaveLength(1);
      expect(highRiskEntries[0]!.toolName).toBe("write_tool");
      expect(highRiskEntries[0]!.riskTier).toBe("WRITE_HIGH");
      expect(highRiskEntries[0]!.isError).toBeUndefined();
    });

    it("does NOT record audit entry for READ_ONLY tool", async () => {
      const sink = createCollectingAuditSink();
      const model = createMockModelPort([
        [toolUseStart("t1", "stub_tool"), toolUseDelta("t1", '{"input":"x"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [stubTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: stubExecutor,
        auditSink: sink,
      });

      await runner.run({ type: "user_message", content: "go" });

      const highRiskEntries = sink.entries.filter((e) => e.kind === "high_risk_exec");
      expect(highRiskEntries).toHaveLength(0);
    });

    it("records high_risk_exec entry with isError=true when executor throws", async () => {
      const sink = createCollectingAuditSink();
      const model = createMockModelPort([
        [toolUseStart("t1", "write_tool"), toolUseDelta("t1", '{"data":"x"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const failingExecutor = async () => { throw new Error("fail"); };

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [highRiskTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: failingExecutor,
        auditSink: sink,
      });

      await runner.run({ type: "user_message", content: "go" });

      const highRiskEntries = sink.entries.filter((e) => e.kind === "high_risk_exec");
      expect(highRiskEntries).toHaveLength(1);
      expect(highRiskEntries[0]!.isError).toBe(true);
    });
  });

  describe("no auditSink", () => {
    it("runner works without auditSink (no crash)", async () => {
      const model = createMockModelPort([
        [toolUseStart("t1", "write_tool"), toolUseDelta("t1", '{"data":"x"}'), modelDone("tool_use")],
        [textDelta("Done"), modelDone("end_turn")],
      ]);

      const runner = createRunner({
        modelPort: model,
        stepContext: { tools: [highRiskTool], model: "test" },
        availableCapabilities: new Set(["stub"]),
        toolExecutor: stubExecutor,
        // No auditSink
      });

      const final = await runner.run({ type: "user_message", content: "go" });
      expect(final.status).toBe("done");
    });
  });
});
