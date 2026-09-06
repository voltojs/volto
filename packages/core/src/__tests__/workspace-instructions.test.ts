import { describe, it, expect } from "vitest";
import {
  ancestorChain,
  candidateFileNames,
  dedupeInstructions,
  instructionLayerId,
  renderInstructionLayers,
  truncateUtf8,
  BASE_INSTRUCTION_FILES,
  LOCAL_INSTRUCTION_FILES,
  type LoadedInstructionFile,
} from "../workspace-instructions.js";

describe("ancestorChain", () => {
  it("returns a single-entry chain when cwd equals the project root", () => {
    expect(ancestorChain("/repo", "/repo")).toEqual(["/repo"]);
  });

  it("orders the chain broad-to-specific from root to cwd", () => {
    expect(ancestorChain("/repo/src/lib", "/repo")).toEqual([
      "/repo",
      "/repo/src",
      "/repo/src/lib",
    ]);
  });

  it("ignores trailing slashes on both ends", () => {
    expect(ancestorChain("/repo/src/", "/repo/")).toEqual(["/repo", "/repo/src"]);
  });

  it("falls back to a single-entry chain when cwd is outside the root", () => {
    expect(ancestorChain("/elsewhere/x", "/repo")).toEqual(["/elsewhere/x"]);
  });
});

describe("candidate file names", () => {
  it("lists base files before local overlays", () => {
    expect(candidateFileNames()).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "AGENTS.local.md",
      "CLAUDE.local.md",
    ]);
    expect(BASE_INSTRUCTION_FILES).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(LOCAL_INSTRUCTION_FILES).toEqual(["AGENTS.local.md", "CLAUDE.local.md"]);
  });
});

function file(displayPath: string, content: string): LoadedInstructionFile {
  return { absolutePath: `/abs/${displayPath}`, displayPath, content };
}

describe("dedupeInstructions", () => {
  it("keeps the first of identical siblings in candidate order", () => {
    const kept = dedupeInstructions([file("AGENTS.md", "same"), file("CLAUDE.md", "same")]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.displayPath).toBe("AGENTS.md");
  });

  it("dedupes across directories, not only siblings", () => {
    const kept = dedupeInstructions([file("AGENTS.md", "rule"), file("src/AGENTS.md", "rule")]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.displayPath).toBe("AGENTS.md");
  });

  it("compares trimmed content", () => {
    const kept = dedupeInstructions([file("AGENTS.md", "rule"), file("src/CLAUDE.md", "  rule  \n")]);
    expect(kept).toHaveLength(1);
  });

  it("keeps files with distinct content in input order", () => {
    const kept = dedupeInstructions([file("a", "1"), file("b", "2"), file("c", "3")]);
    expect(kept.map((f) => f.displayPath)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeInstructions([])).toEqual([]);
  });
});

describe("instructionLayerId", () => {
  it("maps the user-global display path to user-memory", () => {
    expect(instructionLayerId("~/.volto/AGENTS.md")).toBe("user-memory");
  });

  it("keys project layers by their display path", () => {
    expect(instructionLayerId("src/lib/AGENTS.md")).toBe("project-memory:src/lib/AGENTS.md");
  });
});

describe("renderInstructionLayers — rendering (no budget pressure)", () => {
  it("prefixes each layer with its provenance heading", () => {
    const { layers } = renderInstructionLayers(
      [file("AGENTS.md", "Root rule")],
      64 * 1024,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0]!.id).toBe("project-memory:AGENTS.md");
    expect(layers[0]!.text).toBe("Instructions from: AGENTS.md\n\nRoot rule");
  });

  it("renders one layer per file, preserving broad-to-specific order", () => {
    const { layers } = renderInstructionLayers(
      [file("AGENTS.md", "a"), file("src/AGENTS.md", "b"), file("src/CLAUDE.local.md", "c")],
      64 * 1024,
    );
    expect(layers.map((l) => l.id)).toEqual([
      "project-memory:AGENTS.md",
      "project-memory:src/AGENTS.md",
      "project-memory:src/CLAUDE.local.md",
    ]);
  });

  it("emits nothing for empty input", () => {
    expect(renderInstructionLayers([], 64 * 1024)).toEqual({ layers: [], omitted: [], truncated: [] });
  });
});

describe("renderInstructionLayers — byte budget", () => {
  const KB = 1024;

  it("passes through when the total fits", () => {
    const { layers, omitted, truncated } = renderInstructionLayers(
      [file("AGENTS.md", "small")],
      64 * KB,
    );
    expect(layers).toHaveLength(1);
    expect(omitted).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it("omits broadest files whole before touching the most specific", () => {
    const big = "x".repeat(3 * KB);
    const { layers, omitted } = renderInstructionLayers(
      [file("AGENTS.md", big), file("src/AGENTS.md", big), file("src/deep/AGENTS.md", "tiny")],
      4 * KB,
    );
    // Each rendered layer ≈ 3KB; two fit, the broadest is dropped whole.
    expect(omitted).toEqual(["AGENTS.md"]);
    expect(layers.map((l) => l.id)).toEqual(["project-memory:src/AGENTS.md", "project-memory:src/deep/AGENTS.md"]);
    // Spec §5.5.3 — the notice is model-visible and rides on the most-specific
    // surviving layer; every layer text still respects the budget.
    const encoder = new TextEncoder();
    const last = layers[layers.length - 1]!;
    expect(last.text).toContain(`Workspace instruction budget ${4 * KB} bytes: omitted AGENTS.md`);
    for (const l of layers) {
      expect(encoder.encode(l.text).length).toBeLessThanOrEqual(4 * KB);
    }
  });

  it("names omitted files and the truncation together in one notice", () => {
    const { layers, omitted, truncated } = renderInstructionLayers(
      [
        file("AGENTS.md", "x".repeat(2 * KB)),
        file("src/AGENTS.md", "x".repeat(2 * KB)),
        file("src/deep/AGENTS.md", "y".repeat(4 * KB)),
      ],
      3 * KB,
    );
    expect(omitted).toEqual(["AGENTS.md", "src/AGENTS.md"]);
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.displayPath).toBe("src/deep/AGENTS.md");
    expect(truncated[0]!.originalBytes).toBe(4 * KB);
    const text = layers[0]!.text;
    expect(text).toContain(
      `Workspace instruction budget ${3 * KB} bytes: omitted AGENTS.md, src/AGENTS.md; truncated src/deep/AGENTS.md from ${4 * KB} to ${truncated[0]!.includedBytes} bytes`,
    );
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(3 * KB);
  });

  it("truncates the most-specific file at a UTF-8 code-point boundary and posts a visible notice", () => {
    const cjk = "汉".repeat(2000); // 6000 bytes in UTF-8, 3 bytes per char
    const { layers, truncated } = renderInstructionLayers([file("AGENTS.md", cjk)], 2 * KB);
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.originalBytes).toBe(6000);
    expect(truncated[0]!.includedBytes % 3).toBe(0); // never splits 汉
    const text = layers[0]!.text;
    expect(text).toContain(`Workspace instruction budget ${2 * KB} bytes:`);
    expect(text).toContain(`truncated AGENTS.md from 6000 to ${truncated[0]!.includedBytes} bytes`);
    // The rendered total respects the budget (notice line included).
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2 * KB);
  });

  it("keeps the notice itself inside the budget even for a tiny cap", () => {
    const { layers } = renderInstructionLayers([file("AGENTS.md", "y".repeat(5000))], 200);
    expect(layers).toHaveLength(1);
    const text = layers[0]!.text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(200);
    expect(text).toContain("Workspace instruction budget 200 bytes:");
  });

  it("counts the notice line against the budget", () => {
    // Content fits alone; the notice only appears when something was dropped,
    // so assert the no-drop case stays notice-free.
    const { layers } = renderInstructionLayers([file("AGENTS.md", "ok")], 64 * KB);
    expect(layers[0]!.text).not.toContain("budget");
  });

  it("returns everything as omitted and no layers when maxBytes is non-positive", () => {
    const out = renderInstructionLayers([file("AGENTS.md", "a")], 0);
    expect(out.layers).toEqual([]);
    expect(out.omitted).toEqual(["AGENTS.md"]);
  });
});

describe("LoadedInstructionFile id override", () => {
  it("uses the explicit id when present", () => {
    const { layers } = renderInstructionLayers(
      [{ absolutePath: "/skills/x/SKILL.md", displayPath: "skill:x", content: "body", id: "skill:x" }],
      64 * 1024,
    );
    expect(layers[0]!.id).toBe("skill:x");
    expect(layers[0]!.text).toBe("Instructions from: skill:x\n\nbody");
  });

  it("defaults to the displayPath-derived id when absent", () => {
    const { layers } = renderInstructionLayers([file("AGENTS.md", "body")], 64 * 1024);
    expect(layers[0]!.id).toBe("project-memory:AGENTS.md");
  });
});

describe("truncateUtf8", () => {
  it("never splits a multi-byte code point", () => {
    // "汉汉" = 6 bytes; cutting at 4 must back off to 3.
    expect(truncateUtf8("汉汉", 4)).toBe("汉");
    expect(truncateUtf8("汉汉", 5)).toBe("汉");
    expect(truncateUtf8("汉汉", 6)).toBe("汉汉");
  });
});

import {
  extractTouchedToolPaths,
  descendantChain,
  FS_PATH_TOOLS,
  type ContextLayerHints,
  type Message,
} from "../workspace-instructions.js";

function assistantToolUse(name: string, input: Record<string, unknown>): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: `${name}-${JSON.stringify(input)}`, name, input }],
  };
}

describe("extractTouchedToolPaths", () => {
  it("collects path inputs of the structured fs tools in order", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      assistantToolUse("read_file", { path: "src/a.ts" }),
      assistantToolUse("write_file", { path: "src/b.ts" }),
      assistantToolUse("edit_file", { path: "src/a.ts" }),
      assistantToolUse("ls", { path: "docs" }),
    ];
    expect(extractTouchedToolPaths(messages)).toEqual(["src/a.ts", "src/b.ts", "docs"]);
  });

  it("ignores other tools, missing paths, and non-string paths", () => {
    const messages: Message[] = [
      assistantToolUse("bash", { command: "cat src/a.ts" }),
      assistantToolUse("glob", { pattern: "**/*.ts" }),
      assistantToolUse("read_file", { path: 42 }),
      assistantToolUse("read_file", {}),
    ];
    expect(extractTouchedToolPaths(messages)).toEqual([]);
  });

  it("dedupes repeated paths preserving first-seen order", () => {
    const messages: Message[] = [
      assistantToolUse("read_file", { path: "src/a.ts" }),
      assistantToolUse("ls", { path: "src/a.ts" }),
    ];
    expect(extractTouchedToolPaths(messages)).toEqual(["src/a.ts"]);
  });

  it("returns an empty array for empty input", () => {
    expect(extractTouchedToolPaths([])).toEqual([]);
  });

  it("pins the tool set", () => {
    expect(FS_PATH_TOOLS).toEqual(["read_file", "write_file", "edit_file", "ls"]);
  });

  it("exposes the hints shape", () => {
    const hints: ContextLayerHints = { touchedPaths: ["a.ts"] };
    expect(hints.touchedPaths).toEqual(["a.ts"]);
  });
});

describe("descendantChain", () => {
  it("lists directories strictly below cwd down to a touched file's directory", () => {
    expect(descendantChain("/repo/src", ["lib/x.ts"])).toEqual(["/repo/src/lib"]);
  });

  it("resolves absolute touched paths and skips levels above cwd", () => {
    expect(descendantChain("/repo/src", ["/repo/src/lib/deep/y.ts"])).toEqual([
      "/repo/src/lib",
      "/repo/src/lib/deep",
    ]);
  });

  it("emits nothing for files directly in cwd, outside cwd, or empty input", () => {
    expect(descendantChain("/repo/src", ["a.ts"])).toEqual([]);
    expect(descendantChain("/repo/src", ["/elsewhere/a.ts"])).toEqual([]);
    expect(descendantChain("/repo/src", ["../outside/a.ts"])).toEqual([]);
    expect(descendantChain("/repo/src", [])).toEqual([]);
  });

  it("dedupes across paths and orders shallow before deep", () => {
    const out = descendantChain("/repo/src", ["lib/b.ts", "lib/sub/c.ts", "lib/a.ts"]);
    expect(out[0]).toBe("/repo/src/lib");
    expect(out).toContain("/repo/src/lib/sub");
    expect(new Set(out).size).toBe(out.length);
  });
});
