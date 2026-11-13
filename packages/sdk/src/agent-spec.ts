/**
 * Declarative agent / sub-agent spec loader — M13 Phase 4.
 *
 * AgentSpec is fully serializable data: prompt + tools (by name) + model
 * settings + policy + capabilities. `resolveAgentSpec` is a pure function
 * that maps spec data to assembly parameters. `loadAgentSpec` instantiates
 * a running agent from a spec using the existing createAgent path.
 */

import type {
  PermissionConfig,
  JSONSchema,
} from "@voltojs/core";
import type { Tool } from "@voltojs/tools-common";
import type { ModelPort } from "@voltojs/core";
import { createAgent, type AgentInstance, type CreateAgentOptions } from "./create-agent.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/**
 * Declarative agent specification — all fields are JSON-serializable.
 * Tools are referenced by name (resolved from a registry at load time).
 */
export interface AgentSpec {
  /** Unique agent name (used for registry lookup) */
  name: string;
  /** Human-readable one-line purpose (rendered into the task tool description) */
  description?: string;
  /** System prompt prepended as first message */
  systemPrompt?: string;
  /**
   * Model reference with two meanings: a routing-tier id in tier mode (when
   * `CreateAgentOptions.routingTiers` is present), or a raw model code for
   * the legacy single-tier chain when it is omitted. See the `routingTiers`
   * JSDoc in create-agent.ts.
   */
  model?: string;
  /** Max tokens per model call */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Adapter-owned reasoning effort id, forwarded verbatim to the ModelPort */
  reasoningEffort?: string;
  /** Tool names to include (resolved from registry); empty = no tools */
  tools?: string[];
  /** Required capabilities — tools whose requires are not met are gated out */
  capabilities?: string[];
  /** Permission policy override */
  policy?: PermissionConfig;
  /**
   * Legacy switch, no longer read for sub-agent dispatch. Whether a child may
   * delegate is decided by `maxAgentDepth` plus the intersection rule: a
   * definition that lists `tools` must name `task` to get one.
   */
  enableTaskTool?: boolean;
  /** Max inner-loop iterations */
  maxIterations?: number;
  /** Max tool calls per turn */
  maxToolCalls?: number;
  /** Structured / JSON output mode */
  responseFormat?: { type: "json"; schema?: JSONSchema };
}

/**
 * Pure resolution result — maps a spec + registry to assembly parameters.
 * No I/O; can be tested with snapshots.
 */
export interface ResolvedAgentSpec {
  /** Resolved tool definitions (from registry by name) */
  tools: Tool[];
  /** Resolved capability set */
  capabilities: Set<string>;
  /** Resolved permission config (spec.policy or undefined) */
  permissionConfig?: PermissionConfig;
  /** Whether task tool should be enabled */
  enableTaskTool: boolean;
  /** Model settings */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  responseFormat?: { type: "json"; schema?: JSONSchema };
  systemPrompt?: string;
}

// ──────────────────────────────────────────────
// Pure resolver
// ──────────────────────────────────────────────

/**
 * Tool registry — maps tool names to Tool objects.
 * Typically built from collectPlugins() + adapter tools.
 */
export type ToolRegistry = Map<string, Tool>;

/**
 * Pure function: resolve an AgentSpec against a tool registry.
 *
 * - Resolves `tools` names → Tool objects from registry
 * - Unknown tool names are collected as errors (not thrown — pure)
 * - Assembles capability set, permission config, model settings
 * - No I/O; deterministic for same inputs
 */
export function resolveAgentSpec(
  spec: AgentSpec,
  registry: ToolRegistry,
): ResolvedAgentSpec & { errors: string[] } {
  const errors: string[] = [];
  const resolvedTools: Tool[] = [];

  for (const toolName of spec.tools ?? []) {
    const tool = registry.get(toolName);
    if (tool) {
      resolvedTools.push(tool);
    } else {
      errors.push(`Unknown tool: "${toolName}" not found in registry`);
    }
  }

  const capabilities = new Set<string>(spec.capabilities ?? []);

  return {
    tools: resolvedTools,
    capabilities,
    permissionConfig: spec.policy,
    enableTaskTool: spec.enableTaskTool ?? false,
    model: spec.model,
    maxTokens: spec.maxTokens,
    temperature: spec.temperature,
    reasoningEffort: spec.reasoningEffort,
    maxIterations: spec.maxIterations,
    maxToolCalls: spec.maxToolCalls,
    responseFormat: spec.responseFormat,
    systemPrompt: spec.systemPrompt,
    errors,
  };
}

// ──────────────────────────────────────────────
// Spec → AgentInstance loader
// ──────────────────────────────────────────────

export interface LoadAgentSpecOptions {
  /** The agent specification */
  spec: AgentSpec;
  /** Model port — required */
  modelPort: ModelPort;
  /** Tool registry to resolve tool names from */
  toolRegistry: ToolRegistry;
  /** Additional CreateAgentOptions to merge (adapters, eventSink, etc.) */
  extraOpts?: Partial<Omit<CreateAgentOptions, "modelPort" | "tools" | "capabilities" | "systemPrompt" | "model" | "maxTokens" | "temperature" | "maxIterations" | "maxToolCalls" | "permissionConfig" | "responseFormat" | "enableTaskTool" | "hooks" | "config">>;
}

/**
 * Instantiate a running AgentInstance from a declarative AgentSpec.
 *
 * 1. Pure: resolveAgentSpec maps spec → assembly parameters
 * 2. Side-effect: createAgent instantiates the agent (I/O happens at run/stream time)
 */
export function loadAgentSpec(options: LoadAgentSpecOptions): AgentInstance {
  const { spec, modelPort, toolRegistry, extraOpts } = options;

  const resolved = resolveAgentSpec(spec, toolRegistry);

  return createAgent({
    modelPort,
    tools: resolved.tools,
    capabilities: resolved.capabilities.size > 0 ? resolved.capabilities : undefined,
    systemPrompt: resolved.systemPrompt,
    model: resolved.model,
    maxTokens: resolved.maxTokens,
    temperature: resolved.temperature,
    reasoningEffort: resolved.reasoningEffort,
    maxIterations: resolved.maxIterations,
    maxToolCalls: resolved.maxToolCalls,
    permissionConfig: resolved.permissionConfig,
    enableTaskTool: resolved.enableTaskTool,
    responseFormat: resolved.responseFormat,
    ...extraOpts,
  });
}
