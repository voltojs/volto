#!/usr/bin/env node
/**
 * Stages the exported web app inside the gateway package.
 *
 * The gateway serves the chat UI from `web/` next to its compiled server
 * (`apps/gateway/dist/server.js` → `apps/gateway/web/`), so the tarball is
 * self-contained: `npm i -g @volto/gateway && volto` yields a working UI.
 * `apps/web/out` is a Next.js static export and therefore build output — it
 * never enters the repository, which is why `prepack` copies it here.
 *
 * Usage:
 *   VOLTO_WEB_EXPORT=1 pnpm --filter @volto/web build
 *   node apps/gateway/scripts/copy-web-assets.mjs
 *
 * Idempotent: the destination is replaced wholesale, so a stale file from an
 * earlier build cannot survive into the next tarball. Fails loudly (non-zero
 * exit) when the export is missing rather than shipping a gateway whose UI is
 * a 503.
 */
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const source = join(repoRoot, "apps", "web", "out");
const destination = join(packageRoot, "web");
const entryFile = join(source, "index.html");
const BUILD_HINT = "VOLTO_WEB_EXPORT=1 pnpm --filter @volto/web build";

function fail(message) {
  console.error(`[copy-web-assets] ${message}`);
  process.exit(1);
}

if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
  fail(
    `Missing web export entry: ${entryFile}\n` +
      `Run \`${BUILD_HINT}\` first (the export only exists after an explicit export build).`,
  );
}

// Remove the destination first: `cpSync` merges, and a merged copy would ship
// stale chunks from a previous export alongside the current ones.
rmSync(destination, { recursive: true, force: true });

try {
  cpSync(source, destination, { recursive: true });
} catch (error) {
  fail(`Copying ${source} → ${destination} failed: ${error instanceof Error ? error.message : error}`);
}

if (!existsSync(join(destination, "index.html"))) {
  fail(`Copy finished but ${join(destination, "index.html")} is missing.`);
}

console.log(`[copy-web-assets] Copied ${source} → ${destination}`);