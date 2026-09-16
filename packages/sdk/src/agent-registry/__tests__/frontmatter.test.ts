import { describe, it, expect } from "vitest";
import { parseAgentFile } from "../frontmatter.js";

const VALID = `---
name: code-searcher
description: 在大范围代码里定位实现
tools: [read_file, glob, grep]
model: claude-haiku-4-5-20251001
policy: { sandbox: read-only }
maxIterations: 20
customKey: keep-me
---

你是代码检索专员。只读，不改动任何文件。
`;

describe("parseAgentFile", () => {
  it("maps frontmatter onto an AgentSpec", () => {
    const parsed = parseAgentFile(VALID, "/p/.volto/agents/a.md");
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.name).toBe("code-searcher");
    expect(parsed.spec.description).toBe("在大范围代码里定位实现");
    expect(parsed.spec.tools).toEqual(["read_file", "glob", "grep"]);
    expect(parsed.spec.model).toBe("claude-haiku-4-5-20251001");
    expect(parsed.spec.policy).toEqual({ sandbox: "read-only" });
    expect(parsed.spec.maxIterations).toBe(20);
  });

  it("uses the body as the system prompt", () => {
    const parsed = parseAgentFile(VALID, "/p/a.md");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.spec.systemPrompt).toContain("你是代码检索专员");
    expect(parsed.spec.systemPrompt).not.toContain("---");
  });

  it("preserves frontmatter keys it does not own", () => {
    const parsed = parseAgentFile(VALID, "/p/a.md");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.unknownKeys).toEqual({ customKey: "keep-me" });
  });

  it("reports an error instead of throwing when name is missing", () => {
    const result = parseAgentFile("---\ndescription: x\n---\nbody", "/p/b.md");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/name/i);
  });

  it("reports an error instead of throwing on malformed frontmatter", () => {
    const result = parseAgentFile("---\nname: [unclosed\n---\nbody", "/p/c.md");
    expect(result).toHaveProperty("error");
  });

  it("reports an error when there is no frontmatter block at all", () => {
    const result = parseAgentFile("just a body", "/p/d.md");
    expect(result).toHaveProperty("error");
  });

  it("rejects an unknown policy sandbox value instead of producing a broken spec", () => {
    const result = parseAgentFile(
      "---\nname: x\npolicy: { sandbox: superuser }\n---\nbody",
      "/p/e.md",
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/policy/i);
  });

  it("rejects unknown top-level keys inside a policy object", () => {
    const result = parseAgentFile(
      "---\nname: x\npolicy: { sandbox: read-only, escalate: true }\n---\nbody",
      "/p/f.md",
    );
    expect(result).toHaveProperty("error");
  });
});
