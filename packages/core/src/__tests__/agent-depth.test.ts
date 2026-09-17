import { describe, it, expect } from "vitest";
import { filterVisibleTools, CAP_AGENT_DEPTH_AVAILABLE } from "../index.js";
import type { ToolDefinition } from "../index.js";

const def = (name: string, requires: string[]): ToolDefinition => ({
  name, description: name, inputSchema: { type: "object" }, requires, riskTier: "READ_ONLY",
});

const tools = [
  def("task", [CAP_AGENT_DEPTH_AVAILABLE]),
  def("task_output", [CAP_AGENT_DEPTH_AVAILABLE]),
  def("read_file", ["filesystem:read"]),
];

describe("agent depth gating", () => {
  it("names the delegation-budget capability agent:can-delegate", () => {
    expect(CAP_AGENT_DEPTH_AVAILABLE).toBe("agent:can-delegate");
  });

  it("hides both delegation tools when the depth budget is exhausted", () => {
    const visible = filterVisibleTools(tools, new Set(["filesystem:read"]));
    expect(visible.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("exposes both when delegation is still allowed", () => {
    const visible = filterVisibleTools(tools, new Set(["filesystem:read", CAP_AGENT_DEPTH_AVAILABLE]));
    expect(visible.map((t) => t.name)).toEqual(expect.arrayContaining(["task", "task_output"]));
  });
});
