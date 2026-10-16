import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeSpillStore } from "../spill-store.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("createNodeSpillStore", () => {
  it("F-182 writes at the deterministic path and returns the workspace-relative path", async () => {
    const store = createNodeSpillStore({ rootDir: root });
    const r = await store.write({ sessionId: "s1", toolCallId: "c1", text: "full output" });
    expect(r.relativePath).toBe(".volto/spill/s1/c1.txt");
    const onDisk = await fs.readFile(path.join(root, ".volto", "spill", "s1", "c1.txt"), "utf8");
    expect(onDisk).toBe("full output");
  });
  it("F-182 repeated write to the same ids overwrites idempotently", async () => {
    const store = createNodeSpillStore({ rootDir: root });
    await store.write({ sessionId: "s1", toolCallId: "c1", text: "first" });
    const r = await store.write({ sessionId: "s1", toolCallId: "c1", text: "second" });
    expect(r.relativePath).toBe(".volto/spill/s1/c1.txt");
    const onDisk = await fs.readFile(path.join(root, ".volto/spill/s1/c1.txt"), "utf8");
    expect(onDisk).toBe("second");
  });
  it("F-182 REJECTS a toolCallId containing path separators (rejection itself)", async () => {
    const store = createNodeSpillStore({ rootDir: root });
    await expect(store.write({ sessionId: "s1", toolCallId: "../../etc/passwd", text: "x" }))
      .rejects.toThrow(/path segment/i);
    // and nothing was written outside the spill dir
    await expect(fs.access(path.join(root, "spill"))).rejects.toThrow();
  });
  it("F-182 REJECTS an empty / dot sessionId (rejection itself)", async () => {
    const store = createNodeSpillStore({ rootDir: root });
    await expect(store.write({ sessionId: "..", toolCallId: "c1", text: "x" }))
      .rejects.toThrow(/path segment/i);
  });
});

// Symlink creation is not supported on Windows; macOS and Linux both support
// it, so only win32 skips.
const itUnlessWindows = process.platform === "win32" ? it.skip : it;

describe("createNodeSpillStore symlink containment", () => {
  itUnlessWindows(
    "F-182 REJECTS a session dir symlinked outside the spill root (rejection itself)",
    async () => {
      // The spill root sits in the model-writable workspace: a pre-planted
      // `<sessionId>` symlink pointing outside would silently redirect
      // host-side writes through the link. Only the realpath containment
      // check sees this — the lexical path looks perfectly valid.
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-outside-"));
      try {
        await fs.mkdir(path.join(root, ".volto", "spill"), { recursive: true });
        await fs.symlink(outside, path.join(root, ".volto", "spill", "s1"), "dir");
        const store = createNodeSpillStore({ rootDir: root });
        await expect(store.write({ sessionId: "s1", toolCallId: "c1", text: "x" }))
          .rejects.toThrow(/escapes the spill root/i);
        // Supplementary: nothing landed outside — non-existence of the file,
        // not "output empty".
        await expect(fs.access(path.join(outside, "c1.txt"))).rejects.toThrow();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  itUnlessWindows(
    "F-182 replaces a symlinked spill file instead of writing through it",
    async () => {
      // A dangling symlink at the target name would make writeFile create the
      // file at its outside target; the store must never write through it.
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-spill-outside-"));
      const outsideFile = path.join(outsideDir, "c1.txt");
      try {
        const store = createNodeSpillStore({ rootDir: root });
        await fs.mkdir(path.join(root, ".volto", "spill", "s1"), { recursive: true });
        await fs.symlink(outsideFile, path.join(root, ".volto", "spill", "s1", "c1.txt"), "file");
        const r = await store.write({ sessionId: "s1", toolCallId: "c1", text: "full output" });
        expect(r.relativePath).toBe(".volto/spill/s1/c1.txt");
        // The outside target was never created; content landed as a regular file.
        await expect(fs.access(outsideFile)).rejects.toThrow();
        const onDisk = await fs.readFile(path.join(root, ".volto", "spill", "s1", "c1.txt"), "utf8");
        expect(onDisk).toBe("full output");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );
});
