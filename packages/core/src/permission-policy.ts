/**
 * PermissionPolicy — pure decision logic for tool permission gating.
 *
 * Determines whether a tool call should be allowed, denied, or require
 * human approval based on the tool's risk tier and a configuration.
 * Zero I/O, zero side effects — the Runner interprets the decision.
 */

import type { RiskTier } from "./tool.js";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface PermissionConfig {
  /** Default decision per risk tier */
  defaults: Record<RiskTier, "allow" | "deny" | "ask">;
  /** Per-tool name overrides (takes precedence over tier defaults) */
  toolOverrides?: Record<string, "allow" | "deny" | "ask">;
}

// ──────────────────────────────────────────────
// Core decision function
// ──────────────────────────────────────────────

/**
 * Evaluate the permission decision for a tool call.
 *
 * Lookup order:
 * 1. `toolOverrides[toolName]` — explicit per-tool override
 * 2. `defaults[riskTier]` — tier-based default
 * 3. `"ask"` — safe fallback for unknown tiers
 */
export function evaluatePermission(
  config: PermissionConfig,
  toolName: string,
  riskTier: RiskTier,
): "allow" | "deny" | "ask" {
  // 1. Per-tool override
  if (config.toolOverrides?.[toolName] !== undefined) {
    return config.toolOverrides[toolName]!;
  }

  // 2. Tier default
  if (config.defaults[riskTier] !== undefined) {
    return config.defaults[riskTier]!;
  }

  // 3. Unknown tier → ask (safe fallback)
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
