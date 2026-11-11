/**
 * `pnpm docs:sync` — regenerate the reference pages and accept the current
 * surface as documented. Run this after changing code and updating the pages
 * it touched; run `docs:ack` instead when the change provably needs no page.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBaselineFromDir } from "./baseline.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(here, "gen.mjs")], { stdio: "inherit" });
writeBaselineFromDir();
console.log("baseline updated: docs/user/.meta/surface.json");