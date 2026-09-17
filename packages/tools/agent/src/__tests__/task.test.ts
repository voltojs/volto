import { describe, it, expect } from "vitest";
import {
  createTaskTool,
  createTaskOutputTool,
  CAP_AGENT_TASK,
  CAP_AGENT_DEPTH_AVAILABLE,
} from "../index.js";

describe("createTaskTool", () => {
  it("should create a tool with the correct definition", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "hello" }));

    expect(tool.definition.name).toBe("task");
    expect(tool.definition.requires).toContain(CAP_AGENT_TASK);
    expect(tool.definition.requires).toContain(CAP_AGENT_DEPTH_AVAILABLE);
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

  it("passes the child session id through to displayMetadata", async () => {
    const tool = createTaskTool(async () => ({
      taskId: "t1",
      text: "done",
      sessionId: "sess-1-sub-9",
    }));

    const result = await tool.handler({ message: "go" });

    // The UI drills into the child transcript with this; the model never
    // sees it (display layer only).
    expect(result.displayMetadata).toEqual({
      taskId: "t1",
      background: false,
      sessionId: "sess-1-sub-9",
    });
    expect(result.modelContent).not.toContain("sess-1-sub-9");
  });

  it("omits sessionId when the dispatch reports none", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "done" }));

    const result = await tool.handler({ message: "go" });

    expect(result.displayMetadata).toEqual({ taskId: "t1", background: false });
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

describe("createTaskOutputTool", () => {
  it("requires both the task capability and the depth budget", () => {
    const tool = createTaskOutputTool(async () => ({ text: "done" }));

    expect(tool.definition.name).toBe("task_output");
    expect(tool.definition.requires).toContain(CAP_AGENT_TASK);
    expect(tool.definition.requires).toContain(CAP_AGENT_DEPTH_AVAILABLE);
  });
});
