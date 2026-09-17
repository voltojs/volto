import { describe, it, expect, vi } from "vitest";
import type { AttachmentStore } from "@volto/core";
import { createReadDocumentTool } from "../read-document.js";
import type { DocumentParserAdapter } from "../document-parser.js";

const PNG = "iVBORw0KGgo=";
const attachments = {
  put: vi.fn(async () => ({ id: "att-7", mimeType: "image/png", size: 10, width: 2, height: 2 })),
  get: vi.fn(),
  deleteBySession: vi.fn(),
} as unknown as AttachmentStore;

describe("read_document image path", () => {
  it("returns an image block rather than a description", async () => {
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "image", mimeType: "image/png", data: PNG, width: 2, height: 2 }),
    };
    const tool = createReadDocumentTool(parser, { attachments, visionSupported: true });
    const result = await tool.handler({ path: "/tmp/scan.png" });
    expect(result.modelContent).toContainEqual(
      expect.objectContaining({ type: "image", source: expect.objectContaining({ id: "att-7" }) }),
    );
  });

  it("keeps the text path unchanged", async () => {
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "text", mimeType: "application/pdf", text: "page one" }),
    };
    const tool = createReadDocumentTool(parser, { attachments, visionSupported: true });
    const result = await tool.handler({ path: "/tmp/a.pdf" });
    expect(typeof result.modelContent).toBe("string");
    expect(result.modelContent as string).toContain("page one");
  });

  it("errors on an image when the model has no vision support", async () => {
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "image", mimeType: "image/png", data: PNG }),
    };
    const tool = createReadDocumentTool(parser, { attachments, visionSupported: false });
    const result = await tool.handler({ path: "/tmp/scan.png" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/does not support image input/i);
  });

  it("rejects an image beyond the 5 MB base64 cap", async () => {
    const huge = "A".repeat(6 * 1024 * 1024);
    const put = vi.fn();
    const store = { put, get: vi.fn(), deleteBySession: vi.fn() } as unknown as AttachmentStore;
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "image", mimeType: "image/png", data: huge }),
    };
    const tool = createReadDocumentTool(parser, { attachments: store, visionSupported: true });
    const result = await tool.handler({ path: "/tmp/big.png" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/too large/i);
    // Must never reach the store once the cap is exceeded.
    expect(put).not.toHaveBeenCalled();
  });

  it("suggests downscaling when the long edge exceeds 1568px", async () => {
    const store = {
      put: vi.fn(async () => ({ id: "att-big", mimeType: "image/png", size: 10, width: 2000, height: 800 })),
      get: vi.fn(),
      deleteBySession: vi.fn(),
    } as unknown as AttachmentStore;
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "image", mimeType: "image/png", data: PNG }),
    };
    const tool = createReadDocumentTool(parser, { attachments: store, visionSupported: true });
    const result = await tool.handler({ path: "/tmp/wide.png" });
    const textBlock = (result.modelContent as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    expect(textBlock?.text).toContain(
      "Image long edge is 2000px (> 1568px); consider downscaling to reduce token cost.",
    );
  });

  it("does not suggest downscaling when dimensions are small", async () => {
    const parser: DocumentParserAdapter = {
      parse: async () => ({ contentType: "image", mimeType: "image/png", data: PNG, width: 2, height: 2 }),
    };
    const tool = createReadDocumentTool(parser, { attachments, visionSupported: true });
    const result = await tool.handler({ path: "/tmp/scan.png" });
    const textBlock = (result.modelContent as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    expect(textBlock?.text).toBe("Image /tmp/scan.png");
    expect(textBlock?.text).not.toMatch(/downscal/i);
  });
});
