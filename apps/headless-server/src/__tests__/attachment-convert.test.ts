/**
 * Attachment converter unit tests (spec 2026-10-15 §4.3 / §6).
 *
 * Verbatim formats under test:
 *   header line  [attachment: <name|id> (<mimeType>)][, <N> pages][, truncated]
 *   error block  [attachment <name|id> could not be included: <reason>]
 *
 * The PDF SUCCESS path runs the REAL parser (createNodeDocumentParser over
 * pdf-parse) against a minimal valid PDF — only failure paths inject a
 * throwing parsePdf, per the plan's fixture policy.
 */

import { describe, it, expect } from "vitest";
import type { ContentBlock, StoredAttachment } from "@volto/core";
import { convertAttachments } from "../attachments/convert.js";
import { createAttachmentParsePdf } from "../wiring.js";

/**
 * Minimal but strictly valid PDF 1.4 builder, copied byte-for-byte from
 * packages/sdk/src/__tests__/pdf-read-e2e.test.ts, where these exact bytes
 * are parsed by the REAL pdf-parse (pdf.js is strict about the xref table;
 * hand-edited fixtures without real offsets fail to load). The builder
 * emits ASCII only, so string length equals byte length.
 */
function buildPdf(pageTexts: string[]): string {
  const enc = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const n = pageTexts.length;
  const fontObjNum = 3 + 2 * n;
  const objects = new Map<number, string>();
  const kids = pageTexts.map((_, i) => `${3 + 2 * i} 0 R`).join(" ");
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pageTexts.forEach((text, i) => {
    const pageNum = 3 + 2 * i;
    const contentNum = pageNum + 1;
    objects.set(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    const stream = `BT /F1 24 Tf 72 720 Td (${enc(text)}) Tj ET`;
    objects.set(contentNum, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontObjNum, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let i = 1; i <= fontObjNum; i++) {
    offsets.set(i, out.length);
    out += `${i} 0 obj\n${objects.get(i)!}\nendobj\n`;
  }
  const xrefStart = out.length;
  const size = fontObjNum + 1;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontObjNum; i++) {
    out += `${String(offsets.get(i)).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return out;
}

const PDF_3_PAGES = Buffer.from(
  buildPdf(["PAGE_ONE_ALPHA_MARKER", "PAGE_TWO_BRAVO_MARKER", "PAGE_THREE_CHARLIE_MARKER"]),
  "ascii",
);
const PDF_1_PAGE = Buffer.from(buildPdf(["ONLY_PAGE_MARKER"]), "ascii");

/** StoredAttachment + bytes, the shape store.get() hands the converter. */
function attachment(
  id: string,
  mimeType: string,
  data: Buffer,
  name?: string,
): StoredAttachment & { data: string } {
  return {
    id,
    mimeType,
    size: data.byteLength,
    ...(name === undefined ? {} : { name }),
    data: data.toString("base64"),
  };
}

function textOf(block: ContentBlock | undefined): string {
  if (!block || block.type !== "text") {
    throw new Error(`expected a text block, got ${JSON.stringify(block)}`);
  }
  return block.text;
}

describe("convertAttachments", () => {
  it("F-173 inlines a text attachment with the verbatim header line", async () => {
    const blocks = await convertAttachments(
      [attachment("a1", "text/plain", Buffer.from("remember the milk\n", "utf8"), "notes.txt")],
      {},
    );
    expect(blocks).toEqual([
      { type: "text", text: "[attachment: notes.txt (text/plain)]\nremember the milk\n" },
    ]);
  });

  it("F-173 parses a real PDF into a text block with the page count", async () => {
    const parsePdf = await createAttachmentParsePdf();
    expect(parsePdf).toBeDefined();

    const blocks = await convertAttachments(
      [attachment("p1", "application/pdf", PDF_3_PAGES, "report.pdf")],
      { parsePdf },
    );

    expect(blocks).toHaveLength(1);
    const text = textOf(blocks[0]);
    expect(text.startsWith("[attachment: report.pdf (application/pdf), 3 pages]\n")).toBe(true);
    // The real parser actually extracted the page content.
    expect(text).toContain("PAGE_ONE_ALPHA_MARKER");
    expect(text).toContain("PAGE_THREE_CHARLIE_MARKER");
  });

  it("F-173 falls back to the attachment id when no name was stored", async () => {
    const blocks = await convertAttachments(
      [attachment("a1", "text/markdown", Buffer.from("# hi\n", "utf8"))],
      {},
    );
    expect(blocks).toEqual([{ type: "text", text: "[attachment: a1 (text/markdown)]\n# hi\n" }]);
  });

  it("F-173 keeps the caller's order and leaves image entries to the caller", async () => {
    const parsePdf = await createAttachmentParsePdf();
    expect(parsePdf).toBeDefined();

    const blocks = await convertAttachments(
      [
        attachment("t1", "text/plain", Buffer.from("first\n", "utf8"), "first.txt"),
        attachment("i1", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        attachment("p1", "application/pdf", PDF_1_PAGE, "solo.pdf"),
      ],
      { parsePdf },
    );

    // Text + PDF only, in input order — the image entry produces no block.
    expect(blocks).toHaveLength(2);
    expect(textOf(blocks[0])).toBe("[attachment: first.txt (text/plain)]\nfirst\n");
    expect(textOf(blocks[1]).startsWith("[attachment: solo.pdf (application/pdf), 1 page]\n")).toBe(
      true,
    );
  });

  it("F-175 an invalid-UTF-8 payload degrades to an explanatory block, never mojibake", async () => {
    // Bytes that are NOT valid UTF-8 (0xff 0xfe is a UTF-16 BOM, illegal in
    // UTF-8) — a plain toString would silently emit replacement characters.
    const blocks = await convertAttachments(
      [attachment("a1", "text/plain", Buffer.from([0xff, 0xfe, 0x00, 0x61]))],
      {},
    );
    expect(blocks).toEqual([
      { type: "text", text: "[attachment a1 could not be included: not valid UTF-8]" },
    ]);
  });

  it("F-175 a missing or throwing pdf parser degrades to an explanatory block", async () => {
    const pdf = attachment("p1", "application/pdf", PDF_1_PAGE, "doc.pdf");

    const missing = await convertAttachments([pdf], {});
    expect(missing).toEqual([
      { type: "text", text: "[attachment doc.pdf could not be included: PDF parser unavailable]" },
    ]);

    const throwing = await convertAttachments([pdf], {
      parsePdf: async () => {
        throw new Error("pdf-parse is required for PDF files");
      },
    });
    expect(throwing).toEqual([
      {
        type: "text",
        text: "[attachment doc.pdf could not be included: pdf-parse is required for PDF files]",
      },
    ]);
  });

  it("F-175 over-limit text truncates and marks `truncated` in the header", async () => {
    const blocks = await convertAttachments(
      [attachment("a1", "text/plain", Buffer.from("x".repeat(150), "utf8"), "long.txt")],
      { maxTextChars: 100 },
    );
    const text = textOf(blocks[0]);
    expect(text.startsWith("[attachment: long.txt (text/plain), truncated]\n")).toBe(true);
    expect(text.endsWith("… [truncated at 100 characters]")).toBe(true);
    const body = text.slice(
      text.indexOf("\n") + 1,
      text.length - "… [truncated at 100 characters]".length,
    );
    expect(body).toBe(`${"x".repeat(100)}\n`);
  });

  it("F-175 over-limit PDF pages truncate and mark `truncated`", async () => {
    const parsePdf = await createAttachmentParsePdf();
    expect(parsePdf).toBeDefined();

    const blocks = await convertAttachments(
      [attachment("p1", "application/pdf", PDF_3_PAGES, "report.pdf")],
      { parsePdf, maxPdfPages: 1 },
    );

    const text = textOf(blocks[0]);
    expect(
      text.startsWith("[attachment: report.pdf (application/pdf), 1 page, truncated]\n"),
    ).toBe(true);
    // Honest truncation: only the first page's text reached the block.
    expect(text).toContain("PAGE_ONE_ALPHA_MARKER");
    expect(text).not.toContain("PAGE_TWO_BRAVO_MARKER");
  });

  it("F-175 one bad attachment never swallows a good one in the same message", async () => {
    const parsePdf = await createAttachmentParsePdf();
    expect(parsePdf).toBeDefined();

    const blocks = await convertAttachments(
      [
        // Real parser, garbage bytes: the PDF path fails for real (temp file
        // written, pdf-parse rejects), not via an injected throw.
        attachment("bad", "application/pdf", Buffer.from("not a pdf at all", "utf8"), "broken.pdf"),
        attachment("ok", "text/plain", Buffer.from("still here\n", "utf8"), "good.txt"),
      ],
      { parsePdf },
    );

    expect(blocks).toHaveLength(2);
    const badText = textOf(blocks[0]);
    expect(badText.startsWith("[attachment broken.pdf could not be included: ")).toBe(true);
    expect(badText.endsWith("]")).toBe(true);
    expect(textOf(blocks[1])).toBe("[attachment: good.txt (text/plain)]\nstill here\n");
  });
});
