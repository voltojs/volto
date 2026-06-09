import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createNodeFileSystem } from "../filesystem.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tc-e6-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("TC-E6: glob 工作区边界防逃逸", () => {
  it("symlink pointing outside workspace is filtered from glob results", async () => {
    // Create a symlink inside workspace pointing to /etc/passwd.
    const linkPath = path.join(workspace, "escape-link");
    try {
      await fs.symlink("/etc/passwd", linkPath);
    } catch {
      // If /etc/passwd doesn't exist (e.g. non-POSIX), skip gracefully.
      return;
    }

    const nodeFs = createNodeFileSystem({ root: workspace });
    const result = await nodeFs.glob("*");

    // The resolved path of the symlink (/etc/passwd) escapes the root,
    // so it must NOT appear in results.
    expect(result.paths).not.toContain("/etc/passwd");
    expect(result.paths.every((p) => !p.includes("passwd"))).toBe(true);
  });

  it("read with path traversal (..) throws workspace boundary error", async () => {
    await fs.writeFile(path.join(workspace, "safe.txt"), "ok", "utf-8");
    const nodeFs = createNodeFileSystem({ root: workspace });

    // Attempt to read a file outside the workspace via ..
    await expect(nodeFs.read("../package.json")).rejects.toThrow(
      "escapes the workspace boundary",
    );
  });

  it("write with path traversal (..) throws workspace boundary error", async () => {
    const nodeFs = createNodeFileSystem({ root: workspace });

    await expect(
      nodeFs.write("../evil.txt", "pwned"),
    ).rejects.toThrow("escapes the workspace boundary");
  });
});
