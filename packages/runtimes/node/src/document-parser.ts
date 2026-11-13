/**
 * Node.js document parser adapter — implements DocumentParserAdapter.
 *
 * Dispatches to format-specific libraries based on MIME type / file extension.
 * Each library is an optional peerDependency — install only what you need:
 *   pnpm add pdf-parse mammoth xlsx
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  DocumentParserAdapter,
  DocumentParseOptions,
  DocumentParseResult,
} from "@voltojs/tools-document";
import { readImageDimensions } from "./image-dimensions.js";

export interface NodeDocumentParserOptions {
  /** Maximum text length to return before truncation (default: 500000) */
  maxTextLength?: number;
}

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);

async function parsePdf(
  filePath: string,
  maxTextLength: number,
  pages?: number[],
): Promise<DocumentParseResult> {
  let PDFParse: typeof import("pdf-parse").PDFParse;
  try {
    ({ PDFParse } = await import("pdf-parse"));
  } catch {
    throw new Error("pdf-parse is required for PDF files. Install with: pnpm add pdf-parse");
  }

  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  // `partial` (pdf-parse ≥2.x ParseParameters) parses ONLY the listed pages,
  // preserving their order — the documented page-selection mechanism.
  const textResult = await parser.getText(pages !== undefined ? { partial: pages } : undefined);
  await parser.destroy();
  let text = textResult.text ?? "";
  if (text.length > maxTextLength) {
    text = text.slice(0, maxTextLength) + "\n... [truncated]";
  }
  return {
    contentType: "text",
    text,
    mimeType: "application/pdf",
    metadata: { pages: textResult.total, ...(pages !== undefined ? { selectedPages: pages } : {}) },
  };
}

async function parseDocx(filePath: string, maxTextLength: number): Promise<DocumentParseResult> {
  let mammoth: typeof import("mammoth");
  try {
    mammoth = await import("mammoth");
  } catch {
    throw new Error("mammoth is required for DOCX files. Install with: pnpm add mammoth");
  }

  const buffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  let text = result.value ?? "";
  if (text.length > maxTextLength) {
    text = text.slice(0, maxTextLength) + "\n... [truncated]";
  }
  return {
    contentType: "text",
    text,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    metadata: {},
  };
}

async function parseXlsx(filePath: string, maxTextLength: number): Promise<DocumentParseResult> {
  let XLSX: typeof import("xlsx");
  try {
    XLSX = await import("xlsx");
  } catch {
    throw new Error("xlsx is required for XLSX files. Install with: pnpm add xlsx");
  }

  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheets: string[] = [];
  let allText = "";

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    sheets.push(name);
    allText += `\n--- Sheet: ${name} ---\n${csv}`;
  }

  let text = allText.trim();
  if (text.length > maxTextLength) {
    text = text.slice(0, maxTextLength) + "\n... [truncated]";
  }
  return {
    contentType: "text",
    text,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    metadata: { sheets },
  };
}

export async function createNodeDocumentParser(
  opts?: NodeDocumentParserOptions,
): Promise<DocumentParserAdapter> {
  const maxTextLength = opts?.maxTextLength ?? 500_000;

  return {
    async parse(filePath: string, opts?: DocumentParseOptions): Promise<DocumentParseResult> {
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_MAP[ext];

      // PDF (only paginated format — other formats ignore opts.pages)
      if (ext === ".pdf") {
        return parsePdf(filePath, maxTextLength, opts?.pages);
      }

      // DOCX
      if (ext === ".docx") {
        return parseDocx(filePath, maxTextLength);
      }

      // XLSX / XLS
      if (ext === ".xlsx" || ext === ".xls") {
        return parseXlsx(filePath, maxTextLength);
      }

      // Plain text / markdown / csv
      if (TEXT_EXTENSIONS.has(ext) || (mime?.startsWith("text/"))) {
        const content = await fs.readFile(filePath, "utf-8");
        let text = content;
        if (text.length > maxTextLength) {
          text = text.slice(0, maxTextLength) + "\n... [truncated]";
        }
        return {
          contentType: "text",
          text,
          mimeType: mime ?? "text/plain",
          metadata: {},
        };
      }

      // Image files
      if (IMAGE_EXTENSIONS.has(ext)) {
        const bytes = await fs.readFile(filePath);
        const dims = readImageDimensions(bytes);
        return {
          contentType: "image",
          mimeType: mime ?? `image/${ext.slice(1)}`,
          data: bytes.toString("base64"),
          ...(dims ?? {}),
          metadata: { size: bytes.byteLength },
        };
      }

      // Unknown format — try to read as text
      const content = await fs.readFile(filePath, "utf-8");
      let text = content;
      if (text.length > maxTextLength) {
        text = text.slice(0, maxTextLength) + "\n... [truncated]";
      }
      return {
        contentType: "text",
        text,
        mimeType: "application/octet-stream",
        metadata: {},
      };
    },
  };
}
