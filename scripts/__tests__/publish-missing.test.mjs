import { test } from "node:test";
import assert from "node:assert/strict";
import { sortByDependencies } from "../publish-missing.mjs";

const pkg = (name, dependencies = {}) => ({ manifest: { name, dependencies } });

test("dependencies are published before dependents", () => {
  const ordered = sortByDependencies([
    pkg("@voltojs/sdk", { "@voltojs/tools": "workspace:^", "@voltojs/stores": "workspace:^" }),
    pkg("@voltojs/tools"),
    pkg("@voltojs/stores"),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.manifest.name), [
    "@voltojs/stores",
    "@voltojs/tools",
    "@voltojs/sdk",
  ]);
});

test("cycles are rejected", () => {
  assert.throws(() => sortByDependencies([pkg("a", { b: "1" }), pkg("b", { a: "1" })]), /cyclic/);
});
