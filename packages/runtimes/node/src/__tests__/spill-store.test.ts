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
