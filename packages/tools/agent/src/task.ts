import type { TokenUsage, ToolResult } from "@volto/core";
import { z } from "zod";
import { defineTool } from "@volto/tools-common";
import { CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE } from "./capabilities.js";

/**
 * Structured result returned by a sub-agent dispatch.
 *
 * `usage` is the child's token accounting for the whole run, accumulated from
 * its event stream. It rides the model-facing envelope because the parent
 * model — not just the host — needs cost visibility to decide whether another
 * dispatch is worth it; the host still receives the same numbers on the event
 * stream, so billing has a single source of truth.
 */
export interface SubAgentResult {
  taskId: string;
  /** Present when dispatched synchronously. */
  text?: string;
  /**
   * Child transcript session id. It rides the model-facing envelope so the
   * parent can reference the child's result when aggregating and ask the host
   * to drill into that transcript; the UI keeps its direct path through
   * `displayMetadata.sessionId`.
   */
  sessionId?: string;
  /** Present when usage events were captured for the child run. */
  usage?: TokenUsage;
}

/**
 * Dispatch a sub-agent. The SDK provides the real implementation; this package
 * only defines the contract and routes the model-facing tool call.
 */
export type SubAgentDispatch = (req: {
  message: string;
  subagentType?: string;
  background?: boolean;
  /** Per-dispatch model override; takes precedence over the agent definition's model. */
  model?: string;
}) => Promise<SubAgentResult>;

/** One available sub-agent definition, rendered into the tool description. */
export interface AgentTypeSummary {
  name: string;
  description?: string;
}

const NO_OUTPUT = "(Sub-agent completed with no output)";

/**
 * Assemble the model-facing content of a successful dispatch: the body as the
 * first text block, then a bare JSON envelope as the second. Optional keys
 * are omitted when absent — never written as null — so consumers can tell
 * "unknown" from "empty". Failures never go through this helper; they stay a
 * single plain-text `isError` result.
 */
export function buildResultBlocks(
  text: string | undefined,
  meta: { childSessionId?: string; usage?: TokenUsage },
): NonNullable<ToolResult["modelContent"]> {
  const envelope = {
    ...(meta.childSessionId !== undefined
      ? { childSessionId: meta.childSessionId }
      : {}),
    status: "completed" as const,
    ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
  };
  return [
    { type: "text", text: text || NO_OUTPUT },
    { type: "text", text: JSON.stringify(envelope) },
  ];
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
  model: z.string().optional().describe(
    "Model for this dispatch only; overrides the agent definition's model. " +
    "Omit to use the definition's model (or the parent's).",
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
    requires: [CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE],
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
          model: input.model,
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
          modelContent: buildResultBlocks(result.text, {
            childSessionId: result.sessionId,
            usage: result.usage,
          }),
          displayMetadata: {
            taskId: result.taskId,
            background: false,
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
          },
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
