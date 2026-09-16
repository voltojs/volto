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

import type { Shell, ShellExecOptions, ShellEvent, ShellLaunchOptions } from "@volto/core";
import type { Sandbox, SandboxExecSpec, SandboxEvent } from "@volto/core";
import type { SandboxMode } from "@volto/core";
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxProxy, type SandboxProxy } from "./sandbox-proxy.js";
import { classifyRunnerFailure, type SandboxBackendName } from "./sandbox-enforcement.js";
import type { SandboxEnforcement } from "./sandbox-enforcement.js";

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
  /**
   * Absolute paths the sandboxed process may not READ. Distinct from
   * `readOnlyOverlays`, which only bounds writes: these are credential
   * locations (the gateway's own config dir) whose contents would let a
   * sandboxed command authenticate to the control plane that is supposed to
   * be governing it. Resolved with realpath at construction — seatbelt
   * matches real paths, and on macOS `/tmp`, `/var` and `os.tmpdir()` are
   * all symlinks.
   */
  deniedReadPaths?: string[];
  /**
   * Environment variable names removed from the child process. A sandboxed
   * command inherits the gateway's environment verbatim, so a secret passed
   * by env var is readable with `echo $NAME` regardless of any file rule.
   */
  strippedEnvVars?: string[];
  /**
   * Regexes matched against environment variable NAMES; a name matching any
   * of them is removed exactly as `strippedEnvVars` would.
   *
   * An exact list cannot keep up with what a host happens to export
   * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, the next provider's
   * key), and a file-side fence over the credential dir is worth nothing
   * while `echo $OPENAI_API_KEY` walks around it. Patterns judge a variable
   * by what it is called, so a newly added provider key is covered the day
   * the host exports it rather than the day someone remembers to list it.
   */
  strippedEnvPatterns?: RegExp[];
  /** Linux: enable seccomp filter to block unix socket escape. Default: true */
  seccomp?: boolean;
  /** Auto-detect backend: darwin→seatbelt, linux→bubblewrap, rest→none. Default: auto */
  backend?: SandboxBackend;
  /**
   * When true (the default), a confining mode with no working isolation
   * throws at construction instead of running unconfined.
   *
   * Setting it to `false` only suppresses that throw — it does NOT promise an
   * unconfined process, because "unavailable" covers two different things and
   * they opt out differently:
   *
   * - **No backend for this platform** (`backend: "none"`): construction
   *   succeeds and commands run UNCONFINED, with a warning. Env stripping
   *   still applies — it needs no backend. This is a test/e2e affordance;
   *   production callers get the default and never reach it.
   * - **Backend selected but its runner binary is missing** (no
   *   `sandbox-exec` / `bwrap`): construction succeeds, but every `exec`
   *   refuses with an infrastructure-failure frame and exit 126. A half-
   *   present backend is a broken environment, not a platform without one,
   *   and quietly running unconfined there is the failure this phase exists
   *   to prevent.
   *
   * Either way `sandboxEnforcement` reports `none`, which is the field a
   * caller should branch on rather than inferring confinement from the mode.
   * To run without isolation deliberately, use `danger-full-access`.
   */
  failIfUnavailable?: boolean;
  /**
   * Path or name of the seatbelt runner binary. Default: "sandbox-exec".
   * Overridable so tests can inject a broken runner and prove that a runner
   * failure is reported as infrastructure failure rather than as a command
   * failure — without this, a missing or mis-invoked runner exits nonzero
   * with a diagnostic on stderr and reads as an ordinary command failure.
   */
  seatbeltBinary?: string;
  /**
   * Path or name of the bubblewrap runner binary. Default: "bwrap".
   * Same rationale as `seatbeltBinary`.
   */
  bwrapBinary?: string;
}

/**
 * A sandboxed Shell plus the enforcement fact the selected backend achieves.
 * The fact is a property of the RUNTIME (which backend was actually
 * selected), never of the config (what was asked for) — that gap is where a
 * dead sandbox hides.
 */
export type SandboxedShell = Shell & { readonly sandboxEnforcement: SandboxEnforcement };

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

/**
 * Whether the configured sandbox runner binary is actually invocable.
 * Absolute paths are checked with `which` too (it resolves them); bare
 * names go through the PATH probe.
 */
function runnerBinaryAvailable(bin: string): boolean {
  return probeBinary(bin);
}

/**
 * Prefix on the synthetic stderr line emitted when the sandbox RUNNER
 * failed. Distinct wording from any denial so a reader (and the model)
 * can tell "the sandbox blocked this" from "the sandbox is broken".
 */
const INFRA_FAILURE_PREFIX = "[sandbox] INFRASTRUCTURE FAILURE:";

/**
 * Pass through a wrapped run's events, buffering stderr so the exit event
 * can be preceded by an infrastructure-failure note when the runner (not
 * the command) is what failed.
 *
 * `exit` is already the last event of the stream, so holding only it back
 * costs nothing in streaming terms.
 */
async function* withRunnerFailureClassification(
  events: AsyncIterable<ShellEvent>,
  backend: SandboxBackendName,
): AsyncIterable<ShellEvent> {
  let stderrBuf = "";
  let exitEvent: ShellEvent | undefined;

  for await (const event of events) {
    if (event.type === "stderr") stderrBuf += event.data;
    if (event.type === "exit") {
      exitEvent = event;
      continue;
    }
    yield event;
  }

  if (exitEvent !== undefined) {
    const code = exitEvent.type === "exit" ? exitEvent.code : undefined;
    const fatal = classifyRunnerFailure(backend, code, stderrBuf);
    if (fatal !== null) {
      yield {
        type: "stderr",
        data:
          `\n${INFRA_FAILURE_PREFIX} the sandbox runner refused or crashed before ` +
          `running the command, so NOTHING was executed. This is not a denial ` +
          `and not a failure of the command itself: ${fatal}\n`,
      };
    }
    yield exitEvent;
  }
}

/**
 * Emit the infrastructure-failure pair (stderr + exit) for a runner binary
 * that is not present on this system. Short-circuits before any wrapping so
 * a missing runner is never reported as an ordinary command failure.
 */
function* missingRunnerEvents(runner: string): Iterable<ShellEvent> {
  yield {
    type: "stderr",
    data:
      `${INFRA_FAILURE_PREFIX} the sandbox runner "${runner}" was not found on this ` +
      `system, so NOTHING was executed. This is not a denial and not a failure ` +
      `of the command itself: the sandbox infrastructure is unavailable.\n`,
  };
  yield { type: "exit", code: 126 };
}

// ──────────────────────────────────────────────
// Shell decorator (Plan 009 §4.2)
// ──────────────────────────────────────────────

/**
 * Return `opts` with `strippedNames` and every name matching
 * `strippedPatterns` removed from the child environment.
 *
 * Builds the env from `process.env` (plus any caller-supplied `opts.env`)
 * so PATH and the rest of the inherited environment survive — spawn's
 * `env` replaces the whole environment rather than merging.
 */
function stripEnvFrom(
  opts: ShellExecOptions | undefined,
  strippedNames: readonly string[],
  strippedPatterns: readonly RegExp[] = [],
): ShellExecOptions | undefined {
  if (strippedNames.length === 0 && strippedPatterns.length === 0) return opts;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, opts?.env ?? {});
  for (const name of strippedNames) delete env[name];
  for (const name of Object.keys(env)) {
    for (const pattern of strippedPatterns) {
      // A /g or /y regex carries lastIndex across calls and would skip
      // names on a later pass; reset before every test so a caller-supplied
      // pattern behaves the same on every variable.
      pattern.lastIndex = 0;
      if (pattern.test(name)) {
        delete env[name];
        break;
      }
    }
  }
  return { ...opts, env };
}

/**
 * Create a Shell decorator that wraps commands in a sandbox.
 *
 * - macOS: `sandbox-exec -p <profile-file> /bin/bash -c <escaped cmd>`
 * - Linux: `bwrap <args> -- /bin/bash -c <escaped cmd>` (Phase 3)
 * - danger-full-access: passthrough (no wrapping)
 * - Other platform: throw at construction (unless `failIfUnavailable: false`,
 *   which then runs unconfined — see the field's docs for how that differs
 *   from a selected backend whose runner binary is missing)
 */
export function createSandboxedShell(
  realShell: Shell,
  config: SandboxConfig,
): SandboxedShell {
  const backend = config.backend ?? detectBackend();

  // danger-full-access: no isolation, passthrough. It confines nothing by
  // definition, so it reports `none` rather than pretending otherwise.
  if (config.mode === "danger-full-access") {
    return Object.assign(Object.create(Object.getPrototypeOf(realShell) as object), realShell, {
      sandboxEnforcement: "none" as const,
    }) as SandboxedShell;
  }

  // Default CHANGED: a confining mode with nothing to confine it is refused.
  // Silently running unconfined under a mode that promises confinement is
  // the failure this whole phase exists to prevent — it makes "I thought I
  // had a sandbox" a startup error instead of a discovery after the fact.
  // An explicit `failIfUnavailable: false` remains the escape hatch.
  const failIfUnavailable = config.failIfUnavailable ?? true;

  if (backend === "none" && failIfUnavailable) {
    throw new Error(
      `[sandbox] No sandbox backend available on this platform (${process.platform}), ` +
      `and mode "${config.mode}" promises confinement. Refusing to run unconfined. ` +
      `Use mode "danger-full-access" to run without isolation deliberately, or set ` +
      `failIfUnavailable: false to accept an unconfined process under this mode.`,
    );
  }

  // Explicit opt-out: warn once then passthrough.
  if (backend === "none") {
    let warned = false;
    // Env stripping needs no isolation backend — honour it anyway, or a
    // secret-bearing variable survives into the child on every platform
    // that happens to lack seatbelt/bwrap.
    const stripped = config.strippedEnvVars ?? [];
    const strippedPatterns = config.strippedEnvPatterns ?? [];
    return {
      sandboxEnforcement: "none",
      exec(cmd: string, opts?: ShellExecOptions) {
        if (!warned) {
          warned = true;
          console.warn(
            "[sandbox] WARNING: No sandbox backend available on this platform. " +
            "Commands will run without isolation. This is a security risk.",
          );
        }
        return realShell.exec(cmd, stripEnvFrom(opts, stripped, strippedPatterns));
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
    // Pin the resolved default so the seatbelt/bwrap probeBinary checks
    // below see the same value the none-backend check above already used.
    failIfUnavailable,
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
    // Same realpath discipline as writableRoots above — a deny rule built
    // from a lexical path silently never matches on macOS.
    deniedReadPaths: config.deniedReadPaths?.map(resolveRealRootPath),
  };

  const strippedEnvVars = resolvedConfig.strippedEnvVars ?? [];
  const strippedEnvPatterns = resolvedConfig.strippedEnvPatterns ?? [];

  function withStrippedEnv(
    opts: ShellExecOptions | ShellLaunchOptions | undefined,
  ): typeof opts {
    return stripEnvFrom(opts, strippedEnvVars, strippedEnvPatterns) as typeof opts;
  }

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
    const seatbeltBinary = resolvedConfig.seatbeltBinary ?? "sandbox-exec";
    // Probe once at construction: failIfUnavailable decides whether a missing
    // runner is a hard error, and the same fact feeds the honest
    // `sandboxEnforcement` report below.
    const seatbeltRunnerPresent = runnerBinaryAvailable(seatbeltBinary);
    if (resolvedConfig.failIfUnavailable && !seatbeltRunnerPresent) {
      throw new Error(
        `[sandbox] ${seatbeltBinary} binary not found on PATH and failIfUnavailable is true. ` +
        "Install sandbox-exec, or use mode \"danger-full-access\" to run without isolation " +
        "deliberately. Setting failIfUnavailable: false only moves the refusal from " +
        "construction to execution here — it does not grant an unconfined process.",
      );
    }
    const profileContent = buildSeatbeltProfile(resolvedConfig);

    // Enforcement is a RUNTIME fact, not a config claim. A missing runner that
    // we deliberately did not throw on (failIfUnavailable: false) confines
    // nothing — report "none" instead of pretending "full". When the runner is
    // present both confining backends govern every file effect this config
    // asks for; a future Landlock-only path or an ABI too old for one of the
    // rules must report "partial" here instead — see sandbox-enforcement.ts.
    const sandboxEnforcement: SandboxEnforcement = seatbeltRunnerPresent ? "full" : "none";

    return {
      sandboxEnforcement,
      exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
        return (async function* () {
          // A missing runner is infrastructure failure, not a command failure.
          // Detected before any wrapping so it can never read as the latter.
          if (!runnerBinaryAvailable(seatbeltBinary)) {
            yield* missingRunnerEvents(seatbeltBinary);
            return;
          }

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
              ? `${envPrefix} && ${seatbeltBinary} -f '${profilePath}' /bin/bash -c '${escapedCmd}'`
              : `${seatbeltBinary} -f '${profilePath}' /bin/bash -c '${escapedCmd}'`;

            // Yield through all events from the wrapped command, classifying
            // a runner crash (e.g. the -p defect) as infrastructure failure.
            for await (const event of withRunnerFailureClassification(
              realShell.exec(wrappedCmd, withStrippedEnv(opts)),
              backend as SandboxBackendName,
            )) {
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
      // Background launch under a per-process seatbelt profile. Each launch
      // writes its own profile file and registers a cleanup that drops it
      // when the child dies — the same -f discipline as exec() above.
      async launch(
        cmd: string,
        opts?: ShellLaunchOptions,
      ): Promise<string> {
        // Re-probe at launch time: the binary could have been removed since
        // construction. A missing runner is infrastructure failure, not a
        // command failure — refuse rather than run unconfined.
        if (!runnerBinaryAvailable(seatbeltBinary)) {
          throw new Error(
            `${INFRA_FAILURE_PREFIX} the sandbox runner "${seatbeltBinary}" is not available; ` +
            `refusing to background-launch without isolation.`,
          );
        }

        const profileId = `${process.pid}-${++profileCounter}`;
        const profilePath = join(tmpdir(), `volto-sandbox-${profileId}.sb`);
        writeFileSync(profilePath, profileContent, "utf-8");

        const escapedCmd = cmd.replace(/'/g, "'\\''");
        // `-f` takes a profile FILE path; `-p` takes an inline profile
        // string. Passing the path to `-p` makes sandbox-exec try to parse
        // the path itself as a profile, which fails with "unbound variable"
        // — same defect documented on the exec() path above.
        const wrapped = `${seatbeltBinary} -f '${profilePath}' /bin/bash -c '${escapedCmd}'`;

        let id: string;
        try {
          id = await realShell.launch!(wrapped, withStrippedEnv(opts));
        } catch (err) {
          // Launch failed — don't leak the profile file.
          try { unlinkSync(profilePath); } catch { /* best-effort */ }
          throw err;
        }

        // Drop the profile when the process dies. A 1s poll is enough: the
        // file is small, and the same interval covers kill/dispose paths.
        const timer = setInterval(() => {
          const info = realShell.listProcesses?.().find((p) => p.id === id);
          if (!info || !info.running) {
            clearInterval(timer);
            try { unlinkSync(profilePath); } catch { /* best-effort */ }
          }
        }, 1000);
        // Don't let the cleanup timer keep the host event loop alive.
        timer.unref();
        return id;
      },
      readProcessOutput(id: string, cursor?: string) {
        return realShell.readProcessOutput!(id, cursor);
      },
      killProcess(id: string) {
        return realShell.killProcess!(id);
      },
      listProcesses() {
        return realShell.listProcesses!();
      },
      async disposeProcesses() {
        await realShell.disposeProcesses!();
      },
    };
  }

  // ── Linux bubblewrap branch ──
  if (backend === "bubblewrap") {
    const bwrapBinary = resolvedConfig.bwrapBinary ?? "bwrap";
    // Probe once at construction: failIfUnavailable decides whether a missing
    // runner is a hard error, and the same fact feeds the honest
    // `sandboxEnforcement` report below.
    const bwrapRunnerPresent = runnerBinaryAvailable(bwrapBinary);
    if (resolvedConfig.failIfUnavailable && !bwrapRunnerPresent) {
      throw new Error(
        `[sandbox] ${bwrapBinary} (bubblewrap) binary not found on PATH and failIfUnavailable is true. ` +
        "Install bubblewrap (apt install bubblewrap), or use mode \"danger-full-access\" to run " +
        "without isolation deliberately. Setting failIfUnavailable: false only moves the refusal " +
        "from construction to execution here — it does not grant an unconfined process.",
      );
    }

    const bwrapArgs = buildBwrapArgs(resolvedConfig);

    // Enforcement is a RUNTIME fact, not a config claim. A missing runner that
    // we deliberately did not throw on (failIfUnavailable: false) confines
    // nothing — report "none" instead of pretending "full". When the runner is
    // present both confining backends govern every file effect this config
    // asks for; a future Landlock-only path or an ABI too old for one of the
    // rules must report "partial" here instead — see sandbox-enforcement.ts.
    const sandboxEnforcement: SandboxEnforcement = bwrapRunnerPresent ? "full" : "none";

    return {
      sandboxEnforcement,
      exec(cmd: string, opts?: ShellExecOptions): AsyncIterable<ShellEvent> {
        return (async function* () {
          // A missing runner is infrastructure failure, not a command failure.
          // Detected before any wrapping so it can never read as the latter,
          // and NEVER falling through to an unconfined realShell.exec.
          if (!runnerBinaryAvailable(bwrapBinary)) {
            yield* missingRunnerEvents(bwrapBinary);
            return;
          }

          let socatProc: ReturnType<typeof import("node:child_process").spawn> | undefined;
          try {
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
            const wrappedCmd = `${bwrapBinary} ${escapedArgs} -- /bin/bash -c '${innerCmd}'`;

            yield* withRunnerFailureClassification(
              realShell.exec(wrappedCmd, withStrippedEnv(opts)),
              backend as SandboxBackendName,
            );
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

  // Fallback (should not reach here — backend is always one of the three above)
  return Object.assign(Object.create(Object.getPrototypeOf(realShell) as object), realShell, {
    sandboxEnforcement: "none" as const,
  }) as SandboxedShell;
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

  // Denied reads — credential dirs the sandboxed process must never see.
  // Placed after the blanket `(allow file-read-data (subpath "/"))` so the
  // deny actually overrides it (same ordering discipline as the overlays).
  //
  // Verified on-host: `(deny file-read* (subpath ...))` does NOT deny — the
  // wildcard form silently no-ops and `cat` still returns the secret.
  // `(deny file-read-data ...)` does deny. file-read-metadata is denied too
  // so `ls` of the credential dir also fails rather than leaking filenames.
  const deniedReads = config.deniedReadPaths ?? [];
  for (const p of deniedReads) {
    const escaped = escapeSeatbeltPath(p);
    lines.push(`(deny file-read-data (subpath "${escaped}"))`);
    lines.push(`(deny file-read-metadata (subpath "${escaped}"))`);
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

  // Denied reads — bubblewrap has no deny semantics, so mask the path with
  // an empty tmpfs. Reads see an empty directory instead of the credential
  // contents. Must come AFTER --ro-bind / / (and any --bind of a parent)
  // for the mask to win the mount ordering.
  // PARITY NOTE: this is not equivalent to seatbelt's `(deny file-read-data)`.
  // A process that already holds an open fd to a file under the path keeps
  // reading it, and the path still exists (as an empty dir) rather than
  // being refused. Good enough to keep credentials unreadable to a fresh
  // sandboxed command; not a byte-for-byte match of the macOS rule.
  for (const p of config.deniedReadPaths ?? []) {
    args.push("--tmpfs", p);
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
