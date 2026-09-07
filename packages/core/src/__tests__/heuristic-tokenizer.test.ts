import { describe, it, expect } from "vitest";
import { createHeuristicTokenizer } from "../heuristic-tokenizer.js";
import { createCharTokenizer } from "../testing/char-tokenizer.js";

describe("createHeuristicTokenizer", () => {
  const tokenizer = createHeuristicTokenizer();

  it("counts zero for empty text and at least one otherwise", () => {
    expect(tokenizer.count("")).toBe(0);
    expect(tokenizer.count("a")).toBe(1);
  });

  it("rounds up at four characters per token", () => {
    expect(tokenizer.count("abcd")).toBe(1);
    expect(tokenizer.count("abcde")).toBe(2);
  });

  it("honours a custom density", () => {
    expect(createHeuristicTokenizer(2).count("abcd")).toBe(2);
  });

  it("agrees with the testing char tokenizer, which now delegates to it", () => {
    for (const sample of ["", "a", "hello world", "中文内容测试", "x".repeat(1000)]) {
      expect(createCharTokenizer().count(sample)).toBe(tokenizer.count(sample));
    }
  });
});
