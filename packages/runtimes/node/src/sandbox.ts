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

import type { Shell, ShellExecOptions, ShellEvent } from "@volto/core";
import type { Sandbox, SandboxExecSpec, SandboxEvent } from "@volto/core";
import type { SandboxMode } from "@volto/core";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxProxy, type SandboxProxy } from "./sandbox-proxy.js";

// ──────────────────────────────────────────────
// SandboxConfig (Plan 009 §4.3)
// ──────────────────────────────────────────────

/** Three-tier isolation mode — platform-agnostic semantics (re-exported from @volto/core) */
export type { SandboxMode };

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
 * - macOS: `sandbox-exec -p <profile-file> /bin/bash -c <escaped cmd>`
 * - Linux: `bwrap <args> -- /bin/bash -c <escaped cmd>` (Phase 3)
 * - danger-full-access: passthrough (no wrapping)
 * - Other platform: passthrough + console.warn (unless failIfUnavailable)
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
      // No `launch`: only danger-full-access exposes the real shell's
      // background-launch path (see C4 — a passthrough here would let
      // `bash({ runInBackground: true })` bypass isolation entirely, and
      // there is nothing sandboxed on this backend for it to bypass into
      // safely). The bash tool's `if (runInBackground && shell.launch)`
      // guard falls back to the (still unsandboxed-with-warning) `exec`
      // path on its own when `launch` is absent.
    };
  }

  // ── Resolve config defaults (Phase 2) ──
  // Only needed for non-danger-full-access modes (danger-full-access returns above).
  const isWriteMode = config.mode === "workspace-write";
  const resolvedConfig: SandboxConfig = {
    ...config,
    // Verified required: seatbelt's `(subpath "...")` match is evaluated
    // against the REAL (symlink-resolved) path of the file being touched,
    // not the literal string in the profile. On macOS both `/tmp` (→
    // `/private/tmp`) and `os.tmpdir()`'s `/var/folders/...` (→
    // `/private/var/folders/...`) are symlinks, so a profile built from the
    // lexical path denies every write under it — `touch` inside a supposedly
    // writable root failed with "Operation not permitted" until this
    // resolved the roots the same way first.
    writableRoots: isWriteMode
      ? (config.writableRoots ?? [process.cwd(), tmpdir()]).map(resolveRealRootPath)
      : config.writableRoots,
    readOnlyOverlays: isWriteMode
      ? (config.readOnlyOverlays ?? [".git", ".env"])
      : config.readOnlyOverlays,
  };

  // ── Egress proxy setup (Phase 4: lazy start on first exec) ──
  const needsProxy =
    resolvedConfig.network?.enabled === true &&
    (resolvedConfig.network.allowedHosts?.length ?? 0) > 0;
  let proxy: SandboxProxy | null = null;
  let proxyStarted = false;

  async function ensureProxy(): Promise<SandboxProxy> {
    if (proxy && proxyStarted) return proxy;
    if (!proxy) {
      proxy = createSandboxProxy({
        allowedHosts: resolvedConfig.network!.allowedHosts!,
      });
    }
    if (!proxyStarted) {
      await proxy.start();
      proxyStarted = true;
      // Register cleanup on process exit (best-effort)
      process.once("exit", () => { try { proxy?.stop(); } catch { /* best-effort */ } });
    }
    return proxy;
  }

  // ── macOS seatbelt branch ──
  if (backend === "seatbelt") {
    // failIfUnavailable: check that sandbox-exec is actually present
    if (resolvedConfig.failIfUnavailable && !probeBinary("sandbox-exec")) {
      throw new Error(
        "[sandbox] sandbox-exec binary not found on PATH and failIfUnavailable is true. " +
        "Install sandbox-exec or set failIfUnavailable to false.",
      );
    }
    const profileContent = buildSeatbeltProfile(resolvedConfig);

    return {
      exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
        return (async function* () {
          let profilePath: string | undefined;
          let socatProc: ReturnType<typeof import("node:child_process").spawn> | undefined;
          try {
            // Start egress proxy if needed (lazy, first call only)
            let proxyEnv: Record<string, string> = {};
            if (needsProxy) {
              const p = await ensureProxy();
              // socat bridges TCP → unix socket (runs outside sandbox)
              if (probeBinary("socat")) {
                const socatPort = 18080 + (++socatPortCounter);
                socatProc = spawn("socat", [
                  `TCP-LISTEN:${socatPort},bind=127.0.0.1,fork,reuseaddr`,
                  `UNIX-CONNECT:${p.socketPath}`,
                ], { stdio: "ignore", detached: false });
                proxyEnv = {
                  HTTP_PROXY: `http://127.0.0.1:${socatPort}`,
                  HTTPS_PROXY: `http://127.0.0.1:${socatPort}`,
                  NO_PROXY: "localhost,127.0.0.1",
                };
              } else {
                console.warn(
                  "[sandbox] WARNING: socat not found. Egress proxy requires socat for TCP bridging. " +
                  "Network requests inside sandbox may not be filtered. Install: apt install socat",
                );
              }
            }

            // Write profile to temp file (sandbox-exec requires a file path)
            const profileId = `${process.pid}-${++profileCounter}`;
            profilePath = join(tmpdir(), `volto-sandbox-${profileId}.sb`);
            writeFileSync(profilePath, profileContent, "utf-8");

            // Escape cmd for safe embedding in a bash -c string
            const escapedCmd = cmd.replace(/'/g, "'\\''");

            // Inject proxy env vars into the sandboxed command
            const envPrefix = Object.entries(proxyEnv)
              .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
              .join(" && ");
            // `-f` takes a profile FILE path; `-p` takes an inline profile
            // string. Passing the path to `-p` makes sandbox-exec try to
            // parse the path itself as a profile, which fails with
            // "unbound variable: <path>" — every sandboxed command exits 65.
            const wrappedCmd = envPrefix
              ? `${envPrefix} && sandbox-exec -f '${profilePath}' /bin/bash -c '${escapedCmd}'`
              : `sandbox-exec -f '${profilePath}' /bin/bash -c '${escapedCmd}'`;

            // Yield through all events from the wrapped command
            for await (const event of realShell.exec(wrappedCmd, opts)) {
              yield event;
            }
          } catch (err) {
            // Spawn failure or sandbox-exec missing: normalize to isError-like stderr + exit
            const errMsg = err instanceof Error ? err.message : String(err);
            yield { type: "stderr", data: `[sandbox] sandbox-exec wrapper failed: ${errMsg}` };
            yield { type: "exit", code: 1 };
          } finally {
            // Clean up temp profile and socat process
            if (profilePath !== undefined) {
              try { unlinkSync(profilePath); } catch { /* best-effort cleanup */ }
            }
            if (socatProc) {
              try { socatProc.kill("SIGTERM"); } catch { /* best-effort */ }
            }
          }
        })();
      },
      // No `launch` (see C4): the seatbelt profile only wraps `exec`'s
      // per-call temp-file lifecycle, so a passthrough `launch` here would
      // run the command with zero isolation — silently, since the only
      // signal was a `console.warn` nobody sees. Omitting it makes the bash
      // tool's `runInBackground` path fall back to the sandboxed `exec`
      // above instead.
    };
  }

  // ── Linux bubblewrap branch ──
  if (backend === "bubblewrap") {
    // failIfUnavailable: check that bwrap is present
    if (resolvedConfig.failIfUnavailable && !probeBinary("bwrap")) {
      throw new Error(
        "[sandbox] bwrap (bubblewrap) binary not found on PATH and failIfUnavailable is true. " +
        "Install bubblewrap (apt install bubblewrap) or set failIfUnavailable to false.",
      );
    }

    const bwrapArgs = buildBwrapArgs(resolvedConfig);
    let warned = false;

    return {
      exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
        return (async function* () {
          let socatProc: ReturnType<typeof import("node:child_process").spawn> | undefined;
          try {
            if (!warned && !probeBinary("bwrap")) {
              warned = true;
              console.warn(
                "[sandbox] WARNING: bwrap not found on PATH. " +
                "Commands will run without isolation. Install bubblewrap: apt install bubblewrap",
              );
              yield* realShell.exec(cmd, opts);
              return;
            }

            // Start egress proxy if needed
            let envPrefix = "";
            if (needsProxy) {
              const p = await ensureProxy();
              if (probeBinary("socat")) {
                const socatPort = 18080 + (++socatPortCounter);
                
                socatProc = spawn("socat", [
                  `TCP-LISTEN:${socatPort},bind=127.0.0.1,fork,reuseaddr`,
                  `UNIX-CONNECT:${p.socketPath}`,
                ], { stdio: "ignore", detached: false });
                envPrefix = [
                  `export HTTP_PROXY='http://127.0.0.1:${socatPort}'`,
                  `export HTTPS_PROXY='http://127.0.0.1:${socatPort}'`,
                  "export NO_PROXY='localhost,127.0.0.1'",
                ].join(" && ");
              } else {
                console.warn(
                  "[sandbox] WARNING: socat not found. Egress proxy requires socat for TCP bridging. " +
                  "Network requests inside sandbox may not be filtered. Install: apt install socat",
                );
              }
            }

            // Escape cmd for safe embedding in bash -c single-quoted string
            const escapedCmd = cmd.replace(/'/g, "'\\''");
            // Build inner command: envPrefix is already single-quote safe, escapedCmd is already escaped
            const innerCmd = envPrefix
              ? `${envPrefix} && ${escapedCmd}`
              : escapedCmd;
            // Shell-escape each bwrap arg to handle paths with spaces
            const escapedArgs = bwrapArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
            const wrappedCmd = `bwrap ${escapedArgs} -- /bin/bash -c '${innerCmd}'`;

            yield* realShell.exec(wrappedCmd, opts);
          } finally {
            if (socatProc) {
              try { socatProc.kill("SIGTERM"); } catch { /* best-effort */ }
            }
          }
        })();
      },
      // No `launch` (see C4): same reasoning as the seatbelt branch above —
      // bwrap wraps `exec`'s command string, a passthrough `launch` would
      // run fully unisolated.
    };
  }

  // Fallback (should not reach here)
  return realShell;
}

// ──────────────────────────────────────────────
// Seatbelt profile builder (shared — Plan 009 §4.2)
// ──────────────────────────────────────────────

/**
 * Resolve a writable root to its real (symlink-free) form, tolerating a
 * root that does not exist yet (falls back to the lexical path, matching
 * `sandboxed-filesystem.ts`'s own tolerant `realResolveRoot`). Called before
 * a root is embedded in a seatbelt/bwrap profile — see the comment on
 * `resolvedConfig.writableRoots` in `createSandboxedShell`.
 */
function resolveRealRootPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Escape a path for use inside a seatbelt profile string.
 * Handles backslash and double-quote characters.
 */
function escapeSeatbeltPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Expand relative overlay paths into absolute subpaths for each writable root.
 *
 * For a writable root `/workspace` and overlay `.git`, produces `/workspace/.git`.
 * Absolute overlays are kept as-is.
 *
 * Called by buildSeatbeltProfile and (later) buildBwrapArgs.
 */
export function expandOverlays(overlays: string[], writableRoots: string[]): string[] {
  const result: string[] = [];
  for (const overlay of overlays) {
    if (isAbsolute(overlay)) {
      result.push(overlay);
    } else {
      for (const root of writableRoots) {
        result.push(join(root, overlay));
      }
    }
  }
  return result;
}

/**
 * Build a macOS Seatbelt profile string from a SandboxConfig.
 *
 * - `(deny default)` + full read `(allow file-read-data (subpath "/"))`
 * - Allow process-exec for node binary (required for child_process.spawn)
 * - Allow mach-lookup for system.dylib (required for common system calls)
 * - Allow stdout/stderr via `/dev`
 * - `read-only` mode: no writable roots, only essential system writes
 * - `workspace-write` mode: writableRoots → `(allow file-write* ...)`, readOnlyOverlays → `(deny file-write* ...)` (deny overrides allow)
 * - `network.enabled === false` → `(deny network*)`
 */
export function buildSeatbeltProfile(config: SandboxConfig): string {
  const isReadOnly = config.mode === "read-only";
  const writableRoots = isReadOnly ? [] : (config.writableRoots ?? []);
  const rawOverlays = isReadOnly ? [] : (config.readOnlyOverlays ?? []);
  // Expand relative overlays (e.g. ".git") against each writable root
  const readOnlyOverlays = expandOverlays(rawOverlays, writableRoots);
  const networkEnabled = config.network?.enabled ?? false;

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Allow reading from everywhere (including /usr, /bin, /etc)
    '(allow file-read-data (subpath "/"))',
    // Allow file metadata reads (required for ls -l, stat, test -f, etc.)
    '(allow file-read-metadata)',
    // Allow sysctl reads (required for uname, hostname, etc.)
    '(allow sysctl-read)',
    // Allow signals (required for kill, trap, wait, etc.)
    '(allow signal)',
    // Allow POSIX IPC (required for pipes and basic process coordination)
    '(allow ipc-posix*)',
    // Allow process exec (required for child_process.spawn to work, and for
    // /bin/bash itself to exec node/git/curl/etc as the wrapped command)
    '(allow process-exec (subpath "/"))',
    // Allow process fork — verified required: without it, `/bin/bash -c` can
    // run a single simple command (bash's exec-optimization replaces itself
    // rather than forking) but fails with "fork: Operation not permitted" as
    // soon as the command line has more than one process in it — `&&`, `;`,
    // `|`, or a subshell. That is nearly every real shell command.
    '(allow process-fork)',
    // Allow mach-lookup for common system calls
    '(allow mach-lookup (global-name "system.dylib"))',
    // Allow mach-lookup for the Darwin per-user temp/cache directory helper.
    // Verified required: without it, confstr(_CS_DARWIN_USER_TEMP_DIR) fails
    // (git logs "confstr() failed ... using /tmp instead"), and callers that
    // silently fall back to a literal "/tmp" then hit file-write-create
    // denials there since only the real tmpdir() is in writableRoots.
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
    // Allow mach-lookup for user/group identity resolution. Verified
    // required for correct (not just non-crashing) output from `whoami`,
    // `id`, `ls -l`/`-la` (username column), and git's author/committer
    // resolution when user.name/user.email aren't configured.
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    // Allow stdout/stderr via /dev
    "(allow file-write-data (subpath \"/dev\"))",
  ];

  // Writable roots (workspace-write mode only, skipped for read-only)
  for (const root of writableRoots) {
    lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(root)}"))`);
  }

  // Read-only overlays (deny file-write overrides any allow above)
  for (const overlay of readOnlyOverlays) {
    lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(overlay)}"))`);
  }

  // Network — three-state semantics:
  // enabled=false  → deny all (default)
  // enabled=true + empty allowedHosts → allow all (except loopback, see below)
  // enabled=true + non-empty allowedHosts → allow all (except loopback)
  //   (the proxy runs OUTSIDE the sandbox and enforces the allowlist;
  //    the sandboxed process only needs to reach the proxy via loopback,
  //    and socat bridges loopback TCP → unix socket)
  if (networkEnabled) {
    lines.push("(allow network*)");
    // A previous revision added `(deny network* (remote ip "localhost:*"))`
    // here to keep a sandboxed process off the gateway's own control plane
    // (e.g. POST /approvals). Reverted: verified on-host with two local HTTP
    // servers — one bound to 127.0.0.1, one to this machine's LAN address —
    // that the filter does not narrow the deny to loopback at all; it
    // blocks ALL egress, loopback and LAN alike (baseline `(allow
    // network*)` alone reaches both; adding the "localhost:*" deny refuses
    // both). Seatbelt appears to degrade this particular filter into a
    // match-all deny rather than actually evaluating the remote address.
    // Loopback cannot be selectively filtered here — the control plane is
    // protected at the route instead (see apps/headless-server's
    // POST /approvals per-connection token). Do not re-add this rule.
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

/**
 * Build bubblewrap (Linux) arguments from a SandboxConfig.
 *
 * Output shape:
 *   --ro-bind / / --dev /dev --proc /proc
 *   --bind <root> <root> ...               (writableRoots, identity mounts)
 *   --ro-bind <expanded-overlay> <expanded-overlay> ... (readOnlyOverlays, after --bind to override)
 *   --unshare-net                           (when network disabled)
 *   --die-with-parent                       (auto-cleanup orphaned sandboxed processes)
 *
 * All mount options use identity mounts (src == dest) — the process sees
 * the same absolute paths inside the namespace as outside, but write
 * permissions are restricted by mount flags.
 *
 * KNOWN GAP: `--unshare-net` is all-or-nothing — bwrap has no per-destination
 * network filter. When network is enabled on Linux, a sandboxed process can
 * reach a control-plane HTTP server bound to 127.0.0.1, same as on macOS
 * (buildSeatbeltProfile's `(allow network*)` has no loopback carve-out
 * either — see that function's own comment for why one was tried and
 * reverted). The control plane is protected at the route instead, not by
 * either sandbox backend — see apps/headless-server's POST /approvals
 * per-connection token.
 */
export function buildBwrapArgs(config: SandboxConfig): string[] {
  const writableRoots = config.writableRoots ?? [];
  const rawOverlays = config.readOnlyOverlays ?? [];
  const readOnlyOverlays = expandOverlays(rawOverlays, writableRoots);
  const networkEnabled = config.network?.enabled ?? false;

  const args: string[] = [];

  // Full filesystem read-only base (identity mount: / → /)
  args.push("--ro-bind", "/", "/");

  // Required virtual filesystems (bwrap built-in single-arg options)
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // Writable roots (identity mounts: /workspace → /workspace)
  for (const root of writableRoots) {
    args.push("--bind", root, root);
  }

  // Read-only overlays (must come AFTER --bind to override the writable mount)
  for (const overlay of readOnlyOverlays) {
    args.push("--ro-bind", overlay, overlay);
  }

  // Network isolation (default: disabled)
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
/** Profile file counter to avoid concurrent exec() collisions */
let profileCounter = 0;
/** Socat port counter to avoid port conflicts within the same process */
let socatPortCounter = 0;
