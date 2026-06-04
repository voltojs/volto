import type { ToolResult } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import { CAP_AGENT_TASK } from "./capabilities.js";

/**
 * Factory function that the SDK/caller provides to create a sub-agent runner.
 * The SDK assembles a fresh Runner with isolated context, shared ports,
 * and runs it to completion, returning the final text output.
 */
export type SubAgentExecutor = (message: string) => Promise<string>;

const taskSchema = z.object({
  message: z
    .string()
    .describe(
      "The task instruction to send to the sub-agent. " +
        "Be specific and self-contained — the sub-agent has no access to the parent's conversation history.",
    ),
});

export function createTaskTool(executor: SubAgentExecutor) {
  return defineTool({
    name: "task",
    description:
      "Spawn a sub-agent to perform a task in isolation. " +
      "The sub-agent has its own context window and cannot see the parent's conversation. " +
      "Use this for parallel work, long research tasks, or delegating a distinct sub-problem.",
    schema: taskSchema,
    requires: [CAP_AGENT_TASK],
    riskTier: "WRITE_LOW",
    run: async (input): Promise<ToolResult> => {
      try {
        const resultText = await executor(input.message);
        return {
          modelContent: resultText || "(Sub-agent completed with no output)",
        };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          modelContent: `Sub-agent error: ${error}`,
          isError: true,
        };
      }
    },
  });
}
