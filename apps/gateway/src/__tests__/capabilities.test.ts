import { expect, it } from "vitest";
import { resolveCapabilities } from "../capabilities.js";

it("remote 关掉本机专属能力", () => {
  expect(resolveCapabilities({ mode: "remote", browser: true, lsp: true })).toEqual({ nativeDialogs: false, browser: true, lsp: true });
});
it("local 保留", () => {
  expect(resolveCapabilities({ mode: "local", browser: false, lsp: false })).toEqual({ nativeDialogs: true, browser: false, lsp: false });
});