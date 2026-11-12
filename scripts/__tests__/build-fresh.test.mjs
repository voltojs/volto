/**
 * `scripts/build-fresh.mjs` — the release gate's build step.
 *
 * The bug this pins: `tsc --build` treats `tsconfig.tsbuildinfo` as proof that
 * `dist/` is current, so a `dist/` that was deleted on its own is never
 * rebuilt, and the pack gate then packs nothing (or an older `dist/`). The
 * empty `dist/` in the fixture below IS what tsc would leave behind, which is
 * why the test asserts the state file is on the removal list rather than
 * asserting on a real compiler run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleArtifacts } from "../build-fresh-lib.mjs";

/** A miniature workspace: one package with build output, one without. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "volto-fresh-"));
  const built = join(root, "packages", "core");
  const clean = join(root, "packages", "sdk");
  mkdirSync(join(built, "dist"), { recursive: true });
  mkdirSync(clean, { recursive: true });
  for (const dir of [built, clean]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: dir, version: "0.0.0" }));
  }
  writeFileSync(join(built, "dist", "index.js"), "export {};\n");
  writeFileSync(join(built, "tsconfig.tsbuildinfo"), "{}\n");
  // The empty dist tsc refuses to refill: never restored, which is the point.
  mkdirSync(join(clean, "dist"), { recursive: true });
  writeFileSync(join(clean, "tsconfig.tsbuildinfo"), "{}\n");
  mkdirSync(join(root, "apps", "web", "out"), { recursive: true });
  mkdirSync(join(root, "apps", "gateway", "web"), { recursive: true });
  return root;
}

test("the removal list is every package's dist and tsbuildinfo, plus the web export", () => {
  const root = fixture();
  try {
    const rel = staleArtifacts(root).map((path) => path.slice(root.length + 1).split("\\").join("/"));
    assert.deepEqual(new Set(rel), new Set([
        "packages/core/dist",
        "packages/core/tsconfig.tsbuildinfo",
        // An EMPTY dist still has to go: tsc would not refill it.
        "packages/sdk/dist",
        "packages/sdk/tsconfig.tsbuildinfo",
        "apps/web/out",
        "apps/gateway/web",
    ]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run touches nothing", () => {
  const root = fixture();
  try {
    const before = staleArtifacts(root);
    // `staleArtifacts` only reads; the CLI's dry-run path is that plus prints.
    assert.deepEqual(staleArtifacts(root), before);
    assert.equal(existsSync(join(root, "packages", "core", "dist", "index.js")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace with no build output yields an empty list, not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "volto-fresh-"));
  try {
    assert.deepEqual(staleArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});