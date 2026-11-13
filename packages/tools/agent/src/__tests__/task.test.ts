import { describe, it, expect } from "vitest";
import { filterVisibleTools, resolvePermission } from "@voltojs/core";
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
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    // Dispatch records a child task; it is session state, not a workspace
    // write, so read-only/plan sessions keep the tool.
    expect(tool.definition.writesSessionState).toBe(true);
    expect(tool.definition.inputSchema).toBeDefined();
  });

  it("stays visible and allowed under a read-only/plan ceiling", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }));
    const caps = new Set([CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE]);

    const visible = filterVisibleTools([tool.definition], caps, "READ_ONLY");
    expect(visible.map((t) => t.name)).toEqual(["task"]);

    const { decision } = resolvePermission(
      { sandbox: "read-only", approval: "never" },
      tool.definition.name,
      tool.definition.riskTier,
      caps,
    );
    expect(decision).toBe("allow");
  });

  it("should call the dispatch with the message and return its output", async () => {
    const dispatch = async (req: { message: string }) => ({
      taskId: "t1",
      text: `Result for: ${req.message}`,
    });
    const tool = createTaskTool(dispatch);

    const result = await tool.handler({ message: "do something" });

    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "Result for: do something" });
    expect(JSON.parse(blocks[1]!.text)).toEqual({ status: "completed" });
    expect(result.isError).toBeUndefined();
  });

  it("passes the child session id through to displayMetadata and the envelope", async () => {
    const tool = createTaskTool(async () => ({
      taskId: "t1",
      text: "done",
      sessionId: "sess-1-sub-9",
    }));

    const result = await tool.handler({ message: "go" });

    // The model now legitimately holds the child session id: it references
    // the child's result when aggregating and can ask the host to drill into
    // that transcript. The UI keeps its direct path via displayMetadata.
    expect(result.displayMetadata).toEqual({
      taskId: "t1",
      background: false,
      sessionId: "sess-1-sub-9",
    });
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(JSON.parse(blocks[1]!.text)).toEqual({
      childSessionId: "sess-1-sub-9",
      status: "completed",
    });
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

    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks[0]).toEqual({
      type: "text",
      text: "(Sub-agent completed with no output)",
    });
    expect(result.isError).toBeUndefined();
  });

  it("F-142 sync success returns two text blocks: body then a JSON envelope", async () => {
    const tool = createTaskTool(async () => ({
      taskId: "t1", text: "done", sessionId: "sess-sub-1",
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 },
    }));
    const result = await tool.handler({ message: "go" });
    expect(result.isError).toBeUndefined();
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "done" });
    expect(JSON.parse(blocks[1]!.text)).toEqual({
      childSessionId: "sess-sub-1",
      status: "completed",
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 },
    });
    expect(result.displayMetadata).toEqual({ taskId: "t1", background: false, sessionId: "sess-sub-1" });
  });

  it("F-142 omits optional envelope keys instead of writing null", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "done" }));
    const result = await tool.handler({ message: "go" });
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    const env = JSON.parse(blocks[1]!.text) as Record<string, unknown>;
    expect(env).toEqual({ status: "completed" });
    expect("childSessionId" in env).toBe(false);
    expect("usage" in env).toBe(false);
  });

  it("F-143 a dispatch failure stays a single plain-text isError result, never an envelope", async () => {
    const tool = createTaskTool(async () => { throw new Error("sub-agent crashed"); });
    const result = await tool.handler({ message: "go" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toBe("Sub-agent error: sub-agent crashed");
  });

  it("F-141 passes the model override through to dispatch", async () => {
    const seen: Array<{ model?: string }> = [];
    const tool = createTaskTool(async (req) => {
      seen.push({ model: req.model });
      return { taskId: "t1", text: "ok" };
    });
    await tool.handler({ message: "go", model: "haiku" });
    expect(seen).toEqual([{ model: "haiku" }]);
  });

  it("F-141 the model field appears in the tool schema", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }));
    const props = tool.definition.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["message", "subagent_type", "run_in_background", "model"]),
    );
  });

  it("should reject invalid input", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }));

    const result = await tool.handler({ wrong_field: "bad" });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });
});

describe("createTaskTool with routing tiers", () => {
  const tiers = [
    { id: "premium", label: "高级", description: "复杂任务与深度推理", assignable: true },
    { id: "economy", label: "经济", description: "省成本，批量与低风险子任务", assignable: true },
    { id: "fast", label: "快速", description: "低延迟", assignable: false },
  ];

  it("lists the assignable tiers in the description, unassigned ones excluded", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }), { tiers });
    expect(tool.definition.description).toContain(
      "Available model tier values for `model`",
    );
    expect(tool.definition.description).toContain("economy (经济): 省成本，批量与低风险子任务");
    expect(tool.definition.description).toContain("premium (高级): 复杂任务与深度推理");
    // An unassigned tier must not be offered: a menu-following model would
    // bounce straight into its "no assigned model" error.
    expect(tool.definition.description).not.toContain("fast (快速)");
  });

  it("rejects a raw model code at validation instead of reaching dispatch", async () => {
    const seen: Array<{ model?: string }> = [];
    const tool = createTaskTool(
      async (req) => {
        seen.push({ model: req.model });
        return { taskId: "t1", text: "ok" };
      },
      { tiers },
    );
    const result = await tool.handler({ message: "go", model: "sonnet" });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
    // The zod enum names the legal ids, so the model self-corrects.
    expect(String(result.modelContent)).toContain("economy");
  });

  it("accepts a tier id and passes it to dispatch; unassigned ids reach the dispatch check", async () => {
    const seen: Array<{ model?: string }> = [];
    const tool = createTaskTool(
      async (req) => {
        seen.push({ model: req.model });
        return { taskId: "t1", text: "ok" };
      },
      { tiers },
    );
    await tool.handler({ message: "go", model: "economy" });
    expect(seen).toEqual([{ model: "economy" }]);
    // The enum covers ALL ids: an unassigned one must still reach the
    // dispatch layer's dedicated "no assigned model" error, not a zod rejection.
    const result = await tool.handler({ message: "go", model: "fast" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ model: "economy" }, { model: "fast" }]);
  });

  it("tells the model to omit `model` when the table has nothing assignable", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }), {
      tiers: [{ id: "economy", assignable: false }],
    });
    expect(tool.definition.description).toContain("none has an assigned model yet");
  });

  it("keeps `model` free text when no tier table is configured (legacy chain)", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }));
    expect(tool.definition.description).not.toContain("Available model tier values");
  });
});

describe("createTaskOutputTool", () => {
  it("requires both the task capability and the depth budget", () => {
    const tool = createTaskOutputTool(async () => ({ text: "done" }));

    expect(tool.definition.name).toBe("task_output");
    expect(tool.definition.requires).toContain(CAP_AGENT_TASK);
    expect(tool.definition.requires).toContain(CAP_AGENT_DEPTH_AVAILABLE);
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.writesSessionState).toBe(true);
  });
});
