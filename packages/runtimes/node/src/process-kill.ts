/**
 * Terminating a child that was spawned through a shell (`shell: true`) or
 * through a sandbox wrapper.
 *
 * On POSIX `/bin/sh -c "sleep 10"` forks instead of exec'ing, so the direct
 * child is the shell and the work runs in a grandchild. Signalling only the
 * shell leaves the grandchild holding the stdout/stderr pipes, and with them
 * the parent's `close` event — a 500 ms timeout "stops" the command only when
 * the underlying `sleep` finishes.
 *
 * The fix is the process group: those children are spawned with
 * `detached: process.platform !== "win32"`, which makes each one the leader of
 * a new group whose id equals its pid, and termination signals `-pid` (the
 * group) instead of `pid`. Detached without `unref()` is still reaped and
 * still gets its `close` event — it only drops the parent's controlling
 * terminal, which is exactly what a background host wants.
 */

import type { ChildProcess } from "node:child_process";

/**
 * `detached` for a child whose tree may have to be killed as a unit; use it
 * only where the child is later signalled through {@link killProcessTree}.
 */
export const DETACHED_ON_POSIX: boolean = process.platform !== "win32";

/**
 * Whether `child` has a process group worth signalling.
 *
 * Only `pid` decides. A child whose spawn FAILED (ENOENT, EACCES, a missing
 * cwd) reports `pid === undefined`, and `ChildProcess.kill()` on it is not a
 * no-op: libuv sends nothing, but the call is still reported as a delivery
 * failure, and on some platforms that failure is observable to the CALLER's
 * process group.
 *
 * `exitCode` / `signalCode` deliberately do NOT take part: when this process
 * is the group leader, the shell exits on the SIGTERM while the command it
 * forked keeps running, so the leader reports `signalCode === "SIGTERM"` at
 * exactly the moment the group SIGKILL must still be delivered. Gating on
 * those codes would make the escalation a no-op in the case it exists for.
 * Signalling a group whose members are all gone fails with ESRCH, which the
 * fallback below already tolerates.
 */
function hasProcessGroup(child: ChildProcess): boolean {
  return child.pid !== undefined;
}

/**
 * Signal a child and everything it started. Never throws: a process that
 * already exited is the normal case here, not an error.
 *
 * POSIX: signal the process group `-pid`, falling back to the direct child
 * when the group is already gone (ESRCH) or cannot be signalled (EPERM). The
 * group id is the child's pid only because callers spawn it detached; a child
 * spawned without `detached` shares the parent's group, and `-pid` would then
 * name the caller's own group — which is why a child that never started is
 * refused outright instead of falling back. Windows has no process-group
 * signal, so the direct child is the only target.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!hasProcessGroup(child)) return;
  const pid = child.pid!;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // ESRCH (group already gone) or EPERM — fall through to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already dead — nothing to reap.
  }
}