import { describe, it, expect } from "vitest";
import { createHeuristicTokenizer } from "../heuristic-tokenizer.js";
import { createCharTokenizer } from "../testing/char-tokenizer.js";

describe("createHeuristicTokenizer", () => {
  const tokenizer = createHeuristicTokenizer();

  it("counts zero for empty text and at least one otherwise", () => {
    expect(tokenizer.count("")).toBe(0);
    expect(tokenizer.count("a")).toBe(1);
  });

  it("rounds up at four UTF-8 bytes per token", () => {
    expect(tokenizer.count("abcd")).toBe(1);
    expect(tokenizer.count("abcde")).toBe(2);
    expect(tokenizer.count("中文")).toBe(2); // 6 bytes
    expect(tokenizer.count("😀")).toBe(1); // 4 bytes
  });

  it("honours a custom density", () => {
    expect(createHeuristicTokenizer(2).count("abcd")).toBe(2);
    expect(createHeuristicTokenizer(2).count("中文")).toBe(3); // 6 bytes / 2
  });

  it("keeps the testing char tokenizer on UTF-16 code units", () => {
    expect(createCharTokenizer(1).count("中文")).toBe(2);
    expect(createCharTokenizer(1).count("😀")).toBe(2); // surrogate pair
    expect(createCharTokenizer(4).count("abcd")).toBe(1);
  });
});
