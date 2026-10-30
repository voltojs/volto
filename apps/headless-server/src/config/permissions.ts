/**
 * Parameter permission rules — the `permissions` section of `config.json`,
 * loaded once per session build (an edit reaches newly built sessions without
 * a restart), same pattern as the `egress` section.
 *
 * Scope, stated plainly because pretending otherwise is the illusion
 * SAFETY.md warns about: a `pathPattern` only speaks about tools that declare
 * their path inputs (the filesystem tools). `bash` declares none, so a path
 * rule does not constrain the shell at all. A `hostPattern` is an approval
 * filter over the tools that declare a URL input — the actual network
 * boundary is `egress.json` on the Network port.
 *
 * Fail-closed: a malformed file refuses the build instead of silently running
 * without the rules, and unknown keys are rejected so a typo cannot quietly
 * disable the whole set.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Decision, PermissionConfig, PermissionRule } from "@volto/core";
import { isMatchableCommandToken } from "@volto/core";
import { ConfigCorruptError } from "./io.js";
import { getConfigStore } from "./store.js";

const TOP_LEVEL_KEYS = ["rules"] as const;
const STRING_MATCH_KEYS = ["toolName", "toolPattern", "capability", "pathPattern", "hostPattern"] as const;
/** Every key that can make a rule match, including the array-valued one. */
const MATCH_KEYS = [...STRING_MATCH_KEYS, "commandPrefix"] as const;
const RULE_KEYS = [...MATCH_KEYS, "decision"] as const;
const DECISIONS: ReadonlySet<string> = new Set<Decision>(["allow", "deny", "ask"]);
const MAX_RULES = 100;
const MAX_COMMAND_TOKENS = 8;

export class PermissionRulesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionRulesConfigError";
  }
}

/** Expand a leading `~` so a rule cannot silently never match. */
function expandHome(pattern: string): string {
  if (pattern === "~") return os.homedir();
  if (pattern.startsWith("~/")) return path.join(os.homedir(), pattern.slice(2));
  return pattern;
}

function parseRule(value: unknown, where: string): PermissionRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermissionRulesConfigError(`${where} must be an object`);
  }
  const obj = value as Record<string, unknown>;

  const unknown = Object.keys(obj).filter((key) => !(RULE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new PermissionRulesConfigError(
      `${where} has unknown key(s): ${unknown.join(", ")} — expected ${RULE_KEYS.join(" / ")}`,
    );
  }

  const decision = obj["decision"];
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    throw new PermissionRulesConfigError(`${where}.decision must be one of allow / deny / ask`);
  }

  const rule: PermissionRule = { decision: decision as Decision };
  for (const key of STRING_MATCH_KEYS) {
    const raw = obj[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new PermissionRulesConfigError(`${where}.${key} must be a non-empty string`);
    }
    const value = key === "pathPattern" ? expandHome(raw.trim()) : raw.trim();
    if (key === "toolName") rule.toolName = value;
    else if (key === "toolPattern") rule.toolPattern = value;
    else if (key === "capability") rule.capability = value;
    else if (key === "pathPattern") rule.pathPattern = value;
    else rule.hostPattern = value;
  }

  // commandPrefix is array-valued — handled separately from the string-key loop.
  const commandPrefix = obj["commandPrefix"];
  if (commandPrefix !== undefined) {
    if (!Array.isArray(commandPrefix) || commandPrefix.length === 0) {
      throw new PermissionRulesConfigError(
        `${where}.commandPrefix must be a non-empty array of tokens`,
      );
    }
    if (commandPrefix.length > MAX_COMMAND_TOKENS) {
      throw new PermissionRulesConfigError(
        `${where}.commandPrefix supports at most ${MAX_COMMAND_TOKENS} tokens`,
      );
    }
    for (const token of commandPrefix) {
      if (typeof token !== "string" || !isMatchableCommandToken(token)) {
        throw new PermissionRulesConfigError(
          `${where}.commandPrefix tokens must be non-empty strings without whitespace or shell metacharacters`,
        );
      }
    }
    rule.commandPrefix = [...(commandPrefix as string[])];
  }

  if (!MATCH_KEYS.some((key) => rule[key] !== undefined)) {
    throw new PermissionRulesConfigError(
      `${where} needs at least one match key (${MATCH_KEYS.join(" / ")})`,
    );
  }

  // Cross-constraints for command prefix rules.
  if (rule.commandPrefix !== undefined) {
    // A command-only rule would silently start matching any future tool that
    // declares a command input (an ssh/docker executor, say). Require the
    // author to name the tool.
    if (rule.toolName === undefined && rule.toolPattern === undefined) {
      throw new PermissionRulesConfigError(
        `${where}.commandPrefix requires a toolName or toolPattern match key`,
      );
    }
    // Allow-only: a deny/ask prefix rule fails open on everything it does not
    // match, which is the illusion this feature must not create.
    if (rule.decision !== "allow") {
      throw new PermissionRulesConfigError(
        `${where}.commandPrefix is allow-only; a "${rule.decision}" rule would permit whatever it fails to match`,
      );
    }
  }

  return rule;
}

/**
 * Validate one rule with the loader's own constraints. Exported so the
 * one-click "remember" path cannot drift from what the loader accepts —
 * two copies of "allow-only, tool-scoped, ≤8 matchable tokens" is exactly
 * how a saved rule ends up being one the loader later refuses.
 */
export function validatePermissionRule(value: unknown, where = "remembered rule"): PermissionRule {
  return parseRule(value, where);
}

/** Load parameter rules from `config.json`'s permissions section. `[]` when absent. */
export async function loadPermissionRules(configDir: string): Promise<PermissionRule[]> {
  let section: unknown;
  try {
    section = (await getConfigStore(configDir).read())["permissions"];
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      throw new PermissionRulesConfigError(
        `config.json could not be read: ${err.message}`,
      );
    }
    throw err;
  }
  if (section === undefined) return [];
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new PermissionRulesConfigError("config.json: permissions must be a JSON object");
  }
  const obj = section as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((key) => !(TOP_LEVEL_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new PermissionRulesConfigError(
      `config.json: permissions has unknown key(s): ${unknown.join(", ")} — expected ${TOP_LEVEL_KEYS.join(" / ")}`,
    );
  }
  const rules = obj["rules"];
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new PermissionRulesConfigError("config.json: permissions.rules must be an array");
  if (rules.length > MAX_RULES) {
    throw new PermissionRulesConfigError(`config.json: at most ${MAX_RULES} rules are supported`);
  }
  return rules.map((rule, index) => parseRule(rule, `config.json: permissions.rules[${index}]`));
}

/** User rules first: rules are first-match-wins, so user intent outranks presets. */
export function mergePermissionRules(
  config: PermissionConfig,
  rules: PermissionRule[],
): PermissionConfig {
  if (rules.length === 0) return config;
  return { ...config, rules: [...rules, ...(config.rules ?? [])] };
}

// ---------------------------------------------------------------------------
// savePermissionRule — atomic append for the one-click "remember" flow
// ---------------------------------------------------------------------------

export type SaveRuleResult =
  | { status: "saved"; rule: PermissionRule }
  | { status: "duplicate"; rule: PermissionRule }
  | { status: "covered"; by: PermissionRule };

/**
 * Check whether an existing rule's tool key matches the candidate's concrete
 * tool name — by equality, or by the existing rule's `prefix*` pattern.
 *
 * Coverage is only defined when the candidate names a concrete tool; a
 * candidate that carries only a `toolPattern` has no well-defined reach
 * against an existing rule, so we conservatively return false.  This is a
 * deliberate limitation, not an oversight.
 *
 * The `prefix*` path mirrors core's `matchesPattern` semantics locally on
 * purpose — this host package does not import core internals, so a future
 * change to one should be recognisably mirrored in the other.
 */
function toolKeyMatches(existing: PermissionRule, candidate: PermissionRule): boolean {
  // Coverage only makes sense when the candidate pins a concrete tool name.
  // A pattern-only candidate's reach is not compared here — deliberate.
  if (candidate.toolName === undefined) return false;

  if (existing.toolName !== undefined) {
    return existing.toolName === candidate.toolName;
  }

  if (existing.toolPattern !== undefined) {
    const pattern = existing.toolPattern;
    // Mirror core's matchesPattern: `foo*` does startsWith("foo"), exact otherwise.
    return pattern.endsWith("*")
      ? candidate.toolName.startsWith(pattern.slice(0, -1))
      : candidate.toolName === pattern;
  }

  return false;
}

function sameTokenList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((t, i) => t === b[i]);
}

function isIdentical(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.decision === b.decision &&
    a.toolName === b.toolName &&
    a.toolPattern === b.toolPattern &&
    a.capability === b.capability &&
    a.pathPattern === b.pathPattern &&
    a.hostPattern === b.hostPattern &&
    sameTokenList(a.commandPrefix, b.commandPrefix)
  );
}

/** A broader allow rule makes a narrower one pointless (spec D4). */
function covers(existing: PermissionRule, candidate: PermissionRule): boolean {
  if (existing.decision !== "allow" || candidate.decision !== "allow") return false;
  if (!toolKeyMatches(existing, candidate)) return false;
  const e = existing.commandPrefix;
  const c = candidate.commandPrefix;
  if (e === undefined || c === undefined) return false;
  return c.length >= e.length && e.every((token, index) => c[index] === token);
}

/**
 * Append one remembered rule to the config document.
 *
 * Read-modify-write under the config store's per-directory lock, and never
 * through a corrupt document: a failed read throws instead of reporting
 * "empty", so a save can never turn one damaged file into a total loss of the
 * rules it used to hold.
 */
export async function savePermissionRule(
  configDir: string,
  candidate: unknown,
): Promise<SaveRuleResult> {
  const rule = validatePermissionRule(candidate);
  let result: SaveRuleResult | undefined;
  await getConfigStore(configDir).update<Record<string, unknown>>(
    "permissions",
    async (current) => {
      // The raw section is preserved as-is so a hand-edited document keeps
      // whatever it had; the validated view drives dedup/coverage (~ is
      // expanded there, and writing that expansion back would lose the
      // author's original form).
      const doc = current ?? {};
      const existing = await loadPermissionRules(configDir);

      for (const candidateRule of existing) {
        if (isIdentical(candidateRule, rule)) {
          result = { status: "duplicate", rule };
          return doc;
        }
        if (covers(candidateRule, rule)) {
          result = { status: "covered", by: candidateRule };
          return doc;
        }
      }

      const rawRules = Array.isArray(doc["rules"]) ? (doc["rules"] as unknown[]) : [];
      result = { status: "saved", rule };
      return { ...doc, rules: [...rawRules, rule] };
    },
  );
  if (result === undefined) {
    throw new Error("savePermissionRule: update completed without a result");
  }
  return result;
}
