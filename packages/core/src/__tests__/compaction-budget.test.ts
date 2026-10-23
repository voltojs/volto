import { describe, it, expect } from "vitest";
import {
  deriveCompactionMaxTokens,
  DEFAULT_COMPACTION_MAX_TOKENS,
} from "../compaction-budget.js";

describe("deriveCompactionMaxTokens", () => {
  it("falls back to the fixed 60k only when the window is unknown", () => {
    expect(deriveCompactionMaxTokens()).toBe(DEFAULT_COMPACTION_MAX_TOKENS);
    expect(deriveCompactionMaxTokens({ contextWindow: undefined })).toBe(60_000);
    expect(deriveCompactionMaxTokens({ contextWindow: 0 })).toBe(60_000);
    expect(deriveCompactionMaxTokens({ contextWindow: Number.NaN })).toBe(60_000);
  });

  it("scales with the window, reserving the output cap", () => {
    // 1M window, 128k output → floor((1_048_576 − 131_072) × 0.6)
    expect(deriveCompactionMaxTokens({ contextWindow: 1_048_576, maxOutputTokens: 131_072 })).toBe(
      550_502,
    );
    // 128k window, 16k output → floor(112_000 × 0.6)
    expect(deriveCompactionMaxTokens({ contextWindow: 128_000, maxOutputTokens: 16_000 })).toBe(
      67_200,
    );
    // Unknown output cap → reserve nothing.
    expect(deriveCompactionMaxTokens({ contextWindow: 100_000 })).toBe(60_000);
  });

  it("honours a valid ratio override and ignores an invalid one", () => {
    expect(deriveCompactionMaxTokens({ contextWindow: 100_000, ratio: 0.8 })).toBe(80_000);
    expect(deriveCompactionMaxTokens({ contextWindow: 100_000, ratio: 0 })).toBe(60_000);
    expect(deriveCompactionMaxTokens({ contextWindow: 100_000, ratio: 1.5 })).toBe(60_000);
  });

  it("never exceeds the usable window and never returns 0", () => {
    expect(deriveCompactionMaxTokens({ contextWindow: 1_000, maxOutputTokens: 5_000 })).toBe(1);
  });
});
