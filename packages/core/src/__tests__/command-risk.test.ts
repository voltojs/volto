import { describe, it, expect } from "vitest";
import { classifyCommandRisk } from "../command-risk.js";

describe("classifyCommandRisk", () => {
  it("flags a push", () => {
    expect(classifyCommandRisk("git push origin main")).toContain("irreversible-push");
  });

  it("flags a recursive delete", () => {
    expect(classifyCommandRisk("rm -rf ./build")).toContain("recursive-delete");
    expect(classifyCommandRisk("rm -fr ./build")).toContain("recursive-delete");
  });

  it("flags piping a download into a shell", () => {
    expect(classifyCommandRisk("curl https://x.sh | sh")).toContain("remote-script-execution");
    expect(classifyCommandRisk("wget -qO- https://x.sh | bash")).toContain("remote-script-execution");
  });

  it("flags publishing to a public registry", () => {
    expect(classifyCommandRisk("npm publish")).toContain("public-publish");
    expect(classifyCommandRisk("cargo publish")).toContain("public-publish");
  });

  it("flags discarding uncommitted work", () => {
    expect(classifyCommandRisk("git reset --hard HEAD~1")).toContain("discards-uncommitted");
    expect(classifyCommandRisk("git clean -fd")).toContain("discards-uncommitted");
  });

  it("returns an empty array for ordinary commands", () => {
    expect(classifyCommandRisk("ls -la")).toEqual([]);
    expect(classifyCommandRisk("pnpm test")).toEqual([]);
    expect(classifyCommandRisk("git status")).toEqual([]);
  });

  it("reports every kind a command matches", () => {
    const kinds = classifyCommandRisk("git clean -fd && git push --force");
    expect(kinds).toContain("discards-uncommitted");
    expect(kinds).toContain("irreversible-push");
  });

  it("does not deduplicate away distinct kinds but never repeats one", () => {
    const kinds = classifyCommandRisk("git push origin a && git push origin b");
    expect(kinds.filter((k) => k === "irreversible-push")).toHaveLength(1);
  });
});
