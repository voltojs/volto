#!/usr/bin/env node
/**
 * Stages the exported web app inside the gateway package.
 *
 * The gateway serves the chat UI from `web/` next to its compiled server
 * (`apps/gateway/dist/server.js` → `apps/gateway/web/`), so the tarball is
 * self-contained: `npm i -g @voltojs/gateway && volto` yields a working UI.
 * `apps/web/out` is a Next.js static export and therefore build output — it
 * never enters the repository, which is why `prepack` copies it here.
 *
 * Usage:
 *   VOLTO_WEB_EXPORT=1 pnpm --filter @voltojs/web build
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { isShippedAsset } from "./shipped-asset.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const source = join(repoRoot, "apps", "web", "out");
const destination = join(packageRoot, "web");
const entryFile = join(source, "index.html");
const BUILD_HINT = "VOLTO_WEB_EXPORT=1 pnpm --filter @voltojs/web build";

function fail(message) {
  console.error(`[copy-web-assets] ${message}`);
  process.exit(1);
}

function main() {
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
}

// Importing this module must not run the copy.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
