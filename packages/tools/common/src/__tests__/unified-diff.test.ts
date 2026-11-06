import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, MAX_DIFF_CHARS } from "../unified-diff.js";

function diffLines(diff: string): string[] {
  return diff === "" ? [] : diff.split("\n");
}

describe("computeUnifiedDiff", () => {
  it("returns an empty body when the text is unchanged", () => {
    const result = computeUnifiedDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(result).toEqual({ diff: "", additions: 0, deletions: 0, truncated: false });
  });

  it("ignores a trailing-newline-only difference", () => {
    const result = computeUnifiedDiff("a\nb\n", "a\nb");
    expect(result.diff).toBe("");
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  it("reports one replaced line with git-style counting", () => {
    const result = computeUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(diffLines(result.diff)).toEqual(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]);
    expect(result).toMatchObject({ additions: 1, deletions: 1, truncated: false });
  });

  it("marks a created file as a pure addition starting at -0,0", () => {
    const result = computeUnifiedDiff("", "x\ny\n");
    expect(diffLines(result.diff)).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y"]);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
  });

  it("marks an emptied file as a pure deletion", () => {
    const result = computeUnifiedDiff("x\ny\n", "");
    expect(diffLines(result.diff)).toEqual(["@@ -1,2 +0,0 @@", "-x", "-y"]);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(2);
  });

  it("keeps three context lines and merges nearby hunks", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].join("\n");
    const after = before.replace("2", "two").replace("6", "six");
    const result = computeUnifiedDiff(`${before}\n`, `${after}\n`);
    const lines = diffLines(result.diff);
    // Two changes four lines apart merge into one hunk: their contexts touch.
    expect(lines.filter((line) => line.startsWith("@@"))).toHaveLength(1);
    expect(lines).toContain("-2");
    expect(lines).toContain("+two");
    expect(lines).toContain("-6");
    expect(lines).toContain("+six");
    expect(lines).toContain(" 4");
    expect(lines).toContain(" 8");
  });

  it("splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line1", "one").replace("line38", "many");
    const result = computeUnifiedDiff(`${before}\n`, `${after}\n`);
    expect(diffLines(result.diff).filter((line) => line.startsWith("@@"))).toHaveLength(2);
  });

  it("handles many edits without losing a line", () => {
    const before = Array.from({ length: 120 }, (_, i) => `l${i}`).join("\n");
    const after = Array.from({ length: 120 }, (_, i) =>
      i % 7 === 0 ? `changed${i}` : `l${i}`,
    ).join("\n");
    const result = computeUnifiedDiff(`${before}\n`, `${after}\n`);
    expect(result.additions).toBe(18);
    expect(result.deletions).toBe(18);
  });

  it("degrades to a replacement hunk rather than exploding on a wholesale rewrite", () => {
    const before = Array.from({ length: 700 }, (_, i) => `old${i}`).join("\n");
    const after = Array.from({ length: 700 }, (_, i) => `new${i}`).join("\n");
    const result = computeUnifiedDiff(before, after);
    expect(result.additions).toBe(700);
    expect(result.deletions).toBe(700);
    expect(result.diff.startsWith("@@ ")).toBe(true);
  });

  it("declares truncation instead of emitting an oversized body", () => {
    const before = "";
    const after = Array.from({ length: 4000 }, (_, i) => `row ${i} ${"x".repeat(20)}`).join("\n");
    const result = computeUnifiedDiff(before, after);
    expect(result.truncated).toBe(true);
    expect(result.diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
    // The cut lands on a line boundary, so the last line is still parseable.
    expect(result.diff.endsWith("\n")).toBe(false);
    expect(result.diff.split("\n").at(-1)!.startsWith("+")).toBe(true);
  });
});