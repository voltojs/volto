import { describe, it, expect, vi } from "vitest";
import { createTaskTool, createTaskOutputTool } from "../index.js";

const types = [
  { name: "code-searcher", description: "locate implementations" },
  { name: "doc-reader", description: "read long documents" },
];

describe("task tool contract", () => {
  it("accepts subagent_type and run_in_background", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "ok" }), { types });
    const props = tool.definition.inputSchema.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["message", "subagent_type", "run_in_background", "model"]));
  });

  it("lists available types in the description", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types });
    expect(tool.definition.description).toContain("code-searcher");
    expect(tool.definition.description).toContain("locate implementations");
  });

  it("falls back to generic wording when no types are configured", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types: [] });
    expect(tool.definition.description).not.toContain("code-searcher");
    expect(tool.definition.description).toMatch(/sub-agent/i);
  });

  it("errors with the available values on an unknown type", async () => {
    const dispatch = vi.fn(async () => { throw new Error("must not dispatch"); });
    const tool = createTaskTool(dispatch as never, { types });
    const result = await tool.handler({ message: "go", subagent_type: "nope" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toContain("code-searcher");
    expect(result.modelContent as string).toContain("doc-reader");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a task id without result text when dispatched in background", async () => {
    const tool = createTaskTool(async () => ({ taskId: "task-7" }), { types });
    const result = await tool.handler({ message: "go", run_in_background: true });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent as string).toContain("task-7");
    expect(result.displayMetadata).toMatchObject({ taskId: "task-7", background: true });
  });

  it("returns the text when dispatched synchronously", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1", text: "the answer" }), { types });
    const result = await tool.handler({ message: "go" });
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks[0]).toEqual({ type: "text", text: "the answer" });
    expect(JSON.parse(blocks[1]!.text)).toEqual({ status: "completed" });
  });
});

describe("task_output", () => {
  it("returns the collected result", async () => {
    const tool = createTaskOutputTool(async () => ({ text: "done" }));
    const result = await tool.handler({ task_id: "t1" });
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks[0]).toEqual({ type: "text", text: "done" });
  });

  it("F-144 task_output success returns the same envelope shape as sync task", async () => {
    const tool = createTaskOutputTool(async () => ({
      text: "bg result", childSessionId: "sess-sub-2",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const result = await tool.handler({ task_id: "t9" });
    const blocks = result.modelContent as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "bg result" });
    expect(JSON.parse(blocks[1]!.text)).toEqual({
      childSessionId: "sess-sub-2",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result.displayMetadata).toEqual({ taskId: "t9", relatedSessionId: "sess-sub-2" });
  });

  it("F-144 task_output error stays plain-text isError", async () => {
    const tool = createTaskOutputTool(async () => ({ error: "unknown task: nope" }));
    const result = await tool.handler({ task_id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toBe("unknown task: nope");
  });

  it("reports an unknown task id as an error, not an empty result", async () => {
    const tool = createTaskOutputTool(async () => ({ error: "no such task: t9" }));
    const result = await tool.handler({ task_id: "t9" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toContain("t9");
  });
});

describe("per-dispatch refinement parameters", () => {
  const types = [{ name: "general-purpose", description: "default" }];

  it("exposes every refinement field in the schema", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types });
    const props = tool.definition.inputSchema.properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "message",
        "subagent_type",
        "run_in_background",
        "model",
        "title",
        "system_prompt",
        "tools",
        "max_iterations",
        "temperature",
        "max_tokens",
        "response_format",
      ]),
    );
  });

  it("passes every refinement through to the dispatch in camelCase", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool = createTaskTool(async (req) => {
      seen.push(req as Record<string, unknown>);
      return { taskId: "t1", text: "ok" };
    }, { types });

    await tool.handler({
      message: "go",
      title: "调研触发机制",
      system_prompt: "Be brief.",
      tools: ["read_file", "grep"],
      max_iterations: 6,
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: "json" },
    });

    expect(seen[0]).toMatchObject({
      message: "go",
      title: "调研触发机制",
      systemPrompt: "Be brief.",
      tools: ["read_file", "grep"],
      maxIterations: 6,
      temperature: 0.2,
      maxTokens: 2048,
      responseFormat: { type: "json" },
    });
  });

  it("omits every refinement key when the model did not supply it", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool = createTaskTool(async (req) => {
      seen.push(req as Record<string, unknown>);
      return { taskId: "t1", text: "ok" };
    }, { types });

    await tool.handler({ message: "go" });
    for (const key of [
      "title",
      "systemPrompt",
      "tools",
      "maxIterations",
      "temperature",
      "maxTokens",
      "responseFormat",
    ]) {
      expect(seen[0]!).not.toHaveProperty(key);
    }
  });

  it("rejects an over-long title and a malformed response_format", async () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types });
    const longTitle = await tool.handler({ message: "go", title: "x".repeat(121) });
    expect(longTitle.isError).toBe(true);
    const badFormat = await tool.handler({
      message: "go",
      response_format: { type: "yaml" },
    });
    expect(badFormat.isError).toBe(true);
  });
});

describe("subagent_type enum + assembly-fact rendering", () => {
  const richTypes = [
    { name: "general-purpose", description: "default", builtIn: true },
    {
      name: "explore",
      description: "read-only",
      builtIn: true,
      effectiveTools: ["read_file", "grep"],
      droppedTools: ["run_bash_command"],
    },
    { name: "no-tool-scholar", description: "reviews from memory", effectiveTools: [], noTools: true },
    { name: "searcher", description: "locates code", effectiveTools: ["echo"], droppedTools: ["curl"] },
  ];

  it("the schema constrains subagent_type to an enum of the offered names", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types: richTypes });
    const props = tool.definition.inputSchema.properties ?? {};
    expect(props["subagent_type"]?.enum).toEqual(richTypes.map((t) => t.name));
  });

  it("an out-of-enum value is rejected at validation and never dispatched", async () => {
    const dispatch = vi.fn(async () => ({ taskId: "t1" }));
    const tool = createTaskTool(dispatch as never, { types: richTypes });
    const result = await tool.handler({ message: "go", subagent_type: "bug-analyzer" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toContain("Invalid input");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("renders assembled tool facts — inherited, restricted, dropped, none", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types: richTypes });
    expect(tool.definition.description).toContain("inherits the parent's tools");
    expect(tool.definition.description).toContain("tools: read_file, grep");
    expect(tool.definition.description).toContain("unavailable: run_bash_command");
    expect(tool.definition.description).toContain("unavailable: curl");
    expect(tool.definition.description).toContain("no tools");
  });

  it("with no types configured the schema stays a free string", () => {
    const tool = createTaskTool(async () => ({ taskId: "t1" }), { types: [] });
    const props = tool.definition.inputSchema.properties ?? {};
    expect(props["subagent_type"]?.enum).toBeUndefined();
  });
});
