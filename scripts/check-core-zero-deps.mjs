#!/usr/bin/env node
// CI script: assert @volto/core has zero runtime and peer dependencies

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "../packages/core/package.json");

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
} catch (err) {
  console.error(`Failed to read ${pkgPath}:`, err.message);
  process.exit(1);
}

const deps = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
const peerDeps = pkg.peerDependencies ? Object.keys(pkg.peerDependencies) : [];

if (deps.length > 0) {
  console.error(`FAIL: @volto/core has runtime dependencies: ${deps.join(", ")}`);
  console.error("The core package must have zero runtime dependencies.");
  process.exit(1);
}

if (peerDeps.length > 0) {
  console.error(`FAIL: @volto/core has peer dependencies: ${peerDeps.join(", ")}`);
  console.error("The core package must have zero peer dependencies.");
  process.exit(1);
}

console.log("PASS: @volto/core has zero dependencies (runtime + peer).");
process.exit(0);
