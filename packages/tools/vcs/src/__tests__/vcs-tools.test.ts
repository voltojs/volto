import { describe, it, expect } from "vitest";
import type { Shell, ShellEvent } from "@voltojs/core";
import {
  createGitStatusTool,
  createGitDiffTool,
  createGitCommitTool,
  createGitPushTool,
  createRunTestsTool,
  createBuildTool,
  VCS_TOOL_NAMES,
} from "../index.js";

/**
 * Mock Shell that returns predetermined events for each command.
 */
function createMockShell(responses: Record<string, ShellEvent[]>): Shell {
  return {
    async *exec(cmd: string) {
      // Match command prefix
      const key = Object.keys(responses).find((k) => cmd.startsWith(k));
      if (key) {
        yield* responses[key]!;
      } else {
        yield { type: "stdout", data: `mock: ${cmd}` };
        yield { type: "exit", code: 0 };
      }
    },
  };
}

describe("VCS tool names", () => {
  it("registers all 6 tools", () => {
    expect(VCS_TOOL_NAMES.size).toBe(6);
    expect(VCS_TOOL_NAMES.has("git_status")).toBe(true);
    expect(VCS_TOOL_NAMES.has("git_diff")).toBe(true);
    expect(VCS_TOOL_NAMES.has("git_commit")).toBe(true);
    expect(VCS_TOOL_NAMES.has("git_push")).toBe(true);
    expect(VCS_TOOL_NAMES.has("run_tests")).toBe(true);
    expect(VCS_TOOL_NAMES.has("build")).toBe(true);
  });
});

describe("git_status", () => {
  it("parses porcelain output into structured file list", async () => {
    const shell = createMockShell({
      "git status": [
        { type: "stdout", data: "M  src/foo.ts\nA  src/bar.ts\n D src/old.ts\n" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createGitStatusTool(shell);
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("3 changed");
    expect(result.displayMetadata).toMatchObject({ count: 3 });
  });

  it("returns clean message when no changes", async () => {
    const shell = createMockShell({
      "git status": [{ type: "exit", code: 0 }],
    });
    const tool = createGitStatusTool(shell);
    const result = await tool.handler({});
    expect(result.modelContent).toContain("clean");
  });

  it("returns isError on non-zero exit", async () => {
    const shell = createMockShell({
      "git status": [
        { type: "stdout", data: "fatal: not a git repository" },
        { type: "exit", code: 128 },
      ],
    });
    const tool = createGitStatusTool(shell);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });
});

describe("git_diff", () => {
  it("returns diff output", async () => {
    const shell = createMockShell({
      "git diff": [
        { type: "stdout", data: "-old\n+new\n" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createGitDiffTool(shell);
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("+new");
  });

  it("passes validated flags and revision ranges to git diff", async () => {
    let receivedCmd = "";
    const shell: Shell = {
      async *exec(cmd: string) {
        receivedCmd = cmd;
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createGitDiffTool(shell);
    await tool.handler({ args: "--cached HEAD~1" });
    // The read is pinned to git's own diff engine: repo config / attributes
    // must not be able to attach an external command to a READ_ONLY tool.
    expect(receivedCmd).toBe("git diff --no-ext-diff --no-textconv --cached HEAD~1");
  });

  it("rejects shell metacharacters instead of interpolating them", async () => {
    let called = false;
    const shell: Shell = {
      async *exec() {
        called = true;
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createGitDiffTool(shell);

    const result = await tool.handler({ args: "--stat; touch /tmp/pwned" });

    expect(result.isError).toBe(true);
    expect(result.modelContent as string).toContain("unsupported argument");
    expect(called).toBe(false);
  });

  it("rejects flags that write or execute (--output, --ext-diff, unknown tokens)", async () => {
    const shell: Shell = {
      async *exec() {
        throw new Error("must not execute");
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createGitDiffTool(shell);

    for (const args of ["--output=/tmp/diff", "--ext-diff", "--textconv", "HEAD:file"]) {
      const result = await tool.handler({ args });
      expect(result.isError).toBe(true);
    }
  });

  it("accepts --unified=<n> and range tokens", async () => {
    let receivedCmd = "";
    const shell: Shell = {
      async *exec(cmd: string) {
        receivedCmd = cmd;
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createGitDiffTool(shell);
    const result = await tool.handler({ args: "--unified=3 main...HEAD" });
    expect(result.isError).toBeFalsy();
    expect(receivedCmd).toBe("git diff --no-ext-diff --no-textconv --unified=3 main...HEAD");
  });
});

describe("git_commit", () => {
  it("extracts commit hash from output", async () => {
    const shell = createMockShell({
      "git commit": [
        { type: "stdout", data: "[main abc1234] test commit\n 1 file changed" },
        { type: "exit", code: 0 },
      ],
      "echo": [
        { type: "stdout", data: "[main abc1234] test commit\n 1 file changed" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createGitCommitTool(shell);
    const result = await tool.handler({ message: "test commit" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("abc1234");
  });

  it("has WRITE_HIGH risk tier", () => {
    const shell = createMockShell({});
    const tool = createGitCommitTool(shell);
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
  });
});

describe("git_push", () => {
  it("has IRREVERSIBLE risk tier", () => {
    const shell = createMockShell({});
    const tool = createGitPushTool(shell);
    expect(tool.definition.riskTier).toBe("IRREVERSIBLE");
  });

  it("returns success message", async () => {
    const shell = createMockShell({
      "git push": [
        { type: "stdout", data: "To github.com:user/repo.git\n   abc..def  main -> main" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createGitPushTool(shell);
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("Pushed");
  });
});

describe("run_tests", () => {
  it("parses pass/fail from test output", async () => {
    const shell = createMockShell({
      "pnpm test": [
        { type: "stdout", data: "Tests: 12 passed, 2 failed\nFAIL src/bad.test.ts\n" },
        { type: "exit", code: 1 },
      ],
    });
    const tool = createRunTestsTool(shell);
    const result = await tool.handler({ command: "pnpm test" });
    expect(result.modelContent).toContain("failed");
    expect(result.modelContent).toContain("12 passed");
  });

  it("returns pass message on exit 0", async () => {
    const shell = createMockShell({
      "jest": [
        { type: "stdout", data: "Tests: 5 passed\n" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createRunTestsTool(shell);
    const result = await tool.handler({ command: "jest" });
    expect(result.modelContent).toContain("passed");
  });
});

describe("build", () => {
  it("returns success on exit 0", async () => {
    const shell = createMockShell({
      "tsc": [
        { type: "stdout", data: "Build complete.\n" },
        { type: "exit", code: 0 },
      ],
    });
    const tool = createBuildTool(shell);
    const result = await tool.handler({ command: "tsc" });
    expect(result.modelContent).toContain("succeeded");
  });

  it("returns failure on non-zero exit", async () => {
    const shell = createMockShell({
      "tsc": [
        { type: "stdout", data: "error TS2345: Type 'string' is not assignable.\n" },
        { type: "exit", code: 1 },
      ],
    });
    const tool = createBuildTool(shell);
    const result = await tool.handler({ command: "tsc" });
    expect(result.modelContent).toContain("failed");
    expect(result.modelContent).toContain("TS2345");
  });
});
