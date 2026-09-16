import { describe, it, expect } from "vitest";
import type { FileSystem, FileReadResult, FileStat } from "@volto/core";
import { createEditFileTool } from "../edit-file.js";

function createInMemoryFs(seed: Record<string, string>): {
  fs: FileSystem;
  get: (p: string) => string | undefined;
} {
  const store = new Map(Object.entries(seed));
  const fs: FileSystem = {
    async read(path, offset = 1, limit?): Promise<FileReadResult> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      const lines = content.split(/\r?\n/);
      const sliced = limit
        ? lines.slice(offset - 1, offset - 1 + limit)
        : lines.slice(offset - 1);
      return {
        content: sliced.join("\n"),
        totalLines: lines.length,
        truncated: false,
      };
    },
    async readBytes(): Promise<never> {
      throw new Error("readBytes is not implemented in this test double");
    },
    async write(path, data) {
      store.set(path, data);
    },
    async stat(path): Promise<FileStat> {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return { path, isDirectory: false, size: 0, mtime: 0 };
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
  return { fs, get: (p) => store.get(p) };
}

describe("TC-E2: edit_file fuzzy 缩进保持端到端", () => {
  it("fuzzy match preserves 4-space indentation across multi-line replacement", async () => {
    const content = "  function hello() {\n    return 1;\n  }";
    const { fs, get } = createInMemoryFs({ "hello.ts": content });
    const tool = createEditFileTool(fs);

    // old_string has no indentation (single-line collapsed form).
    // The fuzzy match collapses whitespace in the file content to find the match,
    // then preserveIndentation detects the leading "  " and applies it to
    // subsequent lines of the new_string.
    const result = await tool.handler({
      path: "hello.ts",
      old_string: "function hello() {\n  return 1;\n}",
      new_string: "function hello() {\n  return 2;\n}",
    });

    expect(result.isError).toBeFalsy();
    const after = get("hello.ts");
    expect(after).toBe("  function hello() {\n    return 2;\n  }");
  });

  it("single-line fuzzy replacement preserves leading indentation", async () => {
    const content = "    const x = 1;";
    const { fs, get } = createInMemoryFs({ "a.ts": content });
    const tool = createEditFileTool(fs);

    const result = await tool.handler({
      path: "a.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });

    expect(result.isError).toBeFalsy();
    expect(get("a.ts")).toBe("    const x = 2;");
  });
});
