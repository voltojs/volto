import { describe, it, expect } from "vitest";
import { parsePageSpec } from "../page-spec.js";

describe("parsePageSpec", () => {
  it("parses a single page", () => {
    expect(parsePageSpec("3")).toEqual([3]);
  });

  it("parses a comma-separated list", () => {
    expect(parsePageSpec("1,3,5")).toEqual([1, 3, 5]);
  });

  it("parses inclusive ranges", () => {
    expect(parsePageSpec("2-4")).toEqual([2, 3, 4]);
  });

  it("mixes lists and ranges, preserving spec order", () => {
    expect(parsePageSpec("5, 1-3, 7")).toEqual([5, 1, 2, 3, 7]);
  });

  it("rejects zero, negatives, and garbage instead of guessing", () => {
    expect(parsePageSpec("0")).toBeNull();
    expect(parsePageSpec("-1")).toBeNull();
    expect(parsePageSpec("1;x")).toBeNull();
    expect(parsePageSpec("")).toBeNull();
    expect(parsePageSpec("3-1")).toBeNull();
    expect(parsePageSpec("1,2,")).toBeNull();
  });
});
