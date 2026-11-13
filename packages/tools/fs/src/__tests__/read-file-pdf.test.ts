import { describe, it, expect, vi } from "vitest";
import type { FileSystem } from "@voltojs/core";
import { createReadFileTool } from "../read-file.js";
import type { PdfLikeParser } from "../read-file.js";

function fsWith(over: Partial<FileSystem>): FileSystem {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    read: reject, write: reject, stat: reject, list: reject,
    glob: reject, grep: reject, readBytes: reject,
    ...over,
  } as unknown as FileSystem;
}

describe("read_file PDF dispatch", () => {
  it("parses a .pdf through the document parser instead of the utf-8 text path", async () => {
    const parse = vi.fn(async () => ({
      contentType: "text" as const,
      text: "-- page 1 of 2 --\nPDF_BODY_MARKER",
      mimeType: "application/pdf",
    }));
    const parser: PdfLikeParser = { parse };
    // read() is the raw text path — reading a PDF through it produces
    // mojibake. It must never be reached for .pdf.
    const tool = createReadFileTool(
      fsWith({ stat: async () => ({ mtime: 1, size: 10, path: "/doc/report.pdf", isDirectory: false }), read: vi.fn() as never }),
      { documentParser: parser },
    );
    const result = await tool.handler({ path: "/doc/report.pdf" });
    expect(result.isError).toBeFalsy();
    expect(parse).toHaveBeenCalledWith("/doc/report.pdf", undefined);
    expect(result.modelContent as string).toContain("PDF_BODY_MARKER");
    expect(result.modelContent as string).not.toContain("�"); // no utf-8 garbage
  });

  it("forwards a page selection to the parser", async () => {
    const parse = vi.fn(async () => ({
      contentType: "text" as const,
      text: "ONLY_PAGE",
      mimeType: "application/pdf",
    }));
    const parser: PdfLikeParser = { parse };
    const tool = createReadFileTool(
      fsWith({ stat: async () => ({ mtime: 1, size: 10, path: "/doc/report.pdf", isDirectory: false }) }),
      { documentParser: parser },
    );
    const result = await tool.handler({ path: "/doc/report.pdf", pages: "2-3" });
    expect(result.isError).toBeFalsy();
    expect(parse).toHaveBeenCalledWith("/doc/report.pdf", { pages: [2, 3] });
    expect(result.modelContent as string).toContain("ONLY_PAGE");
    expect(result.displayMetadata?.selectedPages).toEqual([2, 3]);
  });

  it("refuses a .pdf when no parser is wired instead of returning mojibake", async () => {
    const read = vi.fn();
    const tool = createReadFileTool(
      fsWith({ read: read as never, stat: async () => ({ mtime: 1, size: 10, path: "/doc/report.pdf", isDirectory: false }) }),
      {},
    );
    const result = await tool.handler({ path: "/doc/report.pdf" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/read_document|no document parser/i);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a malformed page spec without calling the parser", async () => {
    const parse = vi.fn();
    const parser: PdfLikeParser = { parse: parse as never };
    const tool = createReadFileTool(
      fsWith({ stat: async () => ({ mtime: 1, size: 10, path: "/doc/report.pdf", isDirectory: false }) }),
      { documentParser: parser },
    );
    const result = await tool.handler({ path: "/doc/report.pdf", pages: "x" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/pages/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("resolves the parser path through the fs port when available (workspace-relative → absolute)", async () => {
    // The default document parser opens files with raw fs: it needs an
    // absolute host path, while the model speaks workspace-relative.
    // FileStat.path is root-relative and useless here — the port's
    // resolvePath() is the sanctioned escape hatch.
    const parse = vi.fn(async () => ({
      contentType: "text" as const,
      text: "RESOLVED_BODY",
      mimeType: "application/pdf",
    }));
    const parser: PdfLikeParser = { parse };
    const tool = createReadFileTool(
      fsWith({
        stat: async () => ({ mtime: 1, size: 10, path: "report.pdf", isDirectory: false }),
        resolvePath: async () => "/abs/workspace/report.pdf",
      }),
      { documentParser: parser },
    );
    const result = await tool.handler({ path: "report.pdf" });
    expect(result.isError).toBeFalsy();
    expect(parse).toHaveBeenCalledWith("/abs/workspace/report.pdf", undefined);
    expect(result.modelContent as string).toContain("RESOLVED_BODY");
  });

  it("enforces the workspace boundary via the fs port before the parser runs", async () => {
    const parse = vi.fn();
    const parser: PdfLikeParser = { parse: parse as never };
    const tool = createReadFileTool(
      fsWith({
        stat: vi.fn(async () => {
          throw new Error("path escapes the workspace root");
        }) as never,
      }),
      { documentParser: parser },
    );
    const result = await tool.handler({ path: "/etc/passwd.pdf" });
    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toMatch(/escapes the workspace/);
    expect(parse).not.toHaveBeenCalled();
  });
});
