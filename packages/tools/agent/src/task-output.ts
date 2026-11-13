import type { DispatchVerification, TokenUsage, ToolResult } from "@voltojs/core";
import { z } from "zod";
import { defineTool } from "@voltojs/tools-common";
import { CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE } from "./capabilities.js";
import { buildResultBlocks } from "./task.js";

/**
 * Collect the result of a previously dispatched background sub-agent task.
 * Returns the finished text plus the same optional envelope inputs as a sync
 * dispatch (child session id, accumulated usage), or an error description
 * (unknown id, still running, failed, …). Optional keys are omitted when
 * absent — never null.
 */
export type SubAgentOutputCollector = (
  taskId: string,
) => Promise<
  | {
      text: string;
      childSessionId?: string;
      usage?: TokenUsage;
      verification?: DispatchVerification;
      rejected?: boolean;
    }
  | { error: string }
>;

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
          modelContent: buildResultBlocks(result.text, {
            childSessionId: result.childSessionId,
            usage: result.usage,
            ...(result.verification !== undefined ? { verification: result.verification } : {}),
            ...(result.rejected === true ? { rejected: true } : {}),
          }),
          // A background dispatch that exhausted its acceptance reworks is a
          // failed collection, not an empty success — same semantics as the
          // sync path (spec §4.5). Omit the key on success so the legacy
          // shape stays untouched.
          ...(result.rejected === true ? { isError: true } : {}),
          displayMetadata: {
            taskId: input.task_id,
            ...(result.childSessionId !== undefined
              ? { relatedSessionId: result.childSessionId }
              : {}),
            ...(result.verification !== undefined ? { verification: result.verification } : {}),
          },
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
