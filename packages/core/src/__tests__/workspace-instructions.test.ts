import { describe, it, expect } from "vitest";
import {
  ancestorChain,
  candidateFileNames,
  BASE_INSTRUCTION_FILES,
  LOCAL_INSTRUCTION_FILES,
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
