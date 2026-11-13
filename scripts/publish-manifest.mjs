#!/usr/bin/env node
/**
 * Publishing gate: every publishable workspace package must carry complete npm
 * metadata, or a packed tarball drops the built output / publishes privately.
 *
 * Usage:
 *   node scripts/publish-manifest.mjs                       check publishable packages (exit 1 on problems)
 *   node scripts/publish-manifest.mjs --write               fill in missing fields, keep existing values
 *   node scripts/publish-manifest.mjs --strict-workspace    also fail on `workspace:` ranges (publish gate)
 *   node scripts/publish-manifest.mjs --self-test           run the built-in fixture assertions
 *
 * Two modes, by design:
 *   - Default (dev time): source manifests legitimately keep `workspace:*`; pnpm rewrites
 *     those ranges when packing/publishing. Checking them here would make every local run
 *     fail, so `workspace:` ranges are ignored and the run is expected to exit 0.
 *   - `--strict-workspace` (publish time): any surviving `workspace:` range is reported.
 *     Task 2's tarball inspection is what proves pnpm actually rewrote them.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace globs, kept in sync with pnpm-workspace.yaml. */
const WORKSPACE_GLOBS = ["packages/*", "packages/*/*", "apps/*"];

/** Client bundles that are shipped inside other artifacts, never to a registry. */
const PRIVATE_PACKAGES = new Set(["@voltojs/web", "@voltojs/desktop-app"]);

/**
 * Packages the release plan triaged for publishing, mirroring the plan's publish table.
 *
 * Selection itself is "not `private`" (see `isPublishableManifest`); this list is only a
 * sanity guard, so a triaged package that still says `private: true` is still checked
 * instead of silently vanishing from the gate.
 */
const TRIAGED_PACKAGES = new Set([
  "@voltojs/core",
  "@voltojs/eval",
  "@voltojs/i18n",
  "@voltojs/sdk",
  "@voltojs/embedder-openai",
  "@voltojs/memory-common",
  "@voltojs/memory-file",
  "@voltojs/memory-inmemory",
  "@voltojs/provider-anthropic",
  "@voltojs/provider-openai",
  "@voltojs/provider-pi-ai",
  "@voltojs/runtime-browser",
  "@voltojs/runtime-edge",
  "@voltojs/runtime-node",
  "@voltojs/store-file",
  "@voltojs/store-jsonl",
  "@voltojs/store-memory",
  "@voltojs/store-postgres",
  "@voltojs/store-sqlite",
  "@voltojs/tools-agent",
  "@voltojs/tools-ask",
  "@voltojs/tools-browser",
  "@voltojs/tools-code",
  "@voltojs/tools-common",
  "@voltojs/tools-data",
  "@voltojs/tools-document",
  "@voltojs/tools-fs",
  "@voltojs/tools-mcp",
  "@voltojs/tools-memory",
  "@voltojs/tools-plan",
  "@voltojs/tools-schedule",
  "@voltojs/tools-shell",
  "@voltojs/tool-skill",
  "@voltojs/tools-vcs",
  "@voltojs/tools-web",
  "@voltojs/gateway",
]);

/** Dependency sections whose `workspace:` ranges must be rewritten before publishing. */
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * The registry every package publishes to. GitHub Packages only accepts a package
 * whose scope matches the owning account, which is why the scope is `@voltojs`; the
 * publish gate below enforces this exact value in `publishConfig.registry`.
 */
const REGISTRY = "https://npm.pkg.github.com";

/**
 * The metadata `applyManifest` adds when a package does not have it yet.
 *
 * `publishConfig` deliberately carries only `registry`: GitHub ignores `access`, and
 * every package is private by default there (see the release runbook in
 * `docs/user/integrating/guides/publishing.md`).
 */
const REQUIRED_METADATA = {
  publishConfig: { registry: REGISTRY },
  engines: { node: ">=22" },
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/zlipeng/volto.git" },
  type: "module",
};

/** The `REQUIRED_METADATA` fields that must be objects; the rest are scalars. */
const OBJECT_REQUIRED_FIELDS = new Set(["publishConfig", "engines", "repository"]);

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
 * Whether a manifest is one of the packages that ship to a registry: everything that is
 * not `private`, except the client bundles that are never published. The triage list
 * keeps a package selected while `--write` has not dropped its `private` flag yet,
 * which is what makes the first run self-hosting; `assertTriagedArePublishable` then
 * fails the run if such a package is still private afterwards.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 */
export function isPublishableManifest(manifest) {
  if (isPrivatePackage(manifest.name)) return false;
  return manifest.private !== true || TRIAGED_PACKAGES.has(manifest.name);
}

/** The triaged packages are published: after `--write` none may still say `private`. */
function assertTriagedArePublishable(packages) {
  const privateLeft = packages
    .filter(({ manifest }) => TRIAGED_PACKAGES.has(manifest.name) && manifest.private === true)
    .map(({ manifest }) => manifest.name);
  if (privateLeft.length > 0) {
    throw new Error(`triaged packages still marked private: ${privateLeft.join(", ")}`);
  }
}

/**
 * Check one manifest against the publishing contract.
 * Returns stable, ordered, machine-assertable messages; an empty array means OK.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @param {string} dir package directory, handed to `reportWith` so the CLI can say which package failed
 * @param {{ strictWorkspace?: boolean } | ((problem: string) => void)} [opts] options, or the reporter
 *   itself when no options are needed — `(manifest, dir, callback)` must not silently become default mode
 * @param {(problem: string) => void} [reportWith] called once per problem, prefixed with `dir`
 * @returns {string[]} problems in fixed check order; empty means OK
 */
export function validateManifest(manifest, dir, opts, reportWith) {
  const { options, reporter } = splitValidateArgs(opts, reportWith);
  const problems = [];
  const report = (message) => {
    problems.push(message);
    reporter?.(`${dir}: ${message}`);
  };
  const files = Array.isArray(manifest.files) ? manifest.files : [];

  if (!files.some((entry) => pointsIntoDist(entry))) {
    report("files: missing dist entry");
  }
  if (!isPlainObject(manifest.publishConfig) || manifest.publishConfig.registry !== REGISTRY) {
    report(`publishConfig.registry: not ${REGISTRY}`);
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
  if (!options.strictWorkspace) return problems;
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
 * Disambiguate `validateManifest`'s two optional positional arguments: a function in
 * the options slot is the reporter, so `(manifest, dir, callback)` keeps its callback
 * instead of quietly falling back to the default mode.
 *
 * @param {unknown} opts third argument as passed
 * @param {((problem: string) => void) | undefined} reportWith fourth argument as passed
 * @returns {{ options: { strictWorkspace?: boolean }, reporter?: (problem: string) => void }}
 */
function splitValidateArgs(opts, reportWith) {
  if (typeof opts === "function") return { options: {}, reporter: opts };
  return { options: opts ?? {}, reporter: reportWith };
}

/**
 * Fill in the metadata a manifest lacks, and apply the single normalization rule
 * documented on `normalizeManifest`. Apart from that rule, an existing value is never
 * overwritten, so a hand-corrected field (license, engines, files, ...) survives the
 * next `--write` run.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @param {string} dir package directory
 * @returns {Record<string, unknown>} a new manifest with the fields filled in
 */
export function applyManifest(manifest, dir) {
  const next = structuredClone(manifest);
  // Client bundles are never published; the two client packages keep `private` as is.
  if (!isPublishableManifest(manifest)) return next;

  // Everything else is published, so it must not stay in the private set.
  delete next.private;

  // Missing values are filled in; a present value is only repaired when it has the wrong
  // shape to satisfy the check at all (an object field that is not an object), never
  // because its scalar content differs from the default.
  for (const [field, value] of Object.entries(REQUIRED_METADATA)) {
    const absent = next[field] === undefined;
    const wrongShape = OBJECT_REQUIRED_FIELDS.has(field) && !isPlainObject(next[field]);
    if (absent || wrongShape) next[field] = structuredClone(value);
  }
  if (!Array.isArray(next.files) || next.files.length === 0) {
    next.files = ["dist", "!dist/**/__tests__"];
  }
  if (!pointsIntoDist(next.main)) next.main = `./${DIST_PREFIX}index.js`;
  if (!pointsIntoDist(next.types)) next.types = `./${DIST_PREFIX}index.d.ts`;
  return placeKeys(manifest, normalizeManifest(next));
}

/**
 * The one place that may overwrite an existing value: `repository`.
 *
 * The upstream URL is a fact about the repository, not a per-package choice, so a
 * manifest carrying an outdated or copied-from-a-template URL is corrected instead of
 * being left wrong. Only `repository.type` and `repository.url` are touched; any other
 * `repository` field (such as `directory`) is preserved. Every other field keeps the
 * value the package author set.
 *
 * @param {Record<string, unknown>} manifest manifest already filled in by `applyManifest`
 * @returns {Record<string, unknown>} the same manifest with `repository` normalized
 */
export function normalizeManifest(manifest) {
  if (!isPlainObject(manifest.repository)) return manifest;
  const { type, url } = REQUIRED_METADATA.repository;
  if (manifest.repository.type === type && manifest.repository.url === url) return manifest;
  return { ...manifest, repository: { ...manifest.repository, type, url } };
}

/**
 * Rebuild the manifest in its original key order, inserting newly added keys right
 * after the key that precedes them in KEY_ORDER, so `--write` diffs stay local.
 * Keys removed from `next` (such as `private`) stay removed.
 */
function placeKeys(original, next) {
  const present = new Set(Object.keys(next));
  const added = new Set(Object.keys(next).filter((key) => !(key in original)));
  const ordered = [];
  for (const key of KEY_ORDER) {
    if (key in original && present.has(key)) ordered.push(key);
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
  const original = JSON.parse(raw);
  const blocks = splitTopLevelBlocks(raw);
  const lines = ["{"];
  const keys = Object.keys(manifest);
  keys.forEach((key, index) => {
    // Reuse the source text only while the value is unchanged; a changed value is
    // re-rendered, otherwise the edit would be silently dropped.
    const unchanged = JSON.stringify(original[key]) === JSON.stringify(manifest[key]);
    const block = (unchanged && blocks.get(key)) || renderBlock(manifest[key], baseIndent);
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
  name: "@voltojs/fixture",
  version: "0.1.0",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  files: ["dist"],
  publishConfig: { registry: "https://npm.pkg.github.com" },
  engines: { node: ">=22" },
  license: "MIT",
  repository: { type: "git", url: "git+https://example.com/volto.git" },
};

function selfTest() {
  const dir = "/tmp/volto-self-test";
  const applied = applyManifest({ name: "@voltojs/fixture", version: "0.1.0" }, dir);
  const withWorkspaceRange = { ...COMPLETE_FIXTURE, dependencies: { "@voltojs/core": "workspace:*" } };
  const cases = [
    ["complete manifest passes", validateManifest(COMPLETE_FIXTURE, dir), []],
    [
      "workspace protocol is reported",
      validateManifest(withWorkspaceRange, dir, { strictWorkspace: true }),
      ["dependencies.@voltojs/core: workspace protocol left"],
    ],
    [
      "workspace protocol is ignored by default",
      validateManifest(withWorkspaceRange, dir),
      [],
    ],
    ["applyManifest fills files", applied.files, ["dist", "!dist/**/__tests__"]],
    ["applyManifest fills license", applied.license, "MIT"],
    ["applyManifest output passes the check", validateManifest(applied, dir), []],
    ["applyManifest points at the GitHub Packages registry", applied.publishConfig.registry, "https://npm.pkg.github.com"],
    [
      "applyManifest is a fixpoint",
      JSON.stringify(applyManifest(applied, dir)) === JSON.stringify(applied),
      true,
    ],
    [
      "private packages are left untouched",
      applyManifest({ name: "@voltojs/web", private: true }, dir),
      { name: "@voltojs/web", private: true },
    ],
    [
      "applyManifest drops private on triaged packages",
      "private" in applyManifest({ name: "@voltojs/core", private: true }, dir),
      false,
    ],
    [
      "applyManifest uses the zlipeng repository URL",
      applied.repository.url,
      "git+https://github.com/zlipeng/volto.git",
    ],
    [
      "applyManifest corrects a stale repository URL",
      applyManifest({ ...COMPLETE_FIXTURE, name: "@voltojs/fixture2" }, dir).repository.url,
      "git+https://github.com/zlipeng/volto.git",
    ],
    [
      "repository is corrected while a hand-set license is preserved",
      (() => {
        const applied2 = applyManifest(
          {
            ...COMPLETE_FIXTURE,
            name: "@voltojs/fixture3",
            license: "Apache-2.0",
            engines: { node: ">=24" },
          },
          dir,
        );
        return [applied2.repository.url, applied2.license, applied2.engines.node];
      })(),
      ["git+https://github.com/zlipeng/volto.git", "Apache-2.0", ">=24"],
    ],
    [
      "repository normalization keeps unrelated repository fields",
      normalizeManifest({
        repository: { type: "git", url: "git+https://github.com/old/repo.git", directory: "packages/x" },
      }).repository.directory,
      "packages/x",
    ],
    ...(({ collected, returned }) => [
      ["validateManifest accepts a reporter in the options slot", collected, ["/volto-self-test/x: license: not MIT"]],
      ["a lone reporter still returns the problems", returned, ["license: not MIT"]],
    ])((() => {
      // Called as (manifest, dir, callback): no options object at all.
      const calls = [];
      const returned2 = validateManifest({ ...COMPLETE_FIXTURE, license: undefined }, "/volto-self-test/x", (problem) =>
        calls.push(problem),
      );
      return { collected: calls, returned: returned2 };
    })()),
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
  const strictWorkspace = argv.includes("--strict-workspace");
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
    validateManifest(write ? next : manifest, dir, { strictWorkspace }, (problem) =>
      failures.push(problem),
    );
  }

  // Check mode runs against the committed manifests, which must already be publishable.
  const checked = write
    ? packages.map((entry) => ({ ...entry, manifest: applyManifest(entry.manifest, entry.dir) }))
    : packages;
  assertTriagedArePublishable(checked);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`${failures.length} problem(s) in ${packages.length} publishable package(s)`);
    process.exit(1);
  }
  const mode = strictWorkspace ? " [strict workspace]" : "";
  const summary = write ? ` (${written} file(s) updated)` : "";
  console.log(`PASS: ${packages.length} publishable package(s) have complete metadata${mode}${summary}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  main(process.argv.slice(2));
}
