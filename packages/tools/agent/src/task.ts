import type { ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_AGENT_TASK } from "./capabilities.js";

/** Structured result returned by a sub-agent dispatch. */
export interface SubAgentResult {
  taskId: string;
  /** Present when dispatched synchronously. */
  text?: string;
  sessionId?: string;
}

/**
 * Dispatch a sub-agent. The SDK provides the real implementation; this package
 * only defines the contract and routes the model-facing tool call.
 */
export type SubAgentDispatch = (req: {
  message: string;
  subagentType?: string;
  background?: boolean;
}) => Promise<SubAgentResult>;

/** One available sub-agent definition, rendered into the tool description. */
export interface AgentTypeSummary {
  name: string;
  description?: string;
}

const taskSchema = z.object({
  message: z.string().describe(
    "Self-contained instruction; the sub-agent cannot see this conversation.",
  ),
  subagent_type: z.string().optional().describe(
    "Which agent definition to use. Omit for a general-purpose sub-agent.",
  ),
  run_in_background: z.boolean().optional().describe(
    "Return a task id immediately instead of waiting for the result.",
  ),
});

function renderDescription(types: AgentTypeSummary[]): string {
  const base =
    "Spawn a sub-agent to perform a task in isolation. " +
    "The sub-agent has its own context window and cannot see this conversation.";
  if (types.length === 0) return base;
  const list = types
    .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`)
    .join("\n");
  return `${base}\n\nAvailable subagent_type values:\n${list}`;
}

function renderTypeList(types: AgentTypeSummary[]): string {
  return types.map((t) => t.name).join(", ");
}

export function createTaskTool(
  dispatch: SubAgentDispatch,
  opts?: { types?: AgentTypeSummary[] },
) {
  const types = opts?.types ?? [];
  return defineTool({
    name: "task",
    description: renderDescription(types),
    schema: taskSchema,
    requires: [CAP_AGENT_TASK],
    riskTier: "WRITE_LOW",
    run: async (input): Promise<ToolResult> => {
      // Reject an unknown subagent_type BEFORE dispatching, and list the valid
      // values so the model can self-correct in the next attempt.
      if (input.subagent_type !== undefined && types.length > 0) {
        const known = types.some((t) => t.name === input.subagent_type);
        if (!known) {
          return {
            modelContent:
              `Unknown subagent_type "${input.subagent_type}". ` +
              `Available values: ${renderTypeList(types)}`,
            isError: true,
          };
        }
      }

      try {
        const result = await dispatch({
          message: input.message,
          subagentType: input.subagent_type,
          background: input.run_in_background,
        });

        if (input.run_in_background) {
          // Background path: hand back the task id only; the model collects
          // the result later via task_output.
          return {
            modelContent:
              `Task ${result.taskId} started in background. ` +
              `Use task_output with task_id="${result.taskId}" to collect the result.`,
            displayMetadata: { taskId: result.taskId, background: true },
          };
        }

        return {
          modelContent: result.text || "(Sub-agent completed with no output)",
          displayMetadata: { taskId: result.taskId, background: false },
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
