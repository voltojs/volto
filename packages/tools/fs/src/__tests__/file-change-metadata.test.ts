import { describe, it, expect } from "vitest";
import type { FileSystem, ToolResult } from "@volto/core";
import { createApplyPatchTool } from "../apply-patch.js";
import { createEditFileTool } from "../edit-file.js";
import { createMultiEditTool } from "../multi-edit.js";
import { createWriteFileTool } from "../write-file.js";

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
    async write(path, data) {
      store.set(path, data);
    },
    async stat(path) {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
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

interface FileChangeMeta {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

function fileChangeOf(result: ToolResult): FileChangeMeta {
  const change = result.displayMetadata?.["fileChange"] as FileChangeMeta | undefined;
  expect(change).toBeDefined();
  return change!;
}

describe("write tools report their change in displayMetadata", () => {
  it("write_file reports a creation as a pure addition", async () => {
    const fs = createInMemoryFs({});
    const result = await createWriteFileTool(fs).handler({ path: "a.ts", content: "one\ntwo\n" });
    expect(result.isError).toBeFalsy();
    const change = fileChangeOf(result);
    expect(change).toMatchObject({ path: "a.ts", additions: 2, deletions: 0, truncated: false });
    expect(change.diff.split("\n")).toEqual(["@@ -0,0 +1,2 @@", "+one", "+two"]);
  });

  it("write_file reports the overwritten text as a replacement", async () => {
    const fs = createInMemoryFs({ "a.ts": "old\n" });
    const result = await createWriteFileTool(fs).handler({ path: "a.ts", content: "new\n" });
    const change = fileChangeOf(result);
    expect(change).toMatchObject({ additions: 1, deletions: 1 });
    expect(change.diff.split("\n")).toEqual(["@@ -1,1 +1,1 @@", "-old", "+new"]);
  });

  it("edit_file reports the replaced line", async () => {
    const fs = createInMemoryFs({ "a.ts": "const a = 1;\nconst b = 2;\n" });
    const result = await createEditFileTool(fs).handler({
      path: "a.ts",
      old_string: "const b = 2;",
      new_string: "const b = 3;",
    });
    expect(result.isError).toBeFalsy();
    const change = fileChangeOf(result);
    expect(change.additions).toBe(1);
    expect(change.deletions).toBe(1);
    expect(change.diff).toContain("-const b = 2;");
    expect(change.diff).toContain("+const b = 3;");
  });

  it("multi_edit reports the combined change of a batch", async () => {
    const fs = createInMemoryFs({ "a.ts": "a\nb\nc\n" });
    const result = await createMultiEditTool(fs).handler({
      path: "a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "c", new_string: "C" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const change = fileChangeOf(result);
    expect(change.additions).toBe(2);
    expect(change.deletions).toBe(2);
    expect(change.diff).toContain("+A");
    expect(change.diff).toContain("+C");
  });

  it("apply_patch reports the applied hunk as a replacement", async () => {
    const fs = createInMemoryFs({ "a.ts": "line1\nline2\nline3\n" });
    const result = await createApplyPatchTool(fs).handler({
      path: "a.ts",
      patch: ["@@ -2,1 +2,1 @@", "-line2", "+patched"].join("\n"),
    });
    expect(result.isError).toBeFalsy();
    const change = fileChangeOf(result);
    expect(change).toMatchObject({ additions: 1, deletions: 1 });
    expect(change.diff).toContain("-line2");
    expect(change.diff).toContain("+patched");
  });

  it("omits the change metadata when the write fails", async () => {
    const fs = createInMemoryFs({});
    const failing: FileSystem = {
      ...fs,
      async write() {
        throw new Error("EROFS: read-only file system");
      },
    };
    const result = await createWriteFileTool(failing).handler({ path: "a.ts", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.displayMetadata?.["fileChange"]).toBeUndefined();
  });
});