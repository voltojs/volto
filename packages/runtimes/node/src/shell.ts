/**
 * Node Shell adapter — implements the Shell port using child_process.spawn.
 * Streams stdout/stderr/exit events as an AsyncIterable<ShellEvent>.
 * Also supports `launch()` for background process execution; launch also
 * drains both streams concurrently into a ring buffer via the process
 * registry (prevents pipe-buffer deadlock when a command writes >64 KB).
 *
 * Key design: stdout and stderr are consumed CONCURRENTLY via event listeners
 * pushed into a shared async queue, preventing pipe-buffer deadlock when a
 * command produces large amounts on both streams simultaneously.
 */

import type { Shell, ShellExecOptions, ShellEvent } from "@voltojs/core";
import { spawn, type ChildProcess } from "node:child_process";
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js";
import { DETACHED_ON_POSIX, killProcessTree } from "./process-kill.js";

export interface NodeShellOptions {
  /** Default working directory (can be overridden per-exec) */
  defaultCwd?: string;
  /** Maximum concurrent background processes (default: 8) */
  maxBackgroundProcesses?: number;
  /** Per-process output ring buffer capacity in bytes (default: 256 KiB) */
  processBufferBytes?: number;
}

export function createNodeShell(options?: NodeShellOptions): Shell {
  const registry: ProcessRegistry = createProcessRegistry({
    defaultCwd: options?.defaultCwd,
    maxBackground: options?.maxBackgroundProcesses,
    bufferCapacityBytes: options?.processBufferBytes,
  });

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
        // Own process group so a timeout/abort can kill the command the shell
        // forked, not only the shell itself (see process-kill.ts).
        detached: DETACHED_ON_POSIX,
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
      let drained = false;
      let exitYielded = false;

      function enqueue(event: ShellEvent): void {
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
        queue.push(event);
      }

      // True once the child's `close` fired: both output streams are drained
      // and nothing is left to escalate to.
      let closed = false;
      // Timeout — SIGTERM, then SIGKILL after a 2s grace period. The
      // escalation is keyed on `closed`, never on `child.killed`:
      // `killed` flips to true after ANY signal attempt, which made the
      // SIGKILL unreachable and a command that ignores SIGTERM unkillable.
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const escalateLater = (): void => {
        if (escalation !== undefined || closed) return;
        escalation = setTimeout(() => {
          escalation = undefined;
          if (!closed) killProcessTree(child, "SIGKILL");
        }, 2000);
      };
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(child, "SIGTERM");
          escalateLater();
        }, opts.timeout);
      }

      // AbortSignal — terminate on abort.
      const abortHandler = (): void => {
        killProcessTree(child, "SIGTERM");
        escalateLater();
      };
      if (opts?.abortSignal) {
        if (opts.abortSignal.aborted) {
          abortHandler();
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

      // Close event resolves the drain promise. The `timedOut` key is
      // carried only when this adapter's own timeout timer fired — external
      // abortSignal kills and ordinary exits keep the original wire shape.
      child.on("close", (code) => {
        closed = true;
        drained = true;
        if (escalation !== undefined) clearTimeout(escalation);
        escalation = undefined;
        enqueue({ type: "exit", code: code ?? 1, ...(timedOut ? { timedOut: true } : {}) });
      });

      try {
        // Drain the queue: yield events as they arrive, wait when empty.
        while (true) {
          if (queue.length > 0) {
            const event = queue.shift()!;
            if (event.type === "exit") exitYielded = true;
            yield event;
            if (event.type === "exit") return;
          } else if (drained && queue.length === 0) {
            // Process exited and queue is drained.
            return;
          } else {
            // Wait for the next event.
            await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (escalation !== undefined) clearTimeout(escalation);
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
      return registry.launch(cmd, opts);
    },

    async readProcessOutput(id: string, cursor?: string) {
      return registry.readOutput(id, cursor);
    },

    async killProcess(id: string) {
      return registry.kill(id);
    },

    listProcesses() {
      return registry.list();
    },

    async disposeProcesses() {
      return registry.disposeAll();
    },
  };
}
