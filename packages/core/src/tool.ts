/**
 * Tool types — definitions, results, capabilities, and risk tiers.
 * Core only uses abstract JSONSchema (no zod dependency here).
 */

import type { TodoItem } from "./state.js";

// ──────────────────────────────────────────────
// JSON Schema (abstract, minimal subset)
// ──────────────────────────────────────────────

/** Minimal JSON Schema representation used by the core */
export interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
}

// ──────────────────────────────────────────────
// Capability & Risk Tier
// ──────────────────────────────────────────────

/**
 * Capability that a tool requires.
 * Format: "namespace:action" (e.g., "filesystem:read", "shell:exec").
 */
export type Capability = string;

/** Risk tier for permission policy decisions */
export type RiskTier = "READ_ONLY" | "WRITE_LOW" | "WRITE_HIGH" | "IRREVERSIBLE";

// ──────────────────────────────────────────────
// ToolDefinition — how a tool is declared
// ──────────────────────────────────────────────

export interface ToolDefinition {
  /** Unique tool name (snake_case), e.g., "read_file" */
  name: string;
  /** Description for the model to decide whether to use it */
  description: string;
  /** JSON Schema for the tool's input parameters */
  inputSchema: JSONSchema;
  /** Capabilities required for this tool to be available */
  requires: Capability[];
  /** Risk tier for permission policy */
  riskTier: RiskTier;
  /** Output trust level — untrusted output is annotated for prompt-injection defense */
  trust?: "trusted" | "untrusted";
}

// ──────────────────────────────────────────────
// ToolResult — dual-layer output
// ──────────────────────────────────────────────

/** Result returned by a tool execution */
export interface ToolResult {
  /** Content for the model (concise, truncated if oversized) */
  modelContent: string;
  /** Whether this is an error result (model should self-correct) */
  isError?: boolean;
  /** Metadata for UI/logging (diff, line count, latency, etc.) */
  displayMetadata?: Record<string, unknown>;
  /**
   * Optional structured patch the reducer applies to AgentState.
   * v1: only `todos`. Unknown keys are ignored by the reducer.
   * Hosts/Runners must pass this through unchanged.
   */
  statePatch?: {
    todos?: TodoItem[];
  };
}
