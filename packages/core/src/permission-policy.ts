/**
 * PermissionPolicy — pure decision logic for tool permission gating.
 *
 * Determines whether a tool call should be allowed, denied, or require
 * human approval based on the tool's risk tier and a configuration.
 * Zero I/O, zero side effects — the Runner interprets the decision.
 *
 * Supports permission modes (default / plan / auto-accept) and
 * configurable rule sets that take precedence over tier defaults.
 */

import type { RiskTier } from "./tool.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** Permission modes for batch-decision behavior */
export type PermissionMode = "default" | "plan" | "auto-accept";

/**
 * A single permission rule that matches tool name or capability
 * and overrides the permission decision.
 *
 * Match priority: `toolName` (exact) > `toolPattern` (glob-like prefix)
 * > `capability` (matches tool's `requires` set).
 */
export interface PermissionRule {
  /** Exact tool name match (highest priority within rules) */
  toolName?: string;
  /** Glob-like tool name pattern (supports `*` suffix: "db_*", "lsp_*") */
  toolPattern?: string;
  /** Capability match: if tool requires this capability, apply the rule */
  capability?: string;
  /** Decision to apply when matched */
  decision: "allow" | "deny" | "ask";
}

export interface PermissionConfig {
  /** Default decision per risk tier */
  defaults: Record<RiskTier, "allow" | "deny" | "ask">;
  /** Per-tool name overrides (takes precedence over tier defaults, after mode) */
  toolOverrides?: Record<string, "allow" | "deny" | "ask">;
  /**
   * Permission mode:
   * - "default": tier defaults + toolOverrides only
   * - "plan": READ_ONLY → allow, all writes → deny (model produces plans only)
   * - "auto-accept": WRITE_LOW / WRITE_HIGH → allow, IRREVERSIBLE → ask
   */
  mode?: PermissionMode;
  /**
   * Rule set — evaluated in order, first match wins.
   * Priority: rules > mode > toolOverrides > tier defaults > ask.
   */
  rules?: PermissionRule[];
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Check if a risk tier is a write-class tier (not READ_ONLY) */
export function isWriteTier(tier: RiskTier): boolean {
  return tier === "WRITE_LOW" || tier === "WRITE_HIGH" || tier === "IRREVERSIBLE";
}

/** Check if a permission rule matches a tool */
function ruleMatchesRule(
  rule: PermissionRule,
  toolName: string,
  toolCapabilities: Set<string>,
): boolean {
  if (rule.toolName !== undefined && rule.toolName === toolName) return true;
  if (rule.toolPattern !== undefined && matchesPattern(toolName, rule.toolPattern)) return true;
  if (rule.capability !== undefined && toolCapabilities.has(rule.capability)) return true;
  return false;
}

/** Simple glob-like pattern: supports exact match and `*` suffix (e.g., "db_*") */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return toolName === pattern;
}

/**
 * Evaluate mode-specific decision for a tool.
 * Returns `undefined` if mode doesn't apply (e.g., "default" mode).
 */
function evaluateMode(
  mode: PermissionMode | undefined,
  riskTier: RiskTier,
): "allow" | "deny" | "ask" | undefined {
  if (mode === undefined || mode === "default") return undefined;

  if (mode === "plan") {
    // plan mode: READ_ONLY → allow, all writes → deny
    return riskTier === "READ_ONLY" ? "allow" : "deny";
  }

  if (mode === "auto-accept") {
    // auto-accept: WRITE_LOW / WRITE_HIGH → allow, IRREVERSIBLE → ask
    if (riskTier === "IRREVERSIBLE") return "ask";
    return "allow";
  }

  return undefined;
}

// ──────────────────────────────────────────────
// Core decision function
// ──────────────────────────────────────────────

/**
 * Evaluate the permission decision for a tool call.
 *
 * Lookup order (highest priority first):
 * 1. `rules[]` — pattern/capability-based rule set (first match wins)
 * 2. `mode` — batch mode decision (plan / auto-accept)
 * 3. `toolOverrides[toolName]` — explicit per-tool override
 * 4. `defaults[riskTier]` — tier-based default
 * 5. `"ask"` — safe fallback for unknown tiers
 *
 * @param toolCapabilities - the set of capabilities the tool requires
 *                           (optional, needed for rule capability matching)
 */
export function evaluatePermission(
  config: PermissionConfig,
  toolName: string,
  riskTier: RiskTier,
  toolCapabilities?: Set<string>,
): "allow" | "deny" | "ask" {
  // 1. Rule set — first match wins
  if (config.rules) {
    const caps = toolCapabilities ?? new Set<string>();
    for (const rule of config.rules) {
      if (ruleMatchesRule(rule, toolName, caps)) {
        return rule.decision;
      }
    }
  }

  // 2. Mode-specific decision
  const modeDecision = evaluateMode(config.mode, riskTier);
  if (modeDecision !== undefined) return modeDecision;

  // 3. Per-tool override
  if (config.toolOverrides?.[toolName] !== undefined) {
    return config.toolOverrides[toolName]!;
  }

  // 4. Tier default
  if (config.defaults[riskTier] !== undefined) {
    return config.defaults[riskTier]!;
  }

  // 5. Unknown tier → ask (safe fallback)
  return "ask";
}

/**
 * Create a PermissionConfig with sensible defaults:
 * - READ_ONLY → allow
 * - WRITE_LOW → allow
 * - WRITE_HIGH → ask
 * - IRREVERSIBLE → deny
 */
export function createDefaultPermissionConfig(
  overrides?: Record<string, "allow" | "deny" | "ask">,
): PermissionConfig {
  return {
    defaults: {
      READ_ONLY: "allow",
      WRITE_LOW: "allow",
      WRITE_HIGH: "ask",
      IRREVERSIBLE: "deny",
    },
    toolOverrides: overrides,
  };
}
