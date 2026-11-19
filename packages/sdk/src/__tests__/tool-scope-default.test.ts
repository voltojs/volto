import { it, expect } from "vitest";
import { filterByScope } from "@voltojs/core";
import type { ToolDefinition } from "@voltojs/core";
import { buildDefaultToolVisibility } from "../tool-scope-default.js";

const FLOOR = [
  "read_file","write_file","edit_file","multi_edit","apply_patch","ls","glob","grep",
  "bash","bash_output","kill_shell","git_status","git_diff","git_commit",
];
const BASIC = ["task","task_output","todo_write","ask_user","skill"];
const PLAN  = ["save_plan"];
const INFO  = ["web_search","web_fetch","read_document","http_query"];
const LSP   = ["lsp_definition","lsp_hover","lsp_references","lsp_rename","lsp_diagnostics"];
const DB    = ["db_query","db_exec"];
const BROWSER = [
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
const MEMORY = ["memory"];
const UNKNOWN = ["future_tool","mcp__srv__echo","plugin_thing","watch_files","build","git_push"];

function def(name: string): ToolDefinition {
  return { name, description: "", inputSchema: { type: "object" }, requires: [], riskTier: "READ_ONLY" };
}

type Presence = {
  hasLsp?: boolean;
  hasDb?: boolean;
  hasBrowser?: boolean;
  hasMemory?: boolean;
  hasPlan?: boolean;
};

function presence(overrides: Presence = {}) {
  return {
    hasLsp: false,
    hasDb: false,
    hasBrowser: false,
    hasMemory: false,
    hasPlan: false,
    ...overrides,
  };
}

/** The production gateway shape observed in a real session: browser + lsp + memory + db. */
const gatewayDefs = () => [...FLOOR, ...BASIC, ...MEMORY, ...LSP, ...INFO, ...DB, ...BROWSER].map(def);

it("maps every actual tool into an on-table group; unknown names fall to rest", () => {
  const defs = [...FLOOR, ...BASIC, ...PLAN, ...INFO, ...LSP, ...DB, ...BROWSER, ...MEMORY, ...UNKNOWN].map(def);
  const { scope } = buildDefaultToolVisibility(
    defs,
    presence({ hasLsp: true, hasDb: true, hasBrowser: true, hasMemory: true, hasPlan: true }),
  );
  expect(scope.toolGroups).toBeDefined();
  for (const d of defs) {
    const g = scope.toolGroups![d.name];
    expect(g, `unmapped: ${d.name}`).toBeDefined();
    expect(Object.keys(scope.groups)).toContain(g!);   // never a dropped whitelist entry
  }
  for (const n of UNKNOWN) expect(scope.toolGroups![n]).toBe("rest");
  expect(scope.toolGroups!["read_file"]).toBe("fs");
  expect(scope.toolGroups!["bash"]).toBe("shell");
  expect(scope.toolGroups!["git_status"]).toBe("git");
  expect(scope.toolGroups!["task"]).toBe("basic");
  expect(scope.toolGroups!["save_plan"]).toBe("plan");
  expect(scope.toolGroups!["web_search"]).toBe("info");
  expect(scope.toolGroups!["db_query"]).toBe("db");
});

it("orders the tiers: control > plan > browser/memory > code intelligence > web > db", () => {
  const { scope } = buildDefaultToolVisibility(
    [...FLOOR, ...BASIC, ...PLAN, ...INFO, ...LSP, ...DB, ...BROWSER, ...MEMORY].map(def),
    presence({ hasLsp: true, hasDb: true, hasBrowser: true, hasMemory: true, hasPlan: true }),
  );
  expect(scope.groups["fs"]).toEqual({ priority: 100, enabled: true });
  expect(scope.groups["basic"]).toEqual({ priority: 60, enabled: true });
  expect(scope.groups["plan"]).toEqual({ priority: 55, enabled: true });
  expect(scope.groups["browser"]).toEqual({ priority: 45, enabled: true });
  expect(scope.groups["memory"]).toEqual({ priority: 45, enabled: true });
  expect(scope.groups["lsp"]).toEqual({ priority: 40, enabled: true });
  expect(scope.groups["info"]).toEqual({ priority: 30, enabled: true });
  expect(scope.groups["db"]).toEqual({ priority: 10, enabled: true });
  expect(scope.groups["rest"]).toEqual({ priority: 0, enabled: true });
});

it("keeps the 20-slot base plus the info tier when no mode adapter is assembled", () => {
  const defs = [...FLOOR, ...BASIC, ...INFO, ...UNKNOWN].map(def);   // 14 + 5 + 4 + 6
  const { scope, limit } = buildDefaultToolVisibility(defs, presence());
  // info is always mapped, so its four tools count even without a mode adapter;
  // the base's spare slot stays available to rest (plugin / MCP) tools.
  expect(limit).toBe(20 + INFO.length);   // 24
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  expect(names).toHaveLength(24);
  for (const f of FLOOR) expect(names, `floor lost: ${f}`).toContain(f);
  for (const i of INFO) expect(names, `info lost: ${i}`).toContain(i);
  expect(names.filter((n) => UNKNOWN.includes(n))).toHaveLength(1);
});

it("reserves the actual number of lsp tools", () => {
  const defs = [...FLOOR, ...BASIC, ...LSP, ...INFO, ...UNKNOWN].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, presence({ hasLsp: true }));
  expect(limit).toBe(20 + LSP.length + INFO.length);   // 29
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of LSP) expect(names, `lsp lost: ${name}`).toContain(name);
  for (const name of INFO) expect(names, `info lost: ${name}`).toContain(name);
});

it("reserves the actual number of browser tools", () => {
  const defs = [...FLOOR, ...BASIC, ...BROWSER, ...INFO, ...UNKNOWN].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, presence({ hasBrowser: true }));
  expect(limit).toBe(20 + BROWSER.length + INFO.length);   // 33
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of BROWSER) expect(names, `browser lost: ${name}`).toContain(name);
  for (const name of INFO) expect(names, `info lost: ${name}`).toContain(name);
});

it("reserves memory and plan slots", () => {
  const defs = [...FLOOR, ...BASIC, ...PLAN, ...MEMORY, ...INFO].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, presence({ hasMemory: true, hasPlan: true }));
  expect(limit).toBe(20 + PLAN.length + MEMORY.length + INFO.length);   // 26
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  expect(names).toContain("memory");
  expect(names).toContain("save_plan");
});

it("R25 the production gateway shape keeps web_search, web_fetch and every other mapped tool visible", () => {
  const defs = gatewayDefs();
  const { scope, limit } = buildDefaultToolVisibility(
    defs,
    presence({ hasLsp: true, hasDb: true, hasBrowser: true, hasMemory: true }),
  );
  // 20 + browser 9 + lsp 5 + memory 1 + db 2 + info 4
  expect(limit).toBe(41);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of [...FLOOR, ...BASIC, ...LSP, ...DB, ...BROWSER, ...MEMORY, ...INFO]) {
    expect(names, `lost in the gateway shape: ${name}`).toContain(name);
  }
});

it("R25 the info tier outranks db so the web tools cannot be evicted by SQLite", () => {
  const defs = gatewayDefs();
  const { scope, limit } = buildDefaultToolVisibility(
    defs,
    presence({ hasLsp: true, hasDb: true, hasBrowser: true, hasMemory: true }),
  );
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  expect(names.indexOf("web_search")).toBeLessThan(names.indexOf("db_query"));
  expect(names.indexOf("web_fetch")).toBeLessThan(names.indexOf("db_exec"));
});

it("R25 leaves the spare slot for rest (plugin / MCP tools) in the gateway shape", () => {
  const defs = [...gatewayDefs(), ...UNKNOWN.map(def)];
  const { scope, limit } = buildDefaultToolVisibility(
    defs,
    presence({ hasLsp: true, hasDb: true, hasBrowser: true, hasMemory: true }),
  );
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  // 41 mapped tools + one spare slot: exactly one unknown tool survives.
  expect(names.filter((n) => UNKNOWN.includes(n))).toHaveLength(1);
});

it("mode tools whose adapter is absent fall to rest instead of joining the table", () => {
  const defs = [...FLOOR, ...BASIC, ...DB, ...BROWSER, ...PLAN, ...MEMORY].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, presence());
  expect(scope.groups["db"]).toBeUndefined();
  expect(scope.groups["browser"]).toBeUndefined();
  expect(scope.groups["plan"]).toBeUndefined();
  expect(scope.groups["memory"]).toBeUndefined();
  expect(scope.toolGroups!["db_query"]).toBe("rest");
  expect(scope.toolGroups!["browser_navigate"]).toBe("rest");
  expect(scope.toolGroups!["save_plan"]).toBe("rest");
  expect(scope.toolGroups!["memory"]).toBe("rest");
  expect(limit).toBe(20);
});
