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
});
