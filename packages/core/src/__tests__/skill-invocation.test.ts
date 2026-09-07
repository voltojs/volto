import { describe, it, expect } from "vitest";
import { parseSkillInvocation, renderSkillInjection, capSkillInjection } from "../skill-invocation.js";

describe("parseSkillInvocation", () => {
  it("reads a bare slash name on the first line", () => {
    expect(parseSkillInvocation("/commit")).toBe("commit");
  });

  it("reads a slash name followed by prose", () => {
    expect(parseSkillInvocation("/code-review please check this")).toBe("code-review");
  });

  it("only looks at the first line", () => {
    expect(parseSkillInvocation("hello\n/commit")).toBeNull();
  });

  it("rejects non-kebab names", () => {
    expect(parseSkillInvocation("/Commit")).toBeNull();
    expect(parseSkillInvocation("/a_b")).toBeNull();
    expect(parseSkillInvocation("/-lead")).toBeNull();
    expect(parseSkillInvocation("/trail-")).toBeNull();
  });

  it("rejects a path-like slash prefix", () => {
    expect(parseSkillInvocation("/usr/local/bin")).toBeNull();
  });

  it("returns null for ordinary prose", () => {
    expect(parseSkillInvocation("fix the bug")).toBeNull();
    expect(parseSkillInvocation("")).toBeNull();
  });

  it("rejects leading whitespace before slash", () => {
    expect(parseSkillInvocation("  /commit")).toBeNull();
  });

  it("accepts tab as separator after name", () => {
    expect(parseSkillInvocation("/commit\ttab-separated")).toBe("commit");
  });

  it("rejects double slash", () => {
    expect(parseSkillInvocation("//commit")).toBeNull();
  });

  it("rejects slash alone", () => {
    expect(parseSkillInvocation("/")).toBeNull();
  });

  it("handles CRLF line ending without leaking CR into name", () => {
    expect(parseSkillInvocation("/commit\r\nrest of message")).toBe("commit");
  });
});

describe("renderSkillInjection", () => {
  it("renders the name, base directory and body deterministically", () => {
    expect(renderSkillInjection("commit", "/skills/commit", "Do the thing.")).toBe(
      [
        'The user invoked the skill "commit". Its full instructions follow.',
        "Base directory: /skills/commit",
        "Resolve any relative path in the instructions below against that directory.",
        "",
        "Do the thing.",
      ].join("\n"),
    );
  });
});

describe("capSkillInjection (Finding I-1)", () => {
  it("leaves a body under the cap untouched", () => {
    const text = "short body";
    expect(capSkillInjection(text)).toBe(text);
  });

  it("caps an oversized body at the default 64 KiB limit and appends a visible notice", () => {
    const text = "x".repeat(200_000);
    const capped = capSkillInjection(text);
    const bytes = new TextEncoder().encode(capped).length;
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(capped).toContain(`[skill body truncated from ${200_000} to ${64 * 1024} bytes`);
  });

  it("respects a custom byte cap", () => {
    // The cap must comfortably exceed the notice text's own byte length
    // (~110-120 bytes) or there is no room left to bound the body against —
    // the notice is not itself further truncated.
    const text = "y".repeat(1000);
    const capped = capSkillInjection(text, 600);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(600);
    expect(capped).toContain("truncated from 1000 to 600 bytes");
  });

  it("does not split a multi-byte code point at the cap boundary (CJK)", () => {
    // Each "中" is 3 UTF-8 bytes; a naive byte-offset cut can land mid
    // character. 601 is not a multiple of 3, so a byte-unsafe implementation
    // would slice inside a character; there is still ample room past the
    // notice's own byte length for the boundary to actually fall mid-body.
    const text = "中".repeat(1000); // 3000 bytes
    const capped = capSkillInjection(text, 601);
    const bytes = new TextEncoder().encode(capped).length;
    expect(bytes).toBeLessThanOrEqual(601);
    // A split code point would decode to U+FFFD, which would not survive a
    // UTF-8 round trip unchanged.
    expect(Buffer.from(capped, "utf8").toString("utf8")).toBe(capped);
    expect(capped).not.toContain("�");
  });

  it("does not split a surrogate pair at the cap boundary (emoji)", () => {
    // U+1F600 is an astral code point (4 UTF-8 bytes, a surrogate pair in
    // UTF-16). 601 is not a multiple of 4, exercising the same class of bug
    // already fixed twice elsewhere in this repo.
    const text = "\u{1F600}".repeat(500); // 2000 bytes
    const capped = capSkillInjection(text, 601);
    const bytes = new TextEncoder().encode(capped).length;
    expect(bytes).toBeLessThanOrEqual(601);
    expect(Buffer.from(capped, "utf8").toString("utf8")).toBe(capped);
    expect(capped).not.toContain("�");
  });
});
