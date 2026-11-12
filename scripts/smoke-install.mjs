#!/usr/bin/env node
/**
 * Clean-project install smoke: the packed tarballs of the `@volto/sdk` dependency
 * closure must install into a project that knows nothing about the workspace, and
 * `@volto/sdk` must work from there through node's normal resolution.
 *
 * Flow: temp dir → `npm init -y` → `pnpm pack` every package in the closure into the
 * temp dir → `npm install` all those tarballs → copy `scripts/fixtures/smoke-agent.mjs`
 * into the project and run it with plain `node`. The project uses npm on purpose:
 * installing the tarballs with the same package manager that produced them (pnpm,
 * with its workspace linking and hoisting) would hide a `workspace:` range or a
 * hoisting-dependent import that an outside consumer would hit.
 *
 * Usage:
 *   node scripts/smoke-install.mjs        run the smoke (exit 0 means F-01 holds)
 *
 * On success the temp project is deleted; on failure it is kept and its path is
 * printed so the broken install can be inspected.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublishablePackages } from "./publish-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts", "fixtures", "smoke-agent.mjs");

/** Package whose `dependencies` closure gets packed and installed. */
const ENTRY_PACKAGE = "@volto/sdk";

/** Every child process gets this long; a hung npm or node must fail, not block CI. */
const TIMEOUT_MS = 10 * 60 * 1000;
/** How many trailing stderr lines a failed child shows. */
const STDERR_TAIL = 40;

/**
 * The `name → entry` closure of `ENTRY_PACKAGE` over workspace `dependencies`,
 * following each dependency transitively. `workspace:` ranges name a sibling
 * package; any other range is a third-party dependency that npm fetches itself.
 *
 * @param {{ manifest: { name?: string, dependencies?: Record<string, string> } }[]} packages
 *   the publishable workspace packages
 * @param {string} entry package name to start from
 * @returns {Array<{ dir: string, manifest: { name: string } }>} closure, entry first
 */
function dependencyClosure(packages, entry) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const start = byName.get(entry);
  if (!start) throw new Error(`${entry} is not a publishable workspace package`);

  const closure = new Map([[entry, start]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const [name, range] of Object.entries(current.manifest.dependencies ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      const dependency = byName.get(name);
      if (!dependency) throw new Error(`${current.manifest.name} depends on ${name}, which is not publishable`);
      if (closure.has(name)) continue;
      closure.set(name, dependency);
      queue.push(dependency);
    }
  }
  return [...closure.values()];
}

/**
 * Run a child process. A silent step only fails; a verbose one also echoes its output,
 * so the smoke log shows progress without npm/pnpm boilerplate.
 */
function run(command, args, { verbose = false, ...spawn }, label) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...spawn,
  });
  if (!result.error && result.status === 0) {
    if (verbose) process.stdout.write(result.stdout);
    return;
  }
  const reason = result.error
    ? `${result.error.code === "ETIMEDOUT" ? `timed out after ${TIMEOUT_MS / 1000}s` : result.error.message}`
    : `exit ${result.status}`;
  console.error(`FAIL: ${label} (${reason})`);
  const tail = `${result.stderr ?? ""}`.trimEnd().split("\n").slice(-STDERR_TAIL);
  for (const line of tail) console.error(`  ${line}`);
  throw new Error(`${label} failed: ${reason}`);
}

/** Size of the installed tree, as a `du -sh`-style baseline (tarball install cost). */
function installedSize(project) {
  const nodeModules = join(project, "node_modules");
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    }
  };
  walk(nodeModules);
  const installed = readdirSync(join(nodeModules, "@volto")).length;
  return { bytes, installed };
}

function formatSize(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(1)} MiB (${bytes} bytes)`;
}

function main() {
  const packs = dependencyClosure(loadPublishablePackages(), ENTRY_PACKAGE);
  console.log(`Packed package count: ${packs.length} (${ENTRY_PACKAGE} dependency closure)`);
  for (const { manifest } of packs) console.log(`  ${manifest.name}`);

  const project = mkdtempSync(join(tmpdir(), "volto-smoke-install-"));
  console.log(`Temp project: ${project}`);
  try {
    run("npm", ["init", "-y"], { cwd: project }, "npm init -y");
    console.log("npm init -y: done");

    let packed = 0;
    for (const { manifest } of packs) {
      run(
        "pnpm",
        ["--filter", manifest.name, "pack", "--pack-destination", project],
        { cwd: ROOT },
        `pnpm pack ${manifest.name}`,
      );
      packed += 1;
      process.stdout.write(`packed ${packed}/${packs.length} ${manifest.name}\n`);
    }

    // npm names a tarball after the package name with the scope dropped and an extra
    // `volto-` prefix, so the file is read from the directory instead of derived.
    const tarballs = readdirSync(project).filter((file) => file.endsWith(".tgz")).sort();
    if (tarballs.length !== packs.length) {
      throw new Error(`packed ${tarballs.length} tarball(s), expected ${packs.length}: ${tarballs.join(", ")}`);
    }
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", ...tarballs],
      { cwd: project, verbose: true },
      "npm install",
    );

    const { bytes, installed } = installedSize(project);
    console.log(`Installed node_modules: ${formatSize(bytes)} across ${installed} @volto/* package(s)`);

    copyFileSync(FIXTURE, join(project, "smoke-agent.mjs"));
    run("node", ["smoke-agent.mjs"], { cwd: project, verbose: true }, "node smoke-agent.mjs");

    rmSync(project, { recursive: true, force: true });
    console.log(`Removed temp project: ${project}`);
  } catch (error) {
    console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Temp project kept for inspection: ${project}`);
    process.exit(1);
  }
}

main();