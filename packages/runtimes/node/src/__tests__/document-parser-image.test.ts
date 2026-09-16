import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createNodeDocumentParser } from "../index.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("node document parser image path", () => {
  it("returns real bytes and dimensions, not just a size", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "volto-doc-"));
    const file = path.join(dir, "pixel.png");
    await fs.writeFile(file, Buffer.from(PNG_1X1, "base64"));

    const parser = await createNodeDocumentParser();
    const result = await parser.parse(file);

    expect(result.contentType).toBe("image");
    expect(result.data).toBe(PNG_1X1);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
