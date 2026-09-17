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
    });
    // A stdin-reading builtin: the canonical stuck case from the spec.
    // Avoids forking a child that would hold stdio pipes open on kill().
    const r = await s.run("read -r");
    expect(r.exitCode).toBe(124);
    expect(r.stateResetReason).toBe("timeout");
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
