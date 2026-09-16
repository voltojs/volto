import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createNodeFileSystem, createSandboxedFileSystem } from "../index.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("FileSystem.readBytes", () => {
  it("returns base64 bytes with image dimensions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-fs-"));
    const file = path.join(dir, "pixel.png");
    await fs.writeFile(file, Buffer.from(PNG_1X1, "base64"));

    const result = await createNodeFileSystem({ root: dir }).readBytes(file);
    expect(result.data).toBe(PNG_1X1);
    expect(result.mimeType).toBe("image/png");
    expect(result).toMatchObject({ width: 1, height: 1 });

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses to read outside the workspace, exactly like read()", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "volto-ws-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "volto-out-"));
    const secret = path.join(outside, "secret.png");
    await fs.writeFile(secret, Buffer.from(PNG_1X1, "base64"));

    const sandboxed = createSandboxedFileSystem(
      createNodeFileSystem({ root: workspace }),
      {
        mode: "workspace-write",
        writableRoots: [workspace],
      },
      { root: workspace },
    );

    // The denial itself is the assertion — an empty result would also be
    // produced by a store that simply failed to run.
    await expect(sandboxed.readBytes(secret)).rejects.toThrow(/outside|denied|not permitted/i);

    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });
});
