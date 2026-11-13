#!/usr/bin/env node
/**
 * Publishing gate: what actually ends up inside the packed tarball must be the built
 * output only. `scripts/publish-manifest.mjs` checks the manifest's intent (`files`,
 * `main`, `types`); this check reads the real file list pnpm would pack, so a `files`
 * entry that is correct on paper but produces an empty `dist/` (stale build, changed
 * `outDir`, exports subpath renamed) fails here instead of shipping a broken package.
 *
 * Usage:
 *   node scripts/check-pack-contents.mjs                  inspect every publishable package
 *   node scripts/check-pack-contents.mjs --self-test      run the built-in fixture assertions
 *
 * The publishable set comes from `publish-manifest.mjs`, so the two gates can never
 * disagree about which packages ship. `pnpm pack --dry-run --json` performs the same
 * `workspace:` range rewrite as a real publish and lists the files npm would pack,
 * without writing a tarball or touching the network.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublishablePackages } from "./publish-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DIST_DIR = "dist";
const DIST_PREFIX = `${DIST_DIR}/`;
const ENTRY_FILE = "dist/index.js";
const TYPES_FILE = "dist/index.d.ts";
const SRC_PREFIX = "src/";
const TESTS_SEGMENT = "__tests__";

/**
 * Compiled test output. Excluding `__tests__` segments alone is not enough: a
 * `.test.ts` sitting next to its source compiles to a `.test.js` beside it
 * (plus its `.d.ts`, `.js.map` and `.d.ts.map`), which no segment rule sees.
 * The TypeScript emitter produces exactly these suffixes, so the pattern is
 * fixed rather than generic.
 */
const TEST_ARTIFACT = /\.test\.(?:js|d\.ts|js\.map|d\.ts\.map)$/;

/**
 * Files a package must ship beyond the generic `dist/` entry and types, keyed by package.
 * `@voltojs/core` promises `dist/testing/store-contract.js` through `exports["./testing"]`;
 * asserting it by name keeps that public contract from regressing silently. Other
 * packages' subpaths are covered generically by `declaredFiles`.
 */
const REQUIRED_FILES = new Map([["@voltojs/core", ["dist/testing/store-contract.js"]]]);

/** Strip a leading `./` so `./dist/x.js` and `dist/x.js` compare alike. */
function normalizePath(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : "";
}

/**
 * Every path an `exports` / `bin` value can resolve to at run time: strings, the values of
 * condition objects (`import` / `require` / `types` / `default` / ...), and every member of
 * an array of conditions.
 *
 * @param {unknown} value an `exports` target or a `bin` target
 * @returns {string[]} normalized, package-relative paths
 */
function collectTargets(value) {
  if (typeof value === "string") return [normalizePath(value)];
  if (Array.isArray(value)) return value.flatMap(collectTargets);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(collectTargets);
  return [];
}

/**
 * The package's entry file: its `main`, defaulting to the conventional `dist/index.js`.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @returns {string} normalized package-relative path
 */
export function entryFile(manifest) {
  const main = normalizePath(manifest.main);
  return main === "" ? ENTRY_FILE : main;
}

/**
 * The package's type declaration file: its `types`, defaulting to `dist/index.d.ts`.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @returns {string} normalized package-relative path
 */
export function typesFile(manifest) {
  const types = normalizePath(manifest.types);
  return types === "" ? TYPES_FILE : types;
}

/**
 * The files the manifest promises beyond its entry and types: every `exports` target and
 * every `bin` target. Those still need a generic check because a subpath can be renamed
 * without the entry moving; the entry / types pair is checked by `inspectPackList` itself,
 * so those two paths are filtered out here to avoid reporting them twice.
 *
 * @param {Record<string, unknown>} manifest parsed package.json contents
 * @returns {string[]} declared paths in declaration order, de-duplicated
 */
export function declaredFiles(manifest) {
  const declared = [];
  const exportsField = manifest.exports;
  if (typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)) {
    for (const target of Object.values(exportsField)) declared.push(...collectTargets(target));
  }
  declared.push(...collectTargets(manifest.bin));
  const generic = new Set([entryFile(manifest), typesFile(manifest)]);
  return [...new Set(declared)].filter((path) => path !== "" && !generic.has(path));
}

/**
 * Check the packed file list of one package.
 * Returns stable, ordered, machine-assertable messages; an empty array means OK.
 *
 * Rules, in the order problems are reported:
 * - `src/` is never packed (the manifest ships `dist/` only);
 * - a `__tests__` segment is never packed;
 * - compiled test output (`*.test.js` / `*.test.d.ts` / `*.test.js.map` /
 *   `*.test.d.ts.map`) is never packed, wherever it sits — a `.test.ts` beside
 *   its source is exactly the case a segment rule cannot see;
 * - the entry and types are present, `dist/` is not empty, and every declared
 *   subpath ships.
 *
 * @param {string[]} files package-relative paths, as reported by `pnpm pack --dry-run --json`
 * @param {string[]} [required] additional paths that must ship (the package's declared
 *   subpaths), checked after the generic rules
 * @param {{ entry?: string, types?: string }} [resolve] the package's own entry / types
 *   paths; omitted means the conventional `dist/index.js` / `dist/index.d.ts`
 * @returns {string[]} problems in fixed check order; empty means OK
 */
export function inspectPackList(files, required = [], resolve = {}) {
  const problems = [];
  for (const file of files) {
    if (file.startsWith(SRC_PREFIX)) problems.push(`unexpected src/: ${file}`);
  }
  for (const file of files) {
    if (file.split("/").includes(TESTS_SEGMENT)) problems.push(`unexpected tests: ${file}`);
  }
  for (const file of files) {
    if (TEST_ARTIFACT.test(file)) problems.push(`test artifact: ${file}`);
  }
  const shipped = new Set(files.filter((file) => !file.endsWith("/")));
  const entry = resolve.entry ?? ENTRY_FILE;
  const types = resolve.types ?? TYPES_FILE;
  if (!shipped.has(entry)) problems.push(`missing entry: ${entry}`);
  if (!shipped.has(types)) problems.push(`missing types: ${types}`);
  // A bare directory entry (`dist/`) is not output: at least one packed file must sit under it.
  if (![...shipped].some((file) => file.startsWith(DIST_PREFIX))) {
    problems.push(`empty dist/: no files under ${DIST_PREFIX}`);
  }
  for (const file of required) {
    if (!shipped.has(file)) problems.push(`missing subpath: ${file}`);
  }
  return problems;
}

/**
 * The JSON document in `pnpm pack --json`'s stdout.
 *
 * A package whose lifecycle scripts print (or whose `prepack` fans out to
 * `pnpm run`, which announces `> name script`) gets that output mixed into the
 * same stream ahead of the document; the report itself is still the last thing
 * pnpm writes, so the first line that opens a top-level object is its start.
 * Kept here rather than in each package: the gate must read the same output a
 * human would, and no pnpm flag currently separates the two streams.
 *
 * @param {string} output raw stdout of `pnpm pack --dry-run --json`
 * @returns {string} the JSON document
 */
function extractPackJson(output) {
  const start = output.search(/^\{$/m);
  if (start === -1) throw new Error(`no JSON object in pack output: ${output.slice(0, 200)}`);
  return output.slice(start);
}

/** The file list pnpm would pack for `name`, or a thrown error with pnpm's stderr. */
function packedFiles(name) {
  const output = execFileSync("pnpm", ["--filter", name, "pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(extractPackJson(output));
  const [entry] = Array.isArray(parsed) ? parsed : [parsed];
  if (!Array.isArray(entry?.files)) throw new Error(`no file list in pack output for ${name}`);
  return entry.files.map((file) => normalizePath(typeof file === "string" ? file : file.path));
}

/** A minimal manifest that is already complete; cases below mutate copies of it. */
const COMPLETE_MANIFEST = {
  name: "@voltojs/fixture",
  version: "0.1.0",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist"],
};

const COMPLETE_FILES = ["package.json", "dist/index.js", "dist/index.d.ts", "dist/agent.js"];

function selfTest() {
  const cases = [
    ["complete pack passes", inspectPackList(COMPLETE_FILES), []],
    [
      "src is rejected",
      inspectPackList([...COMPLETE_FILES, "src/agent.ts"]),
      ["unexpected src/: src/agent.ts"],
    ],
    [
      "tests are rejected",
      inspectPackList([...COMPLETE_FILES, "dist/__tests__/agent.js"]),
      ["unexpected tests: dist/__tests__/agent.js"],
    ],
    [
      "a compiled test next to its source is a test artifact",
      inspectPackList([...COMPLETE_FILES, "dist/git/git.test.js"]),
      ["test artifact: dist/git/git.test.js"],
    ],
    [
      "every compiled test suffix is a test artifact",
      inspectPackList([
        ...COMPLETE_FILES,
        "dist/index.test.js",
        "dist/index.test.d.ts",
        "dist/index.test.js.map",
        "dist/index.test.d.ts.map",
      ]),
      [
        "test artifact: dist/index.test.js",
        "test artifact: dist/index.test.d.ts",
        "test artifact: dist/index.test.js.map",
        "test artifact: dist/index.test.d.ts.map",
      ],
    ],
    [
      "a name that merely contains '.test.' is not a test artifact",
      inspectPackList([...COMPLETE_FILES, "dist/contest.latest.js"]),
      [],
    ],
    [
      "a bare dist directory entry alone is empty output",
      inspectPackList(["package.json", "dist/"]),
      [`missing entry: ${ENTRY_FILE}`, `missing types: ${TYPES_FILE}`, `empty dist/: no files under ${DIST_PREFIX}`],
    ],
    [
      "a declared subpath that is not packed is reported",
      inspectPackList(COMPLETE_FILES, ["dist/testing/store-contract.js"]),
      ["missing subpath: dist/testing/store-contract.js"],
    ],
    ["a complete manifest declares no extra subpaths", declaredFiles(COMPLETE_MANIFEST), []],
    [
      "entry and types default to dist/index.*",
      [entryFile({}), typesFile({})],
      [ENTRY_FILE, TYPES_FILE],
    ],
    [
      "entry and types follow a non-index main/types",
      inspectPackList(["dist/server.js", "dist/actions.d.ts"], [], {
        entry: "dist/server.js",
        types: "dist/actions.d.ts",
      }),
      [],
    ],
    [
      "a package whose own entry is missing is named after that entry",
      inspectPackList(["dist/index.js", "dist/index.d.ts"], [], { entry: "dist/server.js" }),
      ["missing entry: dist/server.js"],
    ],
    [
      "declared subpaths cover exports subpaths and bin targets",
      declaredFiles({
        ...COMPLETE_MANIFEST,
        exports: {
          ".": "./dist/index.js",
          "./sub": { types: "./dist/sub.d.ts", import: "./dist/sub.js" },
        },
        bin: { "fixture-cli": "./dist/cli.js" },
      }).sort(),
      ["dist/cli.js", "dist/sub.d.ts", "dist/sub.js"],
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
  const packages = loadPublishablePackages();
  const failures = [];
  for (const { manifest } of packages) {
    const name = manifest.name;
    const resolve = { entry: entryFile(manifest), types: typesFile(manifest) };
    const required = [...new Set([...declaredFiles(manifest), ...(REQUIRED_FILES.get(name) ?? [])])];
    let files;
    try {
      files = packedFiles(name);
    } catch (error) {
      failures.push(`${name}: pack failed: ${String(error.stderr || error.message).trim()}`);
      console.log(`FAIL ${name}`);
      continue;
    }
    const problems = inspectPackList(files, required, resolve);
    for (const problem of problems) failures.push(`${name}: ${problem}`);
    console.log(`${problems.length === 0 ? "ok" : "FAIL"} ${name}: ${files.length} file(s)`);
    console.log(`  entry ${resolve.entry}`);
    console.log(`  types ${resolve.types}`);
    for (const file of required) console.log(`  ships ${file}`);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`${failures.length} problem(s) in ${packages.length} publishable package(s)`);
    process.exit(1);
  }
  console.log(`PASS: ${packages.length} publishable package(s) pack only built output`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  main(process.argv.slice(2));
}