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

import type { Shell, ShellExecOptions, ShellEvent, ShellLaunchOptions } from "@voltojs/core";
import type { Sandbox, SandboxExecSpec, SandboxEvent } from "@voltojs/core";
import type { SandboxMode } from "@voltojs/core";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { createSandboxProxy, type SandboxProxy } from "./sandbox-proxy.js";
import { classifyRunnerFailure, type SandboxBackendName } from "./sandbox-enforcement.js";
import type { SandboxEnforcement } from "./sandbox-enforcement.js";
import type { SessionSpawnHandle } from "./persistent-session.js";

// ──────────────────────────────────────────────
// SandboxConfig (Plan 009 §4.3)
// ──────────────────────────────────────────────

/** Three-tier isolation mode — platform-agnostic semantics (re-exported from @voltojs/core) */
export type { SandboxMode };

/** Platform backend selection */
export type SandboxBackend = "seatbelt" | "bubblewrap" | "none";

/** Network egress configuration */
export interface SandboxNetworkConfig {
  /** Whether network is enabled. Default: false (blocked) */
  enabled?: boolean;
  /**
   * When non-empty, only these hosts are allowed through a local proxy.
   *
   * NOT enforced by `createSandboxedProcessSpawner`: that spawner builds no
   * egress proxy, and the seatbelt/bwrap network rule is on/off only, so a
   * non-empty list would be silently ignored. It refuses at construction
   * instead — use `createSandboxedShell` / `createSandboxSessionSpawner` for
   * filtered egress, or drop `allowedHosts` to allow egress explicitly.
   */
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
   *
   * The opt-out is implemented differently per spawner, deliberately:
   *
   * - `createSandboxedShell` (exec/launch) and `createSandboxSessionSpawner`:
   *   `false` in the no-backend branch warns once and then runs the command
   *   UNCONFINED — a test/e2e affordance for platforms without any backend.
   * - `createSandboxedProcessSpawner`: `false` in the no-backend branch
   *   returns `undefined`. That spawner's callers hold a long-lived child and
   *   have no confined fallback to degrade to, so an absent spawner is the
   *   only honest answer; it does NOT grant an unconfined process under a
   *   confining mode.
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

    const warnOnce = (): void => {
      if (!warned) {
        warned = true;
        console.warn(
          "[sandbox] WARNING: No sandbox backend available on this platform. " +
          "Commands will run without isolation. This is a security risk.",
        );
      }
    };

    const shell: SandboxedShell = {
      sandboxEnforcement: "none",
      exec(cmd: string, opts?: ShellExecOptions) {
        warnOnce();
        return realShell.exec(cmd, stripEnvFrom(opts, stripped, strippedPatterns));
      },
    };

    // Background launch on the opt-out path. This backend confines nothing —
    // exec is already unconfined — so a launch passthrough does not "bypass"
    // any boundary that exists; it is the same unconfined process, with the
    // same one-time warning and the same env stripping. The previous refusal
    // to expose launch here (C4) only pushed the caller onto the equally
    // unconfined exec path via the bash tool's fallback.
    //
    // Process methods are attached only when the underlying shell provides
    // them: absent means unsupported, same contract as the confining branches.
    if (realShell.launch) {
      shell.launch = async (cmd: string, opts?: ShellLaunchOptions) => {
        warnOnce();
        return realShell.launch!(
          cmd,
          stripEnvFrom(opts, stripped, strippedPatterns) as ShellLaunchOptions | undefined,
        );
      };
    }
    if (realShell.readProcessOutput) {
      shell.readProcessOutput = (id, cursor) => realShell.readProcessOutput!(id, cursor);
    }
    if (realShell.killProcess) {
      shell.killProcess = (id) => realShell.killProcess!(id);
    }
    if (realShell.listProcesses) {
      shell.listProcesses = () => realShell.listProcesses!();
    }
    if (realShell.disposeProcesses) {
      shell.disposeProcesses = () => realShell.disposeProcesses!();
    }
    return shell;
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
                  // curl ignores uppercase HTTP_PROXY for plain http:// URLs
                  // (httpoxy CVE mitigation — it only trusts the lowercase
                  // form, since HTTP_PROXY is attacker-settable via a
                  // "Proxy:" header under old CGI setups). HTTPS_PROXY has
                  // no such restriction and is read case-insensitively, but
                  // without http_proxy an http:// command connects direct,
                  // bypassing the allowlist entirely.
                  http_proxy: `http://127.0.0.1:${socatPort}`,
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

        // Same egress-proxy discipline as exec() above: without this a
        // background launch reaches any host directly, bypassing
        // `allowedHosts` entirely — the seatbelt profile itself only turns
        // network on/off, it cannot filter by host.
        let socatProc: ReturnType<typeof spawn> | undefined;
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
              `export http_proxy='http://127.0.0.1:${socatPort}'`,
              `export HTTP_PROXY='http://127.0.0.1:${socatPort}'`,
              `export HTTPS_PROXY='http://127.0.0.1:${socatPort}'`,
              "export NO_PROXY='localhost,127.0.0.1'",
            ].join(" && ") + " && ";
          } else {
            console.warn(
              "[sandbox] WARNING: socat not found. Egress proxy requires socat for TCP bridging. " +
              "Background launch network requests may not be filtered. Install: apt install socat",
            );
          }
        }

        const escapedCmd = cmd.replace(/'/g, "'\\''");
        // `-f` takes a profile FILE path; `-p` takes an inline profile
        // string. Passing the path to `-p` makes sandbox-exec try to parse
        // the path itself as a profile, which fails with "unbound variable"
        // — same defect documented on the exec() path above.
        const wrapped = `${envPrefix}${seatbeltBinary} -f '${profilePath}' /bin/bash -c '${escapedCmd}'`;

        let id: string;
        try {
          id = await realShell.launch!(wrapped, withStrippedEnv(opts));
        } catch (err) {
          // Launch failed — don't leak the profile file or the socat bridge.
          try { unlinkSync(profilePath); } catch { /* best-effort */ }
          try { socatProc?.kill("SIGTERM"); } catch { /* best-effort */ }
          throw err;
        }

        // Drop the profile and kill the socat bridge when the process dies.
        // A 1s poll is enough: the file is small, and the same interval
        // covers kill/dispose paths.
        const timer = setInterval(() => {
          const info = realShell.listProcesses?.().find((p) => p.id === id);
          if (!info || !info.running) {
            clearInterval(timer);
            try { unlinkSync(profilePath); } catch { /* best-effort */ }
            try { socatProc?.kill("SIGTERM"); } catch { /* best-effort */ }
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
                  `export http_proxy='http://127.0.0.1:${socatPort}'`,
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
            // Shell-escape each bwrap arg to handle paths with spaces
            const escapedArgs = bwrapArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
            // envPrefix runs in the OUTER shell, before bwrap — bwrap passes
            // the environment through by default (no --clearenv), so the
            // exported HTTP_PROXY/HTTPS_PROXY reach the sandboxed bash the
            // same way PATH does. Putting it outside also sidesteps nesting
            // its single-quoted export values inside the inner /bin/bash -c
            // '...' string, which would prematurely close that quote.
            const wrappedCmd = `${envPrefix ? `${envPrefix} && ` : ""}${bwrapBinary} ${escapedArgs} -- /bin/bash -c '${escapedCmd}'`;

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
      // Background launch under bwrap. Unlike seatbelt there is no profile
      // file to write or clean up — every isolation argument is on the
      // command line, so the wrap is pure string construction and the
      // process methods all delegate straight to realShell.
      async launch(
        cmd: string,
        opts?: ShellLaunchOptions,
      ): Promise<string> {
        // Re-probe at launch time: the binary could have been removed since
        // construction. A missing runner is infrastructure failure, not a
        // command failure — refuse rather than run unconfined.
        if (!runnerBinaryAvailable(bwrapBinary)) {
          throw new Error(
            `${INFRA_FAILURE_PREFIX} the sandbox runner "${bwrapBinary}" is not available; ` +
            `refusing to background-launch without isolation.`,
          );
        }

        // Same egress-proxy discipline as exec() above: without this a
        // background launch reaches any host directly, bypassing
        // `allowedHosts` entirely — bwrap's --unshare-net is all-or-nothing,
        // it cannot filter by host.
        let socatProc: ReturnType<typeof spawn> | undefined;
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
              `export http_proxy='http://127.0.0.1:${socatPort}'`,
              `export HTTP_PROXY='http://127.0.0.1:${socatPort}'`,
              `export HTTPS_PROXY='http://127.0.0.1:${socatPort}'`,
              "export NO_PROXY='localhost,127.0.0.1'",
            ].join(" && ") + " && ";
          } else {
            console.warn(
              "[sandbox] WARNING: socat not found. Egress proxy requires socat for TCP bridging. " +
              "Background launch network requests may not be filtered. Install: apt install socat",
            );
          }
        }

        // Escape cmd for safe embedding in bash -c single-quoted string
        const escapedCmd = cmd.replace(/'/g, "'\\''");
        // Shell-escape each bwrap arg to handle paths with spaces
        const escapedArgs = bwrapArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        // envPrefix runs in the OUTER shell, before bwrap — bwrap passes the
        // environment through by default, so putting it here (rather than
        // nested inside the inner /bin/bash -c '...' string) also avoids its
        // single-quoted export values prematurely closing that quote.
        const wrapped = `${envPrefix}${bwrapBinary} ${escapedArgs} -- /bin/bash -c '${escapedCmd}'`;

        let id: string;
        try {
          id = await realShell.launch!(wrapped, withStrippedEnv(opts));
        } catch (err) {
          try { socatProc?.kill("SIGTERM"); } catch { /* best-effort */ }
          throw err;
        }

        if (socatProc) {
          const proc = socatProc;
          const timer = setInterval(() => {
            const info = realShell.listProcesses?.().find((p) => p.id === id);
            if (!info || !info.running) {
              clearInterval(timer);
              try { proc.kill("SIGTERM"); } catch { /* best-effort */ }
            }
          }, 1000);
          timer.unref();
        }
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

  // Fallback (should not reach here — backend is always one of the three above)
  return Object.assign(Object.create(Object.getPrototypeOf(realShell) as object), realShell, {
    sandboxEnforcement: "none" as const,
  }) as SandboxedShell;
}

// ──────────────────────────────────────────────
// Persistent-session spawner (B-2 Task 8)
// ──────────────────────────────────────────────

/**
 * Environment for a spawned child: `process.env` minus `strippedNames` and
 * any name matching `strippedPatterns`. Spawn's `env` replaces the whole
 * environment rather than merging, so PATH and friends must be rebuilt here.
 */
function buildStrippedEnv(
  strippedNames: readonly string[],
  strippedPatterns: readonly RegExp[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const name of strippedNames) delete env[name];
  for (const name of Object.keys(env)) {
    for (const pattern of strippedPatterns) {
      // A /g or /y regex carries lastIndex across calls; reset every test.
      pattern.lastIndex = 0;
      if (pattern.test(name)) {
        delete env[name];
        break;
      }
    }
  }
  return env;
}

/**
 * Pin the same defaults `createSandboxedShell` uses so a profile built for a
 * long-lived session matches one built for a one-shot exec.
 */
function resolveSessionSandboxConfig(config: SandboxConfig): SandboxConfig {
  const isWriteMode = config.mode === "workspace-write";
  return {
    ...config,
    // Verified required: seatbelt's `(subpath "...")` match is evaluated
    // against the REAL (symlink-resolved) path — see createSandboxedShell.
    writableRoots: isWriteMode
      ? (config.writableRoots ?? [process.cwd(), tmpdir()]).map(resolveRealRootPath)
      : config.writableRoots,
    readOnlyOverlays: isWriteMode
      ? (config.readOnlyOverlays ?? [".git", ".env"])
      : config.readOnlyOverlays,
    deniedReadPaths: config.deniedReadPaths?.map(resolveRealRootPath),
  };
}

/** Bare `/bin/bash -s` spawner — no isolation, env stripping still applies. */
function makeBareSessionSpawner(
  strippedNames: readonly string[],
  strippedPatterns: readonly RegExp[],
  warnOnce?: () => void,
): (opts: { cwd: string }) => SessionSpawnHandle {
  return ({ cwd }: { cwd: string }): SessionSpawnHandle => {
    warnOnce?.();
    return {
      child: spawn("/bin/bash", ["-s"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildStrippedEnv(strippedNames, strippedPatterns),
      }),
    };
  };
}

/**
 * Build a spawn factory that wraps a long-lived `bash -s` in the sandbox.
 *
 * - seatbelt: `sandbox-exec -f <profile> /bin/bash -s` (per-session profile
 *   file, unlinked by `cleanup`)
 * - bwrap:    `bwrap <args> -- /bin/bash -s`
 * - danger-full-access / none: bare `/bin/bash -s` (none warns once)
 *
 * Returns `undefined` when a confining backend was selected but its runner
 * binary is missing and the caller opted out of the throw — that shell cannot
 * confine a long-lived process, and silently running unconfined is the failure
 * this phase exists to prevent. Throws at construction when
 * `failIfUnavailable` (the default) and no usable backend is present.
 */
/**
 * Egress proxy for a session spawner, shared across every session that
 * spawner creates. Same `allowedHosts` enforcement as `createSandboxedShell`'s
 * `exec()`/`launch()` — without it a persistent session's `curl` etc. reaches
 * any host directly, since the seatbelt/bwrap network toggle is on/off only.
 *
 * Unlike exec()/launch(), a session spawn is synchronous (persistent-session.ts
 * calls `options.spawn()` without awaiting), so the proxy is started eagerly,
 * fire-and-forget, the first time a spawner needing it is created — not lazily
 * per spawn. A session spawned before start() resolves fails closed (socat's
 * TCP-LISTEN isn't up yet, so the child's HTTP_PROXY connection is refused)
 * rather than bypassing the allowlist.
 */
function createSessionEgressProxy(
  config: SandboxConfig,
): {
  start(): void;
  /** Env vars for one session's child, plus the socat bridge's own cleanup. */
  forSession(): { env: Record<string, string>; cleanup?: () => void };
} | undefined {
  const needsProxy =
    config.network?.enabled === true && (config.network.allowedHosts?.length ?? 0) > 0;
  if (!needsProxy) return undefined;

  const proxy = createSandboxProxy({ allowedHosts: config.network!.allowedHosts! });
  let started = false;
  return {
    start() {
      if (started) return;
      started = true;
      void proxy.start().catch(() => { /* best-effort; sessions fail closed until ready */ });
      process.once("exit", () => { try { proxy.stop(); } catch { /* best-effort */ } });
    },
    forSession(): { env: Record<string, string>; cleanup?: () => void } {
      if (!probeBinary("socat")) {
        console.warn(
          "[sandbox] WARNING: socat not found. Egress proxy requires socat for TCP bridging. " +
          "Session network requests may not be filtered. Install: apt install socat",
        );
        return { env: {} };
      }
      const socatPort = 18080 + (++socatPortCounter);
      // One socat bridge per session, killed by the caller's cleanup — a
      // session is long-lived, unlike exec()/launch()'s one-shot bridges.
      const socatProc = spawn("socat", [
        `TCP-LISTEN:${socatPort},bind=127.0.0.1,fork,reuseaddr`,
        `UNIX-CONNECT:${proxy.socketPath}`,
      ], { stdio: "ignore", detached: false });
      return {
        env: {
          // curl (and most other tools) ignore uppercase HTTP_PROXY for
          // plain http:// requests — see the matching comment on exec()'s
          // proxyEnv above. Without the lowercase form, a session's
          // `curl http://...` connects direct, bypassing the allowlist.
          http_proxy: `http://127.0.0.1:${socatPort}`,
          HTTP_PROXY: `http://127.0.0.1:${socatPort}`,
          HTTPS_PROXY: `http://127.0.0.1:${socatPort}`,
          NO_PROXY: "localhost,127.0.0.1",
        },
        cleanup: () => { try { socatProc.kill("SIGTERM"); } catch { /* best-effort */ } },
      };
    },
  };
}

export function createSandboxSessionSpawner(
  config: SandboxConfig,
): ((opts: { cwd: string }) => SessionSpawnHandle) | undefined {
  const backend = config.backend ?? detectBackend();
  const strippedNames = config.strippedEnvVars ?? [];
  const strippedPatterns = config.strippedEnvPatterns ?? [];

  // danger-full-access: no isolation by definition.
  if (config.mode === "danger-full-access") {
    return makeBareSessionSpawner(strippedNames, strippedPatterns);
  }

  const failIfUnavailable = config.failIfUnavailable ?? true;

  // No backend for this platform. Default is refuse; opt-out warns once and
  // runs unconfined — same discipline as createSandboxedShell.
  if (backend === "none") {
    if (failIfUnavailable) {
      throw new Error(
        `[sandbox] No sandbox backend available on this platform (${process.platform}), ` +
        `and mode "${config.mode}" promises confinement. Refusing to run unconfined. ` +
        `Use mode "danger-full-access" to run without isolation deliberately, or set ` +
        `failIfUnavailable: false to accept an unconfined process under this mode.`,
      );
    }
    let warned = false;
    const warnOnce = (): void => {
      if (!warned) {
        warned = true;
        console.warn(
          "[sandbox] WARNING: No sandbox backend available on this platform. " +
          "Persistent session commands will run without isolation. This is a security risk.",
        );
      }
    };
    return makeBareSessionSpawner(strippedNames, strippedPatterns, warnOnce);
  }

  const resolved = resolveSessionSandboxConfig(config);
  const strippedNamesR = resolved.strippedEnvVars ?? [];
  const strippedPatternsR = resolved.strippedEnvPatterns ?? [];
  const egressProxy = createSessionEgressProxy(resolved);
  egressProxy?.start();

  if (backend === "seatbelt") {
    const seatbeltBinary = resolved.seatbeltBinary ?? "sandbox-exec";
    if (!runnerBinaryAvailable(seatbeltBinary)) {
      if (failIfUnavailable) {
        throw new Error(
          `[sandbox] ${seatbeltBinary} binary not found on PATH and failIfUnavailable is true. ` +
          "Install sandbox-exec, or use mode \"danger-full-access\" to run without isolation " +
          "deliberately. Setting failIfUnavailable: false only moves the refusal from " +
          "construction to the spawner returning undefined — it does not grant an unconfined process.",
        );
      }
      // Honest "cannot confine": never fall through to a bare bash -s.
      return undefined;
    }

    const profileContent = buildSeatbeltProfile(resolved);
    return ({ cwd }: { cwd: string }): SessionSpawnHandle => {
      const profileId = `${process.pid}-${++profileCounter}`;
      const profilePath = join(tmpdir(), `volto-sandbox-${profileId}.sb`);
      writeFileSync(profilePath, profileContent, "utf-8");
      // Env is passed directly to the sandbox-exec process (not embedded in
      // a shell string), and both sandbox-exec and the inner /bin/bash -s it
      // launches inherit it — no quoting concerns, unlike exec()/launch().
      const proxySession = egressProxy?.forSession();
      let child: ReturnType<typeof spawn>;
      try {
        // `-f` takes a profile FILE path; `-p` takes an inline profile string.
        // Passing the path to `-p` makes sandbox-exec parse the path itself
        // as a profile and fail with "unbound variable" — same defect
        // documented on the exec() path above.
        child = spawn(seatbeltBinary, ["-f", profilePath, "/bin/bash", "-s"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...buildStrippedEnv(strippedNamesR, strippedPatternsR), ...proxySession?.env },
        });
      } catch (err) {
        try { unlinkSync(profilePath); } catch { /* best-effort cleanup */ }
        proxySession?.cleanup?.();
        throw err;
      }
      return {
        child,
        cleanup: () => {
          try { unlinkSync(profilePath); } catch { /* best-effort cleanup */ }
          proxySession?.cleanup?.();
        },
      };
    };
  }

  // bubblewrap
  const bwrapBinary = resolved.bwrapBinary ?? "bwrap";
  if (!runnerBinaryAvailable(bwrapBinary)) {
    if (failIfUnavailable) {
      throw new Error(
        `[sandbox] ${bwrapBinary} (bubblewrap) binary not found on PATH and failIfUnavailable is true. ` +
        "Install bubblewrap (apt install bubblewrap), or use mode \"danger-full-access\" to run " +
        "without isolation deliberately. Setting failIfUnavailable: false only moves the refusal " +
        "from construction to the spawner returning undefined — it does not grant an unconfined process.",
      );
    }
    return undefined;
  }

  const bwrapArgs = buildBwrapArgs(resolved);
  return ({ cwd }: { cwd: string }): SessionSpawnHandle => {
    // bwrap has no profile file — every isolation argument is on the argv.
    // Env is passed directly to the spawned child (not embedded in a shell
    // string); bwrap passes it through to the inner /bin/bash -s (no
    // --clearenv), same as PATH — no quoting concerns.
    const proxySession = egressProxy?.forSession();
    const child = spawn(bwrapBinary, [...bwrapArgs, "--", "/bin/bash", "-s"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...buildStrippedEnv(strippedNamesR, strippedPatternsR), ...proxySession?.env },
    });
    return { child, cleanup: proxySession?.cleanup };
  };
}

// ──────────────────────────────────────────────
// Sandboxed process primitive (LSP/db wiring, Task 1)
// ──────────────────────────────────────────────

/**
 * A long-lived non-shell child living under the sandbox, with pipes.
 *
 * Unlike `createSandboxedShell`, nothing here goes through `/bin/bash`: the
 * caller's `command` and `args` are passed to the sandbox runner as argv, so
 * a language server (or any other program) speaks its own protocol over the
 * three pipes with no shell quoting in between.
 */
export interface SandboxedProcess {
  readonly pid?: number;
  readonly enforcement: SandboxEnforcement;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Spec for one sandboxed child process. */
export interface SandboxedProcessSpec {
  command: string;
  args?: string[];
  cwd: string;
}

/**
 * Build a spawner that runs an arbitrary command inside the session sandbox.
 *
 * - `danger-full-access` → passthrough with `enforcement: "none"` (it confines
 *   nothing by definition, and saying otherwise would be a false claim).
 * - seatbelt → `sandbox-exec -f <profile> <command> <args...>`
 * - bubblewrap → `bwrap <args> -- <command> <args...>`
 *
 * Refusal behaviour. A confining mode never yields an unconfined process:
 *
 * - No backend for this platform (`backend: "none"`): construction throws when
 *   `failIfUnavailable` is unset or true, and returns `undefined` when it is
 *   explicitly `false` — the caller gets no spawner at all.
 * - Backend selected but its runner binary is missing: construction throws
 *   when `failIfUnavailable` is unset or true, and returns `undefined` when it
 *   is explicitly `false`. A half-present backend is never downgraded to an
 *   unconfined passthrough.
 * - `network.enabled` with a non-empty `allowedHosts`, **with a usable backend**
 *   (the `backend === "none"` branch above refuses first, so on a backend-less
 *   platform construction throws the no-backend error instead): construction
 *   throws, because this spawner builds no egress proxy and cannot enforce a
 *   host whitelist.
 *
 * `SandboxConfig.failIfUnavailable` records how this differs from the
 * shell/session spawners, which run unconfined under the same opt-out.
 *
 * Every child-process failure is delivered through `onError` / `onExit`; a
 * `spawn` 'error' event (ENOENT, EACCES) is captured for callbacks registered
 * after construction instead of being re-thrown as an uncaught exception.
 */
export function createSandboxedProcessSpawner(
  config: SandboxConfig,
): ((spec: SandboxedProcessSpec) => SandboxedProcess) | undefined {
  const backend = config.backend ?? detectBackend();
  const strippedNames = config.strippedEnvVars ?? [];
  const strippedPatterns = config.strippedEnvPatterns ?? [];

  // ── danger-full-access: no isolation by definition ──
  if (config.mode === "danger-full-access") {
    return (spec) => spawnSandboxedProcess(
      { command: spec.command, args: spec.args ?? [], cwd: spec.cwd },
      { enforce: false, enforcement: "none", env: buildStrippedEnv(strippedNames, strippedPatterns) },
    );
  }

  const failIfUnavailable = config.failIfUnavailable ?? true;

  // No backend for this platform. Unlike createSandboxSessionSpawner — which
  // warns once and runs a bare, UNCONFINED `bash -s` when the caller opts out
  // — this spawner deliberately refuses: its callers hold a long-lived child
  // and have no confined fallback, so `failIfUnavailable: false` makes it
  // return `undefined` rather than hand back an unconfined process under a
  // mode that promises confinement.
  if (backend === "none") {
    if (failIfUnavailable) {
      throw new Error(
        `[sandbox] No sandbox backend available on this platform (${process.platform}), ` +
        `and mode "${config.mode}" promises confinement. Refusing to run unconfined. ` +
        `Use mode "danger-full-access" to run without isolation deliberately, or set ` +
        `failIfUnavailable: false to make this spawner return undefined — it does not ` +
        `grant an unconfined process under this mode.`,
      );
    }
    return undefined;
  }

  // Same realpath discipline as createSandboxedShell / createSandboxSessionSpawner:
  // seatbelt and bwrap match REAL paths, and on macOS both `/tmp` and
  // `os.tmpdir()` are symlinks.
  const resolved = resolveSessionSandboxConfig(config);
  const strippedNamesR = resolved.strippedEnvVars ?? [];
  const strippedPatternsR = resolved.strippedEnvPatterns ?? [];

  // A host whitelist cannot be honoured here: this spawner builds no egress
  // proxy, and both backends' network rule is on/off only (`(allow network*)`
  // / `--unshare-net`), so a non-empty `allowedHosts` would be silently
  // ignored while `SandboxNetworkConfig.allowedHosts` promises filtering.
  // Refuse rather than pretend. The fs-side config the LSP manager passes
  // carries no `network` block, so this never fires on that path.
  if (config.network?.enabled === true && (config.network.allowedHosts?.length ?? 0) > 0) {
    throw new Error(
      `[sandbox] createSandboxedProcessSpawner cannot enforce a host whitelist ` +
      `(${config.network.allowedHosts?.length ?? 0} allowedHosts configured): this spawner builds no ` +
      `egress proxy and the sandbox backend's network rule is on/off only. Use ` +
      `createSandboxedShell or createSandboxSessionSpawner for filtered egress, or drop ` +
      `allowedHosts to allow egress explicitly.`,
    );
  }

  if (backend === "seatbelt") {
    const seatbeltBinary = resolved.seatbeltBinary ?? "sandbox-exec";
    if (!runnerBinaryAvailable(seatbeltBinary)) {
      if (failIfUnavailable) {
        throw new Error(
          `[sandbox] ${seatbeltBinary} binary not found on PATH and failIfUnavailable is true. ` +
          "Install sandbox-exec, or use mode \"danger-full-access\" to run without isolation " +
          "deliberately. Setting failIfUnavailable: false only makes this spawner return " +
          "undefined — it does not grant an unconfined process.",
        );
      }
      // Honest "cannot confine": no spawner at all.
      return undefined;
    }

    const profileContent = buildSeatbeltProfile(resolved);
    // Enforcement is a RUNTIME fact: the runner is present, so the profile
    // governs every file effect this config asks for.
    return (spec) => {
      // A fresh profile file per spawn, written at spawn time and unlinked
      // when the child exits — a spawner that is never used leaves nothing
      // behind, and a profile cannot be reused for the wrong cwd/roots.
      //
      // The `volto-proc-sandbox-` prefix is deliberately distinct from the
      // session spawner's `volto-sandbox-`: sandbox-session.test.ts proves a
      // killed session unlinks its profile by counting `volto-sandbox-*` in
      // the shared os.tmpdir(), so a second writer under that prefix makes
      // that assertion observe this spawner's files instead.
      const profileId = `${process.pid}-${++profileCounter}`;
      const profilePath = join(tmpdir(), `volto-proc-sandbox-${profileId}.sb`);
      // A write failure (unwritable tmpdir, an undeletable file at that
      // path) is this child's failure, not the host's: it is reported
      // through onError below, never thrown at the caller. No confined child
      // exists, so enforcement is "none" — claiming "full" here would assert
      // confinement for a process that was never started.
      let profileError: Error | undefined;
      try {
        writeFileSync(profilePath, profileContent, "utf-8");
      } catch (err) {
        profileError = err instanceof Error ? err : new Error(String(err));
      }
      if (profileError !== undefined) {
        return unavailableProcess(profileError, { enforcement: "none" });
      }
      // `-f` takes a profile FILE path; `-p` takes an inline profile string —
      // see the defect documented on createSandboxedShell's exec() path.
      // argv is passed through unsplit, so the command needs no shell quoting.
      return spawnSandboxedProcess(
        {
          command: seatbeltBinary,
          args: ["-f", profilePath, spec.command, ...(spec.args ?? [])],
          cwd: spec.cwd,
        },
        {
          enforce: true,
          enforcement: "full",
          env: buildStrippedEnv(strippedNamesR, strippedPatternsR),
          cleanup: () => { try { unlinkSync(profilePath); } catch { /* best-effort cleanup */ } },
        },
      );
    };
  }

  // ── bubblewrap ──
  const bwrapBinary = resolved.bwrapBinary ?? "bwrap";
  if (!runnerBinaryAvailable(bwrapBinary)) {
    if (failIfUnavailable) {
      throw new Error(
        `[sandbox] ${bwrapBinary} (bubblewrap) binary not found on PATH and failIfUnavailable is true. ` +
        "Install bubblewrap (apt install bubblewrap), or use mode \"danger-full-access\" to run " +
        "without isolation deliberately. Setting failIfUnavailable: false only makes this spawner " +
        "return undefined — it does not grant an unconfined process.",
      );
    }
    return undefined;
  }

  const bwrapArgs = buildBwrapArgs(resolved);
  return (spec) => spawnSandboxedProcess(
    {
      command: bwrapBinary,
      args: [...bwrapArgs, "--", spec.command, ...(spec.args ?? [])],
      cwd: spec.cwd,
    },
    { enforce: true, enforcement: "full", env: buildStrippedEnv(strippedNamesR, strippedPatternsR) },
  );
}

/**
 * Spawn one child and wrap it in the `SandboxedProcess` contract.
 *
 * `detached: true` makes the child the leader of its own process group. That is
 * what makes `kill()` able to reap the INNER process: under seatbelt the direct
 * child is `sandbox-exec`, and signalling only it would leave the wrapped
 * command running. `process.kill(-pid)` signals the whole group instead.
 */
function spawnSandboxedProcess(
  spec: { command: string; args: string[]; cwd: string },
  opts: {
    /** Whether `spec` names a sandbox runner (i.e. the child leads a group to reap). */
    enforce: boolean;
    enforcement: SandboxEnforcement;
    env: Record<string, string>;
    cleanup?: () => void;
  },
): SandboxedProcess {
  const errorCbs: ((err: Error) => void)[] = [];
  const exitCbs: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  let pendingError: Error | undefined;
  let exited = false;
  let child: ChildProcess;

  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env,
      // Own process group, so kill() can signal the whole group — the inner
      // process of a seatbelt/bwrap wrapper is not the direct child.
      detached: opts.enforce,
    });
  } catch (err) {
    // A synchronous spawn throw is delivered through onError, never re-thrown
    // into the host process. No child exists, so drop whatever resource the
    // caller attached — otherwise a seatbelt profile file is left behind
    // (same cleanup discipline as the sibling createSandboxSessionSpawner).
    opts.cleanup?.();
    const error = err instanceof Error ? err : new Error(String(err));
    return unavailableProcess(error, opts);
  }

  // Register the 'error' listener before anything else: an unhandled 'error'
  // event on a ChildProcess is an uncaught exception in the host process, and
  // ENOENT for a missing binary is emitted asynchronously.
  child.on("error", (err: Error) => {
    opts.cleanup?.();
    if (errorCbs.length === 0) {
      pendingError = err;
      return;
    }
    for (const cb of errorCbs) cb(err);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    opts.cleanup?.();
    for (const cb of exitCbs) cb(code, signal);
  });

  function kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (exited) return;
    const pid = child.pid;
    if (pid !== undefined && opts.enforce) {
      try {
        // Negative pid = the child's whole process group. The wrapper is the
        // group leader, so this reaps the inner process it launched.
        if (process.kill(-pid, signal)) return;
      } catch {
        // Group already gone (ESRCH) or unsignalable — fall back below.
      }
    }
    try { child.kill(signal); } catch { /* already dead — nothing to reap */ }
  }

  // Pipes are guaranteed by stdio above, but stay honest if a platform ever
  // hands back a child without them (e.g. an already-failed spawn).
  const stdin = child.stdin ?? new Writable({ write(_c, _e, cb) { cb(); } });

  // A write to a child that has closed its stdin emits an asynchronous 'error'
  // on the stream (EPIPE), which a try/catch around `write()` cannot see and
  // which is an uncaught exception in the host process when nothing listens.
  // Long-lived consumers (a language server that exits mid-request) hit this
  // routinely, so the primitive owns it and reports it through onError.
  //
  // First failure wins: the spawn 'error' (ENOENT/EACCES) is the informative
  // one, and a later EPIPE is a consequence of the same dead child. Reporting
  // both would hand a consumer two different reasons for one failure.
  // @types/node declares `Socket.on("error", ...)`; ChildProcess's stdin is a
  // Socket at runtime but typed as Writable here, hence the cast.
  let reported = false;
  const reportStdinError = (err: Error): void => {
    if (reported || pendingError !== undefined) return;
    reported = true;
    if (errorCbs.length === 0) {
      pendingError = err;
      return;
    }
    for (const cb of errorCbs) cb(err);
  };
  (stdin as unknown as NodeJS.EventEmitter).on("error", reportStdinError);

  return {
    pid: child.pid,
    enforcement: opts.enforcement,
    stdin,
    stdout: child.stdout ?? new Readable({ read() { /* no output to read */ } }),
    stderr: child.stderr ?? new Readable({ read() { /* no output to read */ } }),
    onExit(cb) {
      if (exited) return; // a listener cannot be called twice, and the exit is past
      exitCbs.push(cb);
    },
    onError(cb) {
      errorCbs.push(cb);
      if (pendingError !== undefined) {
        const err = pendingError;
        pendingError = undefined;
        cb(err);
      }
    },
    kill,
  };
}

/**
 * A `SandboxedProcess` whose child never started: every operation is a no-op
 * and the reason is delivered to `onError` whenever it is registered.
 */
function unavailableProcess(error: Error, opts: { enforcement: SandboxEnforcement }): SandboxedProcess {
  let delivered = false;
  return {
    enforcement: opts.enforcement,
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: new Readable({ read() { /* no child, no output */ } }),
    stderr: new Readable({ read() { /* no child, no output */ } }),
    onExit() { /* never spawns, so it never exits */ },
    onError(cb) {
      if (delivered) return;
      delivered = true;
      cb(error);
    },
    kill() { /* nothing was started */ },
  };
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
    // protected at the route instead (see apps/gateway's
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
 * `read-only` mode emits neither the `--bind` roots nor the overlay
 * `--ro-bind` lines: `writableRoots` / `readOnlyOverlays` are
 * workspace-write-tier fields, exactly as in buildSeatbeltProfile. Same
 * framing as that function: no writable roots, only essential system writes —
 * here the `--dev /dev` devtmpfs. `deniedReadPaths` still `--tmpfs`-mask their
 * paths, so "read-only" bounds writes, not reads.
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
 * either sandbox backend — see apps/gateway's POST /approvals
 * per-connection token.
 */
export function buildBwrapArgs(config: SandboxConfig): string[] {
  // Same rule as buildSeatbeltProfile: `writableRoots` and `readOnlyOverlays`
  // are workspace-write-tier fields (see SandboxConfig's own doc comment).
  // Callers hand a read-only session the same roots as a workspace-write one,
  // so the MODE must decide whether they bind — otherwise a read-only session
  // gets a writable identity mount of the whole workspace and tmp.
  const isReadOnly = config.mode === "read-only";
  const writableRoots = isReadOnly ? [] : (config.writableRoots ?? []);
  const rawOverlays = isReadOnly ? [] : (config.readOnlyOverlays ?? []);
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
