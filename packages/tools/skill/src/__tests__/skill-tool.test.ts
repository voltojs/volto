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
    expect(new TextEncoder().encode(result.modelContent).length).toBeLessThanOrEqual(64 * 1024);
  });
});
