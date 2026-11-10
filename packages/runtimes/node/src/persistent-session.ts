import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
  /**
   * True when this result was produced by the session's own timeout path
   * (stuck-command recovery). Optional: ordinary results carry no key, so
   * consumers can trust its absence as "not a timeout".
   */
  timedOut?: boolean;
  /**
   * The session's working directory once this command finished. Absent when
   * the shell never reported it (timeout/kill rebuild, or the shell died
   * before printing the sentinel) — consumers must treat absence as "unknown"
   * rather than guessing. A per-call `cwd` runs in a subshell and therefore
   * does NOT move the session, so this stays the session's own directory.
   */
  cwdAfter?: string;
  /**
   * True only when this command moved the session to a DIFFERENT directory.
   * Computed here, against the directory the session was known to be in, with
   * both sides resolved to their physical path: the spawn cwd and the shell's
   * `$PWD` may spell one place two ways (macOS `/var` vs `/private/var`), and a
   * spelling difference is not a move.
   */
  cwdChanged?: boolean;
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
  /** Retention cap per stream, in characters. Default DEFAULT_SESSION_BUFFER_CHARS. */
  maxBufferChars?: number;
}

export const DEFAULT_SESSION_BUFFER_CHARS = 256 * 1024;

const DROPPED_NOTE_PREFIX = "Earlier output was dropped (";

function droppedNote(dropped: number): string {
  return dropped > 0 ? `${DROPPED_NOTE_PREFIX}${dropped} chars)\n` : "";
}

export interface PersistentSession {
  readonly id: string;
  readonly alive: boolean;
  run(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<SessionCommandResult>;
  /**
   * The directory the shell is in right now: the last reported one, or the
   * spawn cwd before any command has reported. Never spawns anything.
   */
  cwd(): string | undefined;
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

/**
 * The directory a path really points at, for change detection only. A path
 * that no longer exists (the shell moved out of a deleted dir) falls back to
 * its own spelling — "different" is still the honest answer there.
 */
function physicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Best-effort signal; a process that already exited must not throw. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/**
 * Wait until the child process itself has exited (exitCode or signalCode
 * set, or an exit/close event). A grandchild holding the stdio pipes must
 * not block us forever, so this is bounded by `timeoutMs`.
 */
function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
  });
}

export function createPersistentSession(options: PersistentSessionOptions): PersistentSession {
  const id = `session-${++sessionSeq}`;
  const generateNonce =
    options.generateNonce ?? (() => randomBytes(8).toString("hex"));

  // Reassigned on rebuild (stuck-command recovery).
  let handle: SessionSpawnHandle = options.spawn({ cwd: options.cwd });
  let alive = true;
  let childExitCode: number | null = null;
  /**
   * Last working directory the shell reported. Seeded with the spawn cwd and
   * reset whenever the shell is rebuilt — a rebuilt shell starts at
   * `options.cwd`, so keeping the pre-rebuild value would point consumers at
   * a directory their next command does not run in.
   */
  let currentCwd: string | undefined = options.cwd;
  // Both streams are retention-capped: eviction happens on append so memory
  // is bounded even between commands. Evicted characters are counted per run
  // and disclosed on return — a cap that silently hides a gap would be
  // worse than the old unbounded buffer for the model's point of view.
  const cap = Math.max(1024, options.maxBufferChars ?? DEFAULT_SESSION_BUFFER_CHARS);
  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutDropped = 0;
  let stderrDropped = 0;
  // Set by the stdout listener once the current command's sentinel has been
  // seen. Matching is event-driven (once per chunk), never a regex over the
  // whole buffer on every 15ms poll. Absolute offsets are captured at match
  // time; eviction freezes while a match is pending, so the consume step can
  // map them back with a plain subtraction.
  let activeMarkerRe: RegExp | null = null;
  let stdoutMatch: { startAbs: number; endAbs: number; code: number; cwd?: string } | null = null;

  function resetRunBuffers(): void {
    stdoutBuf = "";
    stderrBuf = "";
    stdoutDropped = 0;
    stderrDropped = 0;
    stdoutMatch = null;
    activeMarkerRe = null;
  }
  // Serializes run() — a persistent shell is a single ordered pipeline.
  let queue: Promise<unknown> = Promise.resolve();
  // Guards cleanup() so signal-death + kill() cannot double-call it.
  let cleanedUp = false;
  // Set once kill() is called. interruptAndRebuild's grace-period sleep has
  // no way to observe a concurrent kill()/dispose() otherwise — without this
  // flag, the sleep resolving after dispose() would unconditionally spawn a
  // fresh bash (and its sandbox-exec/bwrap parent) that nothing holds a
  // reference to, leaking it for the life of the host process.
  let disposed = false;

  /**
   * Bind stdio/close listeners for a spawn handle. Used for the first
   * spawn and again after a rebuild. Listeners ignore events from a child
   * that is no longer the current one (a late close from a killed shell
   * must not flag the rebuilt session as dead).
   */
  function attachStreams(h: SessionSpawnHandle): void {
    const child = h.child;
    child.stdout?.on("data", (c: Buffer) => {
      if (handle.child !== child) return;
      stdoutBuf += c.toString("utf8");
      if (stdoutMatch) {
        // Positions were captured at match time; eviction is frozen so the
        // consume step's offsets stay valid. Appends continue — a trailing
        // background writer's output belongs to the post-marker remainder.
        return;
      }
      if (stdoutBuf.length > cap) {
        const excess = stdoutBuf.length - cap;
        stdoutBuf = stdoutBuf.slice(excess);
        stdoutDropped += excess;
      }
      // Sentinel scan runs once per chunk here — never in the poll loop.
      const re = activeMarkerRe;
      if (re) {
        const m = re.exec(stdoutBuf);
        if (m && m.index >= 0) {
          const code = Number.parseInt(m[1]!, 10);
          stdoutMatch = {
            startAbs: stdoutDropped + m.index,
            endAbs: stdoutDropped + m.index + m[0].length,
            code,
            ...(m[2] !== undefined && m[2] !== "" ? { cwd: m[2] } : {}),
          };
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (handle.child !== child) return;
      stderrBuf += c.toString("utf8");
      if (stderrBuf.length > cap) {
        const excess = stderrBuf.length - cap;
        stderrBuf = stderrBuf.slice(excess);
        stderrDropped += excess;
      }
    });
    child.on("close", (code) => {
      if (handle.child !== child) return;
      alive = false;
      childExitCode = code;
    });
  }

  function runCleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    handle.cleanup?.();
  }

  attachStreams(handle);

  async function kill(): Promise<void> {
    disposed = true;
    // Signal-death sets signalCode and leaves exitCode null; keying the
    // early-return on exitCode alone misses that case and double-cleans.
    if (!alive) {
      runCleanup();
      return;
    }
    signalChild(handle.child, "SIGKILL");
    await waitForProcessExit(handle.child, 2000);
    alive = false;
    runCleanup();
  }

  /**
   * Stuck-command recovery chain (spec §7):
   * timeout → SIGINT → gracePeriodMs → SIGKILL → cleanup → respawn.
   * The rebuilt session starts at options.cwd with a clean environment, so
   * the result carries an explicit stateResetReason the model must see.
   * Its only caller is runOnce's timeout branch, so every result produced
   * here is a timeout result and carries timedOut: true.
   */
  async function interruptAndRebuild(reason: string): Promise<SessionCommandResult> {
    const stale = handle;
    signalChild(stale.child, "SIGINT");
    await sleep(options.gracePeriodMs ?? 2000);
    if (stale.child.exitCode === null && stale.child.signalCode === null) {
      signalChild(stale.child, "SIGKILL");
      await waitForProcessExit(stale.child, 2000);
    }
    // Drop stdio so a grandchild holding the pipes cannot wedge cleanup.
    stale.child.stdin?.destroy();
    stale.child.stdout?.destroy();
    stale.child.stderr?.destroy();
    stale.cleanup?.();
    // A concurrent kill()/dispose() may have landed while we were asleep —
    // it has no way to interrupt this sleep, so it can only set `disposed`.
    // Spawning a fresh bash (and its sandbox-exec/bwrap parent) here would
    // orphan it: nothing holds a reference to this session anymore.
    if (disposed) {
      alive = false;
      return {
        stdout: "",
        stderr: reason,
        exitCode: 124,
        timedOut: true,
        stateResetReason: "session was disposed while recovering from a stuck command",
      };
    }
    handle = options.spawn({ cwd: options.cwd });
    cleanedUp = false;
    resetRunBuffers();
    childExitCode = null;
    // The rebuilt shell starts at options.cwd; the pre-rebuild directory is
    // gone with the old process, so reporting it would be a lie.
    currentCwd = options.cwd;
    attachStreams(handle);
    alive = true;
    return {
      stdout: "",
      stderr: reason,
      exitCode: 124,
      timedOut: true,
      stateResetReason:
        "Session was rebuilt after a stuck command. " +
        "Working directory and environment variables were reset to the session defaults.",
    };
  }

  async function runOnce(
    cmd: string,
    timeoutMs: number,
    cwd?: string,
  ): Promise<SessionCommandResult> {
    cmd = wrapWithCwd(cmd, cwd);
    const nonce = generateNonce();
    // Deliberately NOT anchored to the end of the buffer. A job left running
    // with `&` inherits the session's stdout and keeps appending after the
    // sentinel; an end-anchored match would never fire again, turning a
    // finished command into a phantom stuck command that burns the whole
    // timeout and resets cd/export state. The per-command random nonce is
    // what rules out a false positive (spec §6.1) — the anchor was a
    // redundant second lock that cost more than it bought.
    const markerRe = new RegExp(
      `\\n__VOLTO_DONE_${escapeRegex(nonce)}:(\\d+):([^\\n]*)\\n`,
    );
    resetRunBuffers();
    activeMarkerRe = markerRe;
    // The printf is a separate stdin line so `$?` captures the user command.
    // A leading `\n` keeps the marker readable even when the command's own
    // output does not end with a newline. `$PWD` rides the same line: the
    // sentinel is already stripped from the model-visible output, so the
    // working directory costs no extra protocol and cannot leak.
    // `$PWD` is escaped shell-side: a directory name may legally contain a
    // newline, which would cut the marker line short and leave a BOGUS path in
    // `cwdAfter` (and in every later reminder). Escaping it as a literal `\n`
    // keeps the report faithful instead of inventing a neighbouring path.
    const payload =
      `${cmd}\n` +
      `__volto_rc=$?; __volto_pwd="\${PWD//$'\\n'/\\\\n}"; ` +
      `printf '\\n__VOLTO_DONE_${nonce}:%d:%s\\n' "$__volto_rc" "$__volto_pwd"\n`;
    handle.child.stdin?.write(payload);

    const start = Date.now();
    for (;;) {
      const match = stdoutMatch;
      if (match) {
        // Offsets are absolute within this run's stream; eviction froze at
        // match time, so mapping back is a plain subtraction.
        const pos = Math.max(0, match.startAbs - stdoutDropped);
        const end = Math.max(0, match.endAbs - stdoutDropped);
        const stdout = droppedNote(stdoutDropped) + stdoutBuf.slice(0, pos);
        const remainder = stdoutBuf.slice(end);
        const stderr = droppedNote(stderrDropped) + stderrBuf;
        const { code, cwd } = match;
        resetRunBuffers();
        // Post-marker tail (background writer) carries into the next run.
        stdoutBuf = remainder;
        // Compare physical paths: the shell reports the logical `$PWD`, and a
        // symlinked or differently-spelled spawn cwd must not read as a move.
        const cwdChanged =
          cwd !== undefined &&
          currentCwd !== undefined &&
          physicalPath(cwd) !== physicalPath(currentCwd);
        if (cwd !== undefined) currentCwd = cwd;
        return {
          stdout,
          stderr,
          exitCode: Number.isFinite(code) ? code : 1,
          ...(cwd !== undefined ? { cwdAfter: cwd, cwdChanged } : {}),
        };
      }
      // Shell died before printing a sentinel (e.g. the command called exit).
      // Surface the process exit code so `run("exit 3")` yields 3.
      if (!alive) {
        const stdout = droppedNote(stdoutDropped) + stdoutBuf;
        const stderr = droppedNote(stderrDropped) + stderrBuf;
        resetRunBuffers();
        return {
          stdout,
          stderr,
          exitCode: childExitCode ?? 1,
          stateResetReason: "session exited",
        };
      }
      if (Date.now() - start > timeoutMs) {
        return interruptAndRebuild("command timed out");
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  return {
    id,
    get alive() {
      return alive;
    },
    cwd() {
      return currentCwd;
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
