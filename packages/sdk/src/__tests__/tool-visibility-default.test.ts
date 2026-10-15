import { describe, it, expect } from "vitest";
import { createAgent } from "../create-agent.js";
import type { CreateAgentOptions } from "../create-agent.js";
import { textScript } from "@volto/core";
import type { ModelPort, ModelRequest, ToolDefinition, ToolResult } from "@volto/core";

/**
 * F-163 / F-164 — default tool-visibility wiring in createAgent
 * (T3 toolset governance, roadmap F-009).
 *
 * The default path (no host `toolVisibility`) must apply the synthesized
 * five-tier scope with limit 20; `Infinity` survives only as an explicit
 * host override (D5 escape hatch). An explicit `toolVisibility`
 * wholesale-replaces the default: `{limit}` truncates in raw list order with
 * no built-in scope mixed in; `{scope}` without a limit caps at 20.
 *
 * The fake list is deliberately interleaved (unknown names before and
 * between the floor names): if the built-in priority table ever leaked into
 * an explicit-override path, floor-first sorting would visibly reorder the
 * output away from raw list order.
 */

const FLOOR = [
  "read_file","write_file","edit_file","multi_edit","apply_patch","ls","glob","grep",
  "bash","bash_output","kill_shell","git_status","git_diff","git_commit",
];
const UNKNOWN = [
  "future_tool","mcp__srv__echo","plugin_thing","deploy_preview","notebook_run","canary_check",
  "schema_migrate","metric_report","log_tail","artifact_pack","trace_diff","index_rebuild",
];
// Raw list order: 6 unknown, the floor 14, 6 unknown — 26 fakes, not tier-sorted.
const FAKE_NAMES = [...UNKNOWN.slice(0, 6), ...FLOOR, ...UNKNOWN.slice(6)];

// createAgent ships these three regardless of wired ports; they are part of
// the assembled list the default trim governs.
const ALWAYS_SHIPPING = ["ask_user", "todo_write", "read_document"];

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object" },
    requires: [],
    riskTier: "READ_ONLY",
  };
}

const REQUESTS: ModelRequest[] = [];
const modelPort: ModelPort = {
  async *stream(req) {
    REQUESTS.push(req);
    yield* textScript("done");
  },
};

/** Run one turn; return the tool names the model actually saw. */
async function captureVisibleTools(
  toolVisibility?: CreateAgentOptions["toolVisibility"],
): Promise<string[]> {
  REQUESTS.length = 0;
  const tools = FAKE_NAMES.map((name) => ({
    definition: makeTool(name),
    handler: async (): Promise<ToolResult> => ({ modelContent: `ok: ${name}` }),
  }));
  const agent = createAgent({
    modelPort,
    tools,
    ...(toolVisibility !== undefined ? { toolVisibility } : {}),
  });
  await agent.run("go");
  return REQUESTS[0]!.tools.map((t) => t.name);
}

describe("createAgent — default tool visibility (T3 governance)", () => {
  it("F-163 omitting toolVisibility trims the visible set to 20 with the floor kept", async () => {
    const tools = await captureVisibleTools();
    expect(tools).toHaveLength(20);
    for (const f of FLOOR) expect(tools, `floor lost: ${f}`).toContain(f);
    // The rest tier competes for the discretionary slots in raw list order —
    // unknown names participate instead of being wiped out wholesale.
    const unknownSeen = UNKNOWN.filter((n) => tools.includes(n));
    expect(unknownSeen.length).toBeGreaterThan(0);
    expect(unknownSeen).toEqual(UNKNOWN.slice(0, unknownSeen.length));
  });

  it("F-163 an explicit Infinity limit is an escape hatch that keeps everything", async () => {
    const kept = await captureVisibleTools({ limit: Infinity });
    // Same assembly with an explicit limit far above the assembled count:
    // that path leaves the list untouched, so it is the untrimmed baseline.
    const untrimmed = await captureVisibleTools({ limit: 1000 });
    expect(kept).toEqual(untrimmed);
    expect(kept.length).toBeGreaterThanOrEqual(FAKE_NAMES.length);
    for (const n of [...FLOOR, ...UNKNOWN]) expect(kept, `dropped: ${n}`).toContain(n);
  });

  it("F-164 an explicit limit alone is pure truncation, no built-in scope leaks", async () => {
    const tools = await captureVisibleTools({ limit: 10 });
    // Raw list order, first 10 — the 6 leading unknown names stay. Had the
    // built-in floor table leaked in, priority sorting would have pushed
    // them out in favor of the floor names.
    expect(tools).toEqual(FAKE_NAMES.slice(0, 10));
    for (const n of ALWAYS_SHIPPING) expect(tools).not.toContain(n);
  });

  it("F-164 an explicit scope without limit defaults the cap to 20", async () => {
    const toolGroups = Object.fromEntries(FAKE_NAMES.map((n) => [n, "all"]));
    const tools = await captureVisibleTools({
      scope: { groups: { all: { priority: 1 } }, toolGroups },
    });
    // Explicit scope wholesale-replaces the default: every fake maps to one
    // group at the same priority, so the cap cuts in raw list order — no
    // built-in tier priorities mixed in, built-in tools off this table.
    expect(tools).toEqual(FAKE_NAMES.slice(0, 20));
    for (const n of ALWAYS_SHIPPING) expect(tools).not.toContain(n);
  });
});
