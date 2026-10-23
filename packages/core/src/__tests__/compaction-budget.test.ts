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

  it("scales with the window and reserves output plus headroom", () => {
    // 1M window, 131k output, 65,536 headroom:
    // min(floor(1_048_576 × 0.8), 1_048_576 − 131_072 − 65_536)
    expect(deriveCompactionMaxTokens({ contextWindow: 1_048_576, maxOutputTokens: 131_072 })).toBe(
      838_860,
    );
    // 128k window, 16k output: min(102,400, 46,464)
    expect(deriveCompactionMaxTokens({ contextWindow: 128_000, maxOutputTokens: 16_000 })).toBe(
      46_464,
    );
    // Unknown output cap still reserves headroom.
    expect(deriveCompactionMaxTokens({ contextWindow: 100_000 })).toBe(34_464);
  });

  it("honours a valid ratio override and ignores an invalid one", () => {
    expect(deriveCompactionMaxTokens({ contextWindow: 1_048_576, ratio: 0.5 })).toBe(524_288);
    expect(deriveCompactionMaxTokens({ contextWindow: 1_048_576, ratio: 0 })).toBe(838_860);
    expect(deriveCompactionMaxTokens({ contextWindow: 1_048_576, ratio: 1.5 })).toBe(838_860);
  });

  it("throws when output plus headroom exhausts the window", () => {
    expect(() =>
      deriveCompactionMaxTokens({ contextWindow: 100_000, maxOutputTokens: 50_000 }),
    ).toThrow(/compaction budget exhausted/);
    expect(() => deriveCompactionMaxTokens({ contextWindow: 1_000, maxOutputTokens: 5_000 })).toThrow(
      /compaction budget exhausted/,
    );
  });
});
