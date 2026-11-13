import { describe, it, expect } from "vitest";
import { createSkillTool, CAP_SKILL } from "../index.js";

describe("createSkillTool", () => {
  it("declares the skill:load capability and a name-only schema", async () => {
    const tool = createSkillTool(async () => undefined);
    expect(tool.definition.name).toBe("skill");
    expect(tool.definition.requires).toContain(CAP_SKILL);
    expect(CAP_SKILL).toBe("skill:load");
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    const parsed = tool.definition.inputSchema as { required?: string[] };
    expect(parsed.required).toEqual(["name"]);
    const rejected = await tool.handler({});
    expect(rejected.isError).toBe(true);
  });

  it("returns the loaded body as modelContent", async () => {
    const tool = createSkillTool(async (name) =>
      name === "alpha" ? { body: "ALPHA-BODY", baseDir: "/skills/alpha" } : undefined,
    );
    const result = await tool.handler({ name: "alpha" });
    expect((result as { modelContent: string }).modelContent).toContain("ALPHA-BODY");
    expect((result as { modelContent: string }).modelContent).toContain("Base directory: /skills/alpha");
  });

  it("returns an error result for unknown or non-invocable skills", async () => {
    const tool = createSkillTool(async () => undefined);
    const result = await tool.handler({ name: "nope" });
    expect(result).toMatchObject({ isError: true });
    expect((result as { modelContent: string }).modelContent).toContain("nope");
  });

  it("returns an error result when the loader throws", async () => {
    const tool = createSkillTool(async () => {
      throw new Error("registry exploded");
    });
    const result = await tool.handler({ name: "alpha" });
    expect(result).toMatchObject({ isError: true });
    expect((result as { modelContent: string }).modelContent).toContain("registry exploded");
  });

  it("truncates bodies over the 64KiB cap with a visible notice", async () => {
    const cap = 64 * 1024;
    const originalBytes = cap + 16 * 1024;
    const bigBody = "A".repeat(originalBytes);
    const tool = createSkillTool(async () => ({ body: bigBody, baseDir: "/skills/big" }));

    const result = await tool.handler({ name: "big" });
    const content = (result as { modelContent: string }).modelContent;

    expect(result).not.toMatchObject({ isError: true });
    expect(content).toContain("truncated");
    // The visible head of the body survives truncation.
    expect(content).toContain(bigBody.slice(0, 128));
    // The rendered result (header + body + notice) stays within the cap.
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(cap);
  });

  it("renders the base directory ahead of the body", async () => {
    const tool = createSkillTool(async () => ({
      body: "Read references/palette.md for the values.",
      baseDir: "/home/u/.agents/skills/dataviz",
    }));
    const result = await tool.handler({ name: "dataviz" });
    expect(result.modelContent).toBe(
      [
        "Skill: dataviz",
        "Base directory: /home/u/.agents/skills/dataviz",
        "Resolve any relative path in the instructions below against that directory.",
        "",
        "Read references/palette.md for the values.",
      ].join("\n"),
    );
    expect(result.displayMetadata?.["baseDir"]).toBe("/home/u/.agents/skills/dataviz");
  });

  it("counts the header against the body cap", async () => {
    const tool = createSkillTool(async () => ({
      body: "x".repeat(70 * 1024),
      baseDir: "/skills/big",
    }));
    const result = await tool.handler({ name: "big" });
    // Skill results are always textual; cast past the widened string | blocks union.
    const content = (result as { modelContent: string }).modelContent;
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("caps multi-byte bodies at the byte limit even when the cut lands mid-character", async () => {
    // Each "你" is a 3-byte UTF-8 sequence. With this repeat count the naive
    // cut point (a fixed byte offset) lands inside one of these sequences,
    // not on a character boundary — the regression this test guards against.
    const tool = createSkillTool(async () => ({
      body: "你".repeat(25 * 1000),
      baseDir: "/skills/big",
    }));
    const result = await tool.handler({ name: "big" });
    const content = (result as { modelContent: string }).modelContent;

    const encodedLength = new TextEncoder().encode(content).length;
    expect(encodedLength).toBeLessThanOrEqual(64 * 1024);
    // A mid-character cut decodes to U+FFFD, which would re-encode 2 bytes
    // longer than the single incomplete byte it replaced — that overshoot
    // must never survive into the returned content.
    expect(content).not.toContain("�");
  });

  it("caps emoji bodies (4-byte UTF-8 sequences) at the byte limit", async () => {
    const tool = createSkillTool(async () => ({
      body: "\u{1F600}".repeat(20 * 1000),
      baseDir: "/skills/big",
    }));
    const result = await tool.handler({ name: "big" });
    const content = (result as { modelContent: string }).modelContent;

    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(64 * 1024);
    expect(content).not.toContain("�");
  });
});
