import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_SCRIPT,
  formatSnapshot,
  type SnapshotNode,
} from "../snapshot.js";

const nodes: SnapshotNode[] = [
  { depth: 0, role: "heading", name: "Sign in", level: 1 },
  { depth: 0, role: "textbox", name: "Email", ref: "e3" },
  { depth: 1, role: "text", text: "Use your work address" },
  { depth: 0, role: "button", name: "Save", ref: "e7", disabled: true },
];

describe("formatSnapshot", () => {
  it("renders roles, names, refs, and indentation in DOM order", () => {
    expect(formatSnapshot(nodes, { maxChars: 8000 })).toEqual({
      text: [
        '- heading "Sign in" [level=1]',
        '- textbox "Email" [ref=e3]',
        "  - text: Use your work address",
        '- button "Save" [ref=e7] [disabled]',
      ].join("\n"),
      truncated: false,
    });
  });

  it("renders text-only nodes without roles or refs", () => {
    expect(formatSnapshot(nodes, { maxChars: 8000, textOnly: true })).toEqual({
      text: "Use your work address",
      truncated: false,
    });
  });

  it("escapes quotes and collapses newlines in names and text", () => {
    const result = formatSnapshot(
      [
        { depth: 0, role: "button", name: 'Say "hi"\nthere', ref: "e1" },
        { depth: 1, role: "text", text: "line one\nline two" },
      ],
      { maxChars: 8000 },
    );
    expect(result.text).toContain('- button "Say \\"hi\\" there" [ref=e1]');
    expect(result.text).toContain("  - text: line one line two");
  });

  it("truncates to maxChars and marks the result", () => {
    const result = formatSnapshot(
      [{ depth: 0, role: "text", text: "x".repeat(500) }],
      { maxChars: 100 },
    );
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text.endsWith("... [truncated]")).toBe(true);
  });

  it("returns an empty body for no nodes", () => {
    expect(formatSnapshot([], { maxChars: 8000 })).toEqual({
      text: "",
      truncated: false,
    });
  });
});

describe("SNAPSHOT_SCRIPT", () => {
  it("is a syntactically valid page expression", () => {
    expect(SNAPSHOT_SCRIPT.trim().startsWith("(()")).toBe(true);
    expect(() => new Function(`return ${SNAPSHOT_SCRIPT}`)).not.toThrow();
  });
});