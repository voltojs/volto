import type { DispatchVerification, PermissionPreset, TokenUsage, ToolResult } from "@voltojs/core";
import { z } from "zod";
import { defineTool } from "@voltojs/tools-common";
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
  /**
   * Acceptance verdict carried alongside the result when the dispatch named
   * acceptance criteria. Absent — never null — when no criteria were given.
   */
  verification?: DispatchVerification;
  /**
   * True when the dispatch exhausted its acceptance reworks without meeting
   * the criteria; the tool result is then an `isError` result whose body
   * lists the failures.
   */
  rejected?: boolean;
}

/**
 * Dispatch a sub-agent. The SDK provides the real implementation; this package
 * only defines the contract and routes the model-facing tool call.
 *
 * The per-dispatch refinement fields mirror `AgentSpec` (the definition-level
 * settings) and follow the same precedence — dispatch > definition > parent —
 * and the same safety rule: they can only narrow or refine, never widen what
 * the parent's assembly line grants.
 */
export type SubAgentDispatch = (req: {
  message: string;
  /** Acceptance criteria the executor verifies the child's work against. */
  acceptance?: string;
  subagentType?: string;
  background?: boolean;
  /** Per-dispatch model override; takes precedence over the agent definition's model. */
  model?: string;
  /**
   * Permission preset for this dispatch only. Narrowing only: a preset wider
   * than the parent's sandbox boundary is an error the model can correct.
   */
  permission?: PermissionPreset;
  /** One-line task label for the UI surfaces (card / tab / trajectory / tasks list). */
  title?: string;
  /** Supplementary instructions APPENDED after the child's role prompt / definition body. */
  systemPrompt?: string;
  /** Per-dispatch tool allowlist, intersected again with the assembled child set. */
  tools?: string[];
  /** Child loop-iteration budget; outranks the definition's maxIterations. */
  maxIterations?: number;
  /** Per-dispatch temperature override. */
  temperature?: number;
  /** Per-dispatch max-tokens override. */
  maxTokens?: number;
  /** Structured-JSON output request for the child's final answer. */
  responseFormat?: { type: "json"; schema?: Record<string, unknown> };
}) => Promise<SubAgentResult>;

/**
 * One available sub-agent definition, rendered into the tool description.
 *
 * The tool-visibility fields carry the ASSEMBLED facts (the definition's
 * declared set intersected with what the parent actually owns), never the
 * declaration: a model choosing between types can only make an informed pick
 * if the list says what the child will really have — including "no tools".
 */
export interface AgentTypeSummary {
  name: string;
  description?: string;
  /**
   * Tool names the child keeps after intersection with the parent's set.
   * Absent = the type inherits the parent's tools (no declared restriction).
   */
  effectiveTools?: string[];
  /** Declared tool names dropped because the parent does not own them. */
  droppedTools?: string[];
  /** True when the definition declares an empty tool list (child gets none). */
  noTools?: boolean;
  /** True for SDK built-in types (general-purpose / explore). */
  builtIn?: boolean;
}

/**
 * One model routing tier, rendered into the tool description so the parent
 * model can pick a tier id informed — without the menu it can only guess raw
 * model codes, which tier mode rejects.
 */
export interface AgentTierSummary {
  id: string;
  label?: string;
  description?: string;
  /**
   * False when the tier has no assigned model. Unassigned tiers stay in the
   * schema enum (so a per-dispatch reference still reaches its dedicated
   * "no assigned model" error) but never appear in the menu: offering one
   * would bounce a menu-following model straight into that error.
   */
  assignable: boolean;
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
  meta: {
    childSessionId?: string;
    usage?: TokenUsage;
    verification?: DispatchVerification;
    rejected?: boolean;
  },
): NonNullable<ToolResult["modelContent"]> {
  const envelope = {
    ...(meta.childSessionId !== undefined
      ? { childSessionId: meta.childSessionId }
      : {}),
    status: "completed" as const,
    ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
    ...(meta.verification !== undefined ? { verification: meta.verification } : {}),
  };
  let body = text || NO_OUTPUT;
  if (meta.rejected === true && meta.verification !== undefined) {
    const { attempts, failures } = meta.verification;
    const list = failures.map((failure) => `- ${failure}`).join("\n");
    body += `\n\nAcceptance not met after ${attempts} attempt(s):\n${list}`;
  }
  return [
    { type: "text", text: body },
    { type: "text", text: JSON.stringify(envelope) },
  ];
}

/**
 * Build the input schema. With a type list the `subagent_type` becomes an
 * enum, not free text: a model that decides "general-purpose" but emits a
 * drifting value must fail validation (isError → self-correct) instead of
 * silently landing on whichever definition the string happens to name.
 * With a tier table the same rule applies to `model`: in tier mode every
 * per-dispatch reference is a tier id, so a raw model code must fail
 * validation rather than reach the provider. The enum covers ALL ids —
 * unassigned ones included — so their dedicated dispatch-time error stays
 * reachable; the menu in the description only lists assignable ones.
 */
function buildTaskSchema(types: AgentTypeSummary[], tiers: AgentTierSummary[]) {
  const subagentType =
    types.length > 0
      ? z.enum(types.map((t) => t.name) as [string, ...string[]])
      : z.string();
  const model =
    tiers.length > 0
      ? z.enum(tiers.map((t) => t.id) as [string, ...string[]])
      : z.string();
  return z.object({
    message: z.string().describe(
      "Self-contained instruction; the sub-agent cannot see this conversation. " +
        "State the required scope, the expected depth (quick overview vs deep " +
        "dive) and a target output size — the child acts only on this message.",
    ),
    subagent_type: subagentType.optional().describe(
      "Which agent definition to use. Omit (or use \"general-purpose\") unless the " +
        "task clearly matches a listed specialist.",
    ),
    acceptance: z.string().max(2000).optional().describe(
      "Acceptance criteria the sub-agent must meet; the dispatch is verified against it " +
        "and reworked once by default.",
    ),
    run_in_background: z.boolean().optional().describe(
      "Return a task id immediately instead of waiting for the result. " +
        "Use for dispatches expected to run long, or when fanning out several in parallel.",
    ),
    model: model.optional().describe(
      tiers.length > 0
        ? "Model routing tier id for this dispatch only; overrides the agent definition's tier. " +
          "Raw model codes are NOT accepted here — pick a tier id from the list in the tool " +
          "description. Omit to use the definition's tier (or the parent's model)."
        : "Model tier id for this dispatch only; overrides the agent definition's tier. Omit to use the definition's tier (or the parent's model).",
    ),
    permission: z
      .enum(["read-only", "ask", "auto", "full"])
      .optional()
      .describe(
        "Permission preset for the child: read-only | ask | auto | full. " +
          "Narrowing only — a preset wider than this session's boundary is rejected " +
          "with the list of presets you may use. Omit to inherit this session's permission.",
      ),
    title: z.string().min(1).max(120).optional().describe(
      "One-line human-readable label for this dispatch, shown in the UI " +
        "(conversation card, execution panel tab, trajectory). Never sent to the child.",
    ),
    system_prompt: z.string().min(1).max(4096).optional().describe(
      "Supplementary instructions for the child, APPENDED after its role prompt " +
        "(or the definition's body). Narrow or refine the child's behavior; the " +
        "built-in sub-agent contract stays.",
    ),
    tools: z.array(z.string()).optional().describe(
      "Per-dispatch tool allowlist for the child, intersected with the type's " +
        "assembled tool set — narrows only, never grants tools the parent lacks. " +
        "An empty list leaves the child tool-less.",
    ),
    max_iterations: z.number().int().positive().optional().describe(
      "Loop-iteration budget for the child run; outranks the definition's maxIterations. " +
        "Omit to inherit. Bounds a 'quick' dispatch instead of trusting the message alone.",
    ),
    temperature: z.number().min(0).max(2).optional().describe(
      "Per-dispatch temperature override; outranks the definition's, which outranks the parent's.",
    ),
    max_tokens: z.number().int().positive().optional().describe(
      "Per-dispatch max output tokens override; outranks the definition's, which outranks the parent's.",
    ),
    response_format: z
      .object({
        type: z.literal("json"),
        schema: z.record(z.string(), z.unknown()).optional(),
      })
      .optional()
      .describe(
        "Ask the child for structured JSON output (optionally schema-validated). " +
          "Use when the result feeds machine processing rather than prose aggregation.",
      ),
  });
}

function renderDescription(types: AgentTypeSummary[], tiers: AgentTierSummary[]): string {
  const base =
    "Spawn a sub-agent to perform a task in isolation. " +
    "The sub-agent has its own context window and cannot see this conversation. " +
    "Pass `title` (one short line) so the user can identify this dispatch in the UI, " +
    "and `max_iterations` to bound a quick one instead of leaving the child unbounded. " +
    "When you write `acceptance` criteria, the sub-agent's work is verified against them; " +
    "criteria it fails trigger one automatic rework round before the dispatch returns as an error.";
  const parts = [base];
  if (types.length > 0) {
    const list = types.map((t) => renderTypeLine(t)).join("\n");
    parts.push(
      `Available subagent_type values (tool lists are what the child ` +
        `actually gets after assembly):\n${list}`,
    );
  }
  if (tiers.length > 0) {
    const menu = tiers.filter((t) => t.assignable).map(renderTierLine).join("\n");
    parts.push(
      menu === ""
        ? "Model routing tiers are configured, but none has an assigned model yet — omit `model`."
        : `Available model tier values for \`model\` (each dispatch runs on that tier's assigned model):\n${menu}`,
    );
  }
  return parts.join("\n\n");
}

function renderTierLine(t: AgentTierSummary): string {
  const name = t.label === undefined || t.label === t.id ? t.id : `${t.id} (${t.label})`;
  return `- ${name}${t.description ? `: ${t.description}` : ""}`;
}

function renderTypeLine(t: AgentTypeSummary): string {
  const facts = renderToolFacts(t);
  return `- ${t.name}${t.description ? `: ${t.description}` : ""}${facts ? ` (${facts})` : ""}`;
}

function renderToolFacts(t: AgentTypeSummary): string | undefined {
  if (t.effectiveTools === undefined) {
    return t.builtIn ? "inherits the parent's tools" : undefined;
  }
  if (t.noTools || t.effectiveTools.length === 0) return "no tools";
  const parts = [`tools: ${t.effectiveTools.join(", ")}`];
  if (t.droppedTools !== undefined && t.droppedTools.length > 0) {
    parts.push(`unavailable: ${t.droppedTools.join(", ")}`);
  }
  return parts.join("; ");
}

function renderTypeList(types: AgentTypeSummary[]): string {
  return types.map((t) => t.name).join(", ");
}

export function createTaskTool(
  dispatch: SubAgentDispatch,
  opts?: { types?: AgentTypeSummary[]; tiers?: AgentTierSummary[] },
) {
  const types = opts?.types ?? [];
  const tiers = opts?.tiers ?? [];
  return defineTool({
    name: "task",
    description: renderDescription(types, tiers),
    schema: buildTaskSchema(types, tiers),
    requires: [CAP_AGENT_TASK, CAP_AGENT_DEPTH_AVAILABLE],
    riskTier: "WRITE_LOW",
    run: async (input): Promise<ToolResult> => {
      // Reject an unknown subagent_type BEFORE dispatching, and list the valid
      // values so the model can self-correct in the next attempt. With the
      // enum schema this is a backstop (zod already rejected the value);
      // with the free-string fallback (no types) it never fires.
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
          // The 2,000-char cap mirrors ACCEPTANCE_LIMITS.maxAcceptanceChars in
          // @voltojs/core (spec §4.1); tools-* consumes core types only, so the
          // literal is repeated here rather than value-imported.
          ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
          subagentType: input.subagent_type,
          background: input.run_in_background,
          model: input.model,
          ...(input.permission !== undefined ? { permission: input.permission } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.system_prompt !== undefined
            ? { systemPrompt: input.system_prompt }
            : {}),
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.max_iterations !== undefined
            ? { maxIterations: input.max_iterations }
            : {}),
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
          ...(input.max_tokens !== undefined
            ? { maxTokens: input.max_tokens }
            : {}),
          ...(input.response_format !== undefined
            ? { responseFormat: input.response_format }
            : {}),
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
            ...(result.verification !== undefined ? { verification: result.verification } : {}),
            ...(result.rejected === true ? { rejected: true } : {}),
          }),
          // Omit the key entirely on success — never write `isError: false` —
          // so the no-acceptance result shape stays byte-identical.
          ...(result.rejected === true ? { isError: true } : {}),
          displayMetadata: {
            taskId: result.taskId,
            background: false,
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            ...(result.verification !== undefined ? { verification: result.verification } : {}),
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
