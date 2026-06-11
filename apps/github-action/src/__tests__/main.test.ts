import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

describe("GitHub Action", () => {
  it("has correct action.yml structure", () => {
    const yamlPath = path.resolve(import.meta.dirname, "../../action.yml");
    const yaml = fs.readFileSync(yamlPath, "utf-8");
    expect(yaml).toContain("Agent Core");
    expect(yaml).toContain("prompt:");
    expect(yaml).toContain("model:");
    expect(yaml).toContain("response:");
  });
});
