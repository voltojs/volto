import { describe, it, expect } from "vitest";
import type { FileSystem } from "@voltojs/core";
import { createApplyPatchTool } from "../apply-patch.js";
import { createMultiEditTool } from "../multi-edit.js";

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
    async readBytes() {
      return Promise.reject(new Error("readBytes is not implemented in this test double"));
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

// ──────────────────────────────────────────────
// apply_patch tests
// ──────────────────────────────────────────────

describe("apply_patch", () => {
  const fileContent = "line1\nline2\nline3\nline4\nline5";

  it("applies a valid unified diff hunk", async () => {
    const fs = createInMemoryFs({ "test.ts": fileContent });
    const tool = createApplyPatchTool(fs);

    const patch = [
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2-modified",
      " line3",
    ].join("\n");

    const result = await tool.handler({ path: "test.ts", patch });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("1 hunk");

    const updated = await fs.read("test.ts");
    expect(updated.content).toContain("line2-modified");
  });

  it("returns isError with candidates when hunk doesn't match", async () => {
    const fs = createInMemoryFs({ "test.ts": fileContent });
    const tool = createApplyPatchTool(fs);

    const patch = [
      "@@ -1,3 +1,3 @@",
      " line1",
      "-nonexistent",
      "+replaced",
      " line3",
    ].join("\n");

    const result = await tool.handler({ path: "test.ts", patch });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("did not match");
  });

  it("returns isError for empty diff (no hunks)", async () => {
    const fs = createInMemoryFs({ "test.ts": fileContent });
    const tool = createApplyPatchTool(fs);

    const result = await tool.handler({ path: "test.ts", patch: "just some random text" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("no hunks");
  });

  it("returns isError when file doesn't exist", async () => {
    const fs = createInMemoryFs({});
    const tool = createApplyPatchTool(fs);

    const patch = "@@ -1,1 +1,1 @@\n-a\n+b";
    const result = await tool.handler({ path: "missing.ts", patch });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("ENOENT");
  });

  it("applies multiple hunks in sequence", async () => {
    const fs = createInMemoryFs({ "test.ts": "aaa\nbbb\nccc" });
    const tool = createApplyPatchTool(fs);

    const patch = [
      "@@ -1,3 +1,3 @@",
      "-aaa",
      "+AAA",
      " bbb",
      "-ccc",
      "+CCC",
    ].join("\n");

    const result = await tool.handler({ path: "test.ts", patch });
    expect(result.isError).toBeFalsy();
    const updated = await fs.read("test.ts");
    expect(updated.content).toBe("AAA\nbbb\nCCC");
  });
});

// ──────────────────────────────────────────────
// multi_edit tests
// ──────────────────────────────────────────────

describe("multi_edit", () => {
  const fileContent = "function hello() {\n  console.log('hello');\n  return true;\n}";

  it("applies multiple edits atomically", async () => {
    const fs = createInMemoryFs({ "test.ts": fileContent });
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "test.ts",
      edits: [
        { old_string: "function hello()", new_string: "function greet()" },
        { old_string: "return true", new_string: "return false" },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("2 edit(s)");
    const updated = await fs.read("test.ts");
    expect(updated.content).toContain("greet");
    expect(updated.content).toContain("return false");
  });

  it("atomicity: rolls back all edits if one fails", async () => {
    const fs = createInMemoryFs({ "test.ts": fileContent });
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "test.ts",
      edits: [
        { old_string: "hello", new_string: "greet" },
        { old_string: "nonexistent_string_xyz", new_string: "nope" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("aborted");
    expect(result.modelContent).toContain("File unchanged");

    // File should be unchanged (atomicity)
    const content = await fs.read("test.ts");
    expect(content.content).toBe(fileContent);
  });

  it("returns isError for duplicate matches without replace_all", async () => {
    const fs = createInMemoryFs({ "test.ts": "aaa aaa aaa" });
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "test.ts",
      edits: [{ old_string: "aaa", new_string: "bbb" }],
    });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("matched 3 times");
  });

  it("replace_all replaces all occurrences", async () => {
    const fs = createInMemoryFs({ "test.ts": "aaa aaa aaa" });
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "test.ts",
      edits: [{ old_string: "aaa", new_string: "bbb", replace_all: true }],
    });

    expect(result.isError).toBeFalsy();
    const content = await fs.read("test.ts");
    expect(content.content).toBe("bbb bbb bbb");
  });

  it("returns isError when file doesn't exist", async () => {
    const fs = createInMemoryFs({});
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "missing.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("ENOENT");
  });

  it("returns isError for empty old_string", async () => {
    const fs = createInMemoryFs({ "test.ts": "content" });
    const tool = createMultiEditTool(fs);

    const result = await tool.handler({
      path: "test.ts",
      edits: [{ old_string: "", new_string: "new" }],
    });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("old_string must not be empty");
  });
});
