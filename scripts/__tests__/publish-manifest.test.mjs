import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../publish-manifest.mjs";

const BASE = {
  name: "@volto/x", version: "0.1.0", type: "module",
  main: "./dist/index.js", types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "!dist/**/__tests__"],
  publishConfig: { access: "public" },
  engines: { node: ">=22" }, license: "MIT",
  repository: { type: "git", url: "git+https://example.com/volto.git" },
  dependencies: { "@volto/core": "0.1.0" },
};

test("完整清单无问题", () => {
  assert.deepEqual(validateManifest(BASE, "/tmp/x"), []);
});
test("workspace:* 未替换时报告", () => {
  const bad = { ...BASE, dependencies: { "@volto/core": "workspace:*" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x", { strictWorkspace: true }), ["dependencies.@volto/core: workspace protocol left"]);
});
test("缺 files / engines / license 都报告", () => {
  const bad = { ...BASE, files: undefined, engines: undefined, license: undefined };
  assert.equal(validateManifest(bad, "/tmp/x").length, 3);
});
