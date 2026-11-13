import { test } from "node:test";
import assert from "node:assert/strict";
import { applyManifest, validateManifest } from "../publish-manifest.mjs";

const BASE = {
  name: "@voltojs/x", version: "0.1.0", type: "module",
  main: "./dist/index.js", types: "./dist/index.d.ts",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./package.json": "./package.json",
  },
  files: ["dist", "!dist/**/__tests__"],
  publishConfig: { access: "public" },
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
test("workspace:^ / workspace:~ 允许（跨组 semver 范围）", () => {
  for (const range of ["workspace:^", "workspace:~"]) {
    const ok = { ...BASE, dependencies: { "@voltojs/core": range } };
    assert.deepEqual(validateManifest(ok, "/tmp/x", { strictWorkspace: true }), []);
  }
});
test("缺 files / engines / license 都报告", () => {
  const bad = { ...BASE, files: undefined, engines: undefined, license: undefined };
  assert.equal(validateManifest(bad, "/tmp/x").length, 3);
});
test("publishConfig 缺失时报告", () => {
  const bad = { ...BASE, publishConfig: undefined };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["publishConfig: missing"]);
});
test("publishConfig.access 不是 public 时报告", () => {
  const bad = { ...BASE, publishConfig: { access: "restricted" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["publishConfig.access: not public"]);
});
test("残留 GitHub Packages registry 时报告", () => {
  const bad = { ...BASE, publishConfig: { access: "public", registry: "https://npm.pkg.github.com" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["publishConfig.registry: not https://registry.npmjs.org (remove it or point it at npmjs)"]);
});
test("显式指向 npmjs 的 registry 可以通过", () => {
  const manifest = { ...BASE, publishConfig: { access: "public", registry: "https://registry.npmjs.org" } };
  assert.deepEqual(validateManifest(manifest, "/tmp/x"), []);
});
test("缺 ./package.json self export 时报告", () => {
  const bad = { ...BASE, exports: { ".": "./dist/index.js" } };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["exports../package.json: missing self export"]);
});
test("字符串形式的 exports 折成对象后仍算缺 self export", () => {
  const bad = { ...BASE, exports: "./dist/index.js" };
  assert.deepEqual(validateManifest(bad, "/tmp/x"), ["exports../package.json: missing self export"]);
});
test("applyManifest 幂等地补 self export 并保持原有顺序", () => {
  const once = applyManifest({ ...BASE, exports: { "./sse": "./dist/sse.js" } }, "/tmp/x");
  assert.deepEqual(Object.keys(once.exports), ["./sse", "./package.json"]);
  assert.equal(once.exports["./package.json"], "./package.json");
  assert.deepEqual(applyManifest(once, "/tmp/x"), once);
  assert.deepEqual(validateManifest(once, "/tmp/x"), []);
});
