import { describe, it, expect } from "vitest";
import { filterVisibleTools, routeToolCall } from "../tool-router.js";
import {
  evaluatePermission,
  createDefaultPermissionConfig,
} from "../permission-policy.js";
import type { ToolDefinition } from "../tool.js";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  requires: ["filesystem:read"],
  riskTier: "READ_ONLY",
};

const editTool: ToolDefinition = {
  name: "edit_file",
  description: "Edit a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  requires: ["filesystem:write"],
  riskTier: "WRITE_LOW",
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "Execute shell command",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  requires: ["shell:exec"],
  riskTier: "WRITE_HIGH",
};

const allTools = [readTool, editTool, bashTool];

describe("TC-E9: ToolRouter 能力门控 + 权限策略联合", () => {
  it("filterVisibleTools removes bash when shell:exec capability is absent", () => {
    const caps = new Set(["filesystem:read", "filesystem:write"]);
    const visible = filterVisibleTools(allTools, caps);

    expect(visible.map((t) => t.name)).toContain("read_file");
    expect(visible.map((t) => t.name)).toContain("edit_file");
    expect(visible.map((t) => t.name)).not.toContain("bash");
  });

  it("filterVisibleTools includes bash when shell:exec capability is present", () => {
    const caps = new Set([
      "filesystem:read",
      "filesystem:write",
      "shell:exec",
    ]);
    const visible = filterVisibleTools(allTools, caps);
    expect(visible).toHaveLength(3);
  });

  it("routeToolCall returns capability error for bash without shell:exec", () => {
    const caps = new Set(["filesystem:read", "filesystem:write"]);
    const result = routeToolCall(allTools, caps, {
      id: "c1",
      name: "bash",
      input: { command: "echo hi" },
    });
    expect(result.result).toBeDefined();
    expect(result.result!.isError).toBe(true);
    expect(result.result!.modelContent).toContain("missing capability");
  });

  it("permission policy: WRITE_HIGH defaults to 'ask' with createDefaultPermissionConfig", () => {
    const config = createDefaultPermissionConfig();
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
  });

  it("permission policy: tool override changes bash from 'ask' to 'deny'", () => {
    const config = createDefaultPermissionConfig({ bash: "deny" });
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("deny");
  });

  it("permission policy: WRITE_LOW defaults to 'allow'", () => {
    const config = createDefaultPermissionConfig();
    expect(evaluatePermission(config, "edit_file", "WRITE_LOW")).toBe("allow");
  });

  it("combined: visible tools are subject to permission policy decisions", () => {
    const caps = new Set([
      "filesystem:read",
      "filesystem:write",
      "shell:exec",
    ]);
    const visible = filterVisibleTools(allTools, caps);
    const config = createDefaultPermissionConfig();

    // all three tools are visible under the injected capabilities
    expect(visible.map((t) => t.name).sort()).toEqual(
      ["bash", "edit_file", "read_file"].sort(),
    );

    // read_file: READ_ONLY → allow
    expect(evaluatePermission(config, "read_file", "READ_ONLY")).toBe("allow");
    // edit_file: WRITE_LOW → allow
    expect(evaluatePermission(config, "edit_file", "WRITE_LOW")).toBe("allow");
    // bash: WRITE_HIGH → ask
    expect(evaluatePermission(config, "bash", "WRITE_HIGH")).toBe("ask");
  });
});
