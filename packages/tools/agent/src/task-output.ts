import type { ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE } from "./capabilities.js";

/**
 * Collect the result of a previously dispatched background sub-agent task.
 * Returns either the finished text or an error description (unknown id,
 * still running, failed, …).
 */
export type SubAgentOutputCollector = (
  taskId: string,
) => Promise<{ text: string } | { error: string }>;

const taskOutputSchema = z.object({
  task_id: z
    .string()
    .describe("The task id returned by a background task dispatch."),
});

export function createTaskOutputTool(collect: SubAgentOutputCollector) {
  return defineTool({
    name: "task_output",
    description:
      "Collect the result of a background sub-agent task previously started " +
      "with task(run_in_background=true).",
    schema: taskOutputSchema,
    requires: [CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE],
    riskTier: "WRITE_LOW",
    run: async (input): Promise<ToolResult> => {
      try {
        const result = await collect(input.task_id);
        if ("error" in result) {
          // Unknown / failed ids must surface as errors, not empty success —
          // an empty success would make the model believe the task produced
          // no output rather than that the id is invalid.
          return {
            modelContent: result.error,
            isError: true,
          };
        }
        return {
          modelContent: result.text,
          displayMetadata: { taskId: input.task_id },
        };
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          modelContent: `task_output error: ${error}`,
          isError: true,
        };
      }
    },
  });
}
