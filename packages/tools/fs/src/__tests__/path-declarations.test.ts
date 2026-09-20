import { describe, it, expect } from "vitest";
import type { FileSystem, FileWatcher } from "@volto/core";
import type { Tool } from "@volto/tools-common";
import { createReadFileTool } from "../read-file.js";
import { createWriteFileTool } from "../write-file.js";
import { createEditFileTool } from "../edit-file.js";
import { createMultiEditTool } from "../multi-edit.js";
import { createApplyPatchTool } from "../apply-patch.js";
import { createLsTool } from "../ls.js";
import { createGrepTool } from "../grep.js";
import { createGlobTool } from "../glob.js";
import { createWatchFilesTool } from "../watch-files.js";

const fsStub = {} as unknown as FileSystem;
const watcherStub = {} as unknown as FileWatcher;

const tools: Array<[string, Tool]> = [
  ["read_file", createReadFileTool(fsStub)],
  ["write_file", createWriteFileTool(fsStub)],
  ["edit_file", createEditFileTool(fsStub)],
  ["multi_edit", createMultiEditTool(fsStub)],
  ["apply_patch", createApplyPatchTool(fsStub)],
  ["ls", createLsTool(fsStub)],
  ["grep", createGrepTool(fsStub)],
  ["watch_files", createWatchFilesTool(watcherStub)],
];

describe("fs tool parameter declarations", () => {
  it("declares only fields that exist in the tool's input schema", () => {
    for (const [name, tool] of tools) {
      const properties = Object.keys(tool.definition.inputSchema.properties ?? {});
      for (const field of tool.definition.pathInputs ?? []) {
        expect(properties, `${name} declares "${field}"`).toContain(field);
      }
    }
  });

  it("declares the path field of every path-bearing tool", () => {
    for (const [name, tool] of tools) {
      if (name === "watch_files") {
        expect(tool.definition.pathInputs).toEqual(["paths"]);
      } else {
        expect(tool.definition.pathInputs, name).toEqual(["path"]);
      }
    }
  });

  it("leaves glob out of path rules — its pattern is not a path", () => {
    expect(createGlobTool(fsStub).definition.pathInputs).toBeUndefined();
  });
});
