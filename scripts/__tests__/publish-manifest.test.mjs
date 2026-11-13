import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../publish-manifest.mjs";

const BASE = {
  name: "@voltojs/x", version: "0.1.0", type: "module",
  main: "./dist/index.js", types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "!dist/**/__tests__"],
  publishConfig: { registry: "https://npm.pkg.github.com" },
  engines: { node: ">=22" }, license: "MIT",
  repository: { type: "git", url: "git+https://example.com/volto.git" },
  dependencies: { "@voltojs/core": "0.1.0" },
};

test("完整清单无问题", () => {
  assert.deepEqual(validateManifest(BASE, "/tmp/x"), []);
});
test("workspace:* 未替换时报告", () => {
  const bad = { ...BASE, dependencies: { "@voltojs/core": "workspace:*" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x", { strictWorkspace: true }), ["dependencies.@voltojs/core: workspace protocol left"]);
});
test("缺 files / engines / license 都报告", () => {
  const bad = { ...BASE, files: undefined, engines: undefined, license: undefined };
  assert.equal(validateManifest(bad, "/tmp/x").length, 3);
});
test("publishConfig 缺 registry 时报告", () => {
  const bad = { ...BASE, publishConfig: undefined };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["publishConfig.registry: not https://npm.pkg.github.com"]);
});
test("publishConfig.registry 指向其它仓库时报告", () => {
  const bad = { ...BASE, publishConfig: { registry: "https://registry.npmjs.org" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["publishConfig.registry: not https://npm.pkg.github.com"]);
});
test("publishConfig 里的 access 不再被检查", () => {
  const manifest = { ...BASE, publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" } };
  assert.deepEqual(validateManifest(manifest, "/tmp/x"), []);
});
