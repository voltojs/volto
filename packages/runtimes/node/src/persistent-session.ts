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

export function createPersistentSession(options: PersistentSessionOptions): PersistentSession {
  const id = `session-${++sessionSeq}`;
  const generateNonce =
    options.generateNonce ?? (() => randomBytes(8).toString("hex"));

  // Task 5 rebuilds the session by replacing this handle; keep the binding name stable.
  const handle: SessionSpawnHandle = options.spawn({ cwd: options.cwd });
  let alive = true;
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
  handle.child.on("close", () => {
    alive = false;
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

  return {
    id,
    get alive() {
      return alive;
    },
    async run(cmd, opts) {
      // Marker protocol arrives in Task 2; skeleton just writes and yields.
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
        void timeout;
        void generateNonce;
        // Temporary: write command only — Task 2 replaces this body.
        handle.child.stdin?.write(`${cmd}\n`);
        await new Promise((r) => setTimeout(r, 50));
        const out = stdoutBuf;
        stdoutBuf = "";
        const err = stderrBuf;
        stderrBuf = "";
        return { stdout: out, stderr: err, exitCode: 0 };
      });
      queue = task.catch(() => undefined);
      return task;
    },
    kill,
  };
}
