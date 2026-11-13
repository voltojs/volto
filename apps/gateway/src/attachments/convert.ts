/**
 * Attachment converter — turns non-image attachments into inline text
 * blocks for POST /messages (spec 2026-10-15 non-image attachments, §4.3).
 *
 * Contract:
 *   - image/* entries are the CALLER's job (server.ts splits before calling
 *     and keeps the ref-block path untouched); a stray image entry here is
 *     skipped, never duplicated into an inline block.
 *   - Text/JSON: utf-8 decode (fatal — invalid bytes degrade to an
 *     explanatory block, never mojibake) + verbatim header line + content.
 *   - PDF: parsed through the injected `parsePdf` (temp-file I/O lives
 *     inside it); missing/throwing parser degrades to an explanatory block.
 *   - One bad attachment NEVER swallows the rest: per-attachment errors
 *     converge to that attachment's explanatory block, and this function
 *     does not throw.
 *
 * Header line (verbatim, spec §4.3 rule 4):
 *   [attachment: <name|id> (<mimeType>)][, <N> pages][, truncated]
 * Error block (verbatim, spec §6):
 *   [attachment <name|id> could not be included: <reason>]
 */

import type { ContentBlock, StoredAttachment } from "@voltojs/core";

/** Result of parsing a PDF: its text plus the document's TOTAL page count. */
export interface ParsedPdf {
  text: string;
  pages: number;
}

/**
 * Parses PDF bytes. `maxPages` asks for at most the first N pages (the
 * adapter's partial selection); `pages` in the result is always the
 * document's total, which is what marks a truncation. Absent → PDF
 * attachments degrade to an explanatory block (spec §4.3).
 */
export type AttachmentParsePdf = (
  bytes: Buffer,
  opts?: { maxPages?: number },
) => Promise<ParsedPdf>;

export interface AttachmentConverterDeps {
  /** Parses .pdf bytes; absent → PDF attachments degrade to an error block. */
  parsePdf?: AttachmentParsePdf;
  /** Character cap on text payloads; over-limit truncates (default 200_000). */
  maxTextChars?: number;
  /** Page cap on PDFs; over-limit truncates (default 50). */
  maxPdfPages?: number;
}

/** StoredAttachment plus its base64 bytes — the shape store.get() returns. */
export type FoundAttachment = StoredAttachment & { data: string };

const DEFAULT_MAX_TEXT_CHARS = 200_000;
const DEFAULT_MAX_PDF_PAGES = 50;

/** Reason string for a PDF attachment when no parser was wired up. */
const PDF_PARSER_UNAVAILABLE = "PDF parser unavailable";

/** Reason string for payloads whose bytes are not valid UTF-8. */
const NOT_VALID_UTF_8 = "not valid UTF-8";

function labelOf(found: FoundAttachment): string {
  // The stored name is untrusted model-visible input; it only ever lands in
  // this header text, never in a path. Absent name → the attachment id.
  return found.name ?? found.id;
}

function headerOf(
  found: FoundAttachment,
  opts: { pages?: number; truncated?: boolean } = {},
): string {
  // All decorations ride INSIDE the bracket (spec §2 D2:
  // `[attachment: <name> (<mime>)<, N pages>]`, then `, truncated`).
  let header = `[attachment: ${labelOf(found)} (${found.mimeType})`;
  if (opts.pages !== undefined) {
    header += `, ${opts.pages} ${opts.pages === 1 ? "page" : "pages"}`;
  }
  if (opts.truncated) {
    header += ", truncated";
  }
  return `${header}]`;
}

function errorBlockOf(found: FoundAttachment, reason: string): ContentBlock {
  return { type: "text", text: `[attachment ${labelOf(found)} could not be included: ${reason}]` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function convertOne(
  found: FoundAttachment,
  deps: Required<Pick<AttachmentConverterDeps, "maxTextChars" | "maxPdfPages">> &
    Pick<AttachmentConverterDeps, "parsePdf">,
): Promise<ContentBlock> {
  if (found.mimeType === "application/pdf") {
    if (!deps.parsePdf) {
      return errorBlockOf(found, PDF_PARSER_UNAVAILABLE);
    }
    const bytes = Buffer.from(found.data, "base64");
    const { text, pages } = await deps.parsePdf(bytes, { maxPages: deps.maxPdfPages });
    const truncated = pages > deps.maxPdfPages;
    const shownPages = Math.min(pages, deps.maxPdfPages);
    const header = headerOf(found, { pages: shownPages, truncated });
    return { type: "text", text: `${header}\n${text}` };
  }

  const bytes = Buffer.from(found.data, "base64");
  let text: string;
  try {
    // Fatal decode: plain Buffer.toString would silently emit U+FFFD
    // replacement characters and feed mojibake to the model.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorBlockOf(found, NOT_VALID_UTF_8);
  }
  if (text.length > deps.maxTextChars) {
    const kept = text.slice(0, deps.maxTextChars);
    const header = headerOf(found, { truncated: true });
    return {
      type: "text",
      text: `${header}\n${kept}\n… [truncated at ${deps.maxTextChars} characters]`,
    };
  }
  return { type: "text", text: `${headerOf(found)}\n${text}` };
}

/**
 * Convert non-image attachments into inline content blocks, preserving the
 * input order. Never throws: any per-attachment failure becomes that
 * attachment's explanatory block, so one bad file cannot swallow the rest
 * of the message (spec §6).
 */
export async function convertAttachments(
  found: readonly FoundAttachment[],
  deps: AttachmentConverterDeps,
): Promise<ContentBlock[]> {
  const resolved = {
    parsePdf: deps.parsePdf,
    maxTextChars: deps.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    maxPdfPages: deps.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES,
  };
  const blocks: ContentBlock[] = [];
  for (const entry of found) {
    // Image entries belong to the caller's ref-block path; skipping here
    // keeps a mixed list safe without duplicating the image machinery.
    if (entry.mimeType.startsWith("image/")) continue;
    try {
      blocks.push(await convertOne(entry, resolved));
    } catch (err: unknown) {
      blocks.push(errorBlockOf(entry, errorMessage(err)));
    }
  }
  return blocks;
}
