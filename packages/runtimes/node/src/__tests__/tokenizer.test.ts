import { describe, it, expect } from "vitest";
import { createNodeTokenizer } from "../tokenizer.js";

describe("createNodeTokenizer", () => {
  it("returns 0 for an empty string", () => {
    expect(createNodeTokenizer().count("")).toBe(0);
  });

  it("estimates ceil(len/4) with the default ratio", () => {
    const tok = createNodeTokenizer();
    expect(tok.count("abcd")).toBe(1); // 4/4
    expect(tok.count("abcde")).toBe(2); // ceil(5/4)
    expect(tok.count("a".repeat(40))).toBe(10);
  });

  it("floors any non-empty input to at least 1 token", () => {
    expect(createNodeTokenizer().count("a")).toBe(1);
  });

  it("honors a custom chars-per-token ratio", () => {
    const tok = createNodeTokenizer(2);
    expect(tok.count("abcd")).toBe(2); // 4/2
    expect(tok.count("abc")).toBe(2); // ceil(3/2)
  });
});
