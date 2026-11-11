/**
 * Regenerate the reference pages that are pure projections of code + notes.
 *
 * Writing is deliberately separate from checking so CI can prove a generated
 * file matches its inputs without touching the working tree.
 */

import * as path from "node:path";
import { DOCS_DIR, computeSurfaces, generatedPages, loadNotes, writeText } from "./lib.mjs";

const surfaces = computeSurfaces();
for (const page of generatedPages()) {
  const notes = page.notes ? loadNotes(page.notes) : {};
  writeText(path.join(DOCS_DIR, page.rel), page.build(surfaces, notes));
  console.log(`generated docs/user/${page.rel}`);
}