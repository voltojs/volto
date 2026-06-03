import { describe, it, expect } from "vitest";
import { routeToolCall } from "../tool-router.js";
import { createReadFileTool } from "../read-file.js";
import { computeFuzzyMatchRegex } from "../fuzzy-match.js";
import { CAP_FS_READ } from "../capabilities.js";
import type { FileSystem, ToolDefinition } from "@agent-core/core";
import type { FileTool } from "../common.js";

function createInMemoryFs(seed: Record<string, string>): FileSystem {
  const store = new Map(Object.entries(seed));

  return {
    async read(path, offset = 1, limit?) {
      const content = store.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      const lines = content.split(/\r?\n/);
      const sliced = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return {
        content: sliced.join("\n"),
        totalLines: lines.length,
        truncated: limit ? sliced.length < lines.length - (offset - 1) : false,
      };
    },
    async write(path, data) {
      store.set(path, data);
    },
    async stat(path) {
      if (!store.has(path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return { path, isDirectory: false, size: store.get(path)?.length ?? 0, mtime: 0 };
    },
    async list() {
      return { entries: [] };
    },
    async glob() {
      return { paths: [] };
    },
    async grep() {
      return { matches: [], truncated: false };
    },
  };
}

const fallbackDefinition: ToolDefinition = {
  name: "__fallback__",
  description: "fallback",
  inputSchema: { type: "object" },
  requires: [],
  riskTier: "READ_ONLY",
};

describe("tools-fs tool router", () => {
  it("should route to read_file when capability is present", () => {
    const fs = createInMemoryFs({ "a.ts": "const x = 1;" });
    const tools: FileTool[] = [createReadFileTool(fs)];
    const result = routeToolCall(tools, new Set([CAP_FS_READ]), {
      id: "c1",
      name: "read_file",
      input: { path: "a.ts" },
    }, fallbackDefinition);

    expect(result.result).toBeUndefined();
    expect(result.tool.definition.name).toBe("read_file");
  });

  it("should block read_file when capability missing", () => {
    const fs = createInMemoryFs({});
    const tools: FileTool[] = [createReadFileTool(fs)];
    const result = routeToolCall(tools, new Set(), {
      id: "c1",
      name: "read_file",
      input: { path: "a.ts" },
    }, fallbackDefinition);

    expect(result.result).toBeDefined();
    expect(result.result!.isError).toBe(true);
  });

  it("should validate required input fields", () => {
    const fs = createInMemoryFs({});
    const tools: FileTool[] = [createReadFileTool(fs)];
    const result = routeToolCall(tools, new Set([CAP_FS_READ]), {
      id: "c1",
      name: "read_file",
      input: {},
    }, fallbackDefinition);

    expect(result.result).toBeDefined();
    expect(result.result!.modelContent).toContain("missing required property: path");
  });
});

describe("edit_file fuzzy match", () => {
  it("should find match when whitespace around lines differs", () => {
    const content = "  const x = 1;  \nconst y = 2;\n";
    const needle = "const x = 1;\n";
    const regex = computeFuzzyMatchRegex(content, needle);
    expect(regex).not.toBeNull();
    expect(regex!.test(content)).toBe(true);
  });

  it("should find match when inter-token whitespace differs", () => {
    const content = "const   x   =   1;";
    const needle = "const x = 1;";
    const regex = computeFuzzyMatchRegex(content, needle);
    expect(regex).not.toBeNull();
    expect(regex!.test(content)).toBe(true);
  });

  it("should return null when no reasonable fuzzy match exists", () => {
    const regex = computeFuzzyMatchRegex("unrelated", "const x = 1;");
    expect(regex).toBeNull();
  });
});
