import { describe, it, expect } from "vitest";
import {
  validateToolInput,
  filterVisibleTools,
  filterByScope,
  routeToolCall,
} from "../tool-router.js";
import type { ToolScopeConfig } from "../tool-router.js";
import type { ToolDefinition, JSONSchema } from "../tool.js";
import type { PendingToolCall } from "../state.js";
import { riskRank, visibleRiskCeiling } from "../permission-policy.js";

const objectSchema: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "number" },
  },
  required: ["path"],
};

function tool(name: string, requires: string[], inputSchema?: JSONSchema): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: inputSchema ?? objectSchema,
    requires,
    riskTier: "READ_ONLY",
  };
}

describe("validateToolInput", () => {
  it("returns null when no schema is provided", () => {
    expect(validateToolInput(undefined, { anything: true })).toBeNull();
  });

  it("flags a missing required property", () => {
    expect(validateToolInput(objectSchema, { count: 1 })).toBe(
      "missing required property: path",
    );
  });

  it("accepts a valid object", () => {
    expect(validateToolInput(objectSchema, { path: "a.ts", count: 2 })).toBeNull();
  });

  it("flags a wrong property type", () => {
    expect(validateToolInput(objectSchema, { path: 123 })).toBe(
      'property "path" has invalid type',
    );
  });

  it("flags an enum property value outside the allowed set", () => {
    const enumSchema: JSONSchema = {
      type: "object",
      properties: {
        subagent_type: { type: "string", enum: ["general-purpose", "explore"] },
      },
    };
    expect(validateToolInput(enumSchema, { subagent_type: "ghost" })).toContain(
      'property "subagent_type" must be one of:',
    );
    expect(validateToolInput(enumSchema, { subagent_type: "explore" })).toBeNull();
    expect(validateToolInput(enumSchema, {})).toBeNull();
  });

  it("allows optional properties to be absent", () => {
    expect(validateToolInput(objectSchema, { path: "a.ts" })).toBeNull();
  });

  it("rejects a non-object where an object is expected", () => {
    expect(validateToolInput(objectSchema, "nope")).toBe("expected object input");
    expect(validateToolInput(objectSchema, ["a"])).toBe("expected object input");
    expect(validateToolInput(objectSchema, null)).toBe("expected object input");
  });

  it("treats an object schema with no properties as unconstrained", () => {
    const schema: JSONSchema = { type: "object" };
    expect(validateToolInput(schema, { anything: 1 })).toBeNull();
  });

  it("validates a scalar (non-object) schema", () => {
    expect(validateToolInput({ type: "string" }, "ok")).toBeNull();
    expect(validateToolInput({ type: "string" }, 1)).toBe("invalid input type");
  });
});

describe("filterVisibleTools", () => {
  const tools = [
    tool("read_file", ["filesystem:read"]),
    tool("bash", ["shell:exec"]),
    tool("todo_write", []),
  ];

  it("keeps tools whose capabilities are all satisfied", () => {
    const visible = filterVisibleTools(tools, new Set(["filesystem:read"]));
    expect(visible.map((t) => t.name).sort()).toEqual(["read_file", "todo_write"]);
  });

  it("always keeps tools requiring no capabilities", () => {
    const visible = filterVisibleTools(tools, new Set());
    expect(visible.map((t) => t.name)).toEqual(["todo_write"]);
  });

  it("keeps all tools when every capability is present", () => {
    const visible = filterVisibleTools(
      tools,
      new Set(["filesystem:read", "shell:exec"]),
    );
    expect(visible).toHaveLength(3);
  });
});

describe("routeToolCall", () => {
  const tools = [tool("read_file", ["filesystem:read"])];
  const call = (name: string, input: Record<string, unknown>): PendingToolCall => ({
    id: "call_1",
    name,
    input,
  });

  it("returns an isError result for an unknown tool", () => {
    const { tool: t, result } = routeToolCall(tools, new Set(), call("ghost", {}));
    expect(t).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("Unknown tool");
  });

  it("returns an isError result when a required capability is missing", () => {
    const { tool: t, result } = routeToolCall(tools, new Set(), call("read_file", { path: "a.ts" }));
    expect(t?.name).toBe("read_file");
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("missing capability filesystem:read");
  });

  it("returns an isError result for invalid input", () => {
    const { result } = routeToolCall(
      tools,
      new Set(["filesystem:read"]),
      call("read_file", { count: 1 }),
    );
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("missing required property: path");
  });

  it("returns the tool with no result when the call is valid", () => {
    const { tool: t, result } = routeToolCall(
      tools,
      new Set(["filesystem:read"]),
      call("read_file", { path: "a.ts" }),
    );
    expect(t?.name).toBe("read_file");
    expect(result).toBeUndefined();
  });
});

describe("filterByScope", () => {
  const makeTools = (names: string[]): ToolDefinition[] =>
    names.map((name) => tool(name, []));

  it("returns tools unchanged when under limit and no scope config", () => {
    const tools = makeTools(["a", "b", "c"]);
    expect(filterByScope(tools, null, 20)).toEqual(tools);
  });

  it("trims to limit when tools exceed limit", () => {
    const tools = makeTools(["a", "b", "c", "d", "e"]);
    const trimmed = filterByScope(tools, null, 3);
    expect(trimmed).toHaveLength(3);
    expect(trimmed.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("filters by enabled groups", () => {
    const tools = makeTools(["mcp__srv__echo", "read_file", "lsp__definition"]);
    const scope: ToolScopeConfig = {
      groups: { mcp: { enabled: true }, read_file: { enabled: false }, lsp: { enabled: true } },
    };
    const result = filterByScope(tools, scope, 20);
    expect(result.map((t) => t.name)).toEqual(["mcp__srv__echo", "lsp__definition"]);
  });

  it("respects priority ordering within groups", () => {
    const tools = makeTools(["mcp__a__tool1", "lsp__hover", "mcp__b__tool2"]);
    const scope: ToolScopeConfig = {
      groups: { mcp: { priority: 10 }, lsp: { priority: 5 } },
    };
    const result = filterByScope(tools, scope, 20);
    // mcp tools (priority 10) should come before lsp (priority 5)
    expect(result[0]!.name).toBe("mcp__a__tool1");
    expect(result[1]!.name).toBe("mcp__b__tool2");
    expect(result[2]!.name).toBe("lsp__hover");
  });

  it("uses explicit toolGroups mapping when provided", () => {
    const tools = makeTools(["custom_tool_a", "custom_tool_b"]);
    const scope: ToolScopeConfig = {
      groups: { core: { enabled: true }, extra: { enabled: false } },
      toolGroups: { custom_tool_a: "core", custom_tool_b: "extra" },
    };
    const result = filterByScope(tools, scope, 20);
    expect(result.map((t) => t.name)).toEqual(["custom_tool_a"]);
  });

  it("applies both scope filtering and limit", () => {
    const tools = makeTools(["mcp__x__a", "mcp__y__b", "mcp__z__c", "mcp__w__d"]);
    const scope: ToolScopeConfig = {
      groups: { mcp: { priority: 1 } },
    };
    const result = filterByScope(tools, scope, 2);
    expect(result).toHaveLength(2);
  });

  it("preserves original order within same priority (stable sort)", () => {
    const tools = makeTools(["a", "b", "c", "d"]);
    const scope: ToolScopeConfig = {
      groups: { a: { priority: 1 }, b: { priority: 1 }, c: { priority: 0 }, d: { priority: 0 } },
    };
    const result = filterByScope(tools, scope, 10);
    expect(result.map((t) => t.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("pure function: same input produces same output (replayable)", () => {
    const tools = makeTools(["mcp__s__t1", "lsp__def", "read_file"]);
    const scope: ToolScopeConfig = { groups: { mcp: { priority: 5 }, lsp: { priority: 3 }, read_file: { priority: 1 } } };
    const r1 = filterByScope(tools, scope, 10);
    const r2 = filterByScope(tools, scope, 10);
    expect(r1.map((t) => t.name)).toEqual(r2.map((t) => t.name));
  });
});

function toolNamed(name: string, riskTier: ToolDefinition["riskTier"]): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    requires: [],
    riskTier,
  };
}

describe("filterVisibleTools — risk ceiling", () => {
  const read = toolNamed("read_file", "READ_ONLY");
  const writeLow = toolNamed("task", "WRITE_LOW");
  const writeHigh = toolNamed("write_file", "WRITE_HIGH");
  const irreversible = toolNamed("git_push", "IRREVERSIBLE");
  const tools = [read, writeLow, writeHigh, irreversible];

  it("hides tools above the ceiling and keeps the rest", () => {
    const visible = filterVisibleTools(tools, new Set(), "READ_ONLY");
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("workspace-write ceiling keeps everything but IRREVERSIBLE", () => {
    const visible = filterVisibleTools(tools, new Set(), "WRITE_HIGH");
    expect(visible.map((t) => t.name)).toEqual(["read_file", "task", "write_file"]);
  });

  it("no ceiling keeps all tools (unchanged behavior)", () => {
    expect(filterVisibleTools(tools, new Set())).toHaveLength(4);
  });

  it("riskRank matches the documented total order", () => {
    expect(riskRank("READ_ONLY")).toBe(0);
    expect(riskRank("WRITE_LOW")).toBe(1);
    expect(riskRank("WRITE_HIGH")).toBe(2);
    expect(riskRank("IRREVERSIBLE")).toBe(3);
  });
});

describe("filterVisibleTools — ask keeps an IRREVERSIBLE tool reachable", () => {
  const read = toolNamed("read_file", "READ_ONLY");
  const write = toolNamed("write_file", "WRITE_HIGH");
  const irreversible = toolNamed("git_push", "IRREVERSIBLE");
  const tools = [read, write, irreversible];

  it("workspace-write + ask keeps git_push so the approval gate can ask", () => {
    const ceiling = visibleRiskCeiling({ sandbox: "workspace-write", approval: "ask" });
    const visible = filterVisibleTools(tools, new Set(), ceiling);
    expect(visible.map((t) => t.name)).toEqual(["read_file", "write_file", "git_push"]);
  });

  it("workspace-write + never (auto) still prunes git_push", () => {
    const ceiling = visibleRiskCeiling({ sandbox: "workspace-write", approval: "never" });
    const visible = filterVisibleTools(tools, new Set(), ceiling);
    expect(visible.map((t) => t.name)).not.toContain("git_push");
    expect(visible.map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });

  it("read-only + ask keeps every write tier pruned", () => {
    const ceiling = visibleRiskCeiling({ sandbox: "read-only", approval: "ask" });
    const visible = filterVisibleTools(tools, new Set(), ceiling);
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
  });
});

// The runner routes against the *pruned* visible set (executeTool passes
// `visibleTools` to routeToolCall), so a hallucinated call for a tool the
// ceiling removed is rejected at the routing layer with the plain unknown-tool
// signature — it never reaches the policy matrix. Safety is unaffected
// (fail-closed at the executor boundary, and earlier than a policy denial),
// but the rejection signature is a load-bearing contract of the plan mode:
// this test pins it so the routing list can never silently regress to the
// unpruned set (which would route pruned tools into policy/executor instead).
describe("routeToolCall — ceiling-pruned tool (runner boundary)", () => {
  it("rejects a ceiling-pruned tool with the unknown-tool signature (fail-closed at routing)", () => {
    const read = toolNamed("read_file", "READ_ONLY");
    const write = toolNamed("write_file", "WRITE_HIGH");
    const visible = filterVisibleTools([read, write], new Set(), "READ_ONLY");
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);

    const { tool: t, result } = routeToolCall(visible, new Set(), {
      id: "call_1",
      name: "write_file",
      input: {},
    });
    expect(t).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("Unknown tool: write_file");
  });
});
