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
});
