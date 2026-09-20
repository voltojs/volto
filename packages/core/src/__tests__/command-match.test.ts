import { describe, it, expect } from "vitest";
import { tokenizeCommand, matchesCommandPrefix, isMatchableCommandToken } from "../command-match.js";

describe("tokenizeCommand", () => {
  it("splits a plain command on whitespace", () => {
    expect(tokenizeCommand("pnpm test --filter @volto/core")).toEqual([
      "pnpm",
      "test",
      "--filter",
      "@volto/core",
    ]);
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(tokenizeCommand("  pnpm   test  ")).toEqual(["pnpm", "test"]);
  });

  it("treats quotes as token delimiters only", () => {
    expect(tokenizeCommand("'pnpm' test")).toEqual(["pnpm", "test"]);
    expect(tokenizeCommand('"pnpm" test')).toEqual(["pnpm", "test"]);
    expect(tokenizeCommand("git commit -m 'a b'")).toEqual(["git", "commit", "-m", "a b"]);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace only"],
    ["pnpm test; rm -rf ~", "semicolon"],
    ["pnpm test && rm -rf ~", "and-and"],
    ["pnpm test | tee log", "pipe"],
    ["pnpm test > out", "redirect"],
    ["pnpm test < in", "input redirect"],
    ["pnpm test $(date)", "command substitution"],
    ["pnpm test `date`", "backticks"],
    ["FOO=1 pnpm test", "leading assignment"],
    ["pnpm test ~/x", "tilde"],
    ["pnpm test *", "glob star"],
    ["pnpm te\\st", "backslash escape"],
    ["pnpm test\nrm -rf ~", "internal newline"],
    ["pnpm 'test", "unterminated quote"],
    ["pnpm \"$X\" test", "expansion inside quotes"],
    ["pnpm 'a`b' test", "backtick inside quotes"],
    ["pnpm 'a\\b' test", "backslash inside quotes"],
  ])("disqualifies %j (%s)", (command) => {
    expect(tokenizeCommand(command)).toBeNull();
  });
});

describe("matchesCommandPrefix", () => {
  it("matches an argv prefix at token boundaries", () => {
    expect(matchesCommandPrefix("pnpm test", ["pnpm", "test"])).toBe(true);
    expect(matchesCommandPrefix("pnpm test --filter x", ["pnpm", "test"])).toBe(true);
    expect(matchesCommandPrefix("pnpm   test", ["pnpm", "test"])).toBe(true);
    expect(matchesCommandPrefix("'pnpm' test", ["pnpm", "test"])).toBe(true);
  });

  it("does not match a longer token that merely starts the same", () => {
    expect(matchesCommandPrefix("pnpm test2", ["pnpm", "test"])).toBe(false);
    expect(matchesCommandPrefix("pnpm testing", ["pnpm", "test"])).toBe(false);
  });

  it("never matches a disqualified command", () => {
    expect(matchesCommandPrefix("pnpm test; rm -rf ~", ["pnpm", "test"])).toBe(false);
    expect(matchesCommandPrefix("FOO=1 pnpm test", ["pnpm", "test"])).toBe(false);
  });

  it("never matches a shorter command than the prefix", () => {
    expect(matchesCommandPrefix("pnpm", ["pnpm", "test"])).toBe(false);
  });

  it("never matches an empty prefix", () => {
    expect(matchesCommandPrefix("pnpm test", [])).toBe(false);
  });

  it("does not interpret `=` in a non-leading token as an assignment", () => {
    expect(matchesCommandPrefix("pnpm test --foo=bar", ["pnpm", "test"])).toBe(true);
  });
});

describe("isMatchableCommandToken", () => {
  it("accepts ordinary argv tokens", () => {
    expect(isMatchableCommandToken("pnpm")).toBe(true);
    expect(isMatchableCommandToken("--filter")).toBe(true);
    expect(isMatchableCommandToken("@volto/core")).toBe(true);
    expect(isMatchableCommandToken("a=b")).toBe(true);
  });

  it("rejects anything that could never appear in a rule-matched token", () => {
    for (const token of ["", " ", "a b", "test*", "a|b", "~", "a$b", "x;y", "a\\b", "o'brien"]) {
      expect(isMatchableCommandToken(token), JSON.stringify(token)).toBe(false);
    }
  });
});
