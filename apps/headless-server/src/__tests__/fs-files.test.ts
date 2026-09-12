// apps/headless-server/src/__tests__/fs-files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  PathOutsideProjectError,
  NotADirectoryError,
  listDirectory,
} from "../fs/files.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-files-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "README.md"), "hello");
  await fs.writeFile(path.join(root, "src", "a.ts"), "export {};");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("accepts a relative path inside the root", async () => {
    const { resolveWithinRoot } = await import("../fs/files.js");
    const abs = await resolveWithinRoot(root, "src/a.ts");
    expect(abs).toBe(path.join(root, "src", "a.ts"));
  });

  it("accepts the root itself via an empty rel", async () => {
    const { resolveWithinRoot } = await import("../fs/files.js");
    expect(await resolveWithinRoot(root, "")).toBe(path.resolve(root));
  });

  it.each([
    ["../outside", "escapes the project root"],
    ["src/../../etc", "escapes the project root"],
    ["/etc/passwd", "must be relative"],
  ])("rejects %j with a signature, not just a non-zero result", async (rel, signature) => {
    const { resolveWithinRoot } = await import("../fs/files.js");
    await expect(resolveWithinRoot(root, rel)).rejects.toThrow(signature);
  });

  it("rejects a symlink that points outside the root (realpath pass)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fs-outside-"));
    await fs.symlink(outside, path.join(root, "leak"));
    const { resolveWithinRoot } = await import("../fs/files.js");
    await expect(resolveWithinRoot(root, "leak")).rejects.toThrow(PathOutsideProjectError);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("allows a symlink that stays inside the root", async () => {
    await fs.symlink(path.join(root, "README.md"), path.join(root, "src", "link.md"));
    const { resolveWithinRoot } = await import("../fs/files.js");
    await expect(resolveWithinRoot(root, "src/link.md")).resolves.toBeDefined();
  });
});

describe("listDirectory", () => {
  it("lists entries, skipping hidden and ignored names, dirs first then name asc", async () => {
    const entries = await listDirectory(root, "");
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"]);
    expect(entries[0]).toMatchObject({ name: "src", type: "dir" });
    expect(entries[1]).toMatchObject({ type: "file", size: 5 });
  });

  it("lists a subdirectory", async () => {
    const entries = await listDirectory(root, "src");
    expect(entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("throws NotADirectoryError when the target is a file", async () => {
    await expect(listDirectory(root, "README.md")).rejects.toThrow(NotADirectoryError);
  });

  it("propagates ENOENT for a missing directory", async () => {
    await expect(listDirectory(root, "nope")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("searchFiles", () => {
  it("matches filenames case-insensitively and returns relative paths", async () => {
    await fs.writeFile(path.join(root, "src", "Router.TS"), "export {};");
    const { searchFiles } = await import("../fs/files.js");
    expect(await searchFiles(root, "rout")).toEqual(["src/Router.TS"]);
  });

  it("never descends into ignored or hidden directories", async () => {
    await fs.writeFile(path.join(root, "node_modules", "pkg", "routed.js"), "x");
    await fs.mkdir(path.join(root, ".next"), { recursive: true });
    await fs.writeFile(path.join(root, ".next", "routed.js"), "x");
    const { searchFiles } = await import("../fs/files.js");
    expect(await searchFiles(root, "rout")).toEqual([]);
  });

  it("stops at the cap", async () => {
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(root, `hit${i}.txt`), "x");
    const { searchFiles } = await import("../fs/files.js");
    expect((await searchFiles(root, "hit", 3)).length).toBe(3);
  });
});

describe("readFilePayload", () => {
  it("returns text with truncated=false for a small file", async () => {
    const { readFilePayload } = await import("../fs/files.js");
    expect(await readFilePayload(root, "README.md")).toEqual({
      kind: "text", content: "hello", truncated: false, size: 5,
    });
  });

  it("truncates text beyond 512KB and says so", async () => {
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(512 * 1024 + 10));
    const { readFilePayload } = await import("../fs/files.js");
    const data = await readFilePayload(root, "big.txt");
    expect(data).toMatchObject({ kind: "text", truncated: true, size: 512 * 1024 + 10 });
    if (data.kind === "text") expect(data.content.length).toBeLessThanOrEqual(512 * 1024 + 1);
  });

  it("classifies NUL-byte content as binary", async () => {
    await fs.writeFile(path.join(root, "blob.dat"), Buffer.from([0x70, 0x00, 0x71]));
    const { readFilePayload } = await import("../fs/files.js");
    expect(await readFilePayload(root, "blob.dat")).toEqual({ kind: "binary", size: 3 });
  });

  it("returns base64 + mediaType for images", async () => {
    await fs.writeFile(path.join(root, "pic.png"), Buffer.from([0x89, 0x50]));
    const { readFilePayload } = await import("../fs/files.js");
    const data = await readFilePayload(root, "pic.png");
    expect(data).toMatchObject({ kind: "image", mediaType: "image/png", size: 2 });
  });

  it("rejects oversized images with FileTooLargeError", async () => {
    await fs.writeFile(path.join(root, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const { readFilePayload, FileTooLargeError } = await import("../fs/files.js");
    await expect(readFilePayload(root, "huge.png")).rejects.toThrow(FileTooLargeError);
  });

  it("rejects a directory target with NotADirectoryError", async () => {
    const { readFilePayload, NotADirectoryError } = await import("../fs/files.js");
    await expect(readFilePayload(root, "src")).rejects.toThrow(NotADirectoryError);
  });
});
