import { expect, it } from "vitest";
import { resolveCapabilities } from "../capabilities.js";

it("remote 关掉本机专属能力", () => {
  expect(resolveCapabilities({ mode: "remote", browserAutomation: true, lsp: true })).toEqual({
    nativeDialogs: false,
    browserAutomation: true,
    lsp: true,
  });
});

it("local 保留", () => {
  expect(resolveCapabilities({ mode: "local", browserAutomation: false, lsp: false })).toEqual({
    nativeDialogs: true,
    browserAutomation: false,
    lsp: false,
  });
});

it("字段名说明它是什么：桌面浏览器自动化宿主，不是「有浏览器」", () => {
  // The published contract, exactly: a rename that only touches the type
  // would still ship `browser` on the wire.
  const keys = Object.keys(resolveCapabilities({ mode: "local", browserAutomation: false, lsp: false })).sort();
  expect(keys).toEqual(["browserAutomation", "lsp", "nativeDialogs"]);
});

it("browserAutomation 只反映宿主是否真的建起来了，与 mode 无关", () => {
  for (const mode of ["local", "remote"] as const) {
    expect(resolveCapabilities({ mode, browserAutomation: false, lsp: true }).browserAutomation).toBe(false);
    expect(resolveCapabilities({ mode, browserAutomation: true, lsp: true }).browserAutomation).toBe(true);
  }
});
