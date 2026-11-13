/**
 * Regenerate the reference pages that are pure projections of code + notes.
 *
 * Both locales are produced: the English page at its usual path and the Chinese
 * mirror under `zh/`. Writing is deliberately separate from checking so CI can
 * prove a generated file matches its inputs without touching the working tree.
 */

import * as path from "node:path";
import { DOCS_DIR, computeSurfaces, generatedPages, loadNotes, writeText } from "./lib.mjs";

const surfaces = computeSurfaces();
for (const locale of ["en", "zh"]) {
  for (const page of generatedPages()) {
    const notes = page.notes ? loadNotes(page.notes) : {};
    const rel = locale === "zh" ? `zh/${page.rel}` : page.rel;
    writeText(path.join(DOCS_DIR, rel), page.build(surfaces, notes, locale));
    console.log(`generated docs/user/${rel}`);
  }
}
