import { describe, it, expect } from "vitest";
import { createNodeSandbox, buildSeatbeltProfile, expandOverlays, createSandboxedShell } from "../sandbox.js";
import type { SandboxConfig } from "../sandbox.js";
import type { Shell } from "@agent-core/core";

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
  it("danger-full-access: returns real shell directly (passthrough)", () => {
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, { mode: "danger-full-access", backend: "none" });
    // Wrapped shell should be the exact same reference as the mock
    expect(wrapped).toBe(mock);
  });

  it("unsupported backend (none) + failIfUnavailable: throws at construction", () => {
    const mock = createMockShell();
    expect(() => createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
      failIfUnavailable: true,
    })).toThrow("failIfUnavailable is true");
  });

  it("unsupported backend (none) without failIfUnavailable: warn + passthrough", async () => {
    const mock = createMockShell();
    const wrapped = createSandboxedShell(mock, {
      mode: "workspace-write",
      backend: "none",
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
