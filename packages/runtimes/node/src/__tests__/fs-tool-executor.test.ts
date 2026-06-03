import { describe, it, expect, beforeEach } from "vitest";
import type { FileSystem, FileReadResult, FileStat, FileListResult, FileGlobResult, FileGrepResult } from "@agent-core/core";
import { createFsToolExecutor } from "../tool-executor.js";
import { createNodeFileSystem } from "../filesystem.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function createInMemoryFs(seed: Record<string, string>): FileSystem {
  const store = new Map(Object.entries(seed));

  return {
    async read(target, offset = 1, limit?): Promise<FileReadResult> {
      const content = store.get(target);
      if (content === undefined) {
        throw new Error(`ENOENT: ${target}`);
      }
      const lines = content.split(/\r?\n/);
      const clampedOffset = Math.max(1, Math.min(offset, lines.length));
      const sliced = limit ? lines.slice(clampedOffset - 1, clampedOffset - 1 + limit) : lines.slice(clampedOffset - 1);
      return {
        content: sliced.join("\n"),
        totalLines: lines.length,
        truncated: typeof limit === "number" ? clampedOffset - 1 + sliced.length < lines.length : false,
      };
    },
    async write(target, data): Promise<void> {
      store.set(target, data);
    },
    async stat(target): Promise<FileStat> {
      if (!store.has(target)) {
        throw new Error(`ENOENT: ${target}`);
      }
      return { path: target, isDirectory: false, size: store.get(target)?.length ?? 0, mtime: 0 };
    },
    async list(): Promise<FileListResult> {
      return { entries: [] };
    },
    async glob(): Promise<FileGlobResult> {
      return { paths: [] };
    },
    async grep(): Promise<FileGrepResult> {
      return { matches: [], truncated: false };
    },
  };
}

describe("fs tool executor", () => {
  it("should read and then edit a file with in-memory filesystem", async () => {
    const fileSystem = createInMemoryFs({ "example.ts": "const value = 1;\n" });
    const execute = createFsToolExecutor({ fs: fileSystem, clock: { now: () => 1 } });

    const readResult = await execute({
      id: "c1",
      name: "read_file",
      input: { path: "example.ts" },
    });

    expect(readResult.isError).toBeFalsy();
    expect(readResult.displayMetadata?.readFile).toEqual({ path: "example.ts" });
    expect(readResult.displayMetadata?.readAt).toBe(1);

    const editResult = await execute({
      id: "c2",
      name: "edit_file",
      input: {
        path: "example.ts",
        old_string: "const value = 1;",
        new_string: "const value = 42;",
      },
    });

    expect(editResult.isError).toBeFalsy();
    expect(editResult.modelContent).toContain("replacement applied");
  });

  it("should block edit_file when read_file was not called", async () => {
    const fileSystem = createInMemoryFs({ "blocked.ts": "export const x = 1;" });
    const execute = createFsToolExecutor({ fs: fileSystem, clock: { now: () => 1 } });

    const editResult = await execute({
      id: "c1",
      name: "edit_file",
      input: {
        path: "blocked.ts",
        old_string: "export const x = 1;",
        new_string: "export const x = 2;",
      },
    });

    expect(editResult.isError).toBe(true);
    expect(editResult.modelContent).toContain("read_file");
  });
});

describe("node filesystem boundary", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-core-fs-"));
  });

  it("should reject paths outside the workspace boundary", async () => {
    const fileSystem = createNodeFileSystem({ root });
    const execute = createFsToolExecutor({ fs: fileSystem, clock: { now: () => 1 } });

    const result = await execute({
      id: "c1",
      name: "read_file",
      input: { path: "../escape.txt" },
    });

    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("escapes the workspace boundary");
  });
});
