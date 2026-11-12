#!/usr/bin/env node
/**
 * Publishes gate: every publishable workspace package must carry complete npm
 * metadata, or a packed tarball drops the built output / publishes privately.
 *
 * Usage:
 *   node scripts/publish-manifest.mjs            validate every publishable package (exit 1 on problems)
 *   node scripts/publish-manifest.mjs --write    fill in missing fields, keep existing values
 *   node scripts/publish-manifest.mjs --self-test run the built-in fixture assertions
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace globs, kept in sync with pnpm-workspace.yaml. */
const WORKSPACE_GLOBS = ["packages/*", "packages/*/*", "apps/*"];

/** Client bundles that are shipped inside other artifacts, never to a registry. */
const PRIVATE_PACKAGES = new Set(["@volto/web", "@volto/desktop-app"]);

/**
 * Packages the release plan already triaged for publishing. Their manifests still
 * carry `private: true` (dropping it is a later release step), so they are selected
 * explicitly. Mirrors the plan's publish table; everything not listed here must stay
 * `private: true` to be skipped.
 */
const TRIAGED_PACKAGES = new Set([
  "@volto/core",
  "@volto/eval",
  "@volto/i18n",
  "@volto/sdk",
  "@volto/embedder-openai",
  "@volto/memory-common",
  "@volto/memory-file",
  "@volto/memory-inmemory",
  "@volto/provider-anthropic",
  "@volto/provider-openai",
  "@volto/provider-pi-ai",
  "@volto/runtime-browser",
  "@volto/runtime-edge",
  "@volto/runtime-node",
  "@volto/store-file",
  "@volto/store-jsonl",
  "@volto/store-memory",
  "@volto/store-postgres",
  "@volto/store-sqlite",
  "@volto/tools-agent",
  "@volto/tools-ask",
  "@volto/tools-browser",
  "@volto/tools-code",
  "@volto/tools-common",
  "@volto/tools-data",
  "@volto/tools-document",
  "@volto/tools-fs",
  "@volto/tools-mcp",
  "@volto/tools-memory",
  "@volto/tools-plan",
  "@volto/tools-schedule",
  "@volto/tools-shell",
  "@volto/tool-skill",
  "@volto/tools-vcs",
  "@volto/tools-web",
  "@volto/headless-server",
]);

/** Dependency sections whose `workspace:` ranges must be rewritten before publishing. */
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/** The metadata `applyManifest` adds when a package does not have it yet. */
const REQUIRED_METADATA = {
  publishConfig: { access: "public" },
  engines: { node: ">=22" },
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/voltojs/volto.git" },
  type: "module",
};

/** Key order used when rewriting a manifest, so `--write` diffs stay reviewable. */
const KEY_ORDER = [
  "name",
  "version",
  "private",
  "type",
  "main",
  "types",
  "exports",
  "bin",
  "files",
  "scripts",
  "publishConfig",
  "engines",
  "license",
  "repository",
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "peerDependenciesMeta",
  "devDependencies",
];

const DIST_DIR = "dist";
const DIST_PREFIX = `${DIST_DIR}/`;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip a leading `./` so `./dist/x.js` and `dist/x.js` compare alike. */
function normalizePath(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : "";
}

/**
 * Whether a path points inside `dist/`: either the directory itself (`files: ["dist"]`)
 * or a file under it (`main: "./dist/index.js"`).
 */
function pointsIntoDist(value) {
  const path = normalizePath(value);
  return path === DIST_DIR || path.startsWith(DIST_PREFIX);
}

/** Whether `name` is one of the packages that must never be published. */
function isPrivatePackage(name) {
  return PRIVATE_PACKAGES.has(name);
}

/**
 * Whether a manifest is one of the packages that ship to a registry: a triaged
 * package, or any package that has already dropped `private`. Everything else,
 * including the fixed denylist, is skipped.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 */
export function isPublishableManifest(manifest) {
  if (isPrivatePackage(manifest.name)) return false;
  return manifest.private !== true || TRIAGED_PACKAGES.has(manifest.name);
}

/**
 * Check one manifest against the publishing contract.
 * Returns stable, ordered, machine-assertable messages; an empty array means OK.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @param {string} dir package directory, handed to `reportWith` so the CLI can say which package failed
 * @param {(problem: string) => void} [reportWith] called once per problem; problems are also returned
 * @returns {string[]}
 */
export function validateManifest(manifest, dir, reportWith) {
  const problems = [];
  const report = (message) => {
    problems.push(message);
    reportWith?.(`${dir}: ${message}`);
  };
  const files = Array.isArray(manifest.files) ? manifest.files : [];

  if (!files.some((entry) => pointsIntoDist(entry))) {
    report("files: missing dist entry");
  }
  if (!isPlainObject(manifest.publishConfig) || manifest.publishConfig.access !== "public") {
    report("publishConfig.access: not public");
  }
  if (!isPlainObject(manifest.engines) || typeof manifest.engines.node !== "string") {
    report("engines.node: missing");
  }
  if (manifest.license !== "MIT") {
    report("license: not MIT");
  }
  if (!isPlainObject(manifest.repository) || typeof manifest.repository.url !== "string") {
    report("repository.url: missing");
  }
  if (manifest.type !== "module") {
    report("type: not module");
  }
  if (!pointsIntoDist(manifest.main)) {
    report("main: not under dist");
  }
  if (!pointsIntoDist(manifest.types)) {
    report("types: not under dist");
  }
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (!isPlainObject(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        report(`${field}.${name}: workspace protocol left`);
      }
    }
  }
  return problems;
}

/**
 * Fill in the metadata a manifest lacks. Existing values are never overwritten,
 * so a hand-corrected field survives the next `--write` run.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @param {string} dir package directory
 * @returns {Record<string, unknown>} a new manifest with the fields filled in
 */
export function applyManifest(manifest, dir) {
  const next = structuredClone(manifest);
  if (isPrivatePackage(manifest.name)) return next;

  for (const [field, value] of Object.entries(REQUIRED_METADATA)) {
    if (next[field] === undefined) next[field] = structuredClone(value);
  }
  if (!Array.isArray(next.files) || next.files.length === 0) {
    next.files = ["dist", "!dist/**/__tests__"];
  }
  if (!pointsIntoDist(next.main)) next.main = `./${DIST_PREFIX}index.js`;
  if (!pointsIntoDist(next.types)) next.types = `./${DIST_PREFIX}index.d.ts`;
  for (const [field, value] of Object.entries(REQUIRED_METADATA)) {
    if (!isPlainObject(next[field])) next[field] = structuredClone(value);
  }
  return placeKeys(manifest, next);
}

/**
 * Rebuild the manifest in its original key order, inserting newly added keys right
 * after the key that precedes them in KEY_ORDER, so `--write` diffs stay local.
 */
function placeKeys(original, next) {
  const added = new Set(Object.keys(next).filter((key) => !(key in original)));
  const ordered = [];
  for (const key of KEY_ORDER) {
    if (key in original) ordered.push(key);
    if (added.has(key)) ordered.push(key);
  }
  for (const key of Object.keys(next)) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  const placed = {};
  for (const key of ordered) placed[key] = next[key];
  return placed;
}

/**
 * Serialize a manifest for writing: rewrite the top-level block of every key whose
 * value changed and copy every other key's source text verbatim. Newly added keys
 * are inserted in the order `applyManifest` placed them. Inner formatting of
 * untouched blocks is preserved, so `--write` never reformats what it did not touch.
 */
function renderManifest(manifest, raw) {
  const baseIndent = raw.match(/^[ \t]+/)?.[0] ?? "  ";
  const blocks = splitTopLevelBlocks(raw);
  const lines = ["{"];
  const keys = Object.keys(manifest);
  keys.forEach((key, index) => {
    const block = blocks.get(key) ?? renderBlock(manifest[key], baseIndent);
    lines.push(`${baseIndent}${JSON.stringify(key)}: ${block}${index === keys.length - 1 ? "" : ","}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/**
 * Map every top-level key of a JSON object document to the exact source text of its
 * value. A real recursive-descent walk is used rather than brace counting, so nested
 * objects, arrays, and strings can never end a value early.
 *
 * @param {string} raw package.json source
 * @returns {Map<string, string>}
 */
function splitTopLevelBlocks(raw) {
  const blocks = new Map();
  let index = raw.indexOf("{") + 1;

  const skipSpace = () => {
    while (index < raw.length && " \t\r\n".includes(raw[index])) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < raw.length) {
      if (raw[index] === "\\") index += 2;
      else if (raw[index] === '"') break;
      else index += 1;
    }
    index += 1;
    return JSON.parse(raw.slice(start, index));
  };
  const skipValue = () => {
    const start = index;
    if (raw[index] === "{" || raw[index] === "[") {
      let depth = 0;
      while (index < raw.length) {
        const char = raw[index];
        if (char === '"') {
          readString();
          continue;
        }
        if (char === "{" || char === "[") depth += 1;
        else if (char === "}" || char === "]") {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            return raw.slice(start, index);
          }
        }
        index += 1;
      }
      throw new Error("unbalanced value in package.json");
    }
    while (index < raw.length && raw[index] !== "," && raw[index] !== "\n" && raw[index] !== "}") {
      index += 1;
    }
    return raw.slice(start, index).trim();
  };

  while (index < raw.length) {
    skipSpace();
    if (raw[index] !== '"') break;
    const key = readString();
    skipSpace();
    if (raw[index] !== ":") throw new Error(`expected ':' after ${key} in package.json`);
    index += 1;
    skipSpace();
    blocks.set(key, skipValue());
    skipSpace();
    if (raw[index] === ",") index += 1;
  }
  return blocks;
}

/** Render a value that has no source text to reuse. */
function renderBlock(value, baseIndent) {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${baseIndent}`);
}

/** Every workspace package directory, matching the pnpm-workspace globs. */
export function listPackageDirs(root = ROOT) {
  const dirs = [];
  for (const glob of WORKSPACE_GLOBS) {
    const segments = glob.split("/");
    // Expand the globs one `*` segment at a time so no package is listed by hand.
    let bases = [root];
    for (const segment of segments) {
      const next = [];
      for (const base of bases) {
        if (segment === "*") {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
              next.push(join(base, entry.name));
            }
          }
        } else {
          next.push(join(base, segment));
        }
      }
      bases = next;
    }
    for (const dir of bases) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs.filter((dir) => {
    try {
      readFileSync(join(dir, "package.json"));
      return true;
    } catch {
      return false;
    }
  });
}

/** Read every workspace package, publishable or not. */
export function loadWorkspacePackages(root = ROOT) {
  return listPackageDirs(root).map((dir) => {
    const path = join(dir, "package.json");
    const raw = readFileSync(path, "utf-8");
    return { dir, path, manifest: JSON.parse(raw), raw };
  });
}

/** Read the subset of workspace packages that ship to a registry. */
export function loadPublishablePackages(root = ROOT) {
  return loadWorkspacePackages(root).filter((entry) => isPublishableManifest(entry.manifest));
}

/** A minimal manifest that is already complete; cases below mutate copies of it. */
const COMPLETE_FIXTURE = {
  name: "@volto/fixture",
  version: "0.1.0",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  files: ["dist"],
  publishConfig: { access: "public" },
  engines: { node: ">=22" },
  license: "MIT",
  repository: { type: "git", url: "git+https://example.com/volto.git" },
};

function selfTest() {
  const dir = "/tmp/volto-self-test";
  const applied = applyManifest({ name: "@volto/fixture", version: "0.1.0" }, dir);
  const cases = [
    ["complete manifest passes", validateManifest(COMPLETE_FIXTURE, dir), []],
    [
      "workspace protocol is reported",
      validateManifest(
        { ...COMPLETE_FIXTURE, dependencies: { "@volto/core": "workspace:*" } },
        dir,
      ),
      ["dependencies.@volto/core: workspace protocol left"],
    ],
    ["applyManifest fills files", applied.files, ["dist", "!dist/**/__tests__"]],
    ["applyManifest fills license", applied.license, "MIT"],
    ["applyManifest output passes the check", validateManifest(applied, dir), []],
    [
      "applyManifest is a fixpoint",
      JSON.stringify(applyManifest(applied, dir)) === JSON.stringify(applied),
      true,
    ],
    [
      "private packages are left untouched",
      applyManifest({ name: "@volto/web", private: true }, dir),
      { name: "@volto/web", private: true },
    ],
  ];
  let failed = 0;
  for (const [name, actual, expected] of cases) {
    const wanted = JSON.stringify(expected);
    const ok = JSON.stringify(actual) === wanted;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok" : "not ok"} - ${name}`);
    if (!ok) console.log(`  expected: ${wanted}\n  actual:   ${JSON.stringify(actual)}`);
  }
  if (failed > 0) {
    console.error(`FAIL: ${failed}/${cases.length} self-test cases failed`);
    process.exit(1);
  }
  console.log(`PASS: ${cases.length}/${cases.length} self-test cases passed`);
}

function main(argv) {
  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const write = argv.includes("--write");
  const packages = loadPublishablePackages();
  const failures = [];
  let written = 0;

  for (const { dir, path, manifest, raw } of packages) {
    const next = applyManifest(manifest, dir);
    if (write && JSON.stringify(next) !== JSON.stringify(manifest)) {
      writeFileSync(path, renderManifest(next, raw));
      written += 1;
      console.log(`wrote ${relative(ROOT, path)}`);
    }
    validateManifest(write ? next : manifest, dir, (problem) => failures.push(problem));
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`${failures.length} problem(s) in ${packages.length} publishable package(s)`);
    process.exit(1);
  }
  const summary = write ? ` (${written} file(s) updated)` : "";
  console.log(`PASS: ${packages.length} publishable package(s) have complete metadata${summary}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  main(process.argv.slice(2));
}