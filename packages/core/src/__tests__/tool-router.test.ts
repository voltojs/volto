import { describe, it, expect } from "vitest";
import {
  validateToolInput,
  filterVisibleTools,
  routeToolCall,
} from "../tool-router.js";
import type { ToolDefinition, JSONSchema } from "../tool.js";
import type { PendingToolCall } from "../state.js";

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
    tool("write_todos", []),
  ];

  it("keeps tools whose capabilities are all satisfied", () => {
    const visible = filterVisibleTools(tools, new Set(["filesystem:read"]));
    expect(visible.map((t) => t.name).sort()).toEqual(["read_file", "write_todos"]);
  });

  it("always keeps tools requiring no capabilities", () => {
    const visible = filterVisibleTools(tools, new Set());
    expect(visible.map((t) => t.name)).toEqual(["write_todos"]);
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
