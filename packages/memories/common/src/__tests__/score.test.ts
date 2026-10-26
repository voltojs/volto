import { describe, it, expect } from "vitest";
import {
  normalizeMemoryText,
  tokenizeMemoryQuery,
  scoreMemoryText,
  DEFAULT_MEMORY_MAX_ENTRIES,
} from "../score.js";

describe("normalizeMemoryText", () => {
  it("normalizes NFKC, lowercases, and collapses whitespace", () => {
    expect(normalizeMemoryText("  Foo\u00A0BAR  ")).toBe("foo bar");
  });

  it("keeps CJK characters intact", () => {
    expect(normalizeMemoryText("记忆系统")).toBe("记忆系统");
  });
});

describe("tokenizeMemoryQuery", () => {
  it("splits ASCII words and keeps CJK as one run", () => {
    expect(tokenizeMemoryQuery("hello world 你好")).toEqual([
      "hello",
      "world",
      "你好",
    ]);
  });

  it("emits 2-char sliding windows for long CJK runs", () => {
    expect(tokenizeMemoryQuery("记忆系统")).toEqual([
      "记忆",
      "忆系",
      "系统",
    ]);
  });

  it("keeps a single CJK character as a single token", () => {
    expect(tokenizeMemoryQuery("记")).toEqual(["记"]);
  });

  it("splits punctuation and collapses whitespace", () => {
    expect(tokenizeMemoryQuery("  foo,bar! ")).toEqual(["foo", "bar"]);
  });
});

describe("scoreMemoryText", () => {
  it("scores a matching token above zero", () => {
    expect(scoreMemoryText("memory", "Memory store")).toBeGreaterThan(0);
  });

  it("returns zero when nothing matches", () => {
    expect(scoreMemoryText("xyz", "Memory store")).toBe(0);
  });

  it("scores an exact normalized substring higher than scattered tokens", () => {
    const substring = scoreMemoryText("memory store", "the memory store is here");
    const scattered = scoreMemoryText(
      "memory store",
      "store of memories, a memory after the store",
    );
    expect(substring).toBeGreaterThan(0);
    expect(scattered).toBeGreaterThan(0);
    expect(substring).toBeGreaterThan(scattered);
  });

  it("caps each query token at 3 counted occurrences", () => {
    const capped = scoreMemoryText("cat", "cat cat cat cat cat");
    const triple = scoreMemoryText("cat", "cat cat cat");
    expect(capped).toBe(triple);
  });

  it("returns zero for an empty query", () => {
    expect(scoreMemoryText("", "anything at all")).toBe(0);
  });
});

describe("DEFAULT_MEMORY_MAX_ENTRIES", () => {
  it("is 5000", () => {
    expect(DEFAULT_MEMORY_MAX_ENTRIES).toBe(5000);
  });

it("tokenizes kana, hangul and astral ideographs as CJK windows", () => {
  // Regression pin: these scripts used to fall outside the CJK run class,
  // so an exact self-match scored 0 and pure-kana/hangul queries never hit.
  expect(scoreMemoryText("こんにちは", "こんにちは")).toBeGreaterThan(0);
  expect(scoreMemoryText("안녕하세요", "안녕하세요")).toBeGreaterThan(0);
  expect(scoreMemoryText("\u{20bb7}野家ホテル", "\u{20bb7}野家ホテル")).toBeGreaterThan(0);
});
});
