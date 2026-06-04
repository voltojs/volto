import { describe, it, expect } from "vitest";
import type { Shell } from "@agent-core/core";
import { spawn } from "node:child_process";
import { createBashTool, CAP_SHELL_EXEC } from "../index.js";

/** Mock shell that actually executes commands via child_process.spawn */
function realShell(): Shell {
  return {
    async *exec(cmd: string) {
      const child = spawn(cmd, [], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      if (child.stdout) for await (const chunk of child.stdout) yield { type: "stdout", data: chunk.toString() };
      if (child.stderr) for await (const chunk of child.stderr) yield { type: "stderr", data: chunk.toString() };
      const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
      yield { type: "exit", code };
    },
  };
}

function mockShell(stdout: string, stderr = "", exitCode = 0): Shell {
  return {
    async *exec() {
      if (stdout) yield { type: "stdout", data: stdout };
      if (stderr) yield { type: "stderr", data: stderr };
      yield { type: "exit", code: exitCode };
    },
  };
}

function mockShellWithLaunch(stdout: string, exitCode = 0): Shell {
  return {
    ...mockShell(stdout, "", exitCode),
    async launch() {
      return "12345";
    },
  };
}

describe("bash tool", () => {
  it("runs a simple command and returns stdout", async () => {
    const tool = createBashTool(realShell());
    const result = await tool.handler({ command: "echo hello" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("hello");
  });

  it("returns error when command fails", async () => {
    const tool = createBashTool(mockShell("", "error occurred", 1));
    const result = await tool.handler({ command: "failing-command" });
    expect(result.modelContent).toContain("error occurred");
    expect(result.modelContent).toContain("exit code: 1");
  });

  it("truncates long output", async () => {
    const longOutput = "x".repeat(150_000);
    const tool = createBashTool(mockShell(longOutput));
    const result = await tool.handler({ command: "generate-output" });
    expect(result.modelContent).toContain("truncated");
    expect(result.displayMetadata?.truncated).toBe(true);
    expect(result.displayMetadata?.totalLength).toBe(longOutput.length);
  });

  it("returns full output when showFullOutput is true", async () => {
    const longOutput = "y".repeat(150_000);
    const tool = createBashTool(mockShell(longOutput));
    const result = await tool.handler({ command: "generate-output", showFullOutput: true });
    expect(result.modelContent).toBe(longOutput);
    expect(result.displayMetadata?.truncated).toBe(false);
  });

  it("launches in background when runInBackground is true", async () => {
    const tool = createBashTool(mockShellWithLaunch(""));
    const result = await tool.handler({ command: "long-task", runInBackground: true });
    expect(result.modelContent).toContain("PID: 12345");
    expect(result.displayMetadata?.backgroundPid).toBe("12345");
    expect(result.displayMetadata?.runInBackground).toBe(true);
  });

  it("falls back to foreground when launch() is not available", async () => {
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: "fg-ok" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell);
    const result = await tool.handler({ command: "test", runInBackground: true });
    // No launch() defined, falls back to foreground exec
    expect(result.modelContent).toContain("fg-ok");
  });

  it("definition requires CAP_SHELL_EXEC and has WRITE_HIGH risk tier", () => {
    const tool = createBashTool(mockShell(""));
    expect(tool.definition.requires).toEqual([CAP_SHELL_EXEC]);
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
  });

  it("definition has valid input schema requiring command", () => {
    const tool = createBashTool(mockShell(""));
    expect(tool.definition.inputSchema.required).toContain("command");
  });
});
