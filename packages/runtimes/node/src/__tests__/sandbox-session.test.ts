import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSandboxedShell, createSandboxSessionSpawner } from "../sandbox.js";
import { createNodeShell } from "../shell.js";
import { createPersistentSession, type PersistentSession } from "../persistent-session.js";

/** Snapshot of seatbelt profile files currently in tmpdir. */
function listSandboxProfiles(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("volto-sandbox-"));
}

describe("sandboxed persistent session (darwin seatbelt)", () => {
  if (process.platform !== "darwin") {
    it.skip("skipped: seatbelt is macOS-only", () => {});
    return;
  }

  const sessions: PersistentSession[] = [];

  async function cleanupSessions(): Promise<void> {
    for (const s of sessions.splice(0)) await s.kill();
  }

  it("session commands inherit the sandbox and deny writes outside roots", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "volto-sess-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "volto-sess-out-"));
    try {
      const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      // Enforcement is a RUNTIME fact, not a config claim.
      expect(shell.sandboxEnforcement).toBe("full");

      const spawn = createSandboxSessionSpawner({
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      expect(spawn).toBeDefined();
      const session = createPersistentSession({
        spawn: spawn!,
        cwd: scratch,
        defaultTimeoutMs: 10_000,
      });
      sessions.push(session);

      const denied = await session.run(`touch "${path.join(outside, "nope.txt")}"`);
      // §2.1: non-zero exit + THIS backend's denial dialect + the file must
      // actually be absent. Never assert emptiness to prove a denial.
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr.toLowerCase()).toContain("operation not permitted");
      expect(fs.existsSync(path.join(outside, "nope.txt"))).toBe(false);

      const allowed = await session.run("touch ./inside.txt");
      expect(allowed.exitCode).toBe(0);
      expect(fs.existsSync(path.join(scratch, "inside.txt"))).toBe(true);
    } finally {
      await cleanupSessions();
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("kill() unlinks the per-session seatbelt profile", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "volto-sess-prof-"));
    try {
      const before = new Set(listSandboxProfiles());
      const spawn = createSandboxSessionSpawner({
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      expect(spawn).toBeDefined();
      const session = createPersistentSession({
        spawn: spawn!,
        cwd: scratch,
        defaultTimeoutMs: 10_000,
      });

      const r = await session.run("echo alive");
      expect(r.exitCode).toBe(0);

      const during = listSandboxProfiles().filter((f) => !before.has(f));
      expect(during.length).toBeGreaterThan(0);

      await session.kill();
      const after = listSandboxProfiles().filter((f) => !before.has(f));
      expect(after.length).toBe(0);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("createSandboxSessionSpawner — backend selection", () => {
  it("danger-full-access returns a bare bash -s spawner that still runs", async () => {
    const spawn = createSandboxSessionSpawner({
      mode: "danger-full-access",
      backend: "seatbelt",
    });
    expect(spawn).toBeDefined();
    const session = createPersistentSession({
      spawn: spawn!,
      cwd: process.cwd(),
      defaultTimeoutMs: 10_000,
    });
    try {
      const r = await session.run("echo unrestricted");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("unrestricted");
    } finally {
      await session.kill();
    }
  });

  it("none + failIfUnavailable throws (confining mode with no backend)", () => {
    expect(() =>
      createSandboxSessionSpawner({
        mode: "workspace-write",
        backend: "none",
      }),
    ).toThrow(/no sandbox backend/i);
  });

  it("none + failIfUnavailable:false returns a bare spawner", () => {
    const spawn = createSandboxSessionSpawner({
      mode: "workspace-write",
      backend: "none",
      failIfUnavailable: false,
    });
    expect(spawn).toBeDefined();
  });

  it("missing confining runner + failIfUnavailable:false returns undefined", () => {
    const spawn = createSandboxSessionSpawner({
      mode: "workspace-write",
      backend: "seatbelt",
      seatbeltBinary: "/nonexistent/volto-sandbox-exec",
      failIfUnavailable: false,
    });
    expect(spawn).toBeUndefined();
  });

  it("missing confining runner + failIfUnavailable throws", () => {
    expect(() =>
      createSandboxSessionSpawner({
        mode: "workspace-write",
        backend: "seatbelt",
        seatbeltBinary: "/nonexistent/volto-sandbox-exec",
      }),
    ).toThrow(/sandbox-exec|not found/i);
  });
});

describe("sandboxed persistent session (linux bwrap)", () => {
  if (process.platform !== "linux") {
    it.skip("skipped: bwrap is Linux-only", () => {});
    return;
  }
  const hasBwrap = (() => {
    try {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!hasBwrap) {
    it.skip("skipped: bwrap binary not installed on this host", () => {});
    return;
  }

  it("session commands deny writes outside roots with the bwrap dialect", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "volto-sess-bwrap-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "volto-sess-bwrap-out-"));
    const spawn = createSandboxSessionSpawner({
      mode: "workspace-write",
      backend: "bubblewrap",
      writableRoots: [scratch],
      network: { enabled: false },
    });
    expect(spawn).toBeDefined();
    const session = createPersistentSession({
      spawn: spawn!,
      cwd: scratch,
      defaultTimeoutMs: 10_000,
    });
    try {
      const denied = await session.run(`touch "${path.join(outside, "nope.txt")}"`);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr.toLowerCase()).toContain("read-only file system");
      expect(fs.existsSync(path.join(outside, "nope.txt"))).toBe(false);

      const allowed = await session.run("touch ./inside.txt");
      expect(allowed.exitCode).toBe(0);
      expect(fs.existsSync(path.join(scratch, "inside.txt"))).toBe(true);
    } finally {
      await session.kill();
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
