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
 * Usage:
 *   node scripts/publish-missing.mjs [--dry-run] [--registry <url>]
 *
 *   --dry-run   list what would be published, publish nothing
 *   --registry  registry base URL (default https://registry.npmjs.org/)
 *
 * Auth comes from the environment: `NODE_AUTH_TOKEN` (CI) or the user-level
 * `~/.npmrc` (local).
 */
import { execFileSync } from "node:child_process";
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--registry") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--registry needs a value");
      registry = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/publish-missing.mjs [--dry-run] [--registry <url>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun, registry };
}

async function main() {
  const { dryRun, registry } = parseArgs(process.argv.slice(2));
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
    execFileSync(
      "pnpm",
      ["--filter", name, "publish", "--no-git-checks", "--access", "public"],
      { stdio: "inherit" },
    );
  }
  console.log(`\nPublished ${missing.length} package(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  main().catch((error) => {
    console.error(`publish-missing: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}