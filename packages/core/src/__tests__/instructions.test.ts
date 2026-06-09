import { describe, it, expect } from "vitest";
import { expandInstructions, mergeInstructionLayers } from "../instructions.js";

describe("expandInstructions", () => {
  it("should expand a simple file with no imports", () => {
    const files = new Map([["/project/AGENTS.md", "# Rules\nBe concise."]]);
    const result = expandInstructions(files, "/project/AGENTS.md", "/project");
    expect(result.text).toBe("# Rules\nBe concise.");
    expect(result.references).toHaveLength(0);
  });

  it("should expand @import directives recursively", () => {
    const files = new Map([
      ["/project/AGENTS.md", "# Main\n@./shared.md"],
      ["/project/shared.md", "## Shared rules\nNo drama."],
    ]);
    const result = expandInstructions(files, "/project/AGENTS.md", "/project");
    expect(result.text).toContain("# Main");
    expect(result.text).toContain("## Shared rules");
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({ from: "/project/AGENTS.md", to: "/project/shared.md" });
  });

  it("should detect circular imports", () => {
    const files = new Map([
      ["/a.md", "@./b.md"],
      ["/b.md", "@./a.md"],
    ]);
    const result = expandInstructions(files, "/a.md", "/");
    expect(result.text).toContain("[circular import:");
  });

  it("should reject out-of-scope imports", () => {
    const files = new Map([
      ["/project/AGENTS.md", "@/etc/passwd"],
    ]);
    const result = expandInstructions(files, "/project/AGENTS.md", "/project");
    expect(result.text).toContain("[import out of scope:");
  });

  it("should degrade gracefully for missing imports", () => {
    const files = new Map([
      ["/project/AGENTS.md", "@./missing.md"],
    ]);
    const result = expandInstructions(files, "/project/AGENTS.md", "/project");
    expect(result.text).toContain("[missing instruction file:");
  });

  it("should degrade for missing entry file", () => {
    const files = new Map<string, string>();
    const result = expandInstructions(files, "/project/AGENTS.md", "/project");
    expect(result.text).toContain("[missing instruction file:");
  });
});

describe("mergeInstructionLayers", () => {
  it("should merge layers in order with double newline separator", () => {
    const merged = mergeInstructionLayers(["Global rules.", "Project rules."]);
    expect(merged).toBe("Global rules.\n\nProject rules.");
  });

  it("should skip empty layers", () => {
    const merged = mergeInstructionLayers(["", "Project rules.", ""]);
    expect(merged).toBe("Project rules.");
  });

  it("should return empty for all-empty layers", () => {
    expect(mergeInstructionLayers(["", ""])).toBe("");
  });
});
