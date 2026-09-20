/**
 * Agent definition file parsing: a YAML subset, not a YAML parser.
 *
 * Agent frontmatter needs more than skill frontmatter: inline arrays for
 * tool lists, inline objects for policy, and typed scalars (numbers, bools).
 * A dependency-free subset covers what `.volto/agents/*.md` files actually
 * use; anything the subset cannot parse is reported as an error object so a
 * single malformed file never takes the registry down.
 */

import type {
  PermissionConfig,
  PermissionRule,
  SandboxMode,
  ApprovalPolicy,
  Decision,
} from "@volto/core";
import type { JSONSchema } from "@volto/core";
import { isMatchableCommandToken } from "@volto/core";
import type { AgentSpec } from "../agent-spec.js";

export interface ParsedAgentFile {
  spec: AgentSpec;
  /** Frontmatter keys this parser does not own, preserved for round-trip. */
  unknownKeys: Record<string, unknown>;
}

/** Frontmatter keys that map onto AgentSpec fields. */
const OWNED_KEYS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "maxTokens",
  "temperature",
  "reasoningEffort",
  "capabilities",
  "policy",
  "maxIterations",
  "maxToolCalls",
  "enableTaskTool",
  "responseFormat",
]);

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(["ask", "never"]);

const DECISIONS = new Set<Decision>(["allow", "deny", "ask"]);

const POLICY_KEYS = new Set(["sandbox", "approval", "rules"]);

// ──────────────────────────────────────────────
// YAML-subset value parsing
// ──────────────────────────────────────────────

/** Strips one pair of matching surrounding quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Strips a trailing YAML-style inline comment from a freshly parsed scalar
 * value. Real YAML only starts a comment at a `#` preceded by whitespace (or
 * at the start of the value) and not inside quotes; `#` glued to preceding
 * text (`C#`, `a#b`) is ordinary data. Runs before `unquote()` so a `#`
 * inside a quoted value is never mistaken for a comment.
 */
function stripInlineComment(value: string): string {
  let inQuote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

/**
 * Splits on `sep` at bracket depth 0, ignoring separators inside quotes.
 * Throws on unbalanced brackets or unterminated quotes — those are the
 * malformed forms (`[unclosed`, nested-structure typos) that must surface
 * as parse errors rather than silently truncated values.
 */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) throw new Error(`unterminated quote in "${s}"`);
  if (depth !== 0) throw new Error(`unbalanced brackets in "${s}"`);
  parts.push(current);
  return parts;
}

/** Parses a single scalar / inline-array / inline-object value. */
function parseValue(raw: string): unknown {
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw new Error(`malformed array value: ${raw}`);
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map((p) => parseValue(p.trim()));
  }
  if (raw.startsWith("{")) {
    if (!raw.endsWith("}")) throw new Error(`malformed object value: ${raw}`);
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return {};
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevel(inner, ",")) {
      // A quoted key (serializeAgentFile emits one when the key contains
      // `,`/`:` etc.) ends at its matching quote; the separating colon is
      // the first one after it, not the first one in the part.
      const trimmedPart = part.trim();
      const quote = trimmedPart[0];
      let key: string;
      let valRaw: string;
      if (quote === '"' || quote === "'") {
        let end = -1;
        for (let i = 1; i < trimmedPart.length; i++) {
          if (trimmedPart[i] === quote) {
            end = i;
            break;
          }
        }
        if (end < 0) throw new Error(`unterminated quoted key: ${trimmedPart}`);
        key = trimmedPart.slice(1, end);
        const rest = trimmedPart.slice(end + 1).trim();
        if (!rest.startsWith(":")) throw new Error(`malformed object entry: ${trimmedPart}`);
        valRaw = rest.slice(1).trim();
      } else {
        const idx = trimmedPart.indexOf(":");
        if (idx < 0) throw new Error(`malformed object entry: ${trimmedPart}`);
        key = trimmedPart.slice(0, idx).trim();
        valRaw = trimmedPart.slice(idx + 1).trim();
      }
      if (key.length === 0) throw new Error(`empty key in object: ${trimmedPart}`);
      obj[key] = parseValue(valRaw);
    }
    return obj;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return unquote(raw);
}

/**
 * Parses the `key: value` lines of a frontmatter block into a map of
 * typed values. One key per line; no multi-line nested indentation (agent
 * files use inline objects/arrays instead).
 */
function parseYamlSubset(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) throw new Error(`malformed line: ${line}`);
    const key = trimmed.slice(0, idx).trim();
    if (key.length === 0) throw new Error(`empty key: ${line}`);
    const rawValue = stripInlineComment(trimmed.slice(idx + 1).trim());
    result[key] = parseValue(rawValue);
  }
  return result;
}

// ──────────────────────────────────────────────
// Policy validation
// ──────────────────────────────────────────────

const RULE_MATCH_KEYS = [
  "toolName",
  "toolPattern",
  "capability",
  "pathPattern",
  "hostPattern",
] as const;

function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const decision = obj["decision"];
  if (typeof decision !== "string" || !DECISIONS.has(decision as Decision)) {
    return false;
  }
  // Only the documented match fields are accepted; unknown fields are not
  // silently dropped — they fail the whole policy so a broken AgentSpec
  // never enters the registry.
  //
  // `commandPrefix` is array-valued so it must be checked separately from
  // the string match keys to avoid being rejected by the string-type guard.
  const STRING_MATCH_KEYS = (RULE_MATCH_KEYS as readonly string[]);
  for (const key of Object.keys(obj)) {
    if (key !== "decision" && key !== "commandPrefix" && !STRING_MATCH_KEYS.includes(key)) {
      return false;
    }
  }
  for (const key of STRING_MATCH_KEYS) {
    const raw = obj[key];
    if (raw !== undefined && (typeof raw !== "string" || raw.trim().length === 0)) {
      return false;
    }
  }
  // commandPrefix validation: non-empty array, at most 8 entries, each a
  // non-empty string passing isMatchableCommandToken. A commandPrefix rule
  // also requires a tool selector (toolName or toolPattern) and must be an
  // allow decision — prefix rules can only turn "ask" into "allow", never
  // deny.
  if (obj["commandPrefix"] !== undefined) {
    const cp = obj["commandPrefix"];
    if (!Array.isArray(cp) || cp.length === 0 || cp.length > 8) {
      return false;
    }
    if (typeof decision !== "string" || decision !== "allow") {
      return false;
    }
    if (!STRING_MATCH_KEYS.includes("toolName") && !STRING_MATCH_KEYS.includes("toolPattern")) {
      // defensive: should never happen since both are in RULE_MATCH_KEYS
      return false;
    }
    if (obj["toolName"] === undefined && obj["toolPattern"] === undefined) {
      return false;
    }
    for (const token of cp) {
      if (typeof token !== "string" || !isMatchableCommandToken(token)) {
        return false;
      }
    }
  }
  // A rule with no match key would match every tool call; reject it at the
  // definition instead of letting it become a blanket deny.
  if (!STRING_MATCH_KEYS.some((key) => obj[key] !== undefined) && obj["commandPrefix"] === undefined) {
    return false;
  }
  // A pathPattern is a filesystem path the Runner matches against a real
  // path, and this parser has no business reading $HOME. A literal `~` would
  // reach core, match nothing, and look like a rule that works — reject it
  // and make the author write an absolute or workspace-relative path. (The
  // user-level ~/.volto/permissions.json loader *does* expand `~`, because
  // there the loader itself is the I/O boundary.)
  if (typeof obj["pathPattern"] === "string" && obj["pathPattern"].startsWith("~")) return false;
  return true;
}

/**
 * Type guard for a conservative subset of `PermissionConfig`. The file may
 * specify only some of `sandbox` / `approval` / `rules`; assembly fills the
 * rest from parent policy / defaults. Unknown keys or values fail the file.
 */
function isPolicy(value: unknown): value is PermissionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!POLICY_KEYS.has(k)) return false;
  }
  if (obj["sandbox"] !== undefined) {
    if (
      typeof obj["sandbox"] !== "string" ||
      !SANDBOX_MODES.has(obj["sandbox"] as SandboxMode)
    ) {
      return false;
    }
  }
  if (obj["approval"] !== undefined) {
    if (
      typeof obj["approval"] !== "string" ||
      !APPROVAL_POLICIES.has(obj["approval"] as ApprovalPolicy)
    ) {
      return false;
    }
  }
  if (obj["rules"] !== undefined) {
    if (!Array.isArray(obj["rules"])) return false;
    for (const rule of obj["rules"]) {
      if (!isPermissionRule(rule)) return false;
    }
  }
  return true;
}

/**
 * Type guard for `AgentSpec["responseFormat"]`. Only `type: "json"` exists
 * today; the schema itself is passed through to the provider untouched, so
 * it is checked for shape (an object) rather than validated as JSON Schema.
 */
function isResponseFormat(
  value: unknown,
): value is { type: "json"; schema?: JSONSchema } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== "type" && k !== "schema") return false;
  }
  if (obj["type"] !== "json") return false;
  if (obj["schema"] !== undefined) {
    const schema = obj["schema"];
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      return false;
    }
  }
  return true;
}

// ──────────────────────────────────────────────
// Owned-field type validation
// ──────────────────────────────────────────────

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Expected type for each owned key other than `name` / `policy` (those have
 * dedicated checks with clearer messages). Present-but-wrong-typed values
 * fail the whole file — same policy as invalid `policy` — so a typo'd
 * `tools: read_file` (bare string) never silently drops the tool list and
 * falls through to assembly defaults.
 */
const OWNED_FIELD_TYPES: Record<string, (v: unknown) => boolean> = {
  description: (v) => typeof v === "string",
  tools: isStringArray,
  model: (v) => typeof v === "string",
  maxTokens: (v) => typeof v === "number",
  temperature: (v) => typeof v === "number",
  reasoningEffort: (v) => typeof v === "string",
  capabilities: isStringArray,
  maxIterations: (v) => typeof v === "number",
  maxToolCalls: (v) => typeof v === "number",
  enableTaskTool: (v) => typeof v === "boolean",
  responseFormat: isResponseFormat,
};

/** Returns the offending key when a present owned field has the wrong type. */
function wrongTypedOwnedKey(front: Record<string, unknown>): string | undefined {
  for (const [key, ok] of Object.entries(OWNED_FIELD_TYPES)) {
    if (front[key] === undefined) continue;
    if (!ok(front[key])) return key;
  }
  return undefined;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Parse an agent definition file.
 *
 * Returns an error object rather than throwing: one malformed file must not
 * take the whole registry down with it (see scan.ts, which skips and warns).
 */
export function parseAgentFile(
  raw: string,
  filePath: string,
): ParsedAgentFile | { error: string } {
  // Windows-authored files use CRLF; normalize so the frontmatter regex and
  // field splitting both see bare \n.
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { error: `${filePath}: missing frontmatter block` };

  let front: Record<string, unknown>;
  try {
    front = parseYamlSubset(match[1] ?? "");
  } catch (err) {
    return {
      error: `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const name = front["name"];
  if (typeof name !== "string" || name.trim() === "") {
    return { error: `${filePath}: "name" is required` };
  }

  // Present-but-invalid policy fails the file; absent policy is fine.
  if (front["policy"] !== undefined) {
    if (!isPolicy(front["policy"])) {
      return {
        error:
          `${filePath}: invalid "policy" — expected an object with known ` +
          `keys sandbox / approval / rules and known values`,
      };
    }
  }

  // Present-but-wrong-typed owned fields fail the file (never silently
  // dropped): a wrong-typed `tools` would otherwise hand the agent the
  // assembly default tool set instead of the author's intended list.
  const badKey = wrongTypedOwnedKey(front);
  if (badKey !== undefined) {
    return {
      error: `${filePath}: invalid "${badKey}" — wrong type for an owned frontmatter field`,
    };
  }

  const unknownKeys: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(front)) {
    if (!OWNED_KEYS.has(k)) unknownKeys[k] = v;
  }

  const body = (match[2] ?? "").trim();
  const spec: AgentSpec = {
    name,
    ...(typeof front["description"] === "string"
      ? { description: front["description"] }
      : {}),
    ...(body ? { systemPrompt: body } : {}),
    ...(isStringArray(front["tools"]) ? { tools: front["tools"] } : {}),
    ...(typeof front["model"] === "string" ? { model: front["model"] } : {}),
    ...(typeof front["maxTokens"] === "number"
      ? { maxTokens: front["maxTokens"] }
      : {}),
    ...(typeof front["temperature"] === "number"
      ? { temperature: front["temperature"] }
      : {}),
    ...(typeof front["reasoningEffort"] === "string"
      ? { reasoningEffort: front["reasoningEffort"] }
      : {}),
    ...(isStringArray(front["capabilities"])
      ? { capabilities: front["capabilities"] }
      : {}),
    ...(typeof front["maxIterations"] === "number"
      ? { maxIterations: front["maxIterations"] }
      : {}),
    ...(typeof front["maxToolCalls"] === "number"
      ? { maxToolCalls: front["maxToolCalls"] }
      : {}),
    ...(typeof front["enableTaskTool"] === "boolean"
      ? { enableTaskTool: front["enableTaskTool"] }
      : {}),
    ...(isResponseFormat(front["responseFormat"])
      ? { responseFormat: front["responseFormat"] }
      : {}),
    ...(isPolicy(front["policy"]) ? { policy: front["policy"] } : {}),
  };

  return { spec, unknownKeys };
}
