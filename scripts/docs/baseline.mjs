/**
 * Accept the current user-visible surface as documented.
 *
 * Two callers:
 * - `pnpm docs:sync`  — regenerate pages and rebaseline. Used after changing
 *   code and updating the affected pages.
 * - `pnpm docs:ack "…"` — same, plus an auditable note in `.meta/reviewed.json`
 *   saying a human/agent looked at the change and decided no page needed edits.
 *
 * Both are explicit acts: the baseline diff is what a reviewer reads.
 */

import * as path from "node:path";
import { computeSurfaces, reviewedFilePath, surfaceFilePath, writeText } from "./lib.mjs";

export function writeBaseline(surfaces) {
  const sections = {};
  for (const [name, value] of Object.entries(surfaces.sections)) {
    sections[name] = { hash: value.hash, names: value.names };
  }
  writeText(surfaceFilePath(), `${JSON.stringify({ version: 1, sections }, null, 2)}\n`);
}

export function recordReview(note) {
  const surfaces = computeSurfaces();
  writeBaseline(surfaces);
  const hash = Object.values(surfaces.sections)
    .map((section) => section.hash)
    .join(":");
  writeText(
    reviewedFilePath(),
    `${JSON.stringify(
      { surfaceHash: hash, note: note || "(no note)", at: new Date().toISOString().slice(0, 10) },
      null,
      2,
    )}\n`,
  );
  return hash;
}

export function writeBaselineFromDir() {
  writeBaseline(computeSurfaces());
}

export const paths = { surfaceFilePath, reviewedFilePath, dir: path.dirname(surfaceFilePath()) };