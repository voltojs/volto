import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STREAM_DENSITY, readStreamDensity, writeStreamDensity } from "../stream-density";

// Plain `.ts` specs run in the node environment — no `window`. Install the
// smallest localStorage stand-in the module actually touches.
const backing = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
  },
};

describe("stream density preference", () => {
  beforeEach(() => backing.clear());

  it("defaults to detailed when unset or corrupt", () => {
    expect(readStreamDensity()).toBe(DEFAULT_STREAM_DENSITY);
    backing.set("volto.stream-density.v1", "verbose");
    expect(readStreamDensity()).toBe(DEFAULT_STREAM_DENSITY);
  });

  it("round-trips a valid value", () => {
    writeStreamDensity("concise");
    expect(readStreamDensity()).toBe("concise");
    expect(backing.get("volto.stream-density.v1")).toBe("concise");
  });
});
