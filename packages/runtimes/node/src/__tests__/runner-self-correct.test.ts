import { describe, it, expect } from "vitest";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import type { Validator, ValidationResult, StepContext, ToolDefinition, PendingToolCall, ToolResult } from "@voltojs/core";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@voltojs/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test-model" };
const capabilities = new Set(["filesystem:read"]);

function createMockToolExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return async (call: PendingToolCall): Promise<ToolResult> => {
    const result = results[call.name];
    if (!result) {
      return { modelContent: `Unknown tool: ${call.name}`, isError: true };
    }
    return result;
  };
}

function createFailingValidator(failUntilCount: number, name = "test-validator"): Validator {
  let callCount = 0;
  return {
    name,
    validate(_toolName: string, _resultContent: string): ValidationResult {
      callCount++;
      if (callCount <= failUntilCount) {
        return {
          passed: false,
          failures: [`Validation failed on attempt ${callCount}`],
          validatorName: name,
        };
      }
      return { passed: true, failures: [], validatorName: name };
    },
  };
}

function createAlwaysFailValidator(name = "test-validator"): Validator {
  return {
    name,
    validate(_toolName: string, _resultContent: string): ValidationResult {
      return {
        passed: false,
        failures: [`Always fails`],
        validatorName: name,
      };
    },
  };
}

  it("a timed-out tool call queues one repair prompt for the model to decide on", async () => {
    const bashTool: ToolDefinition = {
      name: "bash",
      description: "Run a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      requires: ["shell:exec"],
      riskTier: "WRITE_HIGH",
    };
    const model = createMockModelPort([
      toolCallScript("call_1", "bash", JSON.stringify({ command: "sleep 60" })),
      textScript("The command timed out; I did not retry."),
    ]);
    const toolExecutor: ToolExecutor = async () => ({
      modelContent: "[timeout] bash timed out after 120000ms",
      isError: true,
      displayMetadata: { timedOut: true },
    });

    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [bashTool], model: "test-model" },
      toolExecutor,
      availableCapabilities: new Set(["shell:exec"]),
      selfCorrectionMax: 1,
    });

    const final = await runner.run({ type: "user_message", content: "run the slow command" });

    expect(final.selfCorrectionCount).toBe(1);
    // The model was called twice — the tool batch continues — but the Runner
    // never re-executes the tool; it only hands the model a repair prompt.
    expect(model.callCount).toBe(2);
    const repair = final.messages.find(
      (m) => m.role === "user" && String(m.content).includes("[TOOL TIMEOUT]"),
    );
    expect(repair).toBeDefined();
    expect(String(repair?.content)).toContain("run_in_background");
  });

  it("does not queue a repair prompt when the budget is zero", async () => {
    const bashTool: ToolDefinition = {
      name: "bash",
      description: "Run a command",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      requires: ["shell:exec"],
      riskTier: "WRITE_HIGH",
    };
    const model = createMockModelPort([
      toolCallScript("call_1", "bash", JSON.stringify({ command: "sleep 60" })),
      textScript("Timed out."),
    ]);
    const runner = createRunner({
      modelPort: model,
      stepContext: { tools: [bashTool], model: "test-model" },
      toolExecutor: async () => ({
        modelContent: "[timeout] bash timed out after 120000ms",
        isError: true,
        displayMetadata: { timedOut: true },
      }),
      availableCapabilities: new Set(["shell:exec"]),
      // no selfCorrectionMax → budget 0
    });

    const final = await runner.run({ type: "user_message", content: "run the slow command" });

    expect(final.selfCorrectionCount).toBe(0);
    expect(
      final.messages.some(
        (m) => m.role === "user" && String(m.content).includes("[TOOL TIMEOUT]"),
      ),
    ).toBe(false);
  });

describe("Runner self-correction", () => {
  it("validator fails once, model corrects on second try → success", async () => {
    const validator = createFailingValidator(1);

    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      textScript("The result is valid."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "some output", isError: false },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      validators: [validator],
      selfCorrectionMax: 3,
    });

    const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

    expect(finalState.status).toBe("done");
    expect(finalState.selfCorrectionCount).toBe(1);
    // Model was called twice: first tool_use, then text response
    expect(mockModel.callCount).toBe(2);
    // The repair prompt was injected as a user message
    const userMsgs = finalState.messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      return content.includes("[SELF-CORRECT");
    })).toBe(true);
  });

  it("validator fails 3 times (maxSelfCorrections=2) → budget exhausted", async () => {
    const validator = createAlwaysFailValidator();

    // Need 3 tool_call batches to trigger 2 self-corrections:
    // tool_call → fail(count=1) → tool_call → fail(count=2) → tool_call → fail(budget exhausted) → text
    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("call_2", "read_file", '{"path":"foo.ts"}'),
      toolCallScript("call_3", "read_file", '{"path":"foo.ts"}'),
      textScript("Giving up."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "bad output", isError: false },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      validators: [validator],
      selfCorrectionMax: 2,
    });

    const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

    expect(finalState.status).toBe("done");
    expect(finalState.selfCorrectionCount).toBe(2);
    // Budget exhausted: last user message contains the exhausted notice
    const userMsgs = finalState.messages.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThan(0);
    const lastUserMsg = userMsgs[userMsgs.length - 1]!;
    const content = typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
    expect(content).toContain("[SELF-CORRECT BUDGET EXHAUSTED]");
  });

  it("validators array empty → no self-correction (backward compat)", async () => {
    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      textScript("Done."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "some output", isError: false },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      // No validators, no selfCorrectionMax
    });

    const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

    expect(finalState.status).toBe("done");
    expect(finalState.selfCorrectionCount).toBe(0);
    expect(mockModel.callCount).toBe(2);
    // No self-correct user messages injected
    const userMsgs = finalState.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
  });

  it("self-correction does not apply to error results", async () => {
    const validator = createAlwaysFailValidator();

    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      textScript("Error acknowledged."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "File not found", isError: true },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      validators: [validator],
      selfCorrectionMax: 3,
    });

    const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

    expect(finalState.status).toBe("done");
    expect(finalState.selfCorrectionCount).toBe(0);
  });

  it("state.selfCorrectionCount is exposed in getState", async () => {
    const validator = createFailingValidator(1);

    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      textScript("Fixed."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "output", isError: false },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      validators: [validator],
      selfCorrectionMax: 5,
    });

    const initialState = runner.getState();
    expect(initialState.selfCorrectionCount).toBe(0);
    expect(initialState.maxSelfCorrections).toBe(5);

    await runner.run({ type: "user_message", content: "Read foo.ts" });

    const finalState = runner.getState();
    expect(finalState.selfCorrectionCount).toBe(1);
    expect(finalState.maxSelfCorrections).toBe(5);
  });

  it("multiple validators: first passes, second fails → correction triggered", async () => {
    const passValidator: Validator = {
      name: "pass-v",
      validate: () => ({ passed: true, failures: [], validatorName: "pass-v" }),
    };
    const failValidator: Validator = {
      name: "fail-v",
      validate: () => ({
        passed: false,
        failures: ["schema mismatch"],
        validatorName: "fail-v",
      }),
    };

    const mockModel = createMockModelPort([
      toolCallScript("call_1", "read_file", '{"path":"foo.ts"}'),
      textScript("Fixed schema."),
    ]);

    const toolExecutor = createMockToolExecutor({
      read_file: { modelContent: "bad json", isError: false },
    });

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      toolExecutor,
      availableCapabilities: capabilities,
      validators: [passValidator, failValidator],
      selfCorrectionMax: 2,
    });

    const finalState = await runner.run({ type: "user_message", content: "Read foo.ts" });

    expect(finalState.status).toBe("done");
    expect(finalState.selfCorrectionCount).toBe(1);
  });
});
