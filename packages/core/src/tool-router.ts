import type { PendingToolCall } from "./state.js";
import type { ToolDefinition, ToolResult, JSONSchema, RiskTier } from "./tool.js";
import { riskRank } from "./permission-policy.js";

/**
 * Granted while the agent is still below maxAgentDepth. Delegation tools
 * declare it, so the depth limit reuses capability gating instead of adding
 * a second mechanism — and an agent at the limit never sees a tool it would
 * only be refused for using.
 */
export const CAP_AGENT_DEPTH_AVAILABLE = "agent:can-delegate";

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

function typeMatches(schema: JSONSchema | undefined, value: unknown): boolean {
  if (!schema?.type) {
    return true;
  }

  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

export function validateToolInput(schema: JSONSchema | undefined, input: unknown): string | null {
  if (!schema) {
    return null;
  }

  if (schema.type === "object" && schema.properties) {
    if (missing(input) || typeof input !== "object" || Array.isArray(input)) {
      return "expected object input";
    }

    const record = input as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (missing(record[key])) {
        return `missing required property: ${key}`;
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!missing(record[key])) {
        if (
          propertySchema.enum !== undefined &&
          !propertySchema.enum.includes(record[key])
        ) {
          // An enum-constrained property (e.g. subagent_type): reject a value
          // outside the allowed set as a self-correctable input error instead
          // of letting a drifting string reach the dispatcher.
          return `property "${key}" must be one of: ${propertySchema.enum.join(", ")}`;
        }
        if (!typeMatches(propertySchema, record[key])) {
          return `property "${key}" has invalid type`;
        }
      }
    }

    return null;
  }

  if (!typeMatches(schema, input)) {
    return "invalid input type";
  }

  return null;
}

export function filterVisibleTools(
  tools: ToolDefinition[],
  availableCapabilities: Set<string>,
  ceiling?: RiskTier,
): ToolDefinition[] {
  const capFiltered = tools.filter((tool) =>
    tool.requires.every((capability) => availableCapabilities.has(capability)),
  );
  if (ceiling === undefined) return capFiltered;
  const max = riskRank(ceiling);
  return capFiltered.filter((tool) => riskRank(tool.riskTier) <= max);
}

// ──────────────────────────────────────────────
// Scope-based visibility filtering (M10 Phase 2)
// ──────────────────────────────────────────────

/**
 * Scope configuration for tool visibility filtering.
 * Each group has an optional priority (higher = more important).
 * Tools without a matching group are excluded when groups are specified.
 */
export interface ScopeGroupConfig {
  /** Priority for this group (higher = more important). Default: 0 */
  priority?: number;
  /** Whether this group is enabled. Default: true */
  enabled?: boolean;
}

export interface ToolScopeConfig {
  /**
   * Map of tool group names (derived from tool name prefix or explicit tag)
   * to their configuration. Only tools belonging to an enabled group are kept.
   */
  groups: Record<string, ScopeGroupConfig>;
  /**
   * Optional: explicit tool name → group mapping.
   * If omitted, tools are grouped by their first name segment before `__`
   * (e.g. "mcp__srv__echo" → "mcp", "lsp_definition" → "lsp").
   */
  toolGroups?: Record<string, string>;
}

/**
 * After capability gating, trim the visible tool set to ≤ `limit` tools.
 *
 * Pure function — deterministic, no I/O, no side effects.
 * Sorting is stable: within the same priority, tools retain their original order.
 *
 * @param tools - tools that already passed capability gating
 * @param scopeConfig - group-based scope configuration (if null/undefined, no trimming)
 * @param limit - maximum number of tools to keep (default: 20)
 * @returns trimmed tool array (subset of input, same type)
 */
export function filterByScope(
  tools: ToolDefinition[],
  scopeConfig: ToolScopeConfig | null | undefined,
  limit: number = 20,
): ToolDefinition[] {
  if (tools.length <= limit && !scopeConfig) return tools;

  let filtered = tools;

  // Step 1: Apply group-based filtering if scope config is provided
  if (scopeConfig) {
    const { groups, toolGroups } = scopeConfig;

    filtered = tools.filter((tool) => {
      const groupName = toolGroups?.[tool.name] ?? deriveGroupName(tool.name);
      const group = groups[groupName];
      // Tool is kept if its group exists and is enabled (default: enabled)
      return group !== undefined && (group.enabled ?? true);
    });
  }

  // Step 2: Sort by priority (descending), stable within same priority
  if (scopeConfig) {
    const { groups, toolGroups } = scopeConfig;
    const indexed = filtered.map((tool, i) => {
      const groupName = toolGroups?.[tool.name] ?? deriveGroupName(tool.name);
      const priority = groups[groupName]?.priority ?? 0;
      return { tool, priority, originalIndex: i };
    });
    indexed.sort((a, b) => b.priority - a.priority || a.originalIndex - b.originalIndex);
    filtered = indexed.map(({ tool }) => tool);
  }

  // Step 3: Trim to limit
  if (filtered.length > limit) {
    filtered = filtered.slice(0, limit);
  }

  return filtered;
}

/**
 * Derive a group name from a tool name by taking the first segment
 * before `__` or the full name if no `__` is present.
 * "mcp__srv__echo" → "mcp", "lsp_definition" → "lsp_definition"
 */
function deriveGroupName(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx >= 0 ? toolName.slice(0, idx) : toolName;
}

export function routeToolCall(
  tools: ToolDefinition[],
  availableCapabilities: Set<string>,
  call: PendingToolCall,
): { tool?: ToolDefinition; result?: ToolResult } {
  const tool = tools.find((definition) => definition.name === call.name);
  if (!tool) {
    return {
      result: {
        modelContent: `Unknown tool: ${call.name}`,
        isError: true,
      },
    };
  }

  for (const capability of tool.requires) {
    if (!availableCapabilities.has(capability)) {
      return {
        tool,
        result: {
          modelContent: `Tool "${call.name}" is not available: missing capability ${capability}.`,
          isError: true,
        },
      };
    }
  }

  const validationError = validateToolInput(tool.inputSchema, call.input);
  if (validationError) {
    return {
      tool,
      result: {
        modelContent: `Invalid input for tool "${call.name}": ${validationError}`,
        isError: true,
      },
    };
  }

  return { tool };
}
