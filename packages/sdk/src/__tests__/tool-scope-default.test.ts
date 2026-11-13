import { it, expect } from "vitest";
import { filterByScope } from "@voltojs/core";
import type { ToolDefinition } from "@voltojs/core";
import { buildDefaultToolVisibility } from "../tool-scope-default.js";

const FLOOR = [
  "read_file","write_file","edit_file","multi_edit","apply_patch","ls","glob","grep",
  "bash","bash_output","kill_shell","git_status","git_diff","git_commit",
];
const BASIC = ["task","task_output","todo_write","ask_user","skill"];
const INFO  = ["web_search","web_fetch","read_document","http_query","save_plan"];
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
const allDefs = () => [...FLOOR, ...BASIC, ...INFO, ...UNKNOWN].map(def);

it("F-161 maps every actual tool into an on-table group; unknown names fall to rest", () => {
  const presence = { hasLsp: false, hasDb: false, hasBrowser: false, hasMemory: false };
  const { scope } = buildDefaultToolVisibility(allDefs(), presence);
  expect(scope.toolGroups).toBeDefined();
  for (const d of allDefs()) {
    const g = scope.toolGroups![d.name];
    expect(g, `unmapped: ${d.name}`).toBeDefined();
    expect(Object.keys(scope.groups)).toContain(g!);   // never a dropped whitelist entry
  }
  for (const n of UNKNOWN) expect(scope.toolGroups![n]).toBe("rest");
  expect(scope.toolGroups!["read_file"]).toBe("fs");
  expect(scope.toolGroups!["bash"]).toBe("shell");
  expect(scope.toolGroups!["git_status"]).toBe("git");
  expect(scope.toolGroups!["task"]).toBe("basic");
  expect(scope.toolGroups!["web_search"]).toBe("info");
  expect(scope.groups["fs"]).toEqual({ priority: 100, enabled: true });
  expect(scope.groups["basic"]).toEqual({ priority: 50, enabled: true });
  expect(scope.groups["info"]).toEqual({ priority: 20, enabled: true });
  expect(scope.groups["rest"]).toEqual({ priority: 0, enabled: true });
});

it("F-161 the floor 14 survive a >20 trim and lead the output", () => {
  const presence = { hasLsp: false, hasDb: false, hasBrowser: false, hasMemory: false };
  const defs = allDefs();                      // 14 + 5 + 5 + 6 = 30 > 20
  const { scope, limit } = buildDefaultToolVisibility(defs, presence);
  expect(limit).toBe(20);
  const trimmed = filterByScope(defs, scope, limit);
  expect(trimmed).toHaveLength(20);
  const names = trimmed.map((t) => t.name);
  for (const f of FLOOR) expect(names, `floor lost: ${f}`).toContain(f);
  // first 14 are exactly the floor (order = original within the tier)
  expect(new Set(names.slice(0, 14))).toEqual(new Set(FLOOR));
});

it("F-162 mode groups join the table only when assembled; absent keeps presence-false tables lsp-free", () => {
  const on = buildDefaultToolVisibility(allDefs(), { hasLsp: true, hasDb: false, hasBrowser: false, hasMemory: false });
  expect(on.scope.groups["lsp"]).toEqual({ priority: 40, enabled: true });
  expect(on.scope.groups["db"]).toBeUndefined();
  const off = buildDefaultToolVisibility(allDefs(), { hasLsp: false, hasDb: false, hasBrowser: false, hasMemory: false });
  expect(off.scope.groups["lsp"]).toBeUndefined();
});

it("F-162 with mode tools present, they take the discretionary slots after floor+basic", () => {
  const defs = [...FLOOR, ...BASIC, ...LSP, ...INFO, ...UNKNOWN].map(def);   // 14+5+5+5+6 = 35
  const { scope, limit } = buildDefaultToolVisibility(defs, { hasLsp: true, hasDb: false, hasBrowser: false, hasMemory: false });
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  // LSP assembles its own five slots: a bare 20 kept one lsp tool and dropped
  // the other four, whether or not a browser was present.
  expect(limit).toBe(25);
  expect(names).toHaveLength(25);
  expect(names.slice(14, 19).sort()).toEqual([...BASIC].sort());             // tier 2 owns 15-19
  expect(names.slice(19, 24).sort()).toEqual([...LSP].sort());                // tier 3 owns 20-24
  expect(names.slice(24)).toEqual(["web_search"]);                            // then one info slot
  expect(names.filter((n) => UNKNOWN.includes(n))).toEqual([]);               // never the rest tier
});

it("F-162 db and browser groups join the table only when assembled", () => {
  const defs = [...FLOOR, ...BASIC, ...DB, ...BROWSER, ...INFO, ...UNKNOWN].map(def);
  const db = buildDefaultToolVisibility(defs, { hasLsp: false, hasDb: true, hasBrowser: false, hasMemory: false });
  expect(db.scope.groups["db"]).toEqual({ priority: 40, enabled: true });
  expect(db.scope.groups["browser"]).toBeUndefined();
  const browser = buildDefaultToolVisibility(defs, { hasLsp: false, hasDb: false, hasBrowser: true, hasMemory: false });
  expect(browser.scope.groups["browser"]).toEqual({ priority: 45, enabled: true });
  expect(browser.scope.groups["db"]).toBeUndefined();
  // a presence-false mode name never leaves the table: it falls to rest instead
  expect(db.scope.toolGroups!["browser_navigate"]).toBe("rest");
  expect(browser.scope.toolGroups!["db_query"]).toBe("rest");
});


it("T11 memory group joins at priority 45 and raises the limit to 21", () => {
  const defs = [...FLOOR, ...BASIC, ...MEMORY].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: false,
    hasDb: false,
    hasBrowser: false,
    hasMemory: true,
  });
  expect(limit).toBe(21);
  expect(scope.groups["memory"]).toEqual({ priority: 45, enabled: true });
  expect(scope.toolGroups!["memory"]).toBe("memory");
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  expect(names).toContain("memory");
});

it("T11 memory slot never evicts the floor or basic tools when the limit rises to 21", () => {
  // Spec D6 worst case: floor + basic + memory + a full discretionary crowd.
  const defs = [...FLOOR, ...BASIC, ...MEMORY, ...LSP, ...INFO, ...UNKNOWN].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: true,
    hasDb: false,
    hasBrowser: false,
    hasMemory: true,
  });
  // 20 + the five LSP slots + memory's one.
  expect(limit).toBe(26);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const f of FLOOR) expect(names, `floor lost: ${f}`).toContain(f);
  for (const b of BASIC) expect(names, `basic lost: ${b}`).toContain(b);
  expect(names).toContain("memory");
});

it("T11 memory tool falls to rest when memory is not assembled", () => {
  const defs = [...FLOOR, ...BASIC, ...MEMORY].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: false,
    hasDb: false,
    hasBrowser: false,
    hasMemory: false,
  });
  expect(limit).toBe(20);
  expect(scope.groups["memory"]).toBeUndefined();
  expect(scope.toolGroups!["memory"]).toBe("rest");
});


it("browser assembly raises the limit to 30 and keeps all nine browser tools", () => {
  const defs = [...FLOOR, ...BASIC, ...BROWSER, ...INFO].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: false,
    hasDb: false,
    hasBrowser: true,
    hasMemory: false,
  });
  expect(limit).toBe(30);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of BROWSER) expect(names, `browser lost: ${name}`).toContain(name);
  expect(names).toContain("web_fetch");
  expect(names).toContain("web_search");
});


it("browser plus lsp keeps all nine browser tools, all lsp tools, and two info slots", () => {
  const defs = [...FLOOR, ...BASIC, ...LSP, ...BROWSER, ...INFO].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: true,
    hasDb: false,
    hasBrowser: true,
    hasMemory: false,
  });
  expect(limit).toBe(35);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of BROWSER) expect(names, `browser lost: ${name}`).toContain(name);
  for (const name of LSP) expect(names, `lsp lost: ${name}`).toContain(name);
  expect(names).toContain("web_fetch");
  expect(names).toContain("web_search");
});

// R24 — the LSP reservation must not depend on a browser being assembled.
// `playwright-core` is optional, so "LSP wired, browser absent" is the common
// gateway shape; before the fix a bare 20-slot cap left only ONE lsp_* tool
// visible and silently withheld the other four.

/** The production gateway shape: floor + basic + memory + lsp + info + db. */
const gatewayDefs = () => [...FLOOR, ...BASIC, ...MEMORY, ...LSP, ...INFO, ...DB].map(def);

it("R24 lsp wired, browser absent: all five lsp tools stay visible", () => {
  const defs = gatewayDefs();
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: true,
    hasDb: true,
    hasBrowser: false,
    hasMemory: true,
  });
  // 20 + five lsp slots + memory's one; the browser contributes nothing.
  expect(limit).toBe(26);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  // Behaviour, not only the number: every lsp tool is actually offered.
  for (const name of LSP) expect(names, `lsp lost without a browser: ${name}`).toContain(name);
  expect(names).toContain("memory");
  // The browser group was never assembled, so no browser slot was invented.
  expect(scope.groups["browser"]).toBeUndefined();
  expect(names.filter((name) => BROWSER.includes(name))).toEqual([]);
});

it("R24 lsp absent, browser present: the five lsp slots are NOT reserved", () => {
  // The gateway with a browser and no LSP (present false -> the browser nine
  // take their own slots; lsp_* names are wired in anyway).
  const defs = [...FLOOR, ...BASIC, ...MEMORY, ...LSP, ...BROWSER, ...INFO].map(def);
  const { scope, limit } = buildDefaultToolVisibility(defs, {
    hasLsp: false,
    hasDb: false,
    hasBrowser: true,
    hasMemory: true,
  });
  // 20 + ten browser slots + memory's one; no lsp slots.
  expect(limit).toBe(31);
  const names = filterByScope(defs, scope, limit).map((t) => t.name);
  for (const name of BROWSER) expect(names, `browser lost: ${name}`).toContain(name);
  expect(names).toContain("memory");
  // lsp_* names fall to the rest tier and are only reachable through the
  // spare capacity themselves — the table keeps no lsp group at all.
  expect(scope.groups["lsp"]).toBeUndefined();
  expect(names.filter((name) => LSP.includes(name))).toEqual([]);
});
