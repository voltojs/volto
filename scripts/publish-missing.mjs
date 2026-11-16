#!/usr/bin/env node
/**
 * Publish only the workspace packages whose exact version is missing from the
 * registry.
 *
 * `pnpm -r publish` republishes every package and therefore fails on versions that
 * already exist (E403). That is wrong for a workspace with independent fixed groups:
 * a changeset that bumps only one group must publish only that group, and a rerun
 * after a partial failure must skip what already shipped.
 *
 * The script checks the registry version-by-version, publishes in dependency order,
 * and exits non-zero on the first failure so CI can be rerun idempotently.
 *
 * Each package is packed with `pnpm pack` (which rewrites `workspace:^` ranges into
 * real semver ranges) and the resulting tarball is published with `npm publish`.
 * The tarball indirection is deliberate: `pnpm publish` does not implement npm's
 * OIDC detection, so trusted publishing would never engage. `npm publish` on an
 * already-rewritten tarball keeps the rewrite while letting npm mint the OIDC
 * token from the workflow's `id-token: write` permission.
 *
 * Usage:
 *   node scripts/publish-missing.mjs [--dry-run] [--registry <url>] [--no-provenance]
 *
 *   --dry-run          list what would be published, publish nothing
 *   --registry         registry base URL (default https://registry.npmjs.org/)
 *   --no-provenance    skip `--provenance` even under GitHub Actions
 *
 * Auth: in GitHub Actions, trusted publishing (OIDC) is used when no token is
 * configured. Locally, npm falls back to the user-level `~/.npmrc` token.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublishablePackages } from "./publish-manifest.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * Order packages so every workspace dependency comes before its dependents.
 * Independent groups only need this within the missing set, but sorting all
 * publishable packages keeps the output stable and catches cycles early.
 *
 * @param {Array<{ manifest: { name: string } }>} packages
 * @returns {Array<{ manifest: { name: string } }>}
 */
export function sortByDependencies(packages) {
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const remaining = new Set(byName.keys());
  const deps = new Map();
  for (const entry of packages) {
    const names = new Set();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(entry.manifest[field] ?? {})) {
        if (name !== entry.manifest.name && remaining.has(name)) names.add(name);
      }
    }
    deps.set(entry.manifest.name, names);
  }
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...deps.get(name)].every((dep) => !remaining.has(dep)))
      .sort();
    if (ready.length === 0) {
      throw new Error(`cyclic workspace dependencies among: ${[...remaining].sort().join(", ")}`);
    }
    for (const name of ready) {
      ordered.push(byName.get(name));
      remaining.delete(name);
    }
  }
  return ordered;
}

/**
 * Whether one exact version is already on the registry.
 * A 404 means "missing" (publish it); any other non-2xx is an error, not a reason
 * to publish blindly.
 */
export async function versionExists(registry, name, version) {
  const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`registry responded ${response.status} for ${name}`);
  }
  const body = await response.json();
  return typeof body?.versions?.[version] === "object";
}

/** @param {string[]} argv */
function parseArgs(argv) {
  let dryRun = false;
  let registry = DEFAULT_REGISTRY;
  let provenance = process.env["GITHUB_ACTIONS"] === "true";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-provenance") provenance = false;
    else if (arg === "--registry") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--registry needs a value");
      registry = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/publish-missing.mjs [--dry-run] [--registry <url>] [--no-provenance]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, registry, provenance };
}

/**
 * Pack one workspace package and publish the tarball.
 *
 * `pnpm pack` resolves the `workspace:` protocol into a semver range inside the
 * packed manifest; `npm publish` then uploads that tarball. The tarball is built in
 * a throwaway directory so a failed run leaves no artifact in the workspace.
 *
 * @param {{ dir: string, manifest: { name: string, version: string } }} entry
 * @param {{ registry: string, provenance: boolean }} options
 */
function publishOne(entry, options) {
  const staging = mkdtempSync(join(tmpdir(), "volto-publish-"));
  try {
    execFileSync(
      "pnpm",
      ["--filter", entry.manifest.name, "pack", "--pack-destination", staging],
      { stdio: "inherit" },
    );
    const tarball = readdirSync(staging).find((file) => file.endsWith(".tgz"));
    if (tarball === undefined) {
      throw new Error(`pnpm pack produced no tarball for ${entry.manifest.name}`);
    }
    const args = [
      "publish",
      join(staging, tarball),
      "--access",
      "public",
      "--registry",
      options.registry,
    ];
    // Provenance needs OIDC (or a token with the right scope); a local run without
    // it would fail, so the flag is opt-in through the GITHUB_ACTIONS signal.
    if (options.provenance) args.push("--provenance");
    execFileSync("npm", args, { stdio: "inherit" });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { dryRun, registry, provenance } = parseArgs(process.argv.slice(2));
  const packages = sortByDependencies(loadPublishablePackages());
  const missing = [];
  for (const entry of packages) {
    const { name, version } = entry.manifest;
    if (await versionExists(registry, name, version)) {
      console.log(`skip ${name}@${version} (already published)`);
    } else {
      console.log(`todo ${name}@${version}`);
      missing.push(entry);
    }
  }
  if (missing.length === 0) {
    console.log("Nothing to publish: every workspace version is already on the registry.");
    return;
  }
  if (dryRun) {
    console.log(`--dry-run: ${missing.length} package(s) would be published.`);
    return;
  }
  for (const entry of missing) {
    const { name, version } = entry.manifest;
    console.log(`\n→ publishing ${name}@${version}`);
    publishOne(entry, { registry, provenance });
  }
  console.log(`\nPublished ${missing.length} package(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  main().catch((error) => {
    console.error(`publish-missing: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}