/**
 * `pnpm docs:ack "reason"` — record that the current surface change was
 * reviewed and needs no page edits.
 *
 * The note lands in `.meta/reviewed.json`, so the decision shows up in the
 * diff instead of being invisible. That file is the audit trail; the baseline
 * is what makes the next `docs:check` pass.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { recordReview } from "./baseline.mjs";

const note = process.argv.slice(2).join(" ").trim();
if (!note) {
  console.error('docs:ack 需要一个理由，例如：pnpm docs:ack "新增工具仅内部使用，未暴露给用户"');
  process.exit(1);
}
// Regenerate first: an acknowledged surface change may still belong in a
// generated page (a new tool, a new route), and ack must never leave the
// reference pages stale.
const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(here, "gen.mjs")], { stdio: "inherit" });
const hash = recordReview(note);
console.log(`已记录：${note}`);
console.log(`surface hash: ${hash.slice(0, 16)}…（docs/user/.meta/reviewed.json）`);