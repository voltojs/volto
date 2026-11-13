import { describe, it, expect, vi } from "vitest";
import type { FileSystem, AttachmentStore } from "@voltojs/core";
import { createReadFileTool } from "../read-file.js";

const PNG = "iVBORw0KGgo=";

function fsWith(over: Partial<FileSystem>): FileSystem {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    read: reject, write: reject, stat: reject, list: reject,
    glob: reject, grep: reject, readBytes: reject,
    ...over,
  } as unknown as FileSystem;
}

const attachments = {
  put: vi.fn(async () => ({ id: "att-1", mimeType: "image/png", size: 10, width: 4, height: 4 })),
  get: vi.fn(),
  deleteBySession: vi.fn(),
} as unknown as AttachmentStore;

describe("read_file dispatch", () => {
  it("returns an image block for an image file", async () => {
    const tool = createReadFileTool(
      fsWith({ readBytes: async () => ({ data: PNG, size: 10, mimeType: "image/png", width: 4, height: 4 }) }),
      { attachments, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/a.png" });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.modelContent)).toBe(true);
    expect(result.modelContent).toContainEqual(
      expect.objectContaining({ type: "image", source: expect.objectContaining({ type: "ref", id: "att-1" }) }),
    );
  });

  it("reports an error when the model has no vision support", async () => {
    const tool = createReadFileTool(
      fsWith({ readBytes: async () => ({ data: PNG, size: 10, mimeType: "image/png" }) }),
      { attachments, visionSupported: false },
    );
    const result = await tool.handler({ path: "/tmp/a.png" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/does not support image input/i);
    // Must not point at another tool: read_document cannot help either.
    expect(result.modelContent as string).not.toMatch(/read_document/);
  });

  it("rejects an image beyond the size limit", async () => {
    const huge = "A".repeat(6 * 1024 * 1024);
    const tool = createReadFileTool(
      fsWith({ readBytes: async () => ({ data: huge, size: huge.length, mimeType: "image/png" }) }),
      { attachments, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/big.png" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/too large/i);
  });

  it("suggests downscaling when the long edge exceeds 1568px", async () => {
    const bigDims = {
      put: vi.fn(async () => ({ id: "att-big", mimeType: "image/png", size: 10, width: 2000, height: 800 })),
      get: vi.fn(),
      deleteBySession: vi.fn(),
    } as unknown as AttachmentStore;
    const tool = createReadFileTool(
      fsWith({ readBytes: async () => ({ data: PNG, size: 10, mimeType: "image/png" }) }),
      { attachments: bigDims, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/wide.png" });
    const textBlock = (result.modelContent as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    expect(textBlock?.text).toContain(
      "Image long edge is 2000px (> 1568px); consider downscaling to reduce token cost.",
    );
  });

  it("does not suggest downscaling for small images", async () => {
    // The default mock store returns 4x4 — within budget.
    const tool = createReadFileTool(
      fsWith({ readBytes: async () => ({ data: PNG, size: 10, mimeType: "image/png" }) }),
      { attachments, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/a.png" });
    const textBlock = (result.modelContent as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    expect(textBlock?.text).toBe("Image /tmp/a.png");
    expect(textBlock?.text).not.toMatch(/downscal/i);
  });

  it("returns notebook cells with their outputs", async () => {
    const nb = JSON.stringify({
      cells: [
        { cell_type: "code", source: ["print('hi')\n"], outputs: [{ output_type: "stream", text: ["hi\n"] }] },
        { cell_type: "markdown", source: ["# Title\n"] },
      ],
    });
    const tool = createReadFileTool(
      fsWith({ read: async () => ({ content: nb, totalLines: 1, truncated: false }) }),
      { attachments, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/n.ipynb" });
    const text = result.modelContent as string;
    expect(text).toContain("print('hi')");
    expect(text).toContain("hi");
    expect(text).toContain("# Title");
  });

  it("leaves the plain text path unchanged", async () => {
    // The text path also stats the file for displayMetadata; stub it so this
    // case isolates the unchanged text path rather than an unrelated failure.
    const tool = createReadFileTool(
      fsWith({
        read: async () => ({ content: "line one", totalLines: 1, truncated: false }),
        stat: async () => ({ path: "/tmp/a.ts", isDirectory: false, size: 8, mtime: 0 }),
      }),
      { attachments, visionSupported: true },
    );
    const result = await tool.handler({ path: "/tmp/a.ts" });
    expect(typeof result.modelContent).toBe("string");
    expect(result.modelContent as string).toContain("line one");
  });
});
