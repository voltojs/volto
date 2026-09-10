/**
 * Node Shell adapter — implements the Shell port using child_process.spawn.
 * Streams stdout/stderr/exit events as an AsyncIterable<ShellEvent>.
 * Also supports `launch()` for background process execution.
 *
 * Key design: stdout and stderr are consumed CONCURRENTLY via event listeners
 * pushed into a shared async queue, preventing pipe-buffer deadlock when a
 * command produces large amounts on both streams simultaneously.
 */

import type { Shell, ShellExecOptions, ShellEvent } from "@volto/core";
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
        // Omit `env` entirely when not supplied so the child inherits
        // process.env (spawn's default). Passing an explicit env replaces
        // the whole environment — that is what the sandbox relies on to
        // strip secret-bearing variables.
        ...(opts?.env ? { env: opts.env } : {}),
      });

      // Shared async queue — stdout and stderr events are pushed here
      // concurrently, so the consumer never blocks one stream on the other.
      const queue: ShellEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;
      let exitYielded = false;

      function enqueue(event: ShellEvent): void {
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
        queue.push(event);
      }

      // Timeout — SIGTERM then SIGKILL after 2s grace period.
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
        }, opts.timeout);
      }

      // AbortSignal — terminate on abort.
      const abortHandler = (): void => { child.kill("SIGTERM"); };
      if (opts?.abortSignal) {
        if (opts.abortSignal.aborted) {
          child.kill("SIGTERM");
        } else {
          opts.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      // Attach stdout/stderr listeners — they write to the shared queue
      // concurrently, preventing pipe-buffer deadlock.
      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          enqueue({ type: "stdout", data: chunk.toString() });
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          enqueue({ type: "stderr", data: chunk.toString() });
        });
      }

      // Close event resolves the drain promise.
      child.on("close", (code) => {
        closed = true;
        enqueue({ type: "exit", code: code ?? 1 });
      });

      try {
        // Drain the queue: yield events as they arrive, wait when empty.
        while (true) {
          if (queue.length > 0) {
            const event = queue.shift()!;
            if (event.type === "exit") exitYielded = true;
            yield event;
            if (event.type === "exit") return;
          } else if (closed && queue.length === 0) {
            // Process exited and queue is drained.
            return;
          } else {
            // Wait for the next event.
            await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (opts?.abortSignal) {
          opts.abortSignal.removeEventListener("abort", abortHandler);
        }
        // Safety: if exit was never yielded (e.g. generator externally
        // closed), yield it now so consumers always see the exit code.
        if (!exitYielded) {
          yield { type: "exit", code: -1 };
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

      const pid = String(child.pid ?? 0);
      backgroundProcesses.set(pid, child);

      child.on("close", () => {
        backgroundProcesses.delete(pid);
      });

      return pid;
    },
  };
}
