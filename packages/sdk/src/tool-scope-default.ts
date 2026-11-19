import type { ScopeGroupConfig, ToolDefinition, ToolScopeConfig } from "@voltojs/core";

/**
 * Default tool visibility synthesizer (T3 toolset governance).
 *
 * Pure: no I/O, deterministic, no sorting. Given the actual assembled tool
 * list and the assembly state, it produces the tier table plus a `limit` that
 * reserves **the actual number of tools** each assembled mode group brings on
 * top of the 20-slot base (floor 14 + basic 5 + one spare).
 *
 * The previous fixed-budget table (`20 + 10 browser + 5 lsp + 1 memory`) had two
 * failure modes, both silent:
 * - `db` was never in the formula, so an assembled db group spent slots that
 *   belonged to other tiers;
 * - `info` had the lowest priority, so in the gateway shape (browser + lsp +
 *   memory + db) the whole tier — `web_search`, `web_fetch`, `http_query`,
 *   `read_document` — was trimmed away, and `save_plan` shared its fate.
 *
 * Counting members instead of hardcoding per-category budgets means a tier can
 * no longer starve another: every mapped tool of an assembled group is
 * guaranteed a slot, and only `rest` (unknown / plugin / MCP tools) competes for
 * the spare capacity.
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
  hasPlan: boolean; // opts.planStore !== undefined (save_plan assembled)
}

/** Shape consumed by the toolVisibility wiring (defaults filled in by us). */
export interface ToolVisibility {
  scope?: ToolScopeConfig;
  limit?: number;
}

/** Base cap: the floor (14) + basic (5) + one slot any other tool may compete for. */
const DEFAULT_TOOL_VISIBILITY_LIMIT = 20;

// Tier 1 (floor of 14): fs / shell / git, priority 100.
const FLOOR_GROUPS: ReadonlyArray<readonly [group: string, members: readonly string[]]> = [
  [
    "fs",
    ["read_file", "write_file", "edit_file", "multi_edit", "apply_patch", "ls", "glob", "grep"],
  ],
  ["shell", ["bash", "bash_output", "kill_shell"]],
  ["git", ["git_status", "git_diff", "git_commit"]],
];

// Tier 2: session basics, priority 60 — control channels outrank every mode.
const BASIC_TOOLS = ["task", "task_output", "todo_write", "ask_user", "skill"];

// Tier 2.5: plan mode's only tool, priority 55. It sits above the mode groups
// because plan mode cannot work without it, and below basic for the same reason
// basic outranks everything else.
const PLAN_TOOLS = ["save_plan"];

// Tier 3: explicit memory tool, priority 45 — above the code-intel tiers.
const MEMORY_TOOLS = ["memory"];

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

// Tier 4: code intelligence, priority 40. Semantic (symbol-level) navigation,
// references and rename — grep cannot stand in for rename.
const LSP_TOOLS = [
  "lsp_definition",
  "lsp_hover",
  "lsp_references",
  "lsp_rename",
  "lsp_diagnostics",
];

// Tier 5: information tools, priority 30 — the agent's whole web surface.
const INFO_TOOLS = ["web_search", "web_fetch", "read_document", "http_query"];

// Tier 6: local SQLite access, priority 10. Narrow (workspace-scoped SQLite
// only) and write access additionally needs approval, so it must never evict
// the web tools above it.
const DB_TOOLS = ["db_query", "db_exec"];

/** Groups that spend the base cap rather than adding to it. */
const BASE_GROUPS: ReadonlySet<string> = new Set(["fs", "shell", "git", "basic", "rest"]);

/** name -> group for every explicitly listed tool; mode groups gated by presence. */
function buildMembership(presence: AssemblyPresence): Record<string, string> {
  const membership: Record<string, string> = {};
  for (const [group, members] of FLOOR_GROUPS) {
    for (const name of members) membership[name] = group;
  }
  for (const name of BASIC_TOOLS) membership[name] = "basic";
  if (presence.hasPlan) for (const name of PLAN_TOOLS) membership[name] = "plan";
  if (presence.hasMemory) for (const name of MEMORY_TOOLS) membership[name] = "memory";
  if (presence.hasBrowser) for (const name of BROWSER_TOOLS) membership[name] = "browser";
  if (presence.hasLsp) for (const name of LSP_TOOLS) membership[name] = "lsp";
  if (presence.hasDb) for (const name of DB_TOOLS) membership[name] = "db";
  for (const name of INFO_TOOLS) membership[name] = "info";
  return membership;
}

/** Tier table: mode groups join only when their adapter is assembled. */
function buildGroups(presence: AssemblyPresence): Record<string, ScopeGroupConfig> {
  const groups: Record<string, ScopeGroupConfig> = {
    fs: { priority: 100, enabled: true },
    shell: { priority: 100, enabled: true },
    git: { priority: 100, enabled: true },
    basic: { priority: 60, enabled: true },
    info: { priority: 30, enabled: true },
    rest: { priority: 0, enabled: true },
  };
  if (presence.hasPlan) groups["plan"] = { priority: 55, enabled: true };
  if (presence.hasMemory) groups["memory"] = { priority: 45, enabled: true };
  if (presence.hasBrowser) groups["browser"] = { priority: 45, enabled: true };
  if (presence.hasLsp) groups["lsp"] = { priority: 40, enabled: true };
  if (presence.hasDb) groups["db"] = { priority: 10, enabled: true };
  return groups;
}

/**
 * Base cap plus one slot per tool of every assembled mode group, counted from
 * the actual list. Tools that are assembled but whose group is absent from the
 * table fall to `rest` and do not add slots — they compete for the spare.
 */
function limitFor(
  toolDefs: readonly ToolDefinition[],
  membership: Record<string, string>,
  groups: Record<string, ScopeGroupConfig>,
): number {
  let reserved = 0;
  for (const tool of toolDefs) {
    const group = membership[tool.name] ?? "rest";
    if (BASE_GROUPS.has(group)) continue;
    if (groups[group] === undefined) continue;
    reserved += 1;
  }
  return DEFAULT_TOOL_VISIBILITY_LIMIT + reserved;
}

/** Pure: actual tool list + assembly state -> default visibility. */
export function buildDefaultToolVisibility(
  toolDefs: readonly ToolDefinition[],
  presence: AssemblyPresence,
): Required<ToolVisibility> {
  const membership = buildMembership(presence);
  const groups = buildGroups(presence);
  const toolGroups: Record<string, string> = {};
  for (const tool of toolDefs) {
    toolGroups[tool.name] = membership[tool.name] ?? "rest";
  }
  return {
    scope: { groups, toolGroups },
    limit: limitFor(toolDefs, membership, groups),
  };
}
