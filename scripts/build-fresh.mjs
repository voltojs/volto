#!/usr/bin/env node
/**
 * The release gate's build: rebuild everything from source, for real.
 *
 * `pnpm turbo run build` is the developer loop -- fast because it caches, and
 * caching is exactly what a release must not depend on:
 *
 * - A cache HIT replays logs and restores nothing, so a `dist/` that was
 *   deleted on its own (a freshly cloned package, a worktree branch switch
 *   that removed tracked output, a cleaned `apps/web/out`) is packed stale or
 *   absent.
 * - `tsc --build` has its own incremental state (`*.tsbuildinfo`), which
 *   survives a deleted `dist/` just as easily. It sees "output up to date"
 *   and emits NOTHING -- no `dist/server.js` at all, or a mix of fresh and old
 *   files. Neither `turbo --force` nor `tsc --build --force` clears that
 *   state file, so the only reliable step is removing it first.
 *
 * So this script deletes every package's `dist/` and `*.tsbuildinfo`, plus the
 * web export (`apps/web/out`) and its staged copy (`apps/gateway/web`), then
 * rebuilds everything. Turborepo is asked to run uncached (`--force`); its
 * local cache is not consulted either way, so a cache that cannot store
 * output (this checkout's) changes nothing.
 *
 * Usage:
 *   node scripts/build-fresh.mjs            clean, then rebuild everything
 *   node scripts/build-fresh.mjs --dry-run  print what would be removed, touch nothing
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { staleArtifacts } from "./build-fresh-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Recursive byte count, so the log says how much was thrown away. */
function sizeOf(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name));
  }
  return total;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const stale = staleArtifacts();
  for (const path of stale) {
    const size = sizeOf(path);
    console.log(`${dryRun ? "would remove" : "removing"} ${relative(ROOT, path)} (${size} bytes)`);
    if (!dryRun) rmSync(path, { recursive: true, force: true });
  }
  if (dryRun) return;

  // `--force`: never replay a cached task. The output this run produces is the
  // only output the pack gate below may see.
  execFileSync("pnpm", ["turbo", "run", "build", "--force"], { cwd: ROOT, stdio: "inherit" });

  // The release additionally needs the static web export, which `turbo run
  // build` does not produce (it runs Next in server mode). The gateway's
  // `web:export` does the whole step: build the export and stage it into
  // `apps/gateway/web` (the directory the tarball ships and the gateway
  // serves). Staging there rather than in `prepack` keeps `pnpm pack` — which
  // `check:pack` runs per package — from needing the Node build first.
  execFileSync("pnpm", ["--filter", "@volto/gateway", "web:export"], { cwd: ROOT, stdio: "inherit" });
}

if (process.argv[1] && join(dirname(fileURLToPath(import.meta.url)), "build-fresh.mjs") === process.argv[1]) {
  main(process.argv.slice(2));
}
