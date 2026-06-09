import { describe, it, expect, vi } from "vitest";
import type { StepContext, ToolDefinition, ToolResult, PendingToolCall } from "@agent-core/core";
import {
  createMockModelPort,
  toolCallScript,
  textScript,
} from "@agent-core/core";
import { createRunner } from "../runner.js";
import type { ToolExecutor } from "../runner.js";
import * as toolRouterModule from "@agent-core/core";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const ctx: StepContext = { tools: [readTool], model: "test" };
const caps = new Set(["filesystem:read"]);

describe("TC-E12: Runner tool executor 冗余 routeToolCall 已消除", () => {
  it("routeToolCall is called exactly once by the Runner (not duplicated in executor)", async () => {
    const routeSpy = vi.spyOn(toolRouterModule, "routeToolCall");

    const mockModel = createMockModelPort([
      toolCallScript("c1", "read_file", '{"path":"foo.ts"}'),
      textScript("Done."),
    ]);

    const toolExecutor: ToolExecutor = async (
      call: PendingToolCall,
    ): Promise<ToolResult> => {
      return { modelContent: `content of ${call.input.path}` };
    };

    const runner = createRunner({
      modelPort: mockModel,
      stepContext: ctx,
      availableCapabilities: caps,
      toolExecutor,
    });

    await runner.run({ type: "user_message", content: "Read foo.ts" });

    // routeToolCall should be called exactly once per tool call by the Runner.
    // The executor must NOT call it again.
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routeSpy).toHaveBeenCalledWith(
      expect.any(Array),
      caps,
      expect.objectContaining({ name: "read_file" }),
    );

    routeSpy.mockRestore();
  });
});
