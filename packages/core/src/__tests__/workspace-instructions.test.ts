import { describe, it, expect } from "vitest";
import {
  ancestorChain,
  candidateFileNames,
  dedupeInstructions,
  instructionLayerId,
  renderInstructionLayers,
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
