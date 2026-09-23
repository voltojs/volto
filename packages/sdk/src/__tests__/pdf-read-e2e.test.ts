/**
 * End-to-end for PDF reads through createAgent (the roadmap's "PDF 三缺"
 * acceptance): read_file dispatches `.pdf` to the default-on document
 * parser instead of the utf-8 text path, honors `pages`, and read_document
 * pages through to pdf-parse's `partial` selection — all against a REAL
 * multi-page PDF parsed by the REAL pdf-parse, not a mock adapter.
 *
 * Temp workspace — never writes to ~/.volto.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent } from "../create-agent.js";
import { createMockModelPort, toolCallScript, textScript } from "@volto/core";
import type { ModelPort, ModelRequest } from "@volto/core";
import { createNodeFileSystem } from "@volto/runtime-node";

const PAGE_TEXTS = [
  "PAGE_ONE_ALPHA_MARKER",
  "PAGE_TWO_BRAVO_MARKER",
  "PAGE_THREE_CHARLIE_MARKER",
];

/**
 * Minimal but strictly valid 1.4 PDF: catalog → pages tree → one page +
 * one content stream per page + a shared Helvetica font, xref offsets
 * computed byte-exactly (the builder emits ASCII only, so string length
 * equals byte length). pdf.js is strict about the xref table; hand-edited
 * fixtures without real offsets fail to load.
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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    await cleanup().catch(() => {});
  }
});

async function makeWorkspace(): Promise<{
  root: string;
  fs: ReturnType<typeof createNodeFileSystem>;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "volto-pdf-e2e-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "ws");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "FIXTURE.pdf"), buildPdf(PAGE_TEXTS), "ascii");
  return { root, fs: createNodeFileSystem({ root }) };
}

function capturingPort(
  script: Parameters<typeof createMockModelPort>[0],
  requests: ModelRequest[],
): ModelPort {
  const inner = createMockModelPort(script);
  return {
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* inner.stream(req);
    },
  };
}

/** The tool_result text the model saw on the wrap-up call. */
function toolResultJson(requests: ModelRequest[]): string {
  expect(requests.length).toBeGreaterThanOrEqual(2);
  return JSON.stringify(requests.at(-1)!.messages);
}

describe("PDF reads end to end", () => {
  it("read_file parses a .pdf through the parser — extracted text in, no pdf binary soup out", async () => {
    const { fs } = await makeWorkspace();
    const seen: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript("call-1", "read_file", JSON.stringify({ path: "FIXTURE.pdf" })),
        textScript("read it"),
      ],
      seen,
    );

    const agent = createAgent({ modelPort, fs });
    const state = await agent.run("read the pdf");
    expect(state.status).toBe("done");

    const json = toolResultJson(seen);
    for (const marker of PAGE_TEXTS) expect(json).toContain(marker);
    // The utf-8 fallback would carry the raw file structure through:
    // this must be parsed text, never the pdf object soup.
    expect(json).not.toContain("endobj");
    expect(json).not.toContain("/Type /Catalog");
    expect(json).not.toContain("%PDF");
  });

  it("read_file honors pages: only the selected page's text reaches the model", async () => {
    const { fs } = await makeWorkspace();
    const seen: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript("call-1", "read_file", JSON.stringify({ path: "FIXTURE.pdf", pages: "2" })),
        textScript("page two"),
      ],
      seen,
    );

    const agent = createAgent({ modelPort, fs });
    const state = await agent.run("read page 2");
    expect(state.status).toBe("done");

    const json = toolResultJson(seen);
    expect(json).toContain("PAGE_TWO_BRAVO_MARKER");
    // Sharp discriminator: the utf-8 fallback contains every ASCII string
    // literal in the file — only real page selection drops pages 1 and 3.
    expect(json).not.toContain("PAGE_ONE_ALPHA_MARKER");
    expect(json).not.toContain("PAGE_THREE_CHARLIE_MARKER");
  });

  it("read_document honors pages too", async () => {
    const { fs } = await makeWorkspace();
    const seen: ModelRequest[] = [];
    const modelPort = capturingPort(
      [
        toolCallScript("call-1", "read_document", JSON.stringify({ path: "FIXTURE.pdf", pages: "3" })),
        textScript("page three"),
      ],
      seen,
    );

    const agent = createAgent({ modelPort, fs });
    const state = await agent.run("read page 3 with read_document");
    expect(state.status).toBe("done");

    const json = toolResultJson(seen);
    expect(json).toContain("PAGE_THREE_CHARLIE_MARKER");
    expect(json).not.toContain("PAGE_ONE_ALPHA_MARKER");
    expect(json).not.toContain("PAGE_TWO_BRAVO_MARKER");
  });
});
