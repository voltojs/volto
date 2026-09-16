import { describe, it, expect } from "vitest";
import { createReadDocumentTool, DOCUMENT_TOOL_NAMES } from "../index.js";
import type { DocumentParserAdapter } from "../index.js";

function createMockParser(
  textResult?: string,
  mimeType = "application/pdf",
): DocumentParserAdapter {
  return {
    async parse(_filePath: string) {
      if (textResult !== undefined) {
        return {
          contentType: "text",
          text: textResult,
          mimeType,
          metadata: { pages: 5 },
        };
      }
      // Default: image result
      return {
        contentType: "image",
        mimeType: "image/png",
        metadata: { width: 800, height: 600 },
      };
    },
  };
}

function createFailingParser(errorMsg: string): DocumentParserAdapter {
  return {
    async parse() {
      throw new Error(errorMsg);
    },
  };
}

describe("createReadDocumentTool", () => {
  it("has correct tool definition", () => {
    const tool = createReadDocumentTool(createMockParser("content"));
    expect(tool.definition.name).toBe("read_document");
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.requires).toContain("document:parse");
  });

  it("parses text document and returns structured result", async () => {
    const tool = createReadDocumentTool(createMockParser("Hello from PDF"));
    const result = await tool.handler({ path: "/doc.pdf" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("Hello from PDF");
    expect(result.modelContent).toContain("application/pdf");
    expect(result.displayMetadata?.contentType).toBe("text");
    expect(result.displayMetadata?.textLength).toBe(14);
  });

  it("rejects an image when no attachment store is configured", async () => {
    const tool = createReadDocumentTool(createMockParser()); // no text → image
    const result = await tool.handler({ path: "/photo.png" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/no attachment store/i);
  });

  it("returns isError for parser failure", async () => {
    const tool = createReadDocumentTool(createFailingParser("file not found"));
    const result = await tool.handler({ path: "/missing.pdf" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("file not found");
  });

  it("truncates large text documents", async () => {
    const bigText = "x".repeat(200_000);
    const tool = createReadDocumentTool(createMockParser(bigText));
    const result = await tool.handler({ path: "/big.pdf" });
    expect(result.displayMetadata?.truncated).toBe(true);
    expect(result.modelContent).toContain("[truncated]");
  });

  it("returns metadata from parser", async () => {
    const tool = createReadDocumentTool(createMockParser("content"));
    const result = await tool.handler({ path: "/doc.pdf" });
    expect(result.displayMetadata?.pages).toBe(5);
  });
});

describe("DOCUMENT_TOOL_NAMES", () => {
  it("includes read_document", () => {
    expect(DOCUMENT_TOOL_NAMES.has("read_document")).toBe(true);
    expect(DOCUMENT_TOOL_NAMES.size).toBe(1);
  });
});
