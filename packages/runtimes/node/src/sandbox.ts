/**
 * Node Sandbox adapter — implements the M8 Sandbox port.
 *
 * Executes commands inside an isolated environment with configurable
 * filesystem read/write whitelist, egress host whitelist, and resource limits.
 *
 * Platform backends (Plan 009):
 * - macOS: `sandbox-exec` (seatbelt) when available
 * - Linux: bubblewrap (`bwrap`) when available
 * - Fallback: `none` — runs without isolation (emits warning)
 *
 * This module provides two paths:
 * 1. `createNodeSandbox` — Sandbox port adapter (for future task sub-agent use)
 * 2. `createSandboxedShell` — Shell decorator (for bash tool, wraps commands transparently)
 *
 * All rejections are expressed as ShellEvents (stdout/stderr/exit), never thrown.
 */

import type { Shell, ShellExecOptions, ShellEvent } from "@agent-core/core";
import type { Sandbox, SandboxExecSpec, SandboxEvent } from "@agent-core/core";
import { spawn, execFileSync } from "node:child_process";

// ──────────────────────────────────────────────
// SandboxConfig (Plan 009 §4.3)
// ──────────────────────────────────────────────

/** Three-tier isolation mode — platform-agnostic semantics */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Platform backend selection */
export type SandboxBackend = "seatbelt" | "bubblewrap" | "none";

/** Network egress configuration */
export interface SandboxNetworkConfig {
  /** Whether network is enabled. Default: false (blocked) */
  enabled?: boolean;
  /** When non-empty, only these hosts are allowed through a local proxy */
  allowedHosts?: string[];
}

/** Complete sandbox configuration for the Shell decorator */
export interface SandboxConfig {
  /** Isolation mode (required) */
  mode: SandboxMode;
  /** Paths the process may write to in workspace-write mode. Default: [cwd, os.tmpdir()] */
  writableRoots?: string[];
  /** Paths inside writableRoots that remain read-only even when writable. Default: [".git", ".env"] */
  readOnlyOverlays?: string[];
  /** Network egress settings. Default: disabled (blocked) */
  network?: SandboxNetworkConfig;
  /** Linux: enable seccomp filter to block unix socket escape. Default: true */
  seccomp?: boolean;
  /** Auto-detect backend: darwin→seatbelt, linux→bubblewrap, rest→none. Default: auto */
  backend?: SandboxBackend;
  /** When true, throw at construction time if sandbox is unavailable. Default: false */
  failIfUnavailable?: boolean;
}

// ──────────────────────────────────────────────
// Backend detection (Plan 009 Phase 0)
// ──────────────────────────────────────────────

/**
 * Detect which sandbox backend is available on this platform.
 * darwin → seatbelt, linux → bubblewrap, rest → none.
 */
export function detectBackend(): SandboxBackend {
  const platform = process.platform;
  if (platform === "darwin") return "seatbelt";
  if (platform === "linux") return "bubblewrap";
  return "none";
}

/**
 * Probe whether a binary exists on PATH (cached per name).
 * Returns true if `which <name>` exits 0.
 */
const probeCache = new Map<string, boolean>();
export function probeBinary(name: string): boolean {
  const cached = probeCache.get(name);
  if (cached !== undefined) return cached;
  try {
    execFileSync("which", [name], { stdio: "ignore", timeout: 2000 });
    probeCache.set(name, true);
    return true;
  } catch {
    probeCache.set(name, false);
    return false;
  }
}

// ──────────────────────────────────────────────
// Shell decorator (Plan 009 §4.2)
// ──────────────────────────────────────────────

/**
 * Create a Shell decorator that wraps commands in a sandbox.
 *
 * - macOS: `sandbox-exec -p <profile> /bin/bash -c <escaped cmd>`
 * - Linux: `bwrap <args> -- /bin/bash -c <escaped cmd>`
 * - danger-full-access: passthrough (no wrapping)
 * - Other platform: passthrough + console.warn (unless failIfUnavailable)
 *
 * Phase 0: skeleton — all modes passthrough. Real profiles built in Phase 1–3.
 */
export function createSandboxedShell(
  realShell: Shell,
  config: SandboxConfig,
): Shell {
  const backend = config.backend ?? detectBackend();

  // danger-full-access: no isolation, passthrough
  if (config.mode === "danger-full-access") {
    return realShell;
  }

  // Unsupported platform with failIfUnavailable: throw at construction
  if (backend === "none" && config.failIfUnavailable) {
    throw new Error(
      "[sandbox] Sandbox not available on this platform and failIfUnavailable is true. " +
      "Set failIfUnavailable to false to allow passthrough, or provide a supported backend.",
    );
  }

  // Unsupported platform without failIfUnavailable: warn once then passthrough
  if (backend === "none") {
    let warned = false;
    return {
      exec(cmd: string, opts?: ShellExecOptions) {
        if (!warned) {
          warned = true;
          console.warn(
            "[sandbox] WARNING: No sandbox backend available on this platform. " +
            "Commands will run without isolation. This is a security risk.",
          );
        }
        return realShell.exec(cmd, opts);
      },
      launch: realShell.launch
        ? (cmd: string, opts?: Omit<ShellExecOptions, "runInBackground">) => realShell.launch!(cmd, opts)
        : undefined,
    };
  }

  // Phase 1 will implement real wrapping; Phase 0 is passthrough for supported platforms too
  return {
    exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
      // Phase 1: build profile → wrap cmd → delegate
      // Phase 0: passthrough
      return realShell.exec(cmd, opts);
    },
    launch: realShell.launch
      ? (cmd: string, opts?: Omit<ShellExecOptions, "runInBackground">) => realShell.launch!(cmd, opts)
      : undefined,
  };
}

// ──────────────────────────────────────────────
// Seatbelt profile builder (shared — Plan 009 §4.2)
// ──────────────────────────────────────────────

/**
 * Escape a path for use inside a seatbelt profile string.
 * Handles backslash and double-quote characters.
 */
function escapeSeatbeltPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a macOS Seatbelt profile string from a SandboxConfig.
 *
 * - `(deny default)` + full read `(allow file-read-data (subpath "/"))`
 * - `writableRoots` → `(allow file-write* (subpath "<escaped>"))` per path
 * - `readOnlyOverlays` → `(deny file-write* (subpath "<escaped>"))` per path (after allows)
 * - `network.enabled === false` → `(deny network*)`
 *
 * Phase 0: exported for use by both createNodeSandbox and createSandboxedShell.
 * Full implementation in Phase 1.
 */
export function buildSeatbeltProfile(config: SandboxConfig): string {
  const writableRoots = config.writableRoots ?? [];
  const readOnlyOverlays = config.readOnlyOverlays ?? [];
  const networkEnabled = config.network?.enabled ?? false;

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Allow reading from everywhere (including /usr, /bin, /etc)
    '(allow file-read-data (subpath "/"))',
    // Allow stdout/stderr
    "(allow file-write-data (subpath \"/dev\"))",
  ];

  // Writable roots (workspace-write mode)
  for (const root of writableRoots) {
    lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(root)}"))`);
  }

  // Read-only overlays (deny file-write overrides any allow above)
  for (const overlay of readOnlyOverlays) {
    lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(overlay)}"))`);
  }

  // Network
  if (networkEnabled) {
    if (config.network?.allowedHosts && config.network.allowedHosts.length > 0) {
      // Allow loopback for proxy; egress proxy handles allowlist
      lines.push("(allow network* (remote-host))");
    } else {
      // Enabled but no allowlist: allow all
      lines.push("(allow network*)");
    }
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

/**
 * Build bubblewrap (Linux) arguments from a SandboxConfig.
 *
 * Phase 3 will implement full logic with proper dual-arg format
 * (bwrap requires `--ro-bind <src> <dest>` with both paths).
 * This is a stub — parameter lists are incomplete and will be
 * corrected in Phase 3.
 */
export function buildBwrapArgs(config: SandboxConfig): string[] {
  const writableRoots = config.writableRoots ?? [];
  const readOnlyOverlays = config.readOnlyOverlays ?? [];
  const networkEnabled = config.network?.enabled ?? false;

  const args: string[] = [];

  // Full filesystem read-only base
  args.push("--ro-bind", "/");

  // Required virtual filesystems
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // Writable roots
  for (const root of writableRoots) {
    args.push("--bind", root);
  }

  // Read-only overlays (must come after --bind to override)
  for (const overlay of readOnlyOverlays) {
    args.push("--ro-bind", overlay);
  }

  // Network isolation
  if (!networkEnabled) {
    args.push("--unshare-net");
  }

  // Auto-die when parent exits (avoids orphans)
  args.push("--die-with-parent");

  return args;
}

// ──────────────────────────────────────────────
// NodeSandbox — Sandbox port adapter (Plan 009 §4.2: separate path)
// ──────────────────────────────────────────────

export interface SandboxPolicy {
  /** Filesystem paths the process may write to (null = read-only) */
  fsReadWrite?: string[];
  /** Filesystem paths the process may read (null = no restriction) */
  fsReadOnly?: string[];
  /** Hostnames the process may connect to (null = no network) */
  egressAllow?: string[];
  /** Max execution time in ms (0 = no limit) */
  timeoutMs?: number;
  /** Max memory in bytes (0 = no limit) */
  memoryLimitBytes?: number;
  /** Platform backend selection */
  backend?: "seatbelt" | "landlock" | "none";
}

export interface NodeSandboxOptions {
  policy?: SandboxPolicy;
}

/**
 * Legacy buildSeatbeltProfile for createNodeSandbox (Sandbox port path).
 * Converts SandboxPolicy to SandboxConfig and delegates to the shared builder.
 */
function buildSeatbeltProfileFromPolicy(policy: SandboxPolicy): string {
  const config: SandboxConfig = {
    mode: "workspace-write",
    writableRoots: policy.fsReadWrite,
    readOnlyOverlays: [],
    network: policy.egressAllow
      ? { enabled: true, allowedHosts: policy.egressAllow }
      : { enabled: false },
  };
  return buildSeatbeltProfile(config);
}

/**
 * Execute a command in an isolated sandbox (Sandbox port adapter).
 * Returns an AsyncIterable<SandboxEvent> — yields stdout/stderr/exit events.
 * Errors are yielded as events, never thrown.
 *
 * NOTE: For bash tool usage, prefer createSandboxedShell (Shell decorator).
 * This adapter is retained for future task sub-agent and direct spawn scenarios.
 */
export function createNodeSandbox(opts?: NodeSandboxOptions): Sandbox {
  const policy: SandboxPolicy = opts?.policy ?? {};
  const backend = policy.backend ?? detectBackend();

  if (backend === "none" && policy.backend === undefined) {
    console.warn(
      "[sandbox] WARNING: No isolation backend available on this platform. " +
      "Commands will run WITHOUT sandbox isolation. " +
      "This is a security risk in production — configure a sandbox backend explicitly.",
    );
  }

  return {
    async *run(spec: SandboxExecSpec): AsyncIterable<SandboxEvent> {
      const cmd = spec.command;
      const args = spec.args ?? [];
      const cwd = spec.cwd ?? process.cwd();
      const timeout = spec.timeout ?? policy.timeoutMs ?? 30_000;

      // Check egress before exec
      if (policy.egressAllow !== undefined && spec.env?.["EGRESS_HOST"]) {
        const host = spec.env["EGRESS_HOST"];
        if (!policy.egressAllow.includes(host)) {
          yield { type: "stderr", data: `[sandbox] Network egress denied: ${host}` };
          yield { type: "exit", code: 126 };
          return;
        }
      }

      let execCmd = cmd;
      const execArgs: string[] = [];

      // Platform-specific isolation wrapping
      if (backend === "seatbelt") {
        const profile = buildSeatbeltProfileFromPolicy(policy);
        execCmd = "sandbox-exec";
        execArgs.push("-p", profile, cmd, ...args);
      } else {
        // "none" → run bare
        execArgs.push(...args);
      }

      const child = spawn(execCmd, execArgs, {
        cwd,
        shell: backend === "none",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spec.env },
      });

      // Shared async queue for stdout/stderr
      const queue: SandboxEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;
      let exitYielded = false;

      function enqueue(event: SandboxEvent): void {
        if (resolveWaiter) { const r = resolveWaiter; resolveWaiter = null; r(); }
        queue.push(event);
      }

      // Timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000);
        }, timeout);
      }

      // AbortSignal
      const abortHandler = (): void => { child.kill("SIGTERM"); };
      if (spec.abortSignal) {
        if (spec.abortSignal.aborted) {
          child.kill("SIGTERM");
        } else {
          spec.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          enqueue({ type: "stdout", data: chunk.toString() });
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          enqueue({ type: "stderr", data: chunk.toString() });
        });
      }
      child.on("close", (code) => {
        closed = true;
        enqueue({ type: "exit", code: code ?? 1 });
      });

      try {
        while (true) {
          if (queue.length > 0) {
            const event = queue.shift()!;
            if (event.type === "exit") exitYielded = true;
            yield event;
            if (event.type === "exit") return;
          } else if (closed && queue.length === 0) {
            return;
          } else {
            await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (spec.abortSignal) {
          spec.abortSignal.removeEventListener("abort", abortHandler);
        }
        if (!exitYielded) {
          yield { type: "exit", code: -1 };
        }
      }
    },
  };
}
