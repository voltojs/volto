import type { ScopeGroupConfig, ToolDefinition, ToolScopeConfig } from "@voltojs/core";

/**
 * Default tool visibility synthesizer (T3 toolset governance).
 *
 * Pure: no I/O, deterministic, no sorting. Given the actual assembled tool
 * list and the assembly state, it produces a five-tier `ToolScopeConfig`
 * (spec 2026-10-15-toolset-governance-design.md, D3/D4) plus a fixed
 * `limit` of 20 (21 with memory; 30 with browser; 25 with LSP; 35 with
 * browser + LSP).
 *
 * Every actual tool is mapped to exactly one group that is present in
 * `groups`: `filterByScope` keeps only tools whose group exists and is
 * enabled, so an unmapped tool would be dropped wholesale. Unknown, plugin,
 * and future tool names therefore fall to the zero-priority `rest` tier and
 * merely compete for the cap instead of disappearing.
 */

/** Assembly state: which mode adapters were wired into this agent. */
export interface AssemblyPresence {
  hasLsp: boolean; // opts.lsp !== undefined
  hasDb: boolean; // opts.db !== undefined
  hasBrowser: boolean; // opts.browserAdapter !== undefined
  hasMemory: boolean; // opts.memoryStore !== undefined && memory.tools !== false
}

/** Shape consumed by the toolVisibility wiring (defaults filled in by us). */
export interface ToolVisibility {
  scope?: ToolScopeConfig;
  limit?: number;
}

/** Hard cap on the default visible tool set. */
const DEFAULT_TOOL_VISIBILITY_LIMIT = 20;

// Five-tier tables, verbatim from spec D3/D4.
// Tier 1 (floor of 14): fs / shell / git, priority 100.
const FLOOR_GROUPS: ReadonlyArray<readonly [group: string, members: readonly string[]]> = [
  [
    "fs",
    ["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "ls", "glob", "grep"],
  ],
  ["shell", ["bash", "bash_output", "kill_shell"]],
  ["git", ["git_status", "git_diff", "git_commit"]],
];

// Tier 2: session basics, priority 50.
const BASIC_TOOLS = ["task", "task_output", "todo_write", "ask_user", "skill"];

// Tier 3: mode groups, priority 40 — only on the table when assembled.
const LSP_TOOLS = [
  "lsp_definition",
  "lsp_hover",
  "lsp_references",
  "lsp_rename",
  "lsp_diagnostics",
];
const DB_TOOLS = ["db_query", "db_exec"];
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_screenshot",
  "browser_diagnostics",
  "browser_storage_state",
];

// Tier 4: information tools, priority 20.
const INFO_TOOLS = ["web_search", "web_fetch", "read_document", "http_query", "save_plan"];

// Tier 3.5: explicit memory tool, priority 45 — above mode groups so a
// memory-enabled session keeps it, below basic so control channels win.
const MEMORY_TOOLS = ["memory"];

// Tier 5 (rest): priority 0, the fallback for every tool not listed above.

/** name -> group for every explicitly listed tool; mode groups gated by presence. */
function buildMembership(presence: AssemblyPresence): Record<string, string> {
  const membership: Record<string, string> = {};
  for (const [group, members] of FLOOR_GROUPS) {
    for (const name of members) membership[name] = group;
  }
  for (const name of BASIC_TOOLS) membership[name] = "basic";
  if (presence.hasLsp) for (const name of LSP_TOOLS) membership[name] = "lsp";
  if (presence.hasDb) for (const name of DB_TOOLS) membership[name] = "db";
  if (presence.hasBrowser) for (const name of BROWSER_TOOLS) membership[name] = "browser";
  if (presence.hasMemory) for (const name of MEMORY_TOOLS) membership[name] = "memory";
  for (const name of INFO_TOOLS) membership[name] = "info";
  return membership;
}

/** Tier table: mode groups join only when their adapter is assembled. */
function buildGroups(presence: AssemblyPresence): Record<string, ScopeGroupConfig> {
  const groups: Record<string, ScopeGroupConfig> = {
    fs: { priority: 100, enabled: true },
    shell: { priority: 100, enabled: true },
    git: { priority: 100, enabled: true },
    basic: { priority: 50, enabled: true },
  };
  if (presence.hasLsp) groups["lsp"] = { priority: 40, enabled: true };
  if (presence.hasDb) groups["db"] = { priority: 40, enabled: true };
  if (presence.hasBrowser) groups["browser"] = { priority: 45, enabled: true };
  if (presence.hasMemory) groups["memory"] = { priority: 45, enabled: true };
  groups["info"] = { priority: 20, enabled: true };
  groups["rest"] = { priority: 0, enabled: true };
  return groups;
}

/** Pure: actual tool list + assembly state -> default visibility (limit 20 / 21 with memory). */
export function buildDefaultToolVisibility(
  toolDefs: readonly ToolDefinition[],
  presence: AssemblyPresence,
): Required<ToolVisibility> {
  const membership = buildMembership(presence);
  const toolGroups: Record<string, string> = {};
  for (const tool of toolDefs) {
    toolGroups[tool.name] = membership[tool.name] ?? "rest";
  }
  return {
    scope: { groups: buildGroups(presence), toolGroups },
    // Browser sessions need all nine tools plus two info slots. The gateway
    // also assembles five lsp tools whether or not a browser exists — with a
    // bare 20-slot cap only one lsp tool survived, so the other four were
    // silently withheld. Reserve five slots whenever LSP is assembled, and
    // the browser's ten (nine tools + one info slot) when it is. Memory keeps
    // its one extra slot from T11.
    limit:
      DEFAULT_TOOL_VISIBILITY_LIMIT +
      (presence.hasBrowser ? 10 : 0) +
      (presence.hasLsp ? 5 : 0) +
      (presence.hasMemory ? 1 : 0),
  };
}
