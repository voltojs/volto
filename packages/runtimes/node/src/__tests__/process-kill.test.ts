import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETACHED_ON_POSIX, killProcessTree } from "../process-kill.js";

const itPosix = process.platform === "win32" ? it.skip : it;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("killProcessTree", () => {
  itPosix("is detached on POSIX so each child leads its own process group", () => {
    expect(DETACHED_ON_POSIX).toBe(true);
  });

  it("never throws for a child that never started, and sends nothing", () => {
    // A spawn that FAILED (ENOENT) keeps `pid` undefined, so there is no group
    // to signal. Falling back to `child.kill()` here is not a harmless no-op
    // and `process.kill(-undefined)` is not a safe "nothing to do" either —
    // either can reach the process that runs this suite. The helper must send
    // nothing at all.
    const child = spawn("/nonexistent/volto-binary", []);
    child.on("error", () => { /* expected ENOENT */ });
    expect(child.pid).toBeUndefined();

    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const childKill = vi.spyOn(child, "kill").mockImplementation(() => true);
    try {
      expect(() => killProcessTree(child)).not.toThrow();
      expect(() => killProcessTree(child, "SIGKILL")).not.toThrow();
      expect(processKill).not.toHaveBeenCalled();
      expect(childKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
      childKill.mockRestore();
    }
  });

  itPosix("a signal to the group leaves no process of that group behind", async () => {
    // The defect this helper exists for: a shell-spawned command is a
    // GRANDCHILD, and signalling only the shell leaves it running (and holding
    // the caller's stdout pipe, so `close` never arrives). Here the command
    // ignores SIGTERM, so only the group signal — TERM, then the SIGKILL the
    // call sites schedule after the grace period — can end it.
    const dir = mkdtempSync(join(tmpdir(), "volto-killtree-"));
    const pidFile = join(dir, "inner.pid");
    const script = join(dir, "inner.mjs");
    writeFileSync(script,
      `import { writeFileSync } from "node:fs";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
      `setInterval(() => {}, 1000);\n`);
    // Quoted: with `shell: true` the command is exec'd as `/bin/sh -c argv0
    // argv1 ...`, so an unquoted `& wait` would become ARGUMENTS, not syntax.
    const child = spawn(`"${process.execPath}" "${script}" & wait`, [], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: DETACHED_ON_POSIX,
    });
    try {
      expect(child.pid).toBeTypeOf("number");
      await waitUntil(() => existsSync(pidFile));
      const inner = Number.parseInt(execFileSync("cat", [pidFile], { encoding: "utf-8" }), 10);
      expect(inner).toBeGreaterThan(0);
      expect(pidAlive(inner)).toBe(true);

      killProcessTree(child);
      killProcessTree(child, "SIGKILL");

      await waitUntil(() => !pidAlive(inner));
      expect(pidAlive(inner)).toBe(false);
    } finally {
      killProcessTree(child, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
