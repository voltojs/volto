import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";

export interface SessionCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Non-null when the session had to be killed and rebuilt because of a
   * timeout. The tool layer MUST surface this to the model.
   */
  stateResetReason?: string;
}

export interface SessionSpawnHandle {
  child: ChildProcess;
  cleanup?: () => void;
}

export interface PersistentSessionOptions {
  /** Factory for the long-lived bash (already sandbox-wrapped if needed). */
  spawn: (opts: { cwd: string }) => SessionSpawnHandle;
  cwd: string;
  defaultTimeoutMs: number;
  /** SIGINT → kill+rebuild grace period. Default 2000. */
  gracePeriodMs?: number;
  /** Injectable for deterministic tests. Default: crypto.randomBytes(8).toString("hex") */
  generateNonce?: () => string;
}

export interface PersistentSession {
  readonly id: string;
  readonly alive: boolean;
  run(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<SessionCommandResult>;
  kill(): Promise<void>;
}

let sessionSeq = 0;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scope a command to a per-call working directory without moving the
 * long-lived session. Subshell semantics: `cd` (and any other state the
 * command mutates) dies with the subshell.
 */
function wrapWithCwd(cmd: string, cwd?: string): string {
  if (!cwd) return cmd;
  // Escape single quotes for embedding in a subshell.
  const escaped = cwd.replace(/'/g, "'\\''");
  return `(cd '${escaped}' && ${cmd})`;
}

export function createPersistentSession(options: PersistentSessionOptions): PersistentSession {
  const id = `session-${++sessionSeq}`;
  const generateNonce =
    options.generateNonce ?? (() => randomBytes(8).toString("hex"));

  // Task 5 rebuilds the session by replacing this handle; keep the binding name stable.
  const handle: SessionSpawnHandle = options.spawn({ cwd: options.cwd });
  let alive = true;
  let childExitCode: number | null = null;
  let stdoutBuf = "";
  let stderrBuf = "";
  // Serializes run() — a persistent shell is a single ordered pipeline.
  let queue: Promise<unknown> = Promise.resolve();

  handle.child.stdout?.on("data", (c: Buffer) => {
    stdoutBuf += c.toString("utf8");
  });
  handle.child.stderr?.on("data", (c: Buffer) => {
    stderrBuf += c.toString("utf8");
  });
  handle.child.on("close", (code) => {
    alive = false;
    childExitCode = code;
  });

  async function kill(): Promise<void> {
    if (!alive && handle.child.exitCode !== null) {
      handle.cleanup?.();
      return;
    }
    handle.child.kill("SIGKILL");
    await new Promise<void>((r) => {
      if (!alive) return r();
      handle.child.once("close", () => r());
    });
    handle.cleanup?.();
    alive = false;
  }

  async function runOnce(
    cmd: string,
    timeoutMs: number,
    cwd?: string,
  ): Promise<SessionCommandResult> {
    cmd = wrapWithCwd(cmd, cwd);
    const nonce = generateNonce();
    const markerRe = new RegExp(`\\n__VOLTO_DONE_${escapeRegex(nonce)}:(\\d+)\\n?$`);
    stdoutBuf = "";
    stderrBuf = "";
    // The printf is a separate stdin line so `$?` captures the user command.
    // A leading `\n` keeps the marker readable even when the command's own
    // output does not end with a newline.
    const payload =
      `${cmd}\n` +
      `__volto_rc=$?; printf '\\n__VOLTO_DONE_${nonce}:%d\\n' "$__volto_rc"\n`;
    handle.child.stdin?.write(payload);

    const start = Date.now();
    for (;;) {
      const m = markerRe.exec(stdoutBuf);
      if (m && m.index >= 0) {
        const code = Number.parseInt(m[1]!, 10);
        // m.index points at the '\n' that precedes __VOLTO_DONE_...
        const stdout = stdoutBuf.slice(0, m.index);
        stdoutBuf = stdoutBuf.slice(m.index + m[0].length);
        const stderr = stderrBuf;
        stderrBuf = "";
        return { stdout, stderr, exitCode: Number.isFinite(code) ? code : 1 };
      }
      // Shell died before printing a sentinel (e.g. the command called exit).
      // Surface the process exit code so `run("exit 3")` yields 3.
      if (!alive) {
        const stdout = stdoutBuf;
        stdoutBuf = "";
        const stderr = stderrBuf;
        stderrBuf = "";
        return {
          stdout,
          stderr,
          exitCode: childExitCode ?? 1,
          stateResetReason: "session exited",
        };
      }
      if (Date.now() - start > timeoutMs) {
        // Task 5 replaces this with SIGINT → grace → kill+rebuild.
        return {
          stdout: "",
          stderr: "timeout",
          exitCode: 124,
          stateResetReason: "timeout",
        };
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  return {
    id,
    get alive() {
      return alive;
    },
    async run(cmd, opts) {
      const task = queue.then(async () => {
        if (!alive) {
          return {
            stdout: "",
            stderr: "session is dead",
            exitCode: 1,
            stateResetReason: "session already dead",
          };
        }
        const timeout = opts?.timeout ?? options.defaultTimeoutMs;
        return runOnce(cmd, timeout, opts?.cwd);
      });
      queue = task.catch(() => undefined);
      return task;
    },
    kill,
  };
}
