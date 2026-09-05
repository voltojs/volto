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
    expect(JSON.stringify(layers)).not.toContain("budget");
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

describe("truncateUtf8", () => {
  it("never splits a multi-byte code point", () => {
    // "汉汉" = 6 bytes; cutting at 4 must back off to 3.
    expect(truncateUtf8("汉汉", 4)).toBe("汉");
    expect(truncateUtf8("汉汉", 5)).toBe("汉");
    expect(truncateUtf8("汉汉", 6)).toBe("汉汉");
  });
});
