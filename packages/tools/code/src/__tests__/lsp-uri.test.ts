import { describe, expect, it } from "vitest";
import { fileToUri, uriToFile } from "../lsp-uri.js";

describe("fileToUri", () => {
  it("encodes a plain path", () => {
    expect(fileToUri("/tmp/a/b.ts")).toBe("file:///tmp/a/b.ts");
  });

  it("percent-encodes spaces, not the path separators", () => {
    expect(fileToUri("/tmp/a b/c.ts")).toBe("file:///tmp/a%20b/c.ts");
  });

  it("percent-encodes non-ASCII as UTF-8 octets", () => {
    expect(fileToUri("/tmp/中文/a.ts")).toBe("file:///tmp/%E4%B8%AD%E6%96%87/a.ts");
  });

  it("refuses a relative path instead of guessing a root", () => {
    expect(() => fileToUri("src/a.ts")).toThrow(/absolute path/);
  });
});

describe("uriToFile", () => {
  it("decodes a plain URI", () => {
    expect(uriToFile("file:///tmp/a/b.ts")).toBe("/tmp/a/b.ts");
  });

  it("decodes percent-encoded octets", () => {
    expect(uriToFile("file:///tmp/a%20b.ts")).toBe("/tmp/a b.ts");
    expect(uriToFile("file:///tmp/%E4%B8%AD%E6%96%87/a%20b.ts")).toBe("/tmp/中文/a b.ts");
  });

  it("ignores an authority and query/fragment", () => {
    expect(uriToFile("file://localhost/tmp/a.ts")).toBe("/tmp/a.ts");
    expect(uriToFile("file:///tmp/a.ts?line=3#L3")).toBe("/tmp/a.ts");
  });

  it("rejects a non-file scheme", () => {
    expect(() => uriToFile("https://example.com/a.ts")).toThrow(/file:\/\//);
  });
});

describe("round trip", () => {
  const paths = [
    "/tmp/a.ts",
    "/tmp/a b/c.ts",
    "/tmp/中文/文件.ts",
    "/tmp/100%25done/x.ts",
    "/tmp/plus+and'quote/a.ts",
    "/Users/leo.zheng/Documents/github workspace/volto/packages/core/src/index.ts",
  ];

  it("uriToFile(fileToUri(p)) === p", () => {
    for (const path of paths) {
      expect(uriToFile(fileToUri(path))).toBe(path);
    }
  });
});
