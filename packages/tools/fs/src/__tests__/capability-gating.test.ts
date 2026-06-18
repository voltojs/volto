import { describe, it, expect } from "vitest";
import type { ToolDefinition, FileSystem } from "@volto/core";
import { filterVisibleTools } from "@volto/core";
import { createReadFileTool } from "../read-file.js";
import { createEditFileTool } from "../edit-file.js";
import { createWriteFileTool } from "../write-file.js";
import { createLsTool } from "../ls.js";
import { createGlobTool } from "../glob.js";
import { createGrepTool } from "../grep.js";
import { CAP_FS_READ, CAP_FS_WRITE } from "../capabilities.js";

// Construction only needs an object shaped like FileSystem; gating uses definitions.
const fs = {} as FileSystem;

function allDefinitions(): ToolDefinition[] {
  return [
    createReadFileTool(fs).definition,
    createEditFileTool(fs).definition,
    createWriteFileTool(fs).definition,
    createLsTool(fs).definition,
    createGlobTool(fs).definition,
    createGrepTool(fs).definition,
  ];
}

describe("fs capability gating", () => {
  it("hides all fs tools when no filesystem capability is injected", () => {
    const visible = filterVisibleTools(allDefinitions(), new Set());
    expect(visible).toHaveLength(0);
  });

  it("exposes only read-only tools with filesystem:read alone", () => {
    const visible = filterVisibleTools(allDefinitions(), new Set([CAP_FS_READ]));
    expect(visible.map((t) => t.name).sort()).toEqual(
      ["glob", "grep", "ls", "read_file"].sort(),
    );
  });

  it("exposes write tools only when filesystem:write is present", () => {
    const visible = filterVisibleTools(
      allDefinitions(),
      new Set([CAP_FS_READ, CAP_FS_WRITE]),
    );
    expect(visible.map((t) => t.name)).toContain("edit_file");
    expect(visible.map((t) => t.name)).toContain("write_file");
    expect(visible).toHaveLength(6);
  });
});
