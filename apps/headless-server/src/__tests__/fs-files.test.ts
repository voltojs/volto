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
