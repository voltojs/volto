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
  /**
   * Glob over a declared path input. Matched against both the canonical
   * absolute path and the workspace-relative form. Requires the tool to
   * declare `pathInputs` — a tool that declares none can never match, which
   * is how `bash` stays out of path rules entirely.
   */
  pathPattern?: string;
  /** Glob over a declared URL input's lowercased hostname. Requires `hostInputs`. */
  hostPattern?: string;
  /** Decision to apply when matched */
  decision: Decision;
}

/**
 * Facts the Runner resolved from a tool call's raw input. Core never computes
 * these: following a symlink and parsing a URL are I/O, and the Runner owns
 * both. A `pathPattern` / `hostPattern` rule matches only what is here.
 */
export interface ResolvedToolInput {
  /** Declared path inputs, already absolute and symlink-resolved. */
  paths?: Array<{ field: string; absolute: string; relative: string }>;
  /** Declared URL inputs, reduced to a lowercased hostname. */
  hosts?: Array<{ field: string; host: string }>;
}

export interface PermissionConfig {
  /** The capability boundary. */
  sandbox: SandboxMode;
  /** The interruption policy. */
  approval: ApprovalPolicy;
  /**
   * Rule set — evaluated in order, first match wins, and outranks the
   * sandbox/approval matrix. This is where a deployment's static rules live. A
   * session-scoped "always allow" grant from an approval prompt deliberately
   * does not exist — see docs/superpowers/specs/2026-09-10-security-roadmap-decisions.md §1.4.
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

/** Total order over risk tiers — shared with visible-set filtering. */
export function riskRank(tier: RiskTier): number {
  return TIER_RANK[tier];
}

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

/** `**` crosses a path separator, `*` does not; everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function matchesPathPattern(pattern: string, paths: ResolvedToolInput["paths"]): boolean {
  if (paths === undefined || paths.length === 0) return false;
  const re = globToRegExp(pattern);
  return paths.some((entry) => re.test(entry.absolute) || re.test(entry.relative));
}

function matchesHostPattern(pattern: string, hosts: ResolvedToolInput["hosts"]): boolean {
  if (hosts === undefined || hosts.length === 0) return false;
  const re = globToRegExp(pattern);
  return hosts.some((entry) => re.test(entry.host));
}

const TOOL_MATCH_KEYS = ["toolName", "toolPattern", "capability"] as const;
const PARAM_MATCH_KEYS = ["pathPattern", "hostPattern"] as const;

/**
 * Tool-level keys are one group (OR within it), parameter keys a second (OR
 * within it), and the two groups are ANDed. So `{toolName, pathPattern}` means
 * "this tool AND this path", not "this tool OR this path".
 */
function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  toolCapabilities: Set<string>,
  resolved: ResolvedToolInput | undefined,
): boolean {
  const hasToolKey = TOOL_MATCH_KEYS.some((key) => rule[key] !== undefined);
  const hasParamKey = PARAM_MATCH_KEYS.some((key) => rule[key] !== undefined);
  // A keyless rule would otherwise match every call. The config validators
  // reject one; it stays inert here so a hand-built config cannot become a
  // blanket deny.
  if (!hasToolKey && !hasParamKey) return false;

  if (hasToolKey) {
    const toolHit =
      (rule.toolName !== undefined && rule.toolName === toolName) ||
      (rule.toolPattern !== undefined && matchesPattern(toolName, rule.toolPattern)) ||
      (rule.capability !== undefined && toolCapabilities.has(rule.capability));
    if (!toolHit) return false;
  }

  if (hasParamKey) {
    const paramHit =
      (rule.pathPattern !== undefined && matchesPathPattern(rule.pathPattern, resolved?.paths)) ||
      (rule.hostPattern !== undefined && matchesHostPattern(rule.hostPattern, resolved?.hosts));
    if (!paramHit) return false;
  }

  return true;
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

/** deny is stricter than ask, which is stricter than allow. */
const DECISION_RANK: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };

function moreRestrictive(a: Decision, b: Decision): Decision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

/**
 * Evaluate the permission decision for a tool call.
 *
 * Lookup order (highest priority first):
 * 1. `rules[]` — pattern/capability/parameter rules (first match wins)
 * 2. the sandbox x approval matrix
 *
 * Rules may tighten freely, and below the sandbox ceiling they may also turn
 * an "ask" into an "allow". Above the ceiling the sandbox has already spoken:
 * a rule can only make the outcome stricter, never more permissive —
 * otherwise a config file could write through a read-only session.
 *
 * @param resolved - parameter facts the Runner resolved from the raw input;
 *                   required for `pathPattern` / `hostPattern` to match.
 */
export function evaluatePermission(
  config: PermissionConfig,
  toolName: string,
  riskTier: RiskTier,
  toolCapabilities?: Set<string>,
  resolved?: ResolvedToolInput,
): Decision {
  const ceiling = ceilingOf(config.sandbox);
  const base = decide(ceiling, config.approval, riskTier);

  if (config.rules) {
    const caps = toolCapabilities ?? new Set<string>();
    for (const rule of config.rules) {
      if (!ruleMatches(rule, toolName, caps, resolved)) continue;
      if (TIER_RANK[riskTier] > TIER_RANK[ceiling]) {
        return moreRestrictive(rule.decision, base);
      }
      return rule.decision;
    }
  }

  return base;
}

/**
 * Whether any rule needs parameter facts (paths / hostnames) resolved. The
 * Runner skips that I/O entirely when this is false.
 */
export function hasParameterRules(config: PermissionConfig): boolean {
  return (config.rules ?? []).some(
    (rule) => rule.pathPattern !== undefined || rule.hostPattern !== undefined,
  );
}

/**
 * The default config: the "ask" preset (workspace-write + ask). The only
 * tier that both gets work done and never performs an irreversible action
 * behind the user's back.
 */
export function createDefaultPermissionConfig(): PermissionConfig {
  return { sandbox: "workspace-write", approval: "ask" };
}

/**
 * Combine a parent policy with a sub-agent's declared policy, taking the
 * stricter option on every axis.
 *
 * Narrowing only, never widening: the agent can write files inside the
 * workspace, so it can write an agent definition too. If a definition could
 * widen permissions, writing one that declares danger-full-access and then
 * invoking it would be a complete privilege-escalation path around the
 * parent session's limits.
 */
export function narrowPermission(
  parent: PermissionConfig,
  child?: PermissionConfig,
): PermissionConfig {
  if (!child) {
    // Shallow copy: never hand out a live alias of the parent config.
    return { ...parent };
  }

  const sandbox =
    TIER_RANK[ceilingOf(child.sandbox)] < TIER_RANK[ceilingOf(parent.sandbox)]
      ? child.sandbox
      : parent.sandbox;

  const approval = parent.approval === "ask" || child.approval === "ask" ? "ask" : "never";

  // Parent denies come first, so no child rule can override them: rules are
  // first-match-wins and outrank the sandbox×approval matrix. A child `allow`
  // would therefore bypass the narrowed ceiling — drop it. Child `deny`/`ask`
  // only tighten; keep those.
  //
  // The parent's own `allow` rules are dropped too, and for the same reason
  // read the other way: an exemption granted to the parent session (a deployment
  // rule, or an agent definition's own rule) outranks the matrix, so
  // carrying it into a child narrowed to read-only would let the child write
  // anyway and make the definition's sandbox decoration. Everything that only
  // tightens — the parent's `ask` rules — is kept.
  const parentDenies = (parent.rules ?? []).filter((r) => r.decision === "deny");
  const childNarrowing = (child.rules ?? []).filter((r) => r.decision !== "allow");
  const parentAsks = (parent.rules ?? []).filter((r) => r.decision === "ask");

  const rules = [...parentDenies, ...childNarrowing, ...parentAsks];
  return {
    sandbox,
    approval,
    ...(rules.length > 0 ? { rules } : {}),
  };
}

/**
 * The model-facing wording for a tool refused by the permission matrix.
 *
 * Replaces a bare "denied by permission policy", which reads like a
 * malfunction and invites the model to retry through a different tool. Three
 * things have to be said: that a human configured this deliberately, that
 * reaching the same effect another way defeats it, and what the user can
 * change — a refusal with no exit leaves the model looping or improvising.
 *
 * The prohibition is scoped to an EQUIVALENT path, not to switching tools at
 * all: falling back from `write_file` to `edit_file` is ordinary tool
 * selection and must stay allowed.
 */
export function policyDenialMessage(toolName: string, config: PermissionConfig): string {
  return (
    `Tool "${toolName}" was refused by the permission policy in force for this ` +
    `session (sandbox: ${config.sandbox}, approval: ${config.approval}). This is ` +
    `a boundary the user configured deliberately, not a failure of the tool.\n\n` +
    `Do not route around this refusal: do not reach the refused effect through ` +
    `another tool, and in particular do not use \`bash\` to run an equivalent ` +
    `command. Picking a different tool for work that was not refused is ordinary ` +
    `tool selection and stays fine. Stop this line of work and tell the user ` +
    `what was refused and which permission setting would allow it.`
  );
}

/**
 * The model-facing wording for a tool call a human reviewed and declined.
 *
 * Deliberately distinct from `policyDenialMessage`: a configured policy refuses
 * a whole class of calls and names the setting that would change it, whereas
 * this is one person answering "no" to one proposal. Telling them to go edit a
 * permission setting would misread that answer.
 *
 * It still has to carry the same three things, because the observed failure —
 * a refused `git_push` re-run through `bash` — happens on this path too, and on
 * the default preset (`workspace-write` + `ask`) it is the ONLY path an
 * IRREVERSIBLE tool ever takes. As in `policyDenialMessage`, the prohibition is
 * scoped to reaching the REFUSED effect another way, not to switching tools.
 */
export function userDenialMessage(toolName: string): string {
  return (
    `Tool "${toolName}" was denied by the user: they reviewed this specific ` +
    `call and declined it. That is a considered answer to what you proposed, ` +
    `not a failure of the tool.\n\n` +
    `Do not route around the refusal: do not reach the declined effect through ` +
    `another tool — in particular, do not use \`bash\` to run an equivalent ` +
    `command — and do not re-issue the same call hoping for a different answer. ` +
    `Picking a different tool for work that was not declined is ordinary tool ` +
    `selection and stays fine. Stop this line of work and tell the user what you ` +
    `were about to do and why, so they can decide how to proceed; do not ` +
    `improvise a substitute.`
  );
}
