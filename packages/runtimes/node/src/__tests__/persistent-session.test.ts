import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
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
