import { describe, it, expect } from "vitest";
import type { Shell, ShellEvent } from "@volto/core";
import { spawn } from "node:child_process";
import { createBashTool, CAP_SHELL_EXEC } from "../index.js";

/** Mock shell that actually executes commands via child_process.spawn (concurrent stdout/stderr) */
function realShell(): Shell {
  return {
    async *exec(cmd: string) {
      const child = spawn(cmd, [], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
      const queue: ShellEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;
      function enqueue(event: ShellEvent) {
        if (resolveWaiter) { const r = resolveWaiter; resolveWaiter = null; r(); }
        queue.push(event);
      }
      child.stdout?.on("data", (chunk: Buffer) => enqueue({ type: "stdout", data: chunk.toString() }));
      child.stderr?.on("data", (chunk: Buffer) => enqueue({ type: "stderr", data: chunk.toString() }));
      child.on("close", (code) => { closed = true; enqueue({ type: "exit", code: code ?? 1 }); });
      while (true) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
          if (e.type === "exit") return;
        } else if (closed) {
          return;
        } else {
          await new Promise<void>((r) => { resolveWaiter = r; });
        }
      }
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
    expect(result.modelContent).toContain("process_id: 12345");
    expect(result.displayMetadata?.processId).toBe("12345");
    expect(result.displayMetadata?.backgroundPid).toBe("12345");
    expect(result.displayMetadata?.runInBackground).toBe(true);
  });

  // Post-B-1: every confining sandbox backend exposes launch, so this
  // fallback fires only when the underlying Shell truly has no launch
  // method (bare adapter, or a runtime without process support).
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

  it("reports the foreground fallback in modelContent and displayMetadata when runInBackground is requested but launch() is unavailable", async () => {
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: "fg-ok" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell);
    const result = await tool.handler({ command: "test", runInBackground: true });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("fg-ok");
    // The model needs to be told background execution didn't happen, or it
    // will keep expecting an immediate PID from calls that actually block.
    expect(result.modelContent).toMatch(/background/i);
    expect(result.modelContent).toMatch(/foreground/i);
    expect(result.displayMetadata?.backgroundFallback).toBe(true);
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

  it("definition description does not promise streaming output (spec §2.4)", () => {
    const tool = createBashTool(mockShell(""));
    expect(tool.definition.description).not.toMatch(
      /output will stream as it becomes available/i,
    );
    expect(tool.definition.description).toMatch(/bash_output/i);
  });

  it("description documents the persistent session and isolated escape hatch", () => {
    const tool = createBashTool(mockShell(""));
    expect(tool.definition.description).toMatch(/persistent|持久/i);
    expect(tool.definition.description).toMatch(/isolated/i);
  });

  it("background launch result explains how to read output", async () => {
    const tool = createBashTool(mockShellWithLaunch(""));
    const result = await tool.handler({ command: "long-task", runInBackground: true });
    expect(result.modelContent).toContain("process_id");
    expect(result.modelContent).toContain("bash_output");
    expect(result.modelContent).not.toMatch(
      /output will stream as it becomes available/i,
    );
  });
});

describe("bash isolated escape hatch", () => {
  it("isolated:true uses shell.exec, not the session", async () => {
    const execCalls: string[] = [];
    const sessionCalls: string[] = [];
    const shell: Shell = {
      async *exec(cmd: string) {
        execCalls.push(cmd);
        yield { type: "stdout", data: "isolated-ok" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell, {
      getSession: () => ({
        async run(cmd: string) {
          sessionCalls.push(cmd);
          return { stdout: "session-ok", stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({ command: "echo x", isolated: true });
    expect(r.modelContent).toContain("isolated-ok");
    expect(execCalls.length).toBe(1);
    expect(sessionCalls.length).toBe(0);
  });

  it("without isolated, routes through the session", async () => {
    const sessionCalls: string[] = [];
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: "exec-path" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell, {
      getSession: () => ({
        async run(cmd: string) {
          sessionCalls.push(cmd);
          return { stdout: "session-path", stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({ command: "echo x" });
    expect(r.modelContent).toContain("session-path");
    expect(sessionCalls).toEqual(["echo x"]);
  });

  it("falls back to shell.exec when no session is available", async () => {
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: "exec-path" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell, { getSession: () => undefined });
    const r = await tool.handler({ command: "echo x" });
    expect(r.modelContent).toContain("exec-path");
  });

  it("surfaces stateResetReason in modelContent when the session was rebuilt", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return {
            stdout: "after-reset",
            stderr: "",
            exitCode: 124,
            stateResetReason:
              "Session was rebuilt after a stuck command. Working directory and environment variables were reset to the session defaults.",
          };
        },
      }),
    });
    const r = await tool.handler({ command: "echo x" });
    expect(r.modelContent).toContain("after-reset");
    expect(r.modelContent).toContain("Session was rebuilt");
    expect(r.modelContent).toContain("exit code: 124");
    expect(r.displayMetadata?.fromSession).toBe(true);
    expect(r.displayMetadata?.stateReset).toBe(true);
  });

  it("session.run rejection becomes an isError tool result", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          throw new Error("session dead");
        },
      }),
    });
    const r = await tool.handler({ command: "echo x" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toContain("session dead");
  });

  it("session path forwards cwd and timeout", async () => {
    const seen: Array<{ cmd: string; cwd?: string; timeout?: number }> = [];
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run(cmd, opts) {
          seen.push({ cmd, cwd: opts?.cwd, timeout: opts?.timeout });
          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      }),
    });
    await tool.handler({ command: "echo x", cwd: "/tmp", timeout: 5000 });
    expect(seen).toEqual([{ cmd: "echo x", cwd: "/tmp", timeout: 5000 }]);
  });

  // Residual fix from Task 6 review: runInBackground requested, no launch(),
  // session present → must still say background was unavailable, or the model
  // keeps expecting a PID from a call that actually blocked.
  it("session path notes when runInBackground was requested but launch is unavailable", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return { stdout: "session-ran", stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({ command: "echo x", runInBackground: true });
    expect(r.isError).toBeFalsy();
    expect(r.modelContent).toContain("session-ran");
    expect(r.modelContent).toMatch(/background/i);
    expect(r.modelContent).toMatch(/session|foreground/i);
    expect(r.displayMetadata?.backgroundFallback).toBe(true);
  });

  // Residual fix from Task 6 review: session output must go through the same
  // OUTPUT_LIMIT / showFullOutput policy as the exec path.
  it("session path applies OUTPUT_LIMIT truncation", async () => {
    const longOutput = "z".repeat(150_000);
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return { stdout: longOutput, stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({ command: "generate-output" });
    expect(r.modelContent).toContain("truncated");
    expect(r.displayMetadata?.truncated).toBe(true);
    expect(r.displayMetadata?.totalLength).toBe(longOutput.length);
    expect(r.displayMetadata?.fromSession).toBe(true);
  });

  it("session path returns full output when showFullOutput is true", async () => {
    const longOutput = "w".repeat(150_000);
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return { stdout: longOutput, stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({
      command: "generate-output",
      showFullOutput: true,
    });
    expect(r.modelContent).toBe(longOutput);
    expect(r.displayMetadata?.truncated).toBe(false);
    expect(r.displayMetadata?.fromSession).toBe(true);
  });
});
