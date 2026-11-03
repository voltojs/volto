import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPersistentSession, type PersistentSession } from "../persistent-session.js";

const sessions: PersistentSession[] = [];
let lastChild: ChildProcess | undefined;

function pidAlive(pid: number): boolean {
  try {
    execFileSync("ps", ["-p", String(pid)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeSession(overrides?: Partial<Parameters<typeof createPersistentSession>[0]>) {
  const s = createPersistentSession({
    spawn: ({ cwd }) => {
      const child = spawn("/bin/bash", ["-s"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      lastChild = child;
      return { child };
    },
    cwd: process.cwd(),
    defaultTimeoutMs: 30_000,
    ...overrides,
  });
  sessions.push(s);
  return s;
}
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.kill();
});

describe("persistent session skeleton", () => {
  it("starts a long-lived bash and kill() really stops it", async () => {
    const s = makeSession();
    expect(s.alive).toBe(true);
    expect(lastChild?.pid).toBeGreaterThan(0);
    const pid = lastChild!.pid!;
    expect(pidAlive(pid)).toBe(true);
    await s.kill();
    expect(s.alive).toBe(false);
    // OS-side: the long-lived bash must actually be gone, not just flagged dead.
    expect(pidAlive(pid)).toBe(false);
  });

  it("kill() is idempotent", async () => {
    const s = makeSession();
    await s.kill();
    await expect(s.kill()).resolves.toBeUndefined();
  });
});

describe("marker protocol", () => {
  it("returns stdout and the real exit code from the sentinel", async () => {
    const s = makeSession({
      generateNonce: () => "fixednonce",
    });
    const r = await s.run("echo hello");
    expect(r.stdout).toContain("hello");
    expect(r.stdout).not.toContain("__VOLTO_DONE_");
    expect(r.exitCode).toBe(0);
  });

  it("propagates non-zero exit codes", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    const r = await s.run("exit 3");
    expect(r.exitCode).toBe(3);
  });

  it("does not truncate early when command output contains a fake sentinel", async () => {
    const s = makeSession({ generateNonce: () => "realnonce" });
    // Emit a fake sentinel for a DIFFERENT nonce and a fake format that
    // must not match.
    const r = await s.run(
      `echo before; echo '__VOLTO_DONE_otherdeadbeef:0'; echo after`,
    );
    expect(r.stdout).toContain("before");
    expect(r.stdout).toContain("__VOLTO_DONE_otherdeadbeef:0");
    expect(r.stdout).toContain("after");
    expect(r.exitCode).toBe(0);
  });

  it("does not treat a same-nonce lookalike without newline boundaries as done", async () => {
    const s = makeSession({ generateNonce: () => "abc123" });
    // Mid-line lookalike: printf does NOT emit a leading newline for this echo,
    // so the session must wait for the real sentinel.
    const r = await s.run(`printf '%s' '__VOLTO_DONE_abc123:0'; echo tail`);
    expect(r.stdout).toContain("tail");
    expect(r.exitCode).toBe(0);
  });

  it("completes while a background job keeps writing to the shared stdout", async () => {
    // A job left running with `&` inherits the session's stdout and keeps
    // appending AFTER the sentinel. The sentinel must still be recognised —
    // anchoring the match to the end of the buffer turns `npm run dev &`
    // into a phantom stuck command that burns the whole timeout and
    // destroys the session's cd/export state.
    // The writer starts immediately and stays busy for far longer than one
    // poll tick, so the sentinel is reliably NOT the tail of the buffer.
    // Bounded on purpose — an unbounded flood starves the rest of the suite
    // when vitest runs files in parallel.
    const s = makeSession({ defaultTimeoutMs: 4000, gracePeriodMs: 300 });
    const t0 = Date.now();
    const r = await s.run("seq 1 100000 & echo started");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("started");
    expect(r.stateResetReason).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("captures stderr that belongs to the command", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    const r = await s.run("echo out; echo err 1>&2");
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("does not resolve before the sentinel arrives", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    const t0 = Date.now();
    const r = await s.run("sleep 0.25; echo done-waiting");
    const elapsed = Date.now() - t0;
    expect(r.stdout).toContain("done-waiting");
    expect(r.exitCode).toBe(0);
    // Must have waited for the command, not returned on a fixed sleep.
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it("times out when the command never finishes", async () => {
    const s = makeSession({
      generateNonce: () => "fixednonce",
      defaultTimeoutMs: 300,
      gracePeriodMs: 50,
    });
    // A stdin-reading builtin: the canonical stuck case from the spec.
    // Avoids forking a child that would hold stdio pipes open on kill().
    const r = await s.run("read -r");
    expect(r.exitCode).toBe(124);
    // Task 5: timeout no longer poisons the session — it rebuilds it.
    expect(r.stateResetReason).toMatch(/rebuilt/i);
    expect(s.alive).toBe(true);
  });

  // T9 Task 2 (F-232): the session's own timeout path is determinable —
  // every timeout funnels through interruptAndRebuild — so the result
  // carries timedOut for the bash tool to classify it as an error.
  it("marks its own timeout path with timedOut: true", async () => {
    const s = makeSession({
      generateNonce: () => "fixednonce",
      defaultTimeoutMs: 300,
      gracePeriodMs: 50,
    });
    const r = await s.run("read -r");
    expect(r.timedOut).toBe(true);
    expect(s.alive).toBe(true);
  });

  // Wire-shape regression: an ordinary result carries no timedOut key, so
  // consumers can trust the flag's absence as "not a timeout".
  it("does not carry timedOut on an ordinary result", async () => {
    const s = makeSession();
    const r = await s.run("echo plain-ok");
    expect(r.exitCode).toBe(0);
    expect(r).not.toHaveProperty("timedOut");
  });
});

describe("session state retention", () => {
  it("cd persists across commands", async () => {
    const s = makeSession({ cwd: process.cwd() });
    const pid = lastChild?.pid;
    expect(pid).toBeGreaterThan(0);
    await s.run("cd /tmp");
    const r = await s.run("pwd");
    expect(r.stdout.trim()).toMatch(/\/tmp$/);
    // The answer must come from the same long-lived child, not a respawn.
    expect(lastChild?.pid).toBe(pid);
  });

  it("export persists across commands", async () => {
    const s = makeSession();
    await s.run("export VOLTO_B2_TEST=hello-b2");
    const r = await s.run("echo $VOLTO_B2_TEST");
    expect(r.stdout).toContain("hello-b2");
  });

  it("sourcing a file persists its exports", async () => {
    const s = makeSession();
    const file = path.join(os.tmpdir(), `volto-src-${Date.now()}.sh`);
    fs.writeFileSync(file, "export VOLTO_SOURCED=yes\n");
    try {
      await s.run(`source ${file}`);
      const r = await s.run("echo $VOLTO_SOURCED");
      expect(r.stdout).toContain("yes");
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe("bounded output retention", () => {
  // The session buffer used to be an unbounded string concat: a single
  // `cat huge.log` inside the session grew memory without limit, and the
  // sentinel scan ran O(n) over the whole buffer every 15ms poll. Retention
  // must be capped — but the cap must NEVER stop the sentinel from being
  // found, otherwise a normal big-output command would be misjudged as
  // stuck and trigger a rebuild that loses cd/export state.
  const CAP = 256 * 1024;

  it("retains only a bounded tail of stdout, discloses the drop, and still finds the sentinel", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    // ~590KB of stdout — well past the 256KB retention cap, so eviction
    // happens mid-stream while the sentinel still has to be detected after.
    const r = await s.run("seq 1 100000");
    expect(r.exitCode).toBe(0);
    // Sentinel survived the cap: no stuck-command rebuild.
    expect(r.stateResetReason).toBeUndefined();
    // Retention bounded: cap + disclosure-note slack, never the full 590KB.
    expect(r.stdout.length).toBeLessThan(CAP + 500);
    expect(r.stdout).toMatch(/Earlier output was dropped/);
    // The tail (last line) must still be there — it is what the model needs.
    expect(r.stdout).toContain("100000");
  });

  it("caps stderr retention with a disclosure note", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    const r = await s.run("seq 1 100000 >&2");
    expect(r.exitCode).toBe(0);
    expect(r.stateResetReason).toBeUndefined();
    expect(r.stderr.length).toBeLessThan(CAP + 500);
    expect(r.stderr).toMatch(/Earlier output was dropped/);
  });

  it("keeps normal small commands byte-identical with no disclosure note", async () => {
    const s = makeSession({ generateNonce: () => "fixednonce" });
    const r = await s.run("echo small-output");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("small-output");
    expect(r.stdout).not.toMatch(/Earlier output was dropped/);
  });
});

describe("cwd option", () => {
  it("runs the command in cwd without moving the session", async () => {
    const s = makeSession({ cwd: process.cwd() });
    const pid = lastChild?.pid;
    expect(pid).toBeGreaterThan(0);
    await s.run("cd /tmp");
    const inOther = await s.run("pwd", { cwd: "/" });
    expect(inOther.stdout.trim()).toBe("/");
    const still = await s.run("pwd");
    expect(still.stdout.trim()).toMatch(/\/tmp$/);
    // Subshell must not respawn the long-lived child either.
    expect(lastChild?.pid).toBe(pid);
  });
});

describe("stuck-command recovery", () => {
  it("times out a bare cat, rebuilds, and reports state reset", async () => {
    const s = makeSession({ defaultTimeoutMs: 400, gracePeriodMs: 200 });
    await s.run("cd /tmp");
    const r = await s.run("cat"); // eats stdin / never finishes
    expect(r.stateResetReason).toBeDefined();
    expect(r.stateResetReason).toMatch(/rebuilt/i);
    expect(r.stateResetReason).toMatch(/Working directory/i);
    expect(s.alive).toBe(true);
  });

  it("after rebuild, previous cd is gone", async () => {
    const s = makeSession({ defaultTimeoutMs: 400, gracePeriodMs: 200 });
    await s.run("cd /tmp");
    await s.run("cat"); // forces rebuild
    const pwd = await s.run("pwd");
    // Positive assertion: the rebuilt session starts back at options.cwd.
    // An empty stdout would also "not match /\/tmp$/" — that is not a pass.
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(process.cwd());
  });

  it("session remains usable for normal commands after recovery", async () => {
    const s = makeSession({ defaultTimeoutMs: 400, gracePeriodMs: 200 });
    await s.run("cat");
    const r = await s.run("echo recovered");
    expect(r.stdout).toContain("recovered");
    expect(r.exitCode).toBe(0);
    expect(r.stateResetReason).toBeUndefined();
  });

  it("rebuild replaces the child process", async () => {
    const s = makeSession({ defaultTimeoutMs: 400, gracePeriodMs: 200 });
    const pidBefore = lastChild!.pid;
    expect(pidBefore).toBeGreaterThan(0);
    await s.run("cat");
    const pidAfter = lastChild!.pid;
    expect(pidAfter).toBeGreaterThan(0);
    // Same logical session, different OS process.
    expect(pidAfter).not.toBe(pidBefore);
    expect(s.alive).toBe(true);
  });

  it("kill() after signal-death does not double-call cleanup", async () => {
    let cleanupCalls = 0;
    const s = createPersistentSession({
      spawn: ({ cwd }) => {
        const child = spawn("/bin/bash", ["-s"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
        lastChild = child;
        return {
          child,
          cleanup: () => {
            cleanupCalls += 1;
          },
        };
      },
      cwd: process.cwd(),
      defaultTimeoutMs: 30_000,
    });
    sessions.push(s);
    // Signal-death: exitCode stays null, signalCode is set. The old
    // early-return keyed on `exitCode !== null` missed this case and fell
    // through to a second cleanup call.
    lastChild!.kill("SIGKILL");
    await new Promise((r) => {
      lastChild!.once("close", () => r(undefined));
    });
    expect(s.alive).toBe(false);
    await s.kill();
    await s.kill();
    expect(cleanupCalls).toBe(1);
  });
});
