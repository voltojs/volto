import { describe, it, expect, beforeEach } from "vitest";
import type { FileSystem, FileReadResult, FileStat, ReadFileRecord } from "@volto/core";
import { createFsToolExecutor } from "../tool-executor.js";
import { createNodeFileSystem } from "../filesystem.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** In-memory FS where mtime advances on every write (realistic behavior). */
function createInMemoryFs(seed: Record<string, string>): { fs: FileSystem; get: (p: string) => string | undefined } {
  const store = new Map(Object.entries(seed));
  const mtimes = new Map<string, number>(Object.keys(seed).map((k) => [k, 100]));
  let clock = 100;

  const filesystem: FileSystem = {
    async read(target, offset = 1, limit?): Promise<FileReadResult> {
      const content = store.get(target);
      if (content === undefined) throw new Error(`ENOENT: ${target}`);
      const lines = content.split(/\r?\n/);
      const clamped = Math.max(1, Math.min(offset, lines.length));
      const sliced = limit ? lines.slice(clamped - 1, clamped - 1 + limit) : lines.slice(clamped - 1);
      return { content: sliced.join("\n"), totalLines: lines.length, truncated: false };
    },
    async write(target, data): Promise<void> {
      store.set(target, data);
      mtimes.set(target, ++clock);
    },
    async stat(target): Promise<FileStat> {
      if (!store.has(target)) throw new Error(`ENOENT: ${target}`);
      return { path: target, isDirectory: false, size: store.get(target)?.length ?? 0, mtime: mtimes.get(target) ?? 0 };
    },
    async list() { return { entries: [] }; },
    async glob() { return { paths: [] }; },
    async grep() { return { matches: [], truncated: false }; },
  };
  return { fs: filesystem, get: (p) => store.get(p) };
}

const noReads: { readFiles: ReadFileRecord[] } = { readFiles: [] };

describe("fs tool executor — read-before-edit + staleness gate", () => {
  it("allows edit when the path was read and is unchanged", async () => {
    const { fs: filesystem, get } = createInMemoryFs({ "example.ts": "const value = 1;\n" });
    const execute = createFsToolExecutor({ fs: filesystem });

    const read = await execute({ id: "c1", name: "read_file", input: { path: "example.ts" } }, noReads);
    expect(read.isError).toBeFalsy();
    const meta = read.displayMetadata?.readFile as { path: string; mtime: number };
    expect(meta).toMatchObject({ path: "example.ts" });

    // Simulate the reducer having recorded the read.
    const ctx = { readFiles: [{ path: "example.ts", version: 1, mtime: meta.mtime }] };
    const edit = await execute(
      { id: "c2", name: "edit_file", input: { path: "example.ts", old_string: "const value = 1;", new_string: "const value = 42;" } },
      ctx,
    );
    expect(edit.isError).toBeFalsy();
    expect(get("example.ts")).toContain("const value = 42;");
  });

  it("blocks edit when read_file was not called AND does not write", async () => {
    const { fs: filesystem, get } = createInMemoryFs({ "blocked.ts": "export const x = 1;" });
    const execute = createFsToolExecutor({ fs: filesystem });

    const edit = await execute(
      { id: "c1", name: "edit_file", input: { path: "blocked.ts", old_string: "export const x = 1;", new_string: "HACKED" } },
      noReads,
    );

    expect(edit.isError).toBe(true);
    expect(edit.modelContent).toContain("read_file");
    // Critical: the file must NOT have been modified (gate runs before the write).
    expect(get("blocked.ts")).toBe("export const x = 1;");
  });

  it("blocks edit when the file changed since the last read (staleness)", async () => {
    const { fs: filesystem, get } = createInMemoryFs({ "stale.ts": "const v = 1;" });
    const execute = createFsToolExecutor({ fs: filesystem });

    // Recorded read saw mtime 100; the file is currently at a different mtime.
    await filesystem.write("stale.ts", "const v = 1;"); // bumps mtime to 101
    const ctx = { readFiles: [{ path: "stale.ts", version: 1, mtime: 100 }] };

    const edit = await execute(
      { id: "c1", name: "edit_file", input: { path: "stale.ts", old_string: "const v = 1;", new_string: "const v = 2;" } },
      ctx,
    );
    expect(edit.isError).toBe(true);
    expect(edit.modelContent).toContain("changed since");
    expect(get("stale.ts")).toBe("const v = 1;");
  });

  it("blocks overwrite of an existing unread file but allows creating a new file", async () => {
    const { fs: filesystem, get } = createInMemoryFs({ "exists.ts": "old" });
    const execute = createFsToolExecutor({ fs: filesystem });

    const overwrite = await execute(
      { id: "c1", name: "write_file", input: { path: "exists.ts", content: "new" } },
      noReads,
    );
    expect(overwrite.isError).toBe(true);
    expect(get("exists.ts")).toBe("old");

    const create = await execute(
      { id: "c2", name: "write_file", input: { path: "fresh.ts", content: "brand new" } },
      noReads,
    );
    expect(create.isError).toBeFalsy();
    expect(get("fresh.ts")).toBe("brand new");
  });

  it("returns an isError result (not an exception) for invalid input via Zod", async () => {
    const { fs: filesystem } = createInMemoryFs({});
    const execute = createFsToolExecutor({ fs: filesystem });
    const result = await execute({ id: "c1", name: "read_file", input: { path: 123 } }, noReads);
    expect(result.isError).toBe(true);
  });
});

describe("node filesystem boundary", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "volto-fs-"));
  });

  it("rejects paths that climb out of the workspace", async () => {
    const filesystem = createNodeFileSystem({ root });
    const execute = createFsToolExecutor({ fs: filesystem });
    const result = await execute({ id: "c1", name: "read_file", input: { path: "../escape.txt" } }, noReads);
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("escapes the workspace boundary");
  });

  it("rejects a sibling directory that shares the root name prefix", async () => {
    const filesystem = createNodeFileSystem({ root });
    const sibling = `${path.basename(root)}-evil/secret.txt`;
    const execute = createFsToolExecutor({ fs: filesystem });
    const result = await execute({ id: "c1", name: "read_file", input: { path: `../${sibling}` } }, noReads);
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("escapes the workspace boundary");
  });
});
