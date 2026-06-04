/**
 * Node Shell adapter — implements the Shell port using child_process.spawn.
 * Streams stdout/stderr/exit events as an AsyncIterable<ShellEvent>.
 * Also supports `launch()` for background process execution.
 */

import type { Shell, ShellExecOptions, ShellEvent } from "@agent-core/core";
import { spawn, type ChildProcess } from "node:child_process";

export interface NodeShellOptions {
  /** Default working directory (can be overridden per-exec) */
  defaultCwd?: string;
}

export function createNodeShell(options?: NodeShellOptions): Shell {
  const backgroundProcesses = new Map<string, ChildProcess>();

  function resolveCwd(cwd?: string): string {
    return cwd ?? options?.defaultCwd ?? process.cwd();
  }

  return {
    async *exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
      const cwd = resolveCwd(opts?.cwd);
      const child: ChildProcess = spawn(cmd, [], {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timer: ReturnType<typeof setTimeout> | undefined;

      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
        }, opts.timeout);
      }

      const abortHandler = (): void => {
        child.kill("SIGTERM");
      };

      if (opts?.abortSignal) {
        if (opts.abortSignal.aborted) {
          child.kill("SIGTERM");
        } else {
          opts.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      try {
        if (child.stdout) {
          for await (const chunk of child.stdout) {
            yield { type: "stdout", data: chunk.toString() };
          }
        }

        if (child.stderr) {
          for await (const chunk of child.stderr) {
            yield { type: "stderr", data: chunk.toString() };
          }
        }

        const exitCode: number = await new Promise<number>((resolve) => {
          child.on("close", (code) => resolve(code ?? 1));
        });

        yield { type: "exit", code: exitCode };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (opts?.abortSignal) {
          opts.abortSignal.removeEventListener("abort", abortHandler);
        }
      }
    },

    async launch(cmd: string, opts?: Omit<ShellExecOptions, "runInBackground">): Promise<string> {
      const cwd = resolveCwd(opts?.cwd);
      const child: ChildProcess = spawn(cmd, [], {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const pid = String(child.pid ?? Date.now());
      backgroundProcesses.set(pid, child);

      child.on("close", () => {
        backgroundProcesses.delete(pid);
      });

      return pid;
    },
  };
}
