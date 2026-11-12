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
 *
 * Not everything an export writes is for the browser. Next also emits the RSC
 * payload documents (`__next._full.txt`, `__next._tree.txt`, `index.txt`,
 * `_not-found/**`): router internals fetched by its own client, carrying the
 * same content as the HTML the shell already serves. Shipped, they would be
 * static files the gateway answers 200 with as `text/plain` like any other
 * asset, which is more public surface than the UI needs. `isShippedAsset`
 * names what to drop, and `static/serve.ts` refuses the same paths even when a
 * `web/` directory was produced another way.
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

// Run from a packed tarball, `repoRoot` points at wherever the package happens to
// be installed, so the export path below would name a nonsense location. Say what
// actually went wrong instead of blaming a missing build.
if (!existsSync(join(repoRoot, "apps", "web"))) {
  fail(
    `No apps/web next to ${repoRoot}: this script only works inside the volto monorepo ` +
      "(a published tarball already contains web/ — do not copy into it).",
  );
}

if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
  fail(
    `Missing web export entry: ${entryFile}\n` +
      `Run \`${BUILD_HINT}\` first (the export only exists after an explicit export build).`,
  );
}

/** Top-level export directory Next uses for its own not-found route. */
const NOT_FOUND_PREFIX = "_not-found/";

/**
 * Whether a web-root-relative path (`/`-separated, as `cpSync` filter
 * receives it) belongs in the staged site.
 *
 * Dropped: any `.txt` document at the web root (Next's RSC payloads) and
 * everything under `_not-found/` (the same payloads plus a duplicate
 * `index.html` the single-page shell never links to). `404.html` is kept: a
 * static host in front of the gateway uses it.
 *
 * @param {string} relPath path relative to the export root
 * @returns {boolean} true when the path ships and is served
 */
export function isShippedAsset(relPath) {
  const rel = relPath.replace(/^\/+/, "");
  // The directory entry itself (`cpSync` visits it before its children).
  if (rel === NOT_FOUND_PREFIX.slice(0, -1) || rel.startsWith(NOT_FOUND_PREFIX)) return false;
  return !(rel.endsWith(".txt") && !rel.includes("/"));
}

// Remove the destination first: `cpSync` merges, and a merged copy would ship
// stale chunks from a previous export alongside the current ones.
rmSync(destination, { recursive: true, force: true });

try {
  cpSync(source, destination, {
    recursive: true,
    // `src` is the absolute path `cpSync` was handed, `dest` the one it would write.
    filter: (src) => isShippedAsset(src.slice(source.length)),
  });
} catch (error) {
  fail(`Copying ${source} → ${destination} failed: ${error instanceof Error ? error.message : error}`);
}

if (!existsSync(join(destination, "index.html"))) {
  fail(`Copy finished but ${join(destination, "index.html")} is missing.`);
}

console.log(`[copy-web-assets] Copied ${source} → ${destination}`);