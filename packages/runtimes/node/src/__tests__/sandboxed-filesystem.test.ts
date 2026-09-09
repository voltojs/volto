import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../filesystem.js";
import { createSandboxedFileSystem, SandboxBoundaryError } from "../sandboxed-filesystem.js";

let workspace: string;
let outside: string;

beforeEach(async () => {
  // On macOS, os.tmpdir() lives under a symlink (/tmp -> /private/tmp), so a
  // realpath resolution deep inside the sandbox would otherwise disagree with
  // the lexical writableRoots we pass here. Resolve to the real path up front
  // so both sides of every comparison agree.
  const rawBase = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-fs-sandbox-"));
  const base = await fsp.realpath(rawBase);
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(workspace, "existing.txt"), "hello", "utf-8");
  await fsp.writeFile(path.join(outside, "secret.txt"), "classified", "utf-8");
});

afterEach(async () => {
  await fsp.rm(path.dirname(workspace), { recursive: true, force: true });
});

describe("createSandboxedFileSystem — read-only", () => {
  it("rejects a write with SandboxBoundaryError", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" });

    await expect(sandboxed.write("new.txt", "data")).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
  });

  it("leaves the file untouched on disk when a write is rejected", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" });

    await sandboxed.write("existing.txt", "overwritten").catch(() => {});

    const onDisk = await fsp.readFile(path.join(workspace, "existing.txt"), "utf-8");
    expect(onDisk).toBe("hello");
  });

  it("still allows reads", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" });

    const result = await sandboxed.read("existing.txt");
    expect(result.content).toContain("hello");
  });
});

describe("createSandboxedFileSystem — workspace-write", () => {
  it("allows a write inside the writable root", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, {
      mode: "workspace-write",
      writableRoots: [workspace],
    });

    await sandboxed.write("new.txt", "data");

    const onDisk = await fsp.readFile(path.join(workspace, "new.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("allows a write to a not-yet-existing nested path", async () => {
    // The target file does not exist yet, so its own realpath cannot be
    // resolved — the check must fall back to the nearest existing ancestor.
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, {
      mode: "workspace-write",
      writableRoots: [workspace],
    });

    await sandboxed.write("deep/nested/new.txt", "data");

    const onDisk = await fsp.readFile(
      path.join(workspace, "deep/nested/new.txt"),
      "utf-8",
    );
    expect(onDisk).toBe("data");
  });

  it("rejects a write through a symlink that escapes the writable root", async () => {
    // A purely lexical prefix check passes here — the path never contains
    // "..", it just points somewhere else once resolved.
    await fsp.symlink(outside, path.join(workspace, "escape"), "dir");

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, {
      mode: "workspace-write",
      writableRoots: [workspace],
    });

    await expect(
      sandboxed.write("escape/secret.txt", "pwned"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);

    const onDisk = await fsp.readFile(path.join(outside, "secret.txt"), "utf-8");
    expect(onDisk).toBe("classified");
  });

  it("rejects a write into a read-only overlay", async () => {
    await fsp.mkdir(path.join(workspace, ".git"), { recursive: true });

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, {
      mode: "workspace-write",
      writableRoots: [workspace],
      readOnlyOverlays: [".git", ".env"],
    });

    await expect(sandboxed.write(".git/config", "[core]")).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
  });

  it("names the offending path and mode on the error", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" });

    const error = await sandboxed.write("new.txt", "data").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxBoundaryError);
    expect((error as SandboxBoundaryError).mode).toBe("read-only");
    expect((error as SandboxBoundaryError).path).toContain("new.txt");
    // The model reads this message and must learn what to do next, not just
    // that it failed.
    expect((error as SandboxBoundaryError).message).toContain("read-only");
  });
});

describe("createSandboxedFileSystem — danger-full-access", () => {
  it("passes writes straight through", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "danger-full-access" });

    await sandboxed.write("new.txt", "data");

    const onDisk = await fsp.readFile(path.join(workspace, "new.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("returns the very same object rather than a wrapper", () => {
    const inner = createNodeFileSystem({ root: workspace });
    expect(
      createSandboxedFileSystem(inner, { mode: "danger-full-access" }),
    ).toBe(inner);
  });
});
