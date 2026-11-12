import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectPackList } from "../check-pack-contents.mjs";

test("拒绝 src 与测试文件", () => {
  // dist/index.d.ts is included so the fixture only violates the two rules under test.
  const files = ["dist/index.js", "dist/index.d.ts", "src/create-agent.ts", "dist/__tests__/a.js"];
  assert.deepEqual(inspectPackList(files), [
    "unexpected src/: src/create-agent.ts",
    "unexpected tests: dist/__tests__/a.js",
  ]);
});
test("位于 __tests__ 之外的编译测试文件同样被拒绝", () => {
  // The bug this pins: `apps/gateway/src/git/git.test.ts` compiles to
  // `dist/git/git.test.js`, which a `__tests__`-segment rule never sees.
  const files = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/git/git.test.js",
    "dist/git/git.test.d.ts",
    "dist/git/git.test.js.map",
    "dist/git/git.test.d.ts.map",
  ];
  assert.deepEqual(inspectPackList(files), [
    "test artifact: dist/git/git.test.js",
    "test artifact: dist/git/git.test.d.ts",
    "test artifact: dist/git/git.test.js.map",
    "test artifact: dist/git/git.test.d.ts.map",
  ]);
});
test("名字里只是含 .test. 的文件不算测试产物", () => {
  assert.deepEqual(inspectPackList(["dist/index.js", "dist/index.d.ts", "dist/contest.latest.js"]), []);
});
test("要求 dist 里有 js 与 d.ts", () => {
  assert.deepEqual(inspectPackList(["dist/index.js"]), ["missing types: dist/index.d.ts"]);
});
test("dist 里的 js 与 d.ts 齐全时通过", () => {
  assert.deepEqual(inspectPackList(["package.json", "dist/index.js", "dist/index.d.ts"]), []);
});
test("缺入口文件时报告，缺 dist 同时报告缺入口与空 dist", () => {
  assert.deepEqual(inspectPackList(["dist/index.d.ts"]), ["missing entry: dist/index.js"]);
  assert.deepEqual(inspectPackList(["package.json"]), [
    "missing entry: dist/index.js",
    "missing types: dist/index.d.ts",
    "empty dist/: no files under dist/",
  ]);
});
test("dist 只有目录条目时视为空", () => {
  assert.deepEqual(inspectPackList(["package.json", "dist/"]), [
    "missing entry: dist/index.js",
    "missing types: dist/index.d.ts",
    "empty dist/: no files under dist/",
  ]);
});
test("dist 目录条目之外还有文件时不报空", () => {
  assert.deepEqual(inspectPackList(["dist/", "dist/index.js", "dist/index.d.ts"]), []);
});
test("入口与类型按包自己的 main / types 判定，而非硬编码 index", () => {
  const files = ["dist/server.js", "dist/actions.d.ts"];
  assert.deepEqual(inspectPackList(files, [], { entry: "dist/server.js", types: "dist/actions.d.ts" }), []);
  assert.deepEqual(inspectPackList(files, [], { entry: "dist/server.js", types: "dist/index.d.ts" }), [
    "missing types: dist/index.d.ts",
  ]);
});
test("声明的子路径导出缺失时报告", () => {
  assert.deepEqual(
    inspectPackList(["dist/index.js", "dist/index.d.ts"], ["dist/testing/store-contract.js"]),
    ["missing subpath: dist/testing/store-contract.js"],
  );
});