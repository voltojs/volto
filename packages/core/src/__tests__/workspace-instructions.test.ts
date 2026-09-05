import { describe, it, expect } from "vitest";
import {
  ancestorChain,
  candidateFileNames,
  dedupeInstructions,
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
