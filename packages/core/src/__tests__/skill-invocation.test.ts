import { describe, it, expect } from "vitest";
import { parseSkillInvocation, renderSkillInjection } from "../skill-invocation.js";

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
