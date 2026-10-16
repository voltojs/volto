import { describe, it, expect } from "vitest";
import { decideSpill, renderSpillReference } from "../tool-result-spill.js";

describe("decideSpill", () => {
  it("F-181 passes through at or below the threshold", () => {
    const r = decideSpill("x".repeat(16_000), { thresholdChars: 16_000, headChars: 2_000 });
    expect(r.spill).toBe(false);
    expect(r.keptHead).toBeUndefined();
    expect(r.fullText).toBeUndefined();
  });
  it("F-181 spills above the threshold with exact head and full text", () => {
    const text = "a".repeat(16_001);
    const r = decideSpill(text, { thresholdChars: 16_000, headChars: 2_000 });
    expect(r.spill).toBe(true);
    expect(r.keptHead).toBe("a".repeat(2_000));
    expect(r.fullText).toBe(text); // full text BEFORE head slicing
  });
  it("F-181 slices the head by code point, never splitting a surrogate pair", () => {
    const emoji = "😀"; // one code point, two UTF-16 units
    // 41 code points: strictly above thresholdChars (40) under code-point
    // counting (spec D3) — a 40-cp text would sit AT the threshold and pass through.
    const text = emoji.repeat(31) + "x".repeat(10);
    const r = decideSpill(text, { thresholdChars: 40, headChars: 31 });
    expect(r.spill).toBe(true);
    expect(r.keptHead!.length).toBeGreaterThanOrEqual(31); // no lone surrogate
    expect([...r.keptHead!].length).toBe(31);
    expect(r.fullText).toBe(text);
  });
  it("F-181 is deterministic: same input, byte-identical output", () => {
    const opts = { thresholdChars: 100, headChars: 10 };
    const a = decideSpill("y".repeat(250), opts);
    const b = decideSpill("y".repeat(250), opts);
    expect(a).toEqual(b);
  });
});

describe("renderSpillReference", () => {
  it("F-181 renders the exact spec format with leading blank line", () => {
    expect(renderSpillReference({ relativePath: ".volto/spill/s1/c1.txt", totalChars: 16_001 }))
      .toBe("\n\n[output truncated: 16001 chars total; full output saved to .volto/spill/s1/c1.txt — read it with read_file if needed]");
  });
  it("F-181 carries both T10 shared marker substrings", () => {
    const s = renderSpillReference({ relativePath: "p", totalChars: 1 });
    expect(s).toContain("output truncated:");
    expect(s).toContain("full output saved to");
  });
});
