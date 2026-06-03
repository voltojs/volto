import { describe, it, expect } from "vitest";
import type { FileSystem } from "@agent-core/core";
import { createReadFileTool } from "../read-file.js";
import { createEditFileTool } from "../edit-file.js";
import { computeFuzzyMatchRegex } from "../fuzzy-match.js";

function createInMemoryFs(seed: Record<string, string>): FileSystem {
  const store = new Map(Object.entries(seed));
  return {
    async read(path, offset = 1, limit?) {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      const lines = content.split(/\r?\n/);
      const sliced = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return { content: sliced.join("\n"), totalLines: lines.length, truncated: false };
    },
    async write(path, data) { store.set(path, data); },
    async stat(path) {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return { path, isDirectory: false, size: store.get(path)?.length ?? 0, mtime: 0 };
    },
    async list() { return { entries: [] }; },
    async glob() { return { paths: [] }; },
    async grep() { return { matches: [], truncated: false }; },
  };
}

describe("tools-fs Zod schema + validation", () => {
  it("derives a JSON Schema from the Zod schema for the model", () => {
    const tool = createReadFileTool(createInMemoryFs({}));
    const schema = tool.definition.inputSchema as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("path");
    expect(schema.properties).toHaveProperty("path");
  });

  it("returns an isError result (not throw) when input fails Zod validation", async () => {
    const tool = createReadFileTool(createInMemoryFs({ "a.ts": "x" }));
    const result = await tool.handler({ path: 123 });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input for read_file");
  });

  it("accepts valid input and reports mtime in displayMetadata", async () => {
    const tool = createReadFileTool(createInMemoryFs({ "a.ts": "const x = 1;" }));
    const result = await tool.handler({ path: "a.ts" });
    expect(result.isError).toBeFalsy();
    expect(result.displayMetadata?.readFile).toMatchObject({ path: "a.ts", mtime: 0 });
  });
});

describe("edit_file str_replace + fuzzy fallback", () => {
  it("AC1: fuzzy fallback hits despite whitespace differences and replaces the real text", async () => {
    const fs = createInMemoryFs({ "f.ts": "  const   x   =   1;  \n" });
    const tool = createEditFileTool(fs);
    const result = await tool.handler({ path: "f.ts", old_string: "const x = 1;", new_string: "const x = 2;" });
    expect(result.isError).toBeFalsy();
    const after = await fs.read("f.ts");
    expect(after.content).toContain("const x = 2;");
  });

  it("AC2: exact 0 matches returns an explicit error (not an exception)", async () => {
    const fs = createInMemoryFs({ "f.ts": "const x = 1;" });
    const tool = createEditFileTool(fs);
    const result = await tool.handler({ path: "f.ts", old_string: "nonexistent", new_string: "y" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("not found");
  });

  it("AC2: multiple matches without replace_all returns an explicit error", async () => {
    const fs = createInMemoryFs({ "f.ts": "a\na\na" });
    const tool = createEditFileTool(fs);
    const result = await tool.handler({ path: "f.ts", old_string: "a", new_string: "b" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("matched 3 times");
  });

  it("replace_all replaces every occurrence", async () => {
    const fs = createInMemoryFs({ "f.ts": "a\na\na" });
    const tool = createEditFileTool(fs);
    const result = await tool.handler({ path: "f.ts", old_string: "a", new_string: "b", replace_all: true });
    expect(result.isError).toBeFalsy();
    expect((await fs.read("f.ts")).content).toBe("b\nb\nb");
  });

  it("computeFuzzyMatchRegex returns null when no reasonable match exists", () => {
    expect(computeFuzzyMatchRegex("unrelated", "const x = 1;")).toBeNull();
  });
});
