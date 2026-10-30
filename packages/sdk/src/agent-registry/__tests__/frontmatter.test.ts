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

  it("maps responseFormat onto the spec", () => {
    const raw = `---
name: json-reader
responseFormat: { type: json, schema: { type: object } }
---

body
`;
    const parsed = parseAgentFile(raw, "/p/a.md");
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.responseFormat).toEqual({
      type: "json",
      schema: { type: "object" },
    });
    // Owned keys never double as unknown keys, or serialize would emit them twice.
    expect(parsed.unknownKeys["responseFormat"]).toBeUndefined();
  });

  it("fails the file when responseFormat is not a json format object", () => {
    const raw = `---
name: json-reader
responseFormat: text
---

body
`;
    const parsed = parseAgentFile(raw, "/p/a.md");
    expect("error" in parsed && parsed.error).toMatch(/responseFormat/);
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

  it("rejects a wrong-typed tools value that is not an array or comma list", () => {
    const result = parseAgentFile(
      "---\nname: x\ntools: { read_file: true }\n---\nbody",
      "/p/g.md",
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/tools/i);
  });

  it("rejects a string maxIterations instead of a number", () => {
    const result = parseAgentFile(
      '---\nname: x\nmaxIterations: "20"\n---\nbody',
      "/p/h.md",
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/maxIterations/i);
  });

  it("rejects tools array elements that are not strings", () => {
    const result = parseAgentFile(
      "---\nname: x\ntools: [1, true]\n---\nbody",
      "/p/i.md",
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/tools/i);
  });
});

describe("parseAgentFile — parameter permission rules", () => {
  it("accepts a pathPattern rule", () => {
    const parsed = parseAgentFile(
      '---\nname: reviewer\npolicy: { rules: [{ pathPattern: "**/.env", decision: deny }] }\n---\nbody',
      "/p/param-a.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.policy?.rules).toEqual([{ pathPattern: "**/.env", decision: "deny" }]);
  });

  it("accepts a hostPattern rule", () => {
    const parsed = parseAgentFile(
      '---\nname: researcher\npolicy: { rules: [{ hostPattern: "*.internal.example", decision: ask }] }\n---\nbody',
      "/p/param-b.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.policy?.rules).toEqual([{ hostPattern: "*.internal.example", decision: "ask" }]);
  });

  it("rejects a rule with no match key instead of letting it match everything", () => {
    const parsed = parseAgentFile(
      "---\nname: broken\npolicy: { rules: [{ decision: deny }] }\n---\nbody",
      "/p/param-c.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects a literal ~ in a pathPattern rather than letting it silently never match", () => {
    const parsed = parseAgentFile(
      '---\nname: tilde\npolicy: { rules: [{ pathPattern: "~/.ssh/**", decision: deny }] }\n---\nbody',
      "/p/param-d.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects a whitespace-only match key instead of letting it silently never match", () => {
    const parsed = parseAgentFile(
      '---\nname: blank\npolicy: { rules: [{ pathPattern: "   ", decision: deny }] }\n---\nbody',
      "/p/param-e.md",
    );
    expect(parsed).toHaveProperty("error");
  });
});

describe("parseAgentFile — command permission rules", () => {
  it("accepts a valid commandPrefix rule with toolName", () => {
    const parsed = parseAgentFile(
      '---\nname: bash-runner\npolicy: { rules: [{ toolName: bash, commandPrefix: ["pnpm", "test"], decision: allow }] }\n---\nbody',
      "/p/cmd-a.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.policy?.rules).toEqual([
      { toolName: "bash", commandPrefix: ["pnpm", "test"], decision: "allow" },
    ]);
  });

  it("accepts a valid commandPrefix rule with toolPattern", () => {
    const parsed = parseAgentFile(
      '---\nname: shell-runner\npolicy: { rules: [{ toolPattern: "sh_*", commandPrefix: ["git", "status"], decision: allow }] }\n---\nbody',
      "/p/cmd-b.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.policy?.rules).toEqual([
      { toolPattern: "sh_*", commandPrefix: ["git", "status"], decision: "allow" },
    ]);
  });

  it("rejects commandPrefix without toolName or toolPattern", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ commandPrefix: ["pnpm", "test"], decision: allow }] }\n---\nbody',
      "/p/cmd-c.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with non-allow decision", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: ["pnpm", "test"], decision: deny }] }\n---\nbody',
      "/p/cmd-d.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix that is not an array", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: "pnpm test", decision: allow }] }\n---\nbody',
      "/p/cmd-e.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with empty array", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: [], decision: allow }] }\n---\nbody',
      "/p/cmd-f.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with more than 8 entries", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], decision: allow }] }\n---\nbody',
      "/p/cmd-g.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with a non-string entry", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: [123], decision: allow }] }\n---\nbody',
      "/p/cmd-h.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with an empty string entry", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: [""], decision: allow }] }\n---\nbody',
      "/p/cmd-i.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("rejects commandPrefix with a disqualifying token (shell metachar)", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: ["pnpm", "test*"], decision: allow }] }\n---\nbody',
      "/p/cmd-j.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("accepts commandPrefix at exactly 8 entries", () => {
    const parsed = parseAgentFile(
      '---\nname: ok\npolicy: { rules: [{ toolName: bash, commandPrefix: ["a", "b", "c", "d", "e", "f", "g", "h"], decision: allow }] }\n---\nbody',
      "/p/cmd-k.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.policy?.rules![0]!.commandPrefix).toHaveLength(8);
  });

  it("rejects commandPrefix whose rule has an unknown extra key", () => {
    const parsed = parseAgentFile(
      '---\nname: broken\npolicy: { rules: [{ toolName: bash, commandPrefix: ["pnpm"], decision: allow, oops: true }] }\n---\nbody',
      "/p/cmd-l.md",
    );
    expect(parsed).toHaveProperty("error");
  });

  it("accepts a comma-separated tools list (Claude Code style)", () => {
    const parsed = parseAgentFile(
      "---\nname: comma-tools\ndescription: d\ntools: read_file, grep, run_bash_command\n---\nbody",
      "/p/comma-tools.md",
    );
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.tools).toEqual(["read_file", "grep", "run_bash_command"]);
  });

  it("keeps a multi-line description with example list items", () => {
    const raw = `---
name: planner
description: Plan development work.

Examples:
- <example>
  Context: user asks for a plan
  assistant: "I'll use the planner"
  <commentary>
  Planning work belongs here.
  </commentary>
</example>

tools: Read, Grep
color: purple
---

body
`;
    const parsed = parseAgentFile(raw, "/p/planner.md");
    if ("error" in parsed) throw new Error(`unexpected error: ${parsed.error}`);
    expect(parsed.spec.name).toBe("planner");
    expect(parsed.spec.description).toBe("Plan development work.");
    expect(parsed.spec.tools).toEqual(["Read", "Grep"]);
    expect(parsed.unknownKeys["color"]).toBe("purple");
    expect(String(parsed.unknownKeys["Examples"])).toContain("<example>");
  });
});
