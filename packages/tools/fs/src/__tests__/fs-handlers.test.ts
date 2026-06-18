import { describe, it, expect } from "vitest";
import type { FileSystem } from "@volto/core";
import { createLsTool } from "../ls.js";
import { createGlobTool } from "../glob.js";
import { createGrepTool } from "../grep.js";
import { createWriteFileTool } from "../write-file.js";

/** Build a FileSystem fake; override only the methods a given test exercises. */
function fakeFs(overrides: Partial<FileSystem>): FileSystem {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    read: reject as FileSystem["read"],
    write: reject as FileSystem["write"],
    stat: reject as FileSystem["stat"],
    list: reject as FileSystem["list"],
    glob: reject as FileSystem["glob"],
    grep: reject as FileSystem["grep"],
    ...overrides,
  };
}

describe("createLsTool", () => {
  it("lists directory entries with d/- prefixes", async () => {
    const tool = createLsTool(
      fakeFs({
        list: async () => ({
          entries: [
            { name: "src", path: "src", isDirectory: true },
            { name: "index.ts", path: "index.ts", isDirectory: false },
          ],
        }),
      }),
    );
    const result = await tool.handler({ path: "." });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toBe("d src\n- index.ts");
    expect(result.displayMetadata?.entryCount).toBe(2);
  });

  it('returns "(empty)" for an empty directory', async () => {
    const tool = createLsTool(fakeFs({ list: async () => ({ entries: [] }) }));
    const result = await tool.handler({ path: "." });
    expect(result.modelContent).toBe("(empty)");
  });

  it("returns an isError result when the path does not exist", async () => {
    const tool = createLsTool(
      fakeFs({
        list: async () => {
          throw new Error("ENOENT: no such directory");
        },
      }),
    );
    const result = await tool.handler({ path: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("ls failed");
  });
});

describe("createGlobTool", () => {
  it("returns matched paths joined by newline", async () => {
    const tool = createGlobTool(
      fakeFs({ glob: async () => ({ paths: ["a.ts", "b.ts"] }) }),
    );
    const result = await tool.handler({ pattern: "**/*.ts" });
    expect(result.modelContent).toBe("a.ts\nb.ts");
    expect(result.displayMetadata?.matchCount).toBe(2);
  });

  it('returns "(no matches)" when nothing matches', async () => {
    const tool = createGlobTool(fakeFs({ glob: async () => ({ paths: [] }) }));
    const result = await tool.handler({ pattern: "**/*.nope" });
    expect(result.modelContent).toBe("(no matches)");
  });

  it("rejects a missing required pattern via schema", async () => {
    const tool = createGlobTool(fakeFs({}));
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });
});

describe("createGrepTool", () => {
  it("formats matches as path:line: text", async () => {
    const tool = createGrepTool(
      fakeFs({
        grep: async () => ({
          matches: [{ path: "a.ts", line: 3, text: "const x = 1" }],
          truncated: false,
        }),
      }),
    );
    const result = await tool.handler({ query: "const" });
    expect(result.modelContent).toBe("a.ts:3: const x = 1");
    expect(result.displayMetadata?.truncated).toBe(false);
  });

  it("appends a truncation declaration when results are truncated", async () => {
    const tool = createGrepTool(
      fakeFs({
        grep: async () => ({
          matches: [{ path: "a.ts", line: 1, text: "hit" }],
          truncated: true,
        }),
      }),
    );
    const result = await tool.handler({ query: "hit", limit: 1 });
    expect(result.modelContent).toContain("(truncated at 1 matches)");
    expect(result.displayMetadata?.truncated).toBe(true);
  });

  it('returns "(no matches)" when grep finds nothing', async () => {
    const tool = createGrepTool(
      fakeFs({ grep: async () => ({ matches: [], truncated: false }) }),
    );
    const result = await tool.handler({ query: "absent" });
    expect(result.modelContent).toBe("(no matches)");
  });
});

describe("createWriteFileTool", () => {
  it("writes a file and surfaces a writeFile access fact", async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const tool = createWriteFileTool(
      fakeFs({
        write: async (path, data) => {
          writes.push({ path, data });
        },
        stat: async () => ({ path: "out.ts", mtime: 1234, size: 0, isDirectory: false }),
      }),
    );
    const result = await tool.handler({ path: "out.ts", content: "hello" });
    expect(result.isError).toBeFalsy();
    expect(writes).toEqual([{ path: "out.ts", data: "hello" }]);
    expect(result.displayMetadata?.writeFile).toEqual({ path: "out.ts", mtime: 1234 });
  });

  it("rejects a missing content field via schema", async () => {
    const tool = createWriteFileTool(fakeFs({}));
    const result = await tool.handler({ path: "out.ts" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("Invalid input");
  });

  it("returns an isError result when the write throws", async () => {
    const tool = createWriteFileTool(
      fakeFs({
        write: async () => {
          throw new Error("EACCES");
        },
      }),
    );
    const result = await tool.handler({ path: "out.ts", content: "x" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("write_file failed");
  });
});
