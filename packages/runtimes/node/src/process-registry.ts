/**
 * Background process registry — tracks shell-launched background processes
 * with per-process ring buffers, incremental reads, and lifecycle control.
 *
 * launch() attaches stdout/stderr data listeners immediately and drains
 * BOTH streams concurrently into the ring buffer (the §2.1 deadlock is
 * what happens when pipes are opened and never read).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ShellLaunchOptions, ShellProcessInfo, ShellProcessOutput } from "@volto/core";
import {
  createProcessOutputBuffer,
  DEFAULT_PROCESS_BUFFER_BYTES,
  type ProcessOutputBuffer,
} from "./process-buffer.js";

export interface ProcessRegistryOptions {
  maxBackground?: number;
  bufferCapacityBytes?: number;
  defaultCwd?: string;
}

export interface ProcessRegistry {
  launch(cmd: string, opts?: ShellLaunchOptions): Promise<string>;
  readOutput(id: string, cursor?: string): Promise<ShellProcessOutput>;
  kill(id: string): Promise<void>;
  list(): ShellProcessInfo[];
  disposeAll(): Promise<void>;
}

interface Entry {
  id: string;
  child: ChildProcess;
  command: string;
  pid: number;
  buffer: ProcessOutputBuffer;
  running: boolean;
  exitCode?: number;
}

export const DEFAULT_MAX_BACKGROUND = 8;

export function createProcessRegistry(options?: ProcessRegistryOptions): ProcessRegistry {
  const maxBackground = options?.maxBackground ?? DEFAULT_MAX_BACKGROUND;
  const bufferCapacity = options?.bufferCapacityBytes ?? DEFAULT_PROCESS_BUFFER_BYTES;
  const entries = new Map<string, Entry>();
  let seq = 0;

  function resolveCwd(cwd?: string): string {
    return cwd ?? options?.defaultCwd ?? process.cwd();
  }

  function get(id: string): Entry {
    const e = entries.get(id);
    if (!e) throw new Error(`Process not found: ${id}`);
    return e;
  }

  async function killEntry(e: Entry): Promise<void> {
    if (!e.running) return;
    e.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (e.running) e.child.kill("SIGKILL");
        resolve();
      }, 2000);
      e.child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  return {
    async launch(cmd, opts): Promise<string> {
      const runningCount = [...entries.values()].filter((e) => e.running).length;
      if (runningCount >= maxBackground) {
        throw new Error(
          `Background process limit reached (${maxBackground}). ` +
            `Kill an existing process (kill_shell) before launching another.`,
        );
      }
      const child = spawn(cmd, [], {
        cwd: resolveCwd(opts?.cwd),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Omit `env` entirely when not supplied so the child inherits
        // process.env (spawn's default). Passing an explicit env replaces
        // the whole environment — same semantics as exec().
        ...(opts?.env ? { env: opts.env } : {}),
      });
      const id = `bg-${++seq}-${child.pid ?? 0}`;
      const buffer = createProcessOutputBuffer(bufferCapacity);
      const entry: Entry = {
        id,
        child,
        command: cmd,
        pid: child.pid ?? 0,
        buffer,
        running: true,
      };
      entries.set(id, entry);

      // Consume BOTH streams concurrently — the §2.1 deadlock is exactly
      // what happens when pipes are opened and never read.
      child.stdout?.on("data", (chunk: Buffer) => buffer.append(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => buffer.append(chunk.toString("utf8")));

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeout && opts.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          if (entry.running) void killEntry(entry);
        }, opts.timeout);
      }

      child.on("close", (code) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        entry.running = false;
        entry.exitCode = code ?? 1;
      });

      // Without an error listener a spawn failure (bad cwd, missing shell)
      // becomes an unhandled 'error' event and can crash the host.
      child.on("error", () => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        entry.running = false;
        entry.exitCode = entry.exitCode ?? 1;
      });

      return id;
    },

    async readOutput(id, cursor): Promise<ShellProcessOutput> {
      const e = get(id);
      const r = e.buffer.read(cursor);
      return {
        text: r.text,
        cursor: r.cursor,
        overflowed: r.overflowed,
        droppedBytes: r.droppedBytes,
      };
    },

    async kill(id): Promise<void> {
      await killEntry(get(id));
    },

    list(): ShellProcessInfo[] {
      return [...entries.values()].map((e) => ({
        id: e.id,
        pid: e.pid,
        command: e.command,
        kind: "background" as const,
        running: e.running,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      }));
    },

    async disposeAll(): Promise<void> {
      await Promise.all([...entries.values()].map(killEntry));
    },
  };
}
