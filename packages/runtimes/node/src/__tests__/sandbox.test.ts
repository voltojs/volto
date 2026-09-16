import { describe, it, expect, afterEach } from "vitest";
import { createNodeSandbox, buildSeatbeltProfile, expandOverlays, createSandboxedShell, buildBwrapArgs } from "../sandbox.js";
import { createSandboxProxy, isHostAllowed } from "../sandbox-proxy.js";
import { createNodeShell } from "../shell.js";
import type { SandboxConfig } from "../sandbox.js";
import type { Shell, ShellEvent } from "@volto/core";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";

const itDarwin = process.platform === "darwin" ? it : it.skip;

/** Drain a Shell.exec() AsyncIterable into its stdout/stderr text and exit code. */
async function drain(events: AsyncIterable<ShellEvent>): Promise<{ out: string; code: number | undefined }> {
  let out = "";
  let code: number | undefined;
  for await (const ev of events) {
    if (ev.type === "stdout" || ev.type === "stderr") out += ev.data;
    else if (ev.type === "exit") code = ev.code;
  }
  return { out, code };
}

/** Minimal mock Shell for testing createSandboxedShell */
function createMockShell(): Shell {
  return {
    async *exec(cmd: string): AsyncIterable<{ type: "stdout"; data: string } | { type: "exit"; code: number }> {
      yield { type: "stdout", data: `executed: ${cmd}` };
      yield { type: "exit", code: 0 };
    },
  };
}

describe("createNodeSandbox", () => {
  describe("basic execution (no isolation)", () => {
    it("runs a command and yields stdout + exit event", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "echo", args: ["hello"] })) {
        events.push(event);
      }

      const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
      expect(stdout.trim()).toBe("hello");

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });

    it("returns exit code 1 on command failure", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "false" })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(1);
    });
  });

  describe("timeout enforcement", () => {
    it("kills a long-running command after timeout", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      const start = Date.now();
      for await (const event of sandbox.run({
        command: "sleep",
        args: ["10"],
        timeout: 500,
      })) {
        events.push(event);
      }
      const elapsed = Date.now() - start;

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).not.toBe(0);
      // Should complete well within 5s (timeout + 2s grace)
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("backend detection", () => {
    it("none backend runs without wrapping", async () => {
      const sandbox = createNodeSandbox({
        policy: { backend: "none" },
      });

      const events: Array<{ type: string; code?: number }> = [];
      for await (const event of sandbox.run({ command: "echo", args: ["test"] })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });
  });

  describe("egress check in sandbox env", () => {
    it("denies egress when host not in allowlist", async () => {
      const sandbox = createNodeSandbox({
        policy: {
          backend: "none",
          egressAllow: ["allowed-host.com"],
        },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({
        command: "echo",
        args: ["test"],
        env: { EGRESS_HOST: "evil-host.com" },
      })) {
        events.push(event);
      }

      const stderr = events.filter((e) => e.type === "stderr").map((e) => e.data).join("");
      expect(stderr).toContain("denied");
      expect(events.find((e) => e.type === "exit")?.code).toBe(126);
    });

    it("allows egress when host is in allowlist", async () => {
      const sandbox = createNodeSandbox({
        policy: {
          backend: "none",
          egressAllow: ["allowed-host.com"],
        },
      });

      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of sandbox.run({
        command: "echo",
        args: ["ok"],
        env: { EGRESS_HOST: "allowed-host.com" },
      })) {
        events.push(event);
      }

      const exitEvent = events.find((e) => e.type === "exit");
      expect(exitEvent?.code).toBe(0);
    });
  });
});

// ──────────────────────────────────────────────
// Phase 2: buildSeatbeltProfile / expandOverlays / createSandboxedShell
// ──────────────────────────────────────────────

describe("expandOverlays", () => {
  it("expands relative overlay against each writable root", () => {
    const result = expandOverlays([".git", ".env"], ["/workspace", "/tmp"]);
    expect(result).toEqual(["/workspace/.git", "/tmp/.git", "/workspace/.env", "/tmp/.env"]);
  });

  it("keeps absolute overlays unchanged", () => {
    const result = expandOverlays(["/etc/secret", ".env"], ["/workspace"]);
    expect(result).toEqual(["/etc/secret", "/workspace/.env"]);
  });

  it("returns empty array when no overlays", () => {
    expect(expandOverlays([], ["/workspace"])).toEqual([]);
  });

  it("returns empty array when no writable roots and all overlays are relative", () => {
    expect(expandOverlays([".git"], [])).toEqual([]);
  });
});

describe("buildSeatbeltProfile", () => {
  it("read-only mode: no writable roots, only essential writes", () => {
    const profile = buildSeatbeltProfile({ mode: "read-only" });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow file-read-data (subpath "/"))');
    expect(profile).toContain('(allow file-write-data (subpath "/dev"))');
    expect(profile).not.toContain("file-write*");
    expect(profile).toContain("(deny network*)");
  });

  it("workspace-write mode: writableRoots produce allow file-write rules", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace", "/tmp"],
      readOnlyOverlays: [],
      network: { enabled: false },
    });
    expect(profile).toContain('(allow file-write* (subpath "/workspace"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).toContain("(deny network*)");
  });

  it("workspace-write mode: readOnlyOverlays produce deny rules after allow rules", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: ["/workspace/.git", "/workspace/.env"],
      network: { enabled: false },
    });
    // Allow rule comes first
    const allowIdx = profile.indexOf('(allow file-write* (subpath "/workspace"))');
    const denyIdx = profile.indexOf('(deny file-write* (subpath "/workspace/.git"))');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  it("workspace-write mode: relative overlays are expanded against writableRoots", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: [".git"],
      network: { enabled: false },
    });
    expect(profile).toContain('(deny file-write* (subpath "/workspace/.git"))');
  });

  it("network enabled with no allowlist: allow all", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      network: { enabled: true },
    });
    expect(profile).toContain("(allow network*)");
  });

  it("network enabled: no loopback-specific deny (reverted — see buildSeatbeltProfile's comment; a sandboxed curl reaching 127.0.0.1 is refused at the route instead)", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      network: { enabled: true },
    });
    expect(profile).toContain("(allow network*)");
    expect(profile).not.toContain("localhost");
    expect(profile).not.toContain("remote ip");
  });

  it("network disabled: no loopback-specific deny needed (the blanket deny already covers it)", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      network: { enabled: false },
    });
    expect(profile).not.toContain("localhost");
  });

  it("escapes double-quote in path names", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ['/path/with"quote'],
      readOnlyOverlays: [],
      network: { enabled: false },
    });
    expect(profile).toContain('(allow file-write* (subpath "/path/with\\"quote"))');
  });

  it("dollar sign in path is treated as literal by seatbelt parser (not shell-escaped)", () => {
    // $ inside seatbelt profile string literals is inert — the profile
    // is read by sandbox-exec directly, not through a shell.
    // The command itself uses single-quoting which also prevents $ expansion.
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/home/$USER/workspace"],
      readOnlyOverlays: [],
      network: { enabled: false },
    });
    expect(profile).toContain('(allow file-write* (subpath "/home/$USER/workspace"))');
  });

  it("deterministic: same config produces identical profile", () => {
    const config: SandboxConfig = {
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: [".git"],
      network: { enabled: false },
    };
    const a = buildSeatbeltProfile(config);
    const b = buildSeatbeltProfile(config);
    expect(a).toBe(b);
  });
});

describe("createSandboxedShell", () => {
  it("danger-full-access: passthrough with sandboxEnforcement none", () => {
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, { mode: "danger-full-access", backend: "none" });
    // Returns a prototype-preserving copy (not the same reference) because
    // sandboxEnforcement must be attached without mutating the caller's object.
    expect(wrapped.sandboxEnforcement).toBe("none");
    expect(typeof wrapped.exec).toBe("function");
  });

  it("unsupported backend (none) + failIfUnavailable: throws at construction", () => {
    const mock = createMockShell();
    expect(() => createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
      failIfUnavailable: true,
    })).toThrow(/no sandbox backend/i);
  });

  it("unsupported backend (none) + explicit opt-out: warn + passthrough", async () => {
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
      failIfUnavailable: false,
    });
    const events: Array<{ type: string; data?: string }> = [];
    for await (const event of wrapped.exec("echo hello")) {
      events.push(event);
    }
    const stdout = events.filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("echo hello");
  });

  it("darwin seatbelt + failIfUnavailable + sandbox-exec present: does not throw", () => {
    // On macOS, sandbox-exec exists, so this should not throw
    const mock = createMockShell();
    if (process.platform === "darwin") {
      expect(() => createSandboxedShell(mock, {
        mode: "workspace-write",
        backend: "seatbelt",
        failIfUnavailable: true,
        writableRoots: ["/tmp"],
      })).not.toThrow();
    }
  });

  it("profile is deterministic across calls (replay test)", async () => {
    const config: SandboxConfig = {
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: [".git"],
      network: { enabled: false },
      backend: "seatbelt",
    };
    // Build profile twice — must be byte-identical
    const p1 = buildSeatbeltProfile(config);
    const p2 = buildSeatbeltProfile(config);
    expect(p1).toBe(p2);
  });

  it("sandbox denial events contain no timestamps or random values", async () => {
    // Simulate a sandbox denial via createSandboxedShell on an unsupported backend.
    // The denial output (stderr message + exit code) must be deterministic.
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
      failIfUnavailable: false,
    });
    // Run same command twice — events must be identical (no Date.now / Math.random)
    const run = async () => {
      const events: Array<{ type: string; data?: string; code?: number }> = [];
      for await (const event of wrapped.exec("echo injected")) {
        events.push(event);
      }
      return events;
    };
    const run1 = await run();
    const run2 = await run();
    // Shell events are deterministic (mock shell produces same output)
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    // Verify no timestamps or random fragments appear in event data
    const allData = run1.map((e) => e.data ?? "").join("");
    expect(allData).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no ISO dates
    expect(allData).not.toMatch(/[a-f0-9]{8}-[a-f0-9]{4}/); // no UUID fragments
  });
});

describe("createSandboxedShell — launch availability by backend", () => {
  /** A mock Shell whose `launch` is a real, unsandboxed passthrough — the
   * shape `createSandboxedShell` receives from a real Node shell adapter. */
  function createMockShellWithLaunch(): Shell {
    return {
      async *exec(cmd: string): AsyncIterable<{ type: "stdout"; data: string } | { type: "exit"; code: number }> {
        yield { type: "stdout", data: `executed: ${cmd}` };
        yield { type: "exit", code: 0 };
      },
      launch: async (cmd: string) => `mock-pid-for-${cmd}`,
    };
  }

  it("read-only mode (backend none) does not expose a launch passthrough", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, { mode: "read-only", backend: "none", failIfUnavailable: false });
    expect(wrapped.launch).toBeUndefined();
  });

  it("workspace-write mode (backend none) does not expose a launch passthrough", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
      writableRoots: ["/tmp"],
      failIfUnavailable: false,
    });
    expect(wrapped.launch).toBeUndefined();
  });

  it("workspace-write mode (seatbelt backend) now exposes a sandboxed launch", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: ["/tmp"],
      // Shape test — does not require sandbox-exec to be installed.
      failIfUnavailable: false,
    });
    // Task 5: seatbelt launch writes a per-process profile and wraps the
    // command, so it is no longer omitted.
    expect(typeof wrapped.launch).toBe("function");
  });

  it("read-only mode (seatbelt backend) now exposes a sandboxed launch", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, {
      mode: "read-only",
      backend: "seatbelt",
      // Shape test — does not require sandbox-exec to be installed.
      failIfUnavailable: false,
    });
    expect(typeof wrapped.launch).toBe("function");
  });

  it("workspace-write mode (bubblewrap backend) does not expose a launch passthrough", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "bubblewrap",
      writableRoots: ["/tmp"],
      // Launch-passthrough shape test — does not require bwrap to be installed.
      failIfUnavailable: false,
    });
    expect(wrapped.launch).toBeUndefined();
  });

  it("danger-full-access still exposes the real shell's launch (raw passthrough by design)", () => {
    const mock = createMockShellWithLaunch();
    const wrapped = createSandboxedShell(mock, { mode: "danger-full-access", backend: "none" });
    // danger-full-access returns a prototype-preserving passthrough —
    // there is no sandbox boundary to enforce in this mode. The launch
    // method must survive the copy.
    expect(wrapped.sandboxEnforcement).toBe("none");
    expect(wrapped.launch).toBe(mock.launch);
  });
});

// ──────────────────────────────────────────────
// Phase 3: buildBwrapArgs / Linux bubblewrap
// ──────────────────────────────────────────────

describe("buildBwrapArgs", () => {
  it("workspace-write: produces --ro-bind / / + writable --bind + overlays + --unshare-net", () => {
    const args = buildBwrapArgs({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: ["/workspace/.git"],
      network: { enabled: false },
    });
    // Identity mount: --ro-bind / /
    expect(args).toContain("--ro-bind");
    expect(args[args.indexOf("--ro-bind") + 1]).toBe("/");
    expect(args[args.indexOf("--ro-bind") + 2]).toBe("/");
    // Writable root: --bind /workspace /workspace
    const bindIdx = args.indexOf("--bind");
    expect(args[bindIdx + 1]).toBe("/workspace");
    expect(args[bindIdx + 2]).toBe("/workspace");
    // Overlay comes AFTER the bind (to override it)
    const overlayIdx = args.indexOf("--ro-bind", args.indexOf("--ro-bind") + 1); // second --ro-bind
    expect(args[overlayIdx + 1]).toBe("/workspace/.git");
    expect(args[overlayIdx + 2]).toBe("/workspace/.git");
    // Network unshared
    expect(args).toContain("--unshare-net");
    // Die with parent
    expect(args).toContain("--die-with-parent");
  });

  it("workspace-write: relative overlay expanded against writable root", () => {
    const args = buildBwrapArgs({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: [".env"],
      network: { enabled: false },
    });
    // .env should be expanded to /workspace/.env
    expect(args).toContain("/workspace/.env");
  });

  it("read-only mode: no --bind writable mounts", () => {
    const args = buildBwrapArgs({
      mode: "read-only",
      network: { enabled: false },
    });
    // Only --ro-bind for /, no --bind writable roots
    const bindCount = args.filter((a) => a === "--bind").length;
    expect(bindCount).toBe(0);
    expect(args).toContain("--unshare-net");
  });

  it("network enabled: no --unshare-net", () => {
    const args = buildBwrapArgs({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      network: { enabled: true },
    });
    expect(args).not.toContain("--unshare-net");
  });

  it("deterministic: same config produces identical args", () => {
    const config: SandboxConfig = {
      mode: "workspace-write",
      writableRoots: ["/workspace", "/tmp"],
      readOnlyOverlays: [".git", ".env"],
      network: { enabled: false },
    };
    const a = buildBwrapArgs(config);
    const b = buildBwrapArgs(config);
    expect(a).toEqual(b);
  });
});

describe("createSandboxedShell - Linux bubblewrap branch", () => {
  it("non-Linux with explicit bubblewrap backend: refuses as INFRASTRUCTURE FAILURE, never unconfined", async () => {
    if (process.platform === "linux") return; // skip on actual Linux
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: [],
      network: { enabled: false },
      backend: "bubblewrap",
      // Opt out of the construction-time throw so this test can observe the
      // exec-time behaviour: a missing bwrap must refuse, never passthrough.
      failIfUnavailable: false,
    });
    // Enforcement is a runtime fact: with no bwrap there is nothing confining.
    expect(wrapped.sandboxEnforcement).toBe("none");
    const result = await drain(wrapped.exec("echo test"));
    expect(result.out).toContain("[sandbox] INFRASTRUCTURE FAILURE");
    expect(result.code).toBe(126);
    // The mock shell echoes `executed: ${cmd}` — unconfined passthrough must
    // not have happened.
    expect(result.out).not.toContain("executed:");
    expect(result.out).not.toContain("echo test");
  });

  it("non-Linux + failIfUnavailable + bubblewrap backend: throws", () => {
    if (process.platform === "linux") return;
    const mock = createMockShell();
    // On non-Linux, bwrap is not on PATH, so failIfUnavailable should throw
    expect(() => createSandboxedShell(mock, {
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      network: { enabled: false },
      backend: "bubblewrap",
      failIfUnavailable: true,
    })).toThrow("bwrap");
  });

  it("bubblewrap exec command contains correct bwrap args", async () => {
    if (process.platform !== "linux") return; // bwrap only available on Linux
    // A missing bwrap refuses at exec time (INFRASTRUCTURE FAILURE) and never
    // reaches command construction — skip rather than fail on a host without it.
    try {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
    } catch {
      return;
    }
    // Capture the actual command passed to the mock shell
    let capturedCmd = "";
    const capturingShell: Shell = {
      async *exec(cmd: string): AsyncIterable<{ type: "stdout"; data: string } | { type: "exit"; code: number }> {
        capturedCmd = cmd;
        yield { type: "stdout", data: "ok" };
        yield { type: "exit", code: 0 };
      },
    };
    const wrapped = createSandboxedShell(capturingShell, {
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      readOnlyOverlays: ["/workspace/.git"],
      network: { enabled: false },
      backend: "bubblewrap", // force bubblewrap backend even on macOS
      // Command-construction test — does not require bwrap to be installed.
      failIfUnavailable: false,
    });
    for await (const _event of wrapped.exec("ls -la")) { /* drain */ }
    expect(capturedCmd).toContain("bwrap");
    expect(capturedCmd).toContain("--ro-bind / /");
    expect(capturedCmd).toContain("--bind /workspace /workspace");
    expect(capturedCmd).toContain("--ro-bind /workspace/.git /workspace/.git");
    expect(capturedCmd).toContain("--unshare-net");
    expect(capturedCmd).toContain("--die-with-parent");
    expect(capturedCmd).toContain("/bin/bash -c");
    expect(capturedCmd).toContain("ls -la");
  });
});

// ──────────────────────────────────────────────
// Phase 4: Egress proxy allowlist + lifecycle
// ──────────────────────────────────────────────

describe("isHostAllowed", () => {
  it("exact match allows the host", () => {
    expect(isHostAllowed("example.com", ["example.com"])).toBe(true);
  });

  it("non-matching host is rejected", () => {
    expect(isHostAllowed("evil.com", ["example.com"])).toBe(false);
  });

  it("wildcard *.example.com matches subdomain", () => {
    expect(isHostAllowed("api.example.com", ["*.example.com"])).toBe(true);
  });

  it("wildcard *.example.com does not match bare domain", () => {
    expect(isHostAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("multiple patterns: any match allows", () => {
    expect(isHostAllowed("evil.com", ["example.com", "evil.com"])).toBe(true);
  });

  it("empty allowlist: all hosts rejected", () => {
    expect(isHostAllowed("example.com", [])).toBe(false);
  });
});

describe("createSandboxProxy", () => {
  it("creates and cleans up a unix socket file", async () => {
    const proxy = createSandboxProxy({ allowedHosts: ["example.com"] });
    const { existsSync } = await import("node:fs");
    expect(existsSync(proxy.socketPath)).toBe(false);

    await proxy.start();
    expect(existsSync(proxy.socketPath)).toBe(true);

    await proxy.stop();
    expect(existsSync(proxy.socketPath)).toBe(false);
  });

  it("socket path is unique across instances", () => {
    const p1 = createSandboxProxy({ allowedHosts: [] });
    const p2 = createSandboxProxy({ allowedHosts: [] });
    expect(p1.socketPath).not.toBe(p2.socketPath);
  });

  it("deterministic allowlist logic (replay test)", () => {
    const hosts = ["api.example.com", "cdn.example.com"];
    // Same inputs → same results across calls
    for (let i = 0; i < 10; i++) {
      expect(isHostAllowed("api.example.com", hosts)).toBe(true);
      expect(isHostAllowed("evil.com", hosts)).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────
// Real seatbelt execution (darwin only)
//
// Every test above either uses backend: "none" (passthrough) or asserts on
// the generated profile STRING — none of them ever actually invoke
// sandbox-exec. That gap is exactly what let a one-line defect ship: the
// seatbelt branch called `sandbox-exec -p '<profile-file-path>'`, but `-p`
// takes an INLINE profile string, not a file path (`-f` does). Every
// sandboxed command on macOS exited 65 with "unbound variable: <path>"
// until that was fixed. These tests really shell out to sandbox-exec so a
// regression like that fails loudly again.
// ──────────────────────────────────────────────

describe("createSandboxedShell — real seatbelt execution (darwin only)", () => {
  if (process.platform !== "darwin") {
    it.skip("skipped: seatbelt is a macOS-only backend", () => {});
    return;
  }

  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeScratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "volto-seatbelt-test-"));
    scratchDirs.push(dir);
    return dir;
  }

  it("actually executes a simple command and returns its real stdout + exit 0", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });

    const { out, code } = await drain(shell.exec("echo sandboxed-hello"));

    // This is the exact regression the -p/-f bug caused: sandbox-exec would
    // exit 65 with "unbound variable: <profile-path>" and no stdout at all.
    expect(code).toBe(0);
    expect(out).toContain("sandboxed-hello");
  });

  it("a multi-command line actually runs under the seatbelt (needs process-fork)", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });

    const { out, code } = await drain(shell.exec("echo one && echo two"));

    expect(code).toBe(0);
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  it("a write inside a writable root actually succeeds on disk", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });

    const { code } = await drain(shell.exec("touch ./inside.txt"));

    expect(code).toBe(0);
    // Assert on the real filesystem, not just the exit code — the write
    // must have actually landed inside the sandbox's writable root.
    expect(fs.existsSync(path.join(scratch, "inside.txt"))).toBe(true);
  });

  it("a write outside every writable root is refused, and nothing is created", async () => {
    const scratch = makeScratch();
    const outsideDir = makeScratch(); // a second scratch dir, NOT in writableRoots
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });
    const outsideTarget = path.join(outsideDir, "should-not-exist.txt");

    const { code } = await drain(shell.exec(`touch "${outsideTarget}"`));

    expect(code).not.toBe(0);
    expect(fs.existsSync(outsideTarget)).toBe(false);
  });

  it("read-only mode: reads succeed but a write is refused, on the real filesystem", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "read-only",
      backend: "seatbelt",
    });

    const read = await drain(shell.exec("cat /etc/hosts"));
    expect(read.code).toBe(0);
    expect(read.out).toContain("localhost");

    const target = path.join(scratch, "ro-should-not-exist.txt");
    const write = await drain(shell.exec(`touch "${target}"`));
    expect(write.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  // ──────────────────────────────────────────────
  // R2 (reverted) — the loopback-deny SBPL rule that used to live here
  // turned out to block ALL egress, not just loopback (see
  // buildSeatbeltProfile's comment). These tests now prove the revert
  // actually restored general egress: a local HTTP server on 127.0.0.1 AND
  // one on this machine's own LAN address must both be reachable from
  // inside the sandbox when network is enabled. Using two local servers
  // (never an external URL) because this test process's own shell may
  // itself be sandboxed and unable to reach the internet, which would make
  // an external probe inconclusive either way.
  // ──────────────────────────────────────────────
  describe("R2 (reverted) — general egress works again under network: enabled", () => {
    /** A non-internal IPv4 address of this host, or undefined if none is configured. */
    function lanAddress(): string | undefined {
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family === "IPv4" && !addr.internal) return addr.address;
        }
      }
      return undefined;
    }

    it("a sandboxed curl CAN reach a real local HTTP server on 127.0.0.1", async () => {
      const scratch = makeScratch();
      const server = http.createServer((_req, res) => {
        res.end("reached-loopback");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
          mode: "workspace-write",
          backend: "seatbelt",
          writableRoots: [scratch],
          network: { enabled: true },
        });

        const { code, out } = await drain(
          shell.exec(`curl -sS --max-time 3 http://127.0.0.1:${port}/`),
        );

        expect(code).toBe(0);
        expect(out).toContain("reached-loopback");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("a sandboxed curl CAN reach a real local HTTP server on this host's LAN address", async () => {
      const lan = lanAddress();
      if (!lan) {
        // No LAN interface configured on this machine (e.g. some CI
        // sandboxes) — nothing to probe.
        return;
      }
      const scratch = makeScratch();
      const server = http.createServer((_req, res) => {
        res.end("reached-lan");
      });
      await new Promise<void>((resolve) => server.listen(0, lan, () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
          mode: "workspace-write",
          backend: "seatbelt",
          writableRoots: [scratch],
          network: { enabled: true },
        });

        const { code, out } = await drain(
          shell.exec(`curl -sS --max-time 3 http://${lan}:${port}/`),
        );

        expect(code).toBe(0);
        expect(out).toContain("reached-lan");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // ──────────────────────────────────────────────
  // R4 — dropping the opendirectoryd.membership mach-lookup does not
  // regress the commands the reviewer's necessity matrix checked.
  // ──────────────────────────────────────────────
  describe("R4 — membership mach-lookup removal does not regress identity commands", () => {
    it("whoami returns a real (non-empty) username", async () => {
      const scratch = makeScratch();
      const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      const { code, out } = await drain(shell.exec("whoami"));
      expect(code).toBe(0);
      expect(out.trim().length).toBeGreaterThan(0);
    });

    it("id returns uid/gid, not an error", async () => {
      const scratch = makeScratch();
      const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      const { code, out } = await drain(shell.exec("id"));
      expect(code).toBe(0);
      expect(out).toContain("uid=");
    });

    it("ls -la resolves the username column instead of a raw uid", async () => {
      const scratch = makeScratch();
      fs.writeFileSync(path.join(scratch, "probe.txt"), "x");
      const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
        mode: "workspace-write",
        backend: "seatbelt",
        writableRoots: [scratch],
        network: { enabled: false },
      });
      const { code, out } = await drain(shell.exec("ls -la probe.txt"));
      expect(code).toBe(0);
      expect(out).toContain("probe.txt");
      // Without opendirectoryd.libinfo, ls falls back to a raw numeric uid
      // in the owner column instead of resolving it to a name. Assert the
      // real, resolved username shows up — this is what `membership`'s
      // removal must NOT regress (libinfo alone is claimed sufficient).
      expect(out).toContain(os.userInfo().username);
    });

    it("git commit --allow-empty succeeds with no confstr warning on stderr", async () => {
      const scratch = makeScratch();
      const { code, out } = await drain(
        createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
          mode: "workspace-write",
          backend: "seatbelt",
          writableRoots: [scratch],
          // The adapter's own default overlay set (".git", ".env") would
          // block `git init` from creating .git in the first place — that
          // is a different, deliberate policy (see wiring.ts's
          // buildSandboxConfigs for where it's overridden at the gateway
          // level) and not what this test is checking. Empty it out here so
          // this test isolates the one thing it's verifying: that removing
          // the `membership` mach-lookup doesn't regress git's identity
          // resolution.
          readOnlyOverlays: [],
          network: { enabled: false },
        }).exec(
          `git init -q && git config user.email "t@example.com" && git config user.name "T" && git commit --allow-empty -m probe`,
        ),
      );
      expect(code).toBe(0);
      expect(out).not.toContain("confstr");
    });
  });

  // ──────────────────────────────────────────────
  // Task 5 — background launch under a per-process seatbelt profile.
  //
  // The seatbelt branch used to omit `launch` entirely (C4): the profile
  // was tied to exec's temp-file lifecycle, so a passthrough launch would
  // have run fully unisolated. Now each launch writes its own profile and
  // drops it when the child dies, so runInBackground is confined.
  // ──────────────────────────────────────────────

  it("launch() runs under a per-process seatbelt profile and denies writes outside roots", async () => {
    const scratch = makeScratch();
    const outsideDir = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });

    const id = await shell.launch!(`touch "${path.join(outsideDir, "denied.txt")}"`);
    // Wait for exit.
    await new Promise((r) => setTimeout(r, 800));
    const out = await shell.readProcessOutput!(id);
    // Backend-specific denial dialect — do NOT union with bwrap's.
    expect(out.text.toLowerCase()).toContain("operation not permitted");
    expect(fs.existsSync(path.join(outsideDir, "denied.txt"))).toBe(false);
  });

  it("launch() enforces sandboxEnforcement as a runtime fact", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
    });
    expect(shell.sandboxEnforcement).toBe("full");
    const id = await shell.launch!("echo seatbelt-bg-ok");
    await new Promise((r) => setTimeout(r, 500));
    const out = await shell.readProcessOutput!(id);
    expect(out.text).toContain("seatbelt-bg-ok");
  });

  it("launch() cleans up its per-process seatbelt profile after the process exits", async () => {
    const scratch = makeScratch();
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: scratch }), {
      mode: "workspace-write",
      backend: "seatbelt",
      writableRoots: [scratch],
      network: { enabled: false },
    });

    /** List seatbelt profile files belonging to this Node process. */
    const profiles = (): string[] =>
      fs.readdirSync(os.tmpdir()).filter(
        (f) => f.startsWith(`volto-sandbox-${process.pid}-`) && f.endsWith(".sb"),
      );

    const before = profiles().length;
    await shell.launch!("echo profile-cleanup-probe");
    // Wait for the quick command to exit plus the 1s cleanup interval.
    await new Promise((r) => setTimeout(r, 2500));
    const after = profiles().length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ──────────────────────────────────────────────
// deniedReadPaths / strippedEnvVars — the sandbox must refuse reads of
// named credential paths and remove named environment variables from the
// child, so a sandboxed command cannot authenticate as the gateway itself.
// ──────────────────────────────────────────────

describe("deniedReadPaths", () => {
  itDarwin("refuses to read a denied path while other reads still work", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-denyread-")));
    const secrets = path.join(base, "creds");
    await fsp.mkdir(secrets);
    await fsp.writeFile(path.join(secrets, "token"), "SECRET_VALUE", "utf-8");

    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
      deniedReadPaths: [secrets],
    });

    const read = await drain(shell.exec(`cat ${JSON.stringify(path.join(secrets, "token"))}`));
    expect(read.out).not.toContain("SECRET_VALUE");
    // The read itself must have been refused — empty output alone is also
    // what a broken sandbox-exec or a malformed profile would produce.
    expect(read.code).not.toBe(0);
    expect(read.out).toContain("Operation not permitted");

    // A read outside the denied path is unaffected — the rule must be narrow.
    const other = await drain(shell.exec("head -1 /etc/hosts"));
    expect(other.code).toBe(0);

    await fsp.rm(base, { recursive: true, force: true });
  });

  itDarwin("strips the named environment variables from the child", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-stripenv-")));
    process.env["VOLTO_TEST_SECRET"] = "LEAKED";

    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
      strippedEnvVars: ["VOLTO_TEST_SECRET"],
    });

    const result = await drain(shell.exec("echo ${VOLTO_TEST_SECRET:-ABSENT}"));
    expect(result.out).toContain("ABSENT");
    expect(result.out).not.toContain("LEAKED");

    delete process.env["VOLTO_TEST_SECRET"];
    await fsp.rm(base, { recursive: true, force: true });
  });

  itDarwin("strips pattern-matched names while leaving the rest of the env intact", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-stripenv2-")));
    // The exact leak demonstrated on this branch: the file-side fence over
    // the credential dir was already in place and `echo $OPENAI_API_KEY`
    // still printed the key, because the strip list named one variable that
    // does not exist.
    process.env["OPENAI_API_KEY"] = "LEAKED_OPENAI";
    process.env["VOLTO_TEST_PLAIN"] = "KEPT_PLAIN";

    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
      strippedEnvPatterns: [/API_?KEY/i],
    });

    const result = await drain(
      shell.exec("echo ${OPENAI_API_KEY:-ABSENT} ${VOLTO_TEST_PLAIN:-MISSING}"),
    );
    expect(result.out).not.toContain("LEAKED_OPENAI");
    expect(result.out).toContain("ABSENT");
    // PATH and friends must survive — spawn's `env` replaces the whole
    // environment, so an over-eager strip breaks every command.
    expect(result.out).toContain("KEPT_PLAIN");

    delete process.env["OPENAI_API_KEY"];
    delete process.env["VOLTO_TEST_PLAIN"];
    await fsp.rm(base, { recursive: true, force: true });
  });
});

// ──────────────────────────────────────────────
// sandboxEnforcement — the shell decorator self-reports which enforcement
// level the selected backend actually achieves. The fact belongs to the
// RUNTIME (which backend was actually selected), not to the config (what
// was asked for) — that gap is where a dead sandbox hides.
// ──────────────────────────────────────────────

describe("sandboxEnforcement", () => {
  itDarwin("reports full when seatbelt is the selected backend", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "workspace-write",
      writableRoots: [os.tmpdir()],
    });
    expect(shell.sandboxEnforcement).toBe("full");
  });

  it("reports none when no backend confines the process", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "workspace-write",
      writableRoots: [os.tmpdir()],
      backend: "none",
      // Task 5 flips this default to true; the passthrough path only exists
      // for callers that opt out explicitly.
      failIfUnavailable: false,
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });

  it("reports none for danger-full-access, which confines nothing by definition", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "danger-full-access",
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });

  it("reports none when the bubblewrap runner is missing under an explicit opt-out", () => {
    // failIfUnavailable:false lets construction succeed, but a missing runner
    // confines nothing — enforcement must not claim "full".
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "workspace-write",
      writableRoots: [os.tmpdir()],
      backend: "bubblewrap",
      bwrapBinary: "/nonexistent/volto-bwrap",
      failIfUnavailable: false,
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });

  it("reports none when the seatbelt runner is missing under an explicit opt-out", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "workspace-write",
      writableRoots: [os.tmpdir()],
      backend: "seatbelt",
      seatbeltBinary: "/nonexistent/volto-sandbox-exec",
      failIfUnavailable: false,
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });
});

// ──────────────────────────────────────────────
// runner failure vs denial — a runner that refuses before the wrapped
// command ever ran is INFRASTRUCTURE FAILURE (nothing was executed), not
// a denial and not an ordinary command failure. Conflating the two is how
// a broken sandbox-exec stayed invisible.
// ──────────────────────────────────────────────

describe("runner failure vs denial", () => {
  itDarwin("labels a broken runner as infrastructure failure, not a command failure", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-runnerfail-")));
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
      // Reproduces the -p defect's shape: the runner refuses before the
      // wrapped command ever runs. Opt out of the construction-time probe
      // so the failure surfaces at exec time, which is what this test is
      // about.
      seatbeltBinary: "/usr/bin/sandbox-exec-does-not-exist",
      failIfUnavailable: false,
    });

    const result = await drain(shell.exec("echo hello"));
    expect(result.out).toContain("[sandbox] INFRASTRUCTURE FAILURE");
    expect(result.out).not.toContain("hello");
    // missingRunnerEvents' deliberate exit code for "nothing was executed".
    expect(result.code).toBe(126);

    await fsp.rm(base, { recursive: true, force: true });
  });

  itDarwin("does NOT label a genuine denial as infrastructure failure", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-denial-")));
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
    });

    // Writing outside the writable root: confinement working as intended.
    const result = await drain(shell.exec("touch /etc/volto-should-not-exist"));
    expect(result.code).not.toBe(0);
    // Seatbelt's own dialect -- not a cross-backend union.
    expect(result.out.toLowerCase()).toContain("operation not permitted");
    expect(result.out).not.toContain("[sandbox] INFRASTRUCTURE FAILURE");

    await fsp.rm(base, { recursive: true, force: true });
  });

  itDarwin("leaves an ordinary failing command alone", async () => {
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-plainfail-")));
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
    });

    const result = await drain(shell.exec("ls /definitely-not-here"));
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("[sandbox] INFRASTRUCTURE FAILURE");

    await fsp.rm(base, { recursive: true, force: true });
  });
});

// ──────────────────────────────────────────────
// no backend available — a confining mode with nothing to confine it is
// refused by default. Silently running unconfined under a mode that
// promises confinement is the failure this phase exists to prevent.
// ──────────────────────────────────────────────

describe("no backend available", () => {
  it("refuses to construct a confining shell when nothing can confine it", () => {
    expect(() =>
      createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
        mode: "workspace-write",
        writableRoots: [os.tmpdir()],
        backend: "none",
      }),
    ).toThrow(/no sandbox backend/i);
  });

  it("still allows an explicit opt-out", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "workspace-write",
      writableRoots: [os.tmpdir()],
      backend: "none",
      failIfUnavailable: false,
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });

  itDarwin("opting out of the throw does NOT grant an unconfined process when the runner is merely missing", async () => {
    // The two flavours of "unavailable" opt out differently, and the field's
    // docs now say so. Pinned because the difference is easy to erase by
    // accident and the safe half is the non-obvious one:
    //
    //   backend "none"        -> no backend exists here; opt-out runs unconfined
    //   runner binary missing -> a backend was selected and is broken; opt-out
    //                            still refuses to execute
    const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "volto-optout-")));

    const brokenRunner = createSandboxedShell(createNodeShell({ defaultCwd: base }), {
      mode: "workspace-write",
      writableRoots: [base],
      seatbeltBinary: "/usr/bin/sandbox-exec-not-installed",
      failIfUnavailable: false,
    });
    expect(brokenRunner.sandboxEnforcement).toBe("none");

    const result = await drain(brokenRunner.exec("echo MUST_NOT_RUN"));
    expect(result.out).toContain("[sandbox] INFRASTRUCTURE FAILURE");
    expect(result.out).not.toContain("MUST_NOT_RUN");
    expect(result.code).toBe(126);

    await fsp.rm(base, { recursive: true, force: true });
  });

  it("never blocks danger-full-access, which asks for no confinement", () => {
    const shell = createSandboxedShell(createNodeShell({ defaultCwd: os.tmpdir() }), {
      mode: "danger-full-access",
      backend: "none",
    });
    expect(shell.sandboxEnforcement).toBe("none");
  });
});
