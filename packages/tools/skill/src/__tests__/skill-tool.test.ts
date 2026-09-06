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
    const tool = createSkillTool(async (name) => (name === "alpha" ? "ALPHA-BODY" : undefined));
    const result = await tool.handler({ name: "alpha" });
    expect(result).toEqual({ modelContent: "ALPHA-BODY" });
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
    const tool = createSkillTool(async () => bigBody);

    const result = await tool.handler({ name: "big" });
    const content = (result as { modelContent: string }).modelContent;

    expect(result).not.toMatchObject({ isError: true });
    expect(content).toContain("truncated");
    // The visible head of the body survives truncation.
    expect(content).toContain(bigBody.slice(0, 128));
    // Byte length stays within the cap plus the fixed notice line.
    const notice =
      `\n\n[skill body truncated from ${originalBytes} to ${cap} bytes` +
      " — reload after editing the skill file if you need the remainder]";
    const contentBytes = new TextEncoder().encode(content).length;
    expect(contentBytes).toBeLessThanOrEqual(cap + new TextEncoder().encode(notice).length);
  });
});
