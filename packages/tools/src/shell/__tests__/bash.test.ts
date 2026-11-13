import { describe, it, expect } from "vitest";
import type { Shell, ShellEvent } from "@voltojs/core";
import { spawn } from "node:child_process";
import { DEFAULT_TIMEOUTS } from "../../common/index.js";
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

  it("returns full output when show_full_output is true", async () => {
    const longOutput = "y".repeat(150_000);
    const tool = createBashTool(mockShell(longOutput));
    const result = await tool.handler({ command: "generate-output", show_full_output: true });
    expect(result.modelContent).toBe(longOutput);
    expect(result.displayMetadata?.truncated).toBe(false);
  });

  it("launches in background when run_in_background is true", async () => {
    const tool = createBashTool(mockShellWithLaunch(""));
    const result = await tool.handler({ command: "long-task", run_in_background: true });
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
    const result = await tool.handler({ command: "test", run_in_background: true });
    // No launch() defined, falls back to foreground exec
    expect(result.modelContent).toContain("fg-ok");
  });

  it("reports the foreground fallback in modelContent and displayMetadata when run_in_background is requested but launch() is unavailable", async () => {
    const shell: Shell = {
      async *exec() {
        yield { type: "stdout", data: "fg-ok" };
        yield { type: "exit", code: 0 };
      },
    };
    const tool = createBashTool(shell);
    const result = await tool.handler({ command: "test", run_in_background: true });
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
    // The description must use the real Zod field name, or a model that
    // follows it sends the wrong case and Zod silently drops the flag.
    expect(tool.definition.description).toMatch(/run_in_background/);
    expect(tool.definition.description).not.toMatch(/runInBackground/);
  });

  it("background launch result explains how to read output", async () => {
    const tool = createBashTool(mockShellWithLaunch(""));
    const result = await tool.handler({ command: "long-task", run_in_background: true });
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

  // Residual fix from Task 6 review: run_in_background requested, no launch(),
  // session present → must still say background was unavailable, or the model
  // keeps expecting a PID from a call that actually blocked.
  it("session path notes when run_in_background was requested but launch is unavailable", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return { stdout: "session-ran", stderr: "", exitCode: 0 };
        },
      }),
    });
    const r = await tool.handler({ command: "echo x", run_in_background: true });
    expect(r.isError).toBeFalsy();
    expect(r.modelContent).toContain("session-ran");
    expect(r.modelContent).toMatch(/background/i);
    expect(r.modelContent).toMatch(/session|foreground/i);
    expect(r.displayMetadata?.backgroundFallback).toBe(true);
  });

  // Residual fix from Task 6 review: session output must go through the same
  // OUTPUT_LIMIT / show_full_output policy as the exec path.
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

  it("session path returns full output when show_full_output is true", async () => {
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
      show_full_output: true,
    });
    expect(r.modelContent).toBe(longOutput);
    expect(r.displayMetadata?.truncated).toBe(false);
    expect(r.displayMetadata?.fromSession).toBe(true);
  });
});

describe("bash bounded accumulation (non-session exec)", () => {
  it("F-184 bounds non-session accumulation and discloses dropped chars", async () => {
    const tool = createBashTool({
      async *exec() {
        const chunk = "x".repeat(10_000);
        for (let i = 0; i < 30; i++) yield { type: "stdout", data: chunk }; // 300k total
        yield { type: "exit", code: 0 };
      },
    });
    const r = await tool.handler({ command: "big" });
    // kept text is capped at OUTPUT_LIMIT even though 300k arrived
    expect(r.modelContent).toContain("output truncated: 300000 chars total");
    expect(String(r.modelContent).length).toBeLessThanOrEqual(100_000 + 200);
    expect(r.displayMetadata?.totalLength).toBe(300_000);
    expect(r.displayMetadata?.droppedChars).toBe(200_000);
    expect(r.displayMetadata?.truncated).toBe(true);
  });

  it("F-184 keeps small output byte-identical (regression)", async () => {
    const tool = createBashTool({
      async *exec() {
        yield { type: "stdout", data: "hi" };
        yield { type: "exit", code: 0 };
      },
    });
    const r = await tool.handler({ command: "small" });
    expect(r.modelContent).toContain("hi");
    expect(r.displayMetadata?.droppedChars).toBeUndefined();
  });
});

describe("bash timeout classification (F-232, spec D3/§6)", () => {
  // (a) exec path: the shell adapter's own timer sets exit.timedOut →
  // the result must be an error carrying the unified signature, with the
  // existing (exit code: N) tail note preserved (spec §6 row 1).
  it("exec path: timedOut exit → isError + unified signature + exit-code tail", async () => {
    const tool = createBashTool({
      async *exec() {
        yield { type: "stdout", data: "partial" };
        yield { type: "exit", code: 143, timedOut: true };
      },
    });
    const r = await tool.handler({ command: "sleep 60" });
    expect(r.isError).toBe(true);
    // Default N comes from the shared DEFAULT_TIMEOUTS.tool table.
    expect(r.modelContent).toContain(
      `[timeout] bash timed out after ${DEFAULT_TIMEOUTS.tool}ms`,
    );
    expect(r.modelContent).toContain("(exit code: 143)");
    expect(r.displayMetadata?.timedOut).toBe(true);
  });

  // (b) Non-timeout failure stays byte-identical (spec §6 row 2: exit 1 is
  // still NOT an error — this classification grants no new authority).
  it("exec path: non-timeout exit 1 stays byte-identical (regression)", async () => {
    const tool = createBashTool(mockShell("", "error occurred", 1));
    const r = await tool.handler({ command: "failing-command" });
    expect(r.isError).toBeUndefined();
    expect(r.modelContent).toBe("\n[stderr]\nerror occurred\n(exit code: 1)");
  });

  // (c) per-call timeout override: the signature's N is the effective
  // per-call timeout, not the default.
  it("exec path: per-call timeout override renders that N in the signature", async () => {
    const tool = createBashTool({
      async *exec() {
        yield { type: "exit", code: 124, timedOut: true };
      },
    });
    const r = await tool.handler({ command: "sleep 60", timeout: 500 });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toContain("[timeout] bash timed out after 500ms");
    expect(r.modelContent).toContain("(exit code: 124)");
  });

  // (d) session path: a BashSessionLike result carrying timedOut gets the
  // same classification (mock-port level; persistent-session sets the field
  // on its own timeout path — pinned in runtime-node's tests).
  it("session path: timedOut result → isError + unified signature", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return {
            stdout: "",
            stderr: "",
            exitCode: 124,
            timedOut: true,
            stateResetReason:
              "Session was rebuilt after a stuck command. Working directory and environment variables were reset to the session defaults.",
          };
        },
      }),
    });
    const r = await tool.handler({ command: "sleep 60" });
    expect(r.isError).toBe(true);
    expect(r.modelContent).toContain(
      `[timeout] bash timed out after ${DEFAULT_TIMEOUTS.tool}ms`,
    );
    expect(r.modelContent).toContain("(exit code: 124)");
    expect(r.displayMetadata?.timedOut).toBe(true);
  });

  // (d2) Session results without timedOut keep the existing semantics —
  // a rebuilt session with exit 124 is still not classified as an error
  // unless the session says it was a timeout.
  it("session path: result without timedOut keeps existing classification", async () => {
    const tool = createBashTool(mockShell(""), {
      getSession: () => ({
        async run() {
          return {
            stdout: "kept",
            stderr: "",
            exitCode: 0,
          };
        },
      }),
    });
    const r = await tool.handler({ command: "echo kept" });
    expect(r.isError).toBeUndefined();
    expect(r.modelContent).toBe("kept");
  });
});
