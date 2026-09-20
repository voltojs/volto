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

function parseRule(value: unknown, index: number): PermissionRule {
  const where = `permissions.json: rules[${index}]`;
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
  return rules.map((rule, index) => parseRule(rule, index));
}

/** User rules first: rules are first-match-wins, so user intent outranks presets. */
export function mergePermissionRules(
  config: PermissionConfig,
  rules: PermissionRule[],
): PermissionConfig {
  if (rules.length === 0) return config;
  return { ...config, rules: [...rules, ...(config.rules ?? [])] };
}
