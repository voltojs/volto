import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../filesystem.js";
import { createSandboxedFileSystem, SandboxBoundaryError } from "../sandboxed-filesystem.js";

let workspace: string;
let outside: string;

beforeEach(async () => {
  // Deliberately NOT pre-realpath'ed: os.tmpdir() is itself a symlink on
  // macOS (/tmp -> /private/tmp), and that is exactly the case the sandbox
  // must handle on its own — resolving writableRoots through realpath, not
  // by requiring callers to pre-resolve their inputs.
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "volto-fs-sandbox-"));
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
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" }, { root: workspace });

    await expect(sandboxed.write("new.txt", "data")).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
  });

  it("leaves the file untouched on disk when a write is rejected", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" }, { root: workspace });

    await sandboxed.write("existing.txt", "overwritten").catch(() => {});

    const onDisk = await fsp.readFile(path.join(workspace, "existing.txt"), "utf-8");
    expect(onDisk).toBe("hello");
  });

  it("still allows reads", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" }, { root: workspace });

    const result = await sandboxed.read("existing.txt");
    expect(result.content).toContain("hello");
  });
});

describe("createSandboxedFileSystem — workspace-write", () => {
  it("allows a write inside the writable root", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [workspace] },
      { root: workspace },
    );

    await sandboxed.write("new.txt", "data");

    const onDisk = await fsp.readFile(path.join(workspace, "new.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("allows a write to a not-yet-existing nested path", async () => {
    // The target file does not exist yet, so its own realpath cannot be
    // resolved — the check must fall back to the nearest existing ancestor.
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [workspace] },
      { root: workspace },
    );

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
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [workspace] },
      { root: workspace },
    );

    await expect(
      sandboxed.write("escape/secret.txt", "pwned"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);

    const onDisk = await fsp.readFile(path.join(outside, "secret.txt"), "utf-8");
    expect(onDisk).toBe("classified");
  });

  it("rejects a write into a read-only overlay", async () => {
    await fsp.mkdir(path.join(workspace, ".git"), { recursive: true });

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      {
        mode: "workspace-write",
        writableRoots: [workspace],
        readOnlyOverlays: [".git", ".env"],
      },
      { root: workspace },
    );

    await expect(sandboxed.write(".git/config", "[core]")).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
  });

  it("catches a read-only overlay nested several levels deep", async () => {
    // Regresses against a matcher that only checked the last path segment.
    await fsp.mkdir(path.join(workspace, "a/b/.git"), { recursive: true });

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      {
        mode: "workspace-write",
        writableRoots: [workspace],
        readOnlyOverlays: [".git"],
      },
      { root: workspace },
    );

    await expect(
      sandboxed.write("a/b/.git/config", "[core]"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);
  });

  it("does not false-positive on a filename that merely contains the overlay name as a substring", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      {
        mode: "workspace-write",
        writableRoots: [workspace],
        readOnlyOverlays: [".git"],
      },
      { root: workspace },
    );

    await sandboxed.write("myfile.gitignore", "ignored");

    const onDisk = await fsp.readFile(path.join(workspace, "myfile.gitignore"), "utf-8");
    expect(onDisk).toBe("ignored");
  });

  it("honors a multi-segment overlay entry as a path prefix (Finding 3)", async () => {
    // "secrets/prod.env" has no single segment equal to a full-path entry,
    // so segment-only matching can never catch it — it must be matched as a
    // path prefix relative to the writable root instead.
    await fsp.mkdir(path.join(workspace, "secrets"), { recursive: true });
    await fsp.writeFile(path.join(workspace, "secrets/prod.env"), "SECRET=1", "utf-8");

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      {
        mode: "workspace-write",
        writableRoots: [workspace],
        readOnlyOverlays: ["secrets/prod.env"],
      },
      { root: workspace },
    );

    await expect(
      sandboxed.write("secrets/prod.env", "SECRET=leaked"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);

    const onDisk = await fsp.readFile(path.join(workspace, "secrets/prod.env"), "utf-8");
    expect(onDisk).toBe("SECRET=1");
  });

  it("names the offending path and mode on the error", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(inner, { mode: "read-only" }, { root: workspace });

    const error = await sandboxed.write("new.txt", "data").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxBoundaryError);
    expect((error as SandboxBoundaryError).mode).toBe("read-only");
    expect((error as SandboxBoundaryError).path).toContain("new.txt");
    // The model reads this message and must learn what to do next, not just
    // that it failed.
    expect((error as SandboxBoundaryError).message).toContain("read-only");
  });

  it("accepts a symlinked path passed directly as a writableRoots entry (Finding 2)", async () => {
    // writableRoots itself may be a symlink (e.g. the documented default
    // os.tmpdir() on macOS). The root-side of the comparison must be
    // realpath-resolved too, or every write under it is wrongly rejected.
    const symlinkedRoot = path.join(path.dirname(workspace), "workspace-link");
    await fsp.symlink(workspace, symlinkedRoot, "dir");

    const inner = createNodeFileSystem({ root: symlinkedRoot });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [symlinkedRoot] },
      { root: symlinkedRoot },
    );

    await sandboxed.write("new.txt", "data");

    const onDisk = await fsp.readFile(path.join(workspace, "new.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("catches a symlink several levels up the path, not just the last component", async () => {
    // realResolve must walk the whole path, not just check whether the
    // final component is a symlink.
    const linkedDir = path.join(path.dirname(workspace), "linked-ancestor");
    await fsp.symlink(outside, linkedDir, "dir");
    await fsp.mkdir(path.join(workspace, "nested"), { recursive: true });
    // Point deep inside the workspace at a symlinked ancestor several
    // segments above the write target.
    await fsp.symlink(linkedDir, path.join(workspace, "nested", "deep-link"), "dir");

    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [workspace] },
      { root: workspace },
    );

    await expect(
      sandboxed.write("nested/deep-link/some/deeper/path/secret.txt", "pwned"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);
  });

  it("refuses a write when the inner FileSystem's construction root differs from writableRoots[0] (Finding 1)", async () => {
    // Inner fs is rooted at the whole base dir (so e.g. grep/glob can see
    // both workspace/ and outside/), but only workspace/ is writable. A
    // relative target must be checked AND written against the same root —
    // resolving the check against writableRoots[0] while the inner fs
    // resolves the write against its own construction root would let a
    // write that checks as "inside workspace" actually land outside it.
    //
    // Everything here is pre-realpath'ed (unlike the shared beforeEach)
    // specifically so this test isolates Finding 1 from Finding 2's
    // symlink-asymmetry bug: on macOS os.tmpdir() sits under a symlink
    // (/tmp -> /private/tmp), and under the pre-fix code that asymmetry
    // alone makes even a same-root write "fail closed" for the wrong
    // reason, which would incidentally mask the Finding 1 bypass instead
    // of demonstrating it.
    const realBase = await fsp.realpath(path.dirname(workspace));
    const realWorkspace = path.join(realBase, path.basename(workspace));
    const realOutside = path.join(realBase, path.basename(outside));

    const inner = createNodeFileSystem({ root: realBase });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "workspace-write", writableRoots: [realWorkspace] },
      { root: realBase },
    );

    // A target that is a sibling of "workspace" relative to the inner root
    // resolves OUTSIDE the writable root and must be rejected.
    await expect(
      sandboxed.write("outside/pwned.txt", "pwned"),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);

    await expect(fsp.access(path.join(realOutside, "pwned.txt"))).rejects.toBeTruthy();
  });
});

describe("createSandboxedFileSystem — danger-full-access", () => {
  it("passes writes straight through", async () => {
    const inner = createNodeFileSystem({ root: workspace });
    const sandboxed = createSandboxedFileSystem(
      inner,
      { mode: "danger-full-access" },
      { root: workspace },
    );

    await sandboxed.write("new.txt", "data");

    const onDisk = await fsp.readFile(path.join(workspace, "new.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("returns the very same object rather than a wrapper", () => {
    const inner = createNodeFileSystem({ root: workspace });
    expect(
      createSandboxedFileSystem(inner, { mode: "danger-full-access" }, { root: workspace }),
    ).toBe(inner);
  });
});
