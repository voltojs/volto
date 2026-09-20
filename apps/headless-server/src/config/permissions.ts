/**
 * Parameter permission rules — `permissions.json` in the user config dir,
 * loaded once per session build (an edit reaches newly built sessions without
 * a restart), same pattern as `egress.json`.
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

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Decision, PermissionConfig, PermissionRule } from "@volto/core";
import { isMatchableCommandToken } from "@volto/core";
import { readJsonFile, writeJsonFileAtomic } from "./io.js";

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

/** Load parameter rules from `<configDir>/permissions.json`. `[]` when absent. */
export async function loadPermissionRules(configDir: string): Promise<PermissionRule[]> {
  const file = path.join(configDir, "permissions.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PermissionRulesConfigError(
      `permissions.json exists but could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PermissionRulesConfigError(
      `permissions.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PermissionRulesConfigError("permissions.json must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((key) => !(TOP_LEVEL_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new PermissionRulesConfigError(
      `permissions.json has unknown key(s): ${unknown.join(", ")} — expected ${TOP_LEVEL_KEYS.join(" / ")}`,
    );
  }
  const rules = obj["rules"];
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new PermissionRulesConfigError("permissions.json: \"rules\" must be an array");
  if (rules.length > MAX_RULES) {
    throw new PermissionRulesConfigError(`permissions.json: at most ${MAX_RULES} rules are supported`);
  }
  return rules.map((rule, index) => parseRule(rule, `permissions.json: rules[${index}]`));
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

/** Same tool key resolution as core's matcher: exact name, or `prefix*`. */
function toolKeyMatches(existing: PermissionRule, candidate: PermissionRule): boolean {
  if (existing.toolName !== undefined && candidate.toolName !== undefined) {
    return existing.toolName === candidate.toolName;
  }
  if (existing.toolPattern !== undefined && candidate.toolName !== undefined) {
    const pattern = existing.toolPattern;
    return pattern.endsWith("*")
      ? candidate.toolName.startsWith(pattern.slice(0, -1))
      : candidate.toolName === pattern;
  }
  return false;
}

function samePrefix(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
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
    samePrefix(a.commandPrefix, b.commandPrefix)
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

// One writer in this process (the gateway); a promise chain is enough to keep
// two clicks from interleaving a read-modify-write into a lost update.
let saveChain: Promise<unknown> = Promise.resolve();
function withSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = saveChain.then(fn, fn);
  saveChain = next.catch(() => undefined);
  return next;
}

/**
 * Append one remembered rule to the user-level permissions.json.
 *
 * Read-modify-write under a process lock, and never through a corrupt file:
 * `readJsonFile` throws rather than reporting "empty", so a save can never
 * turn one damaged file into a total loss of the rules it used to hold.
 */
export async function savePermissionRule(
  configDir: string,
  candidate: unknown,
): Promise<SaveRuleResult> {
  const rule = validatePermissionRule(candidate);
  return withSaveLock(async () => {
    const file = path.join(configDir, "permissions.json");
    const doc = await readJsonFile<Record<string, unknown>>(file, {});
    const existing = await loadPermissionRules(configDir);

    for (const current of existing) {
      if (isIdentical(current, rule)) return { status: "duplicate", rule };
      if (covers(current, rule)) return { status: "covered", by: current };
    }

    const rawRules = Array.isArray(doc["rules"]) ? (doc["rules"] as unknown[]) : [];
    await writeJsonFileAtomic(file, { ...doc, rules: [...rawRules, rule] });
    return { status: "saved", rule };
  });
}
