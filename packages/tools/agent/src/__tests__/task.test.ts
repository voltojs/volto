import { describe, it, expect } from "vitest";
import { createTaskTool, CAP_AGENT_TASK } from "../index.js";

describe("createTaskTool", () => {
  it("should create a tool with the correct definition", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "hello" }));

    expect(tool.definition.name).toBe("task");
    expect(tool.definition.requires).toContain(CAP_AGENT_TASK);
    expect(tool.definition.riskTier).toBe("WRITE_LOW");
    expect(tool.definition.inputSchema).toBeDefined();
  });

  it("should call the dispatch with the message and return its output", async () => {
    const dispatch = async (req: { message: string }) => ({
      taskId: "t1",
      text: `Result for: ${req.message}`,
    });
    const tool = createTaskTool(dispatch);

    const result = await tool.handler({ message: "do something" });

    expect(result.modelContent).toBe("Result for: do something");
    expect(result.isError).toBeUndefined();
  });

  it("should return error result when dispatch throws", async () => {
    const dispatch = async () => {
      throw new Error("sub-agent crashed");
    };
    const tool = createTaskTool(dispatch);

    const result = await tool.handler({ message: "fail" });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("sub-agent crashed");
  });

  it("should return fallback message when dispatch returns empty text", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "" }));

    const result = await tool.handler({ message: "empty" });

    expect(result.modelContent).toContain("no output");
    expect(result.isError).toBeUndefined();
  });

  it("should reject invalid input", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }));

    const result = await tool.handler({ wrong_field: "bad" });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });
});
