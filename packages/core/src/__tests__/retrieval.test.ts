import { describe, it, expect } from "vitest";
import { computeRAGInjectionIndex, buildRAGMessage } from "../retrieval.js";

describe("computeRAGInjectionIndex", () => {
  it("should inject after the last cache breakpoint", () => {
    const index = computeRAGInjectionIndex([0, 3], 10);
    expect(index).toBe(4); // after breakpoint 3
  });

  it("should clamp to totalMessages", () => {
    const index = computeRAGInjectionIndex([0, 9], 10);
    expect(index).toBe(10); // clamped to totalMessages
  });

  it("should return 0 when no breakpoints", () => {
    const index = computeRAGInjectionIndex([], 10);
    expect(index).toBe(0);
  });
});

describe("buildRAGMessage", () => {
  it("should format fragments with numbered blocks", () => {
    const msg = buildRAGMessage(["fact one", "fact two"]);
    expect(msg).toContain("# Retrieved Context");
    expect(msg).toContain("[1] fact one");
    expect(msg).toContain("[2] fact two");
  });

  it("should return empty string for empty fragments", () => {
    expect(buildRAGMessage([])).toBe("");
  });
});
