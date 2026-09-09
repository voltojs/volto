/**
 * PermissionPolicy — pure decision logic for tool permission gating.
 *
 * Permission is two orthogonal knobs:
 *   - `sandbox`  — the capability boundary: how far the agent may reach.
 *   - `approval` — the interruption policy: whether crossing a line stops
 *                  to ask a human, or is decided outright.
 *
 * The sandbox mode yields a ceiling risk tier; the approval policy decides
 * what happens below it (and whether above it may be escalated to a human).
 * Zero I/O, zero side effects — the Runner interprets the decision.
 */

import type { RiskTier } from "./tool.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

/** The capability boundary: how far the agent may reach. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** The interruption policy: whether crossing a line stops to ask a human. */
export type ApprovalPolicy = "ask" | "never";

/** The outcome of a permission evaluation. */
export type Decision = "allow" | "deny" | "ask";

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
  decision: Decision;
}

export interface PermissionConfig {
  /** The capability boundary. */
  sandbox: SandboxMode;
  /** The interruption policy. */
  approval: ApprovalPolicy;
  /**
   * Rule set — evaluated in order, first match wins, and outranks the
   * sandbox/approval matrix. This is where a deployment's static rules live,
   * and where a host appends a session-scoped "always allow this tool"
   * decision that a user granted at an approval prompt.
   */
  rules?: PermissionRule[];
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Total order over risk tiers — the matrix compares tiers, not names. */
const TIER_RANK: Record<RiskTier, number> = {
  READ_ONLY: 0,
  WRITE_LOW: 1,
  WRITE_HIGH: 2,
  IRREVERSIBLE: 3,
};

/** Check if a risk tier is a write-class tier (not READ_ONLY) */
export function isWriteTier(tier: RiskTier): boolean {
  return tier === "WRITE_LOW" || tier === "WRITE_HIGH" || tier === "IRREVERSIBLE";
}

/** Simple glob-like pattern: supports exact match and `*` suffix (e.g., "db_*") */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return toolName === pattern;
}

/** Check if a permission rule matches a tool */
function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  toolCapabilities: Set<string>,
): boolean {
  if (rule.toolName !== undefined && rule.toolName === toolName) return true;
  if (rule.toolPattern !== undefined && matchesPattern(toolName, rule.toolPattern)) return true;
  if (rule.capability !== undefined && toolCapabilities.has(rule.capability)) return true;
  return false;
}

// ──────────────────────────────────────────────
// The matrix
// ──────────────────────────────────────────────

/** The highest risk tier a sandbox mode permits at all. */
export function ceilingOf(sandbox: SandboxMode): RiskTier {
  switch (sandbox) {
    case "read-only":
      return "READ_ONLY";
    case "workspace-write":
      return "WRITE_HIGH";
    case "danger-full-access":
      return "IRREVERSIBLE";
  }
}

/**
 * Decide one (ceiling, approval, tier) cell.
 *
 * Above the ceiling the sandbox says no; only a human can override, so an
 * `ask` policy escalates while `never` denies outright. At or below the
 * ceiling `never` allows, and `ask` stops only for the tiers worth stopping
 * for — asking about every file read would train the user to click through.
 */
export function decide(
  ceiling: RiskTier,
  approval: ApprovalPolicy,
  tier: RiskTier,
): Decision {
  if (TIER_RANK[tier] > TIER_RANK[ceiling]) {
    return approval === "ask" ? "ask" : "deny";
  }
  if (approval === "never") return "allow";
  return TIER_RANK[tier] >= TIER_RANK.WRITE_HIGH ? "ask" : "allow";
}

// ──────────────────────────────────────────────
// Core decision function
// ──────────────────────────────────────────────

/**
 * Evaluate the permission decision for a tool call.
 *
 * Lookup order (highest priority first):
 * 1. `rules[]` — pattern/capability-based rule set (first match wins)
 * 2. the sandbox x approval matrix
 *
 * There is no third layer: the matrix decides every (sandbox, approval, tier)
 * triple, so anything after it would be unreachable.
 *
 * @param toolCapabilities - the set of capabilities the tool requires
 *                           (optional, needed for rule capability matching)
 */
export function evaluatePermission(
  config: PermissionConfig,
  toolName: string,
  riskTier: RiskTier,
  toolCapabilities?: Set<string>,
): Decision {
  if (config.rules) {
    const caps = toolCapabilities ?? new Set<string>();
    for (const rule of config.rules) {
      if (ruleMatches(rule, toolName, caps)) {
        return rule.decision;
      }
    }
  }

  return decide(ceilingOf(config.sandbox), config.approval, riskTier);
}

/**
 * The default config: the "ask" preset (workspace-write + ask). The only
 * tier that both gets work done and never performs an irreversible action
 * behind the user's back.
 */
export function createDefaultPermissionConfig(): PermissionConfig {
  return { sandbox: "workspace-write", approval: "ask" };
}
