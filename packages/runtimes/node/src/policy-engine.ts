/**
 * PolicyEngine adapters for the Node runtime.
 *
 * Provides a default allow-all policy and a configurable rule-based policy
 * that consumes the M8 PolicyEngine port type.
 */

import type { PolicyEngine, PolicyRequest } from "@volto/core";

/**
 * Allow-all policy engine — grants every request.
 * Use as a safe default when no real authorization backend is configured.
 */
export function createAllowAllPolicyEngine(): PolicyEngine {
  return {
    async evaluate(): Promise<"allow" | "deny" | "ask"> {
      return "allow";
    },
  };
}

/** A single authorization rule */
export interface PolicyRule {
  /** Action pattern to match (exact string or prefix with `*` suffix) */
  action: string;
  decision: "allow" | "deny" | "ask";
}

/**
 * Rule-based policy engine — evaluates against a static rule set.
 * First match wins; no match defaults to `ask` (fail-open for unknown actions).
 */
export function createRuleBasedPolicyEngine(rules: PolicyRule[]): PolicyEngine {
  return {
    async evaluate(request: PolicyRequest): Promise<"allow" | "deny" | "ask"> {
      for (const rule of rules) {
        if (rule.action.endsWith("*")) {
          const prefix = rule.action.slice(0, -1);
          if (request.action.startsWith(prefix)) return rule.decision;
        } else if (rule.action === request.action) {
          return rule.decision;
        }
      }
      // No match → default to ask (safe fallback for unknown actions)
      return "ask";
    },
  };
}
