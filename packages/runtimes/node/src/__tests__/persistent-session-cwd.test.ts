import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPersistentSession,
  type PersistentSession,
} from "../persistent-session.js";

const sessions: PersistentSession[] = [];

function makeSession(overrides?: Partial<Parameters<typeof createPersistentSession>[0]>) {
  const s = createPersistentSession({
    spawn: ({ cwd }) => {
      const child = spawn("/bin/bash", ["-s"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
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

/**
 * `$PWD` is the shell's LOGICAL path (the spelling `cd` was given), not the
 * filesystem's resolved one — on macOS `/tmp` stays `/tmp` instead of
 * `/private/tmp`. Assertions therefore compare against the logical path.
 */

describe("session cwd reporting", () => {
  it("reports the cwd the command left behind", async () => {
    const s = makeSession();
    // First command only reports the baseline: the shell's `$PWD` may spell
    // the spawn directory differently, and that is not a move.
    await s.run("true");
    const r = await s.run("cd /tmp");
    expect(r.cwdAfter).toBe("/tmp");
    expect(r.cwdChanged).toBe(true);
    expect(s.cwd?.()).toBe("/tmp");
  });

  it("does not report a move on the first command of a session", async () => {
    const s = makeSession();
    const r = await s.run("true");
    expect(r.cwdAfter).toBeDefined();
    expect(r.cwdChanged).toBe(false);
  });

  it("is not fooled by a command that prints sentinel lookalikes", async () => {
    const s = makeSession();
    const r = await s.run("echo '__VOLTO_DONE_bogus:0:/fake/place'");
    expect(r.cwdAfter).toBe(process.cwd());
  });

  it("carries the cwd on a non-zero exit", async () => {
    const s = makeSession();
    const r = await s.run("cd /tmp && false");
    expect(r.exitCode).toBe(1);
    expect(r.cwdAfter).toBe("/tmp");
  });

  it("keeps the model-visible stdout free of the sentinel line", async () => {
    const s = makeSession();
    const r = await s.run("echo visible");
    expect(r.stdout.trim()).toBe("visible");
    expect(r.stdout).not.toContain("__VOLTO_DONE_");
    expect(r.stdout).not.toContain("/bin/bash");
  });

  it("does not move the session when a per-call cwd is supplied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "volto-cwd-"));
    try {
      const s = makeSession();
      const r = await s.run("pwd", { cwd: dir });
      // The command ran inside the subshell, so it printed the per-call dir...
      expect(r.stdout).toContain(dir);
      // ...while the session itself never left its own cwd.
      expect(r.cwdAfter).toBe(process.cwd());
      expect(s.cwd?.()).toBe(process.cwd());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no cwdAfter on a timeout and resets the tracked cwd to the spawn cwd", async () => {
    const s = makeSession({ defaultTimeoutMs: 40 });
    await s.run("cd /tmp");
    expect(s.cwd?.()).toBe("/tmp");
    const r = await s.run("sleep 5", { timeout: 40 });
    expect(r.timedOut).toBe(true);
    expect(r.cwdAfter).toBeUndefined();
    // The shell was rebuilt at options.cwd — reporting the old /tmp would
    // point the model at a directory its next command never runs in.
    expect(s.cwd?.()).toBe(process.cwd());
  });

  it("keeps the last known cwd when the shell dies without a sentinel", async () => {
    const s = makeSession();
    await s.run("cd /tmp");
    const r = await s.run("exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.cwdAfter).toBeUndefined();
    expect(s.cwd?.()).toBe("/tmp");
  });
});