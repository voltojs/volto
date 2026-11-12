/**
 * `volto` — the operator-facing entry point for the gateway.
 *
 * Three commands share one argument parser:
 *   volto [--port n] [--host addr] [--serve-remote] [--trust-proxy]
 *         [--config-dir p] [--web-dir p] [--open|--no-open]
 *   volto token [--rotate]
 *   volto doctor
 *
 * Everything that touches the outside world (binding a port, opening a
 * browser, printing, the config directory) enters through `CliDeps`, so the
 * behaviour is testable without a real port or a real browser.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import type * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detectBackend, probeBinary } from "@volto/runtime-node";
import { loadOrCreateAccessToken, rotateAccessToken, tokenFingerprint } from "./auth/access-token.js";
import { getConfigDir } from "./config/paths.js";
import {
  describeSessionStoreKind,
  fallbackWarning,
  selectSessionStore,
} from "./session-store-factory.js";
import { createServer, type HeadlessServer, type ServerOptions } from "./server.js";
import { startWebServer, type WebServerOptions } from "./web-server.js";

/** `dist/cli.js` -> the package directory. */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = "127.0.0.1";
/** The tunnel-facing port `volto web` proxies to unless told otherwise. */
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3100";
/** `volto web`'s own port — the same one the web dev server uses. */
const DEFAULT_WEB_PORT = 6100;
const HOSTS_NEEDING_REFERENCE_NOTE = new Set(["0.0.0.0", "::"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const COMMANDS = ["serve", "token", "doctor", "web"] as const;

const USAGE = [
  "Usage: volto [command] [options]",
  "",
  "Commands:",
  "  (none)          Start the gateway and serve the web UI (default)",
  "  token           Print the persistent access token and its login URL",
  "  token --rotate  Replace the token (invalidates every issued cookie)",
  "  doctor          Check this machine's prerequisites for running volto",
  "  web             Serve the exported web app and proxy /api to a gateway",
  "",
  "Options:",
  `  --port <n>          Port to listen on (default ${DEFAULT_PORT}; 0 = system-assigned)`,
  `  --host <addr>       Interface to bind (default ${DEFAULT_HOST})`,
  "  --serve-remote      Remote mode: allow a non-loopback bind, require the access token",
  "  --trust-proxy       Trust X-Forwarded-For / X-Forwarded-Proto (only behind a tunnel)",
  "                      Off by default: without it, rate limiting counts the socket",
  "                      address, so a forged header cannot move another client's count.",
  "  --config-dir <p>    Override ~/.volto",
  "  --web-dir <p>       Override the bundled web build directory",
  "  --open / --no-open  Open the authenticated URL in a browser (default: open when local)",
  "  --help, -h          Show this message",
].join("\n");

export interface CliDeps {
  /** Swap the server factory in tests — no real port is ever bound. */
  startServer?: (opts: ServerOptions) => Promise<HeadlessServer>;
  /** Same seam for `volto web`. */
  startWeb?: (opts: WebServerOptions) => Promise<http.Server>;
  /** Overrides `--config-dir`; still exported as VOLTO_CONFIG_DIR for the process. */
  configDir?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Open the authenticated URL. Tests inject a spy; `--no-open` skips it. */
  openBrowser?: (url: string) => void;
  /** Watches for an interactive terminal; long-running servers wait for it. */
  waitForShutdown?: () => Promise<void>;
}

export interface CliOptions {
  command: (typeof COMMANDS)[number];
  help: boolean;
  port: number;
  host: string;
  serveRemote: boolean;
  trustProxy: boolean;
  configDir?: string;
  webRoot?: string;
  /** Three-state: undefined means "decide by mode". */
  open?: boolean;
  rotate: boolean;
  /** `web` only: the gateway to proxy API routes to. */
  gateway?: string;
}

/**
 * Parse `argv` into options. Unknown subcommands are reported through
 * `command`, which returns `"serve"` for args that start with a flag (the
 * default command) — the caller distinguishes them by `unknownCommand`.
 */
export function parseCliArgs(argv: string[]): { ok: true; options: CliOptions } | { ok: false; reason: string } {
  const first = argv[0];
  const hasCommand = first !== undefined && !first.startsWith("-");
  const command = hasCommand ? first : "serve";
  if (!(COMMANDS as readonly string[]).includes(command)) {
    return { ok: false, reason: `Unknown command: ${command}` };
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: hasCommand ? argv.slice(1) : argv,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "serve-remote": { type: "boolean" },
        "trust-proxy": { type: "boolean" },
        "config-dir": { type: "string" },
        "web-dir": { type: "string" },
        open: { type: "boolean" },
        "no-open": { type: "boolean" },
        rotate: { type: "boolean" },
        gateway: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // `web` listens on its own default: reusing 3100 would collide with the
  // gateway it proxies to, which is the one configuration this command exists
  // for.
  let port = command === "web" ? DEFAULT_WEB_PORT : DEFAULT_PORT;
  if (typeof values["port"] === "string") {
    port = Number(values["port"]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { ok: false, reason: `Invalid --port: ${values["port"]}` };
    }
  }

  const openFlag = values["open"] === true;
  const noOpenFlag = values["no-open"] === true;
  if (openFlag && noOpenFlag) {
    return { ok: false, reason: "--open and --no-open are mutually exclusive" };
  }

  return {
    ok: true,
    options: {
      command: command as CliOptions["command"],
      help: values["help"] === true,
      port,
      host: typeof values["host"] === "string" && values["host"] !== "" ? values["host"] : DEFAULT_HOST,
      serveRemote: values["serve-remote"] === true,
      trustProxy: values["trust-proxy"] === true,
      ...(typeof values["config-dir"] === "string" ? { configDir: values["config-dir"] } : {}),
      ...(typeof values["web-dir"] === "string" ? { webRoot: values["web-dir"] } : {}),
      ...(openFlag ? { open: true } : {}),
      ...(noOpenFlag ? { open: false } : {}),
      rotate: values["rotate"] === true,
      ...(typeof values["gateway"] === "string" ? { gateway: values["gateway"] } : {}),
    },
  };
}

/** The gateway's own version, mirroring how `server.ts` reads it. */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
      version?: unknown;
    };
    if (typeof manifest.version === "string") return manifest.version;
  } catch {
    // Display data only — never a routing input.
  }
  return "0.0.0";
}

/**
 * Whether this invocation points at a directory or a URL a remote client
 * could reach. Only the loopback bind keeps native dialogs available.
 *
 * The flag is what counts: after `--serve-remote` is accepted, a remote host
 * without the flag is refused (see `runServe` / `runWeb`), so `serveRemote`
 * alone is already the full posture.
 */
function isRemoteMode(opts: CliOptions): boolean {
  return opts.serveRemote || !LOOPBACK_HOSTS.has(opts.host);
}

/**
 * `VOLTO_CORS_ORIGINS` (comma-separated) → the list handed to the server.
 * Blank entries are dropped so a trailing comma is not an empty origin, and
 * an unset/blank variable leaves the server's own default in force.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function resolveConfigDir(opts: CliOptions, deps: CliDeps): string {
  return deps.configDir ?? opts.configDir ?? getConfigDir();
}

/**
 * Default browser opener. Deliberately fire-and-forget: a missing `open`
 * binary must not fail a server that is already listening.
 */
function defaultOpenBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(command, [url], () => undefined);
}

/** Resolve once the process is asked to stop, or the terminal is not interactive. */
function defaultWaitForShutdown(): Promise<void> {
  if (process.stdin.isTTY !== true) return new Promise<void>(() => undefined);
  return new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

// ──────────────────────────────────────────────
// token
// ──────────────────────────────────────────────

async function runToken(opts: CliOptions, configDir: string, out: (s: string) => void): Promise<number> {
  const token = opts.rotate
    ? await rotateAccessToken(configDir)
    : await loadOrCreateAccessToken(configDir);
  // R6: exactly two lines — the token, then the login URL carrying it.
  // The host here is where clients connect, which is the bind address unless
  // it is the "all interfaces" wildcard (not a usable URL host).
  const host = HOSTS_NEEDING_REFERENCE_NOTE.has(opts.host) ? DEFAULT_HOST : opts.host;
  out(`${token}\n`);
  out(`Open: http://${host}:${opts.port}/?token=${token}\n`);
  return 0;
}

// ──────────────────────────────────────────────
// doctor
// ──────────────────────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable machine-readable name, e.g. `sandbox backend`. */
  name: string;
  status: CheckStatus;
  detail: string;
  /** A failed hard requirement exits 1; a failed soft one does not. */
  hard: boolean;
}

async function checkNodeVersion(): Promise<DoctorCheck> {
  const required = 22;
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node version",
    status: major >= required ? "ok" : "fail",
    detail: `v${process.versions.node}, requires >=${required}`,
    hard: true,
  };
}

async function checkSandboxBackend(): Promise<DoctorCheck> {
  const backend = detectBackend();
  return backend === "none"
    ? { name: "sandbox backend", status: "fail", detail: "none (this platform has no supported sandbox)", hard: true }
    : { name: "sandbox backend", status: "ok", detail: backend, hard: true };
}

async function checkSandboxBinary(): Promise<DoctorCheck> {
  const backend = detectBackend();
  if (backend === "none") {
    return { name: "sandbox binary", status: "fail", detail: "n/a (no backend)", hard: true };
  }
  const binary = backend === "seatbelt" ? "sandbox-exec" : "bwrap";
  const present = probeBinary(binary);
  return {
    name: "sandbox binary",
    status: present ? "ok" : "fail",
    // A present backend without its runner cannot enforce anything, so a
    // missing binary is as hard a failure as a missing backend.
    detail: `${binary} ${present ? "found on PATH" : "NOT found on PATH"}`,
    hard: true,
  };
}

async function checkConfigDirWritable(configDir: string): Promise<DoctorCheck> {
  const probe = path.join(configDir, `.doctor-${randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(probe, "", { mode: 0o600 });
    await fs.rm(probe, { force: true });
    return { name: "config dir", status: "ok", detail: `${configDir} (writable)`, hard: true };
  } catch (err) {
    await fs.rm(probe, { force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return { name: "config dir", status: "fail", detail: `${configDir} (not writable: ${message})`, hard: true };
  }
}

/** The one configuration both store checks share, so they cannot disagree. */
function defaultStorePaths(configDir: string): { dbPath: string; fallbackDir: string } {
  return {
    dbPath: path.join(configDir, "db", "sessions.db"),
    fallbackDir: path.join(configDir, "sessions-store"),
  };
}

/**
 * Which session store the server would actually use — the same call the
 * wiring makes (`selectSessionStore`), so `doctor` cannot drift from the
 * server. The verdict vocabulary is the same for every outcome:
 *
 *   ok   (sqlite (primary))                      — loaded, sessions in `sessions.db`
 *   ok   (file (forced))                         — `VOLTO_SESSION_STORE=file`
 *   warn (file (fallback: module missing))       — the driver is absent
 *   warn (file (fallback: db unusable))          — the database exists but will not open
 *
 * Degradation and deliberate choice both show `ok`/`warn`, never `fail`: the
 * gateway starts either way and reads the file store. Only "no store at all"
 * (neither sqlite nor the file store could be created) is `fail`, and that is
 * the one store outcome allowed to make `doctor` exit 1.
 *
 * The detailed warning is printed BY THE CALLER, once, via `storeWarning` —
 * not here, so it does not appear both above the table and inside it.
 */
async function checkSessionStore(configDir: string): Promise<DoctorCheck> {
  const paths = defaultStorePaths(configDir);
  try {
    const selection = await selectSessionStore(paths, { warn: false });
    const detail = describeSessionStoreKind(selection.kind, selection.reason);
    if (selection.kind === "sqlite" || selection.reason === "forced") {
      return { name: "sqlite", status: "ok", detail, hard: false };
    }
    return { name: "sqlite", status: "warn", detail, hard: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "sqlite",
      status: "fail",
      // Nothing can hold sessions: this is the only store failure that blocks
      // a useful `volto`.
      detail: `no session store available: ${message}`,
      hard: true,
    };
  }
}

/**
 * The detailed fallback warning for `runDoctor` to print once, after the
 * table. `undefined` when sqlite is in use (or forced), and also when the
 * store check itself threw — that failure is already in the table.
 */
async function storeWarning(configDir: string): Promise<string | undefined> {
  const paths = defaultStorePaths(configDir);
  try {
    const selection = await selectSessionStore(paths, { warn: false });
    if (selection.kind === "sqlite" || selection.reason === "forced") return undefined;
    const reason = selection.reason === "db-unusable" ? "db-unusable" : "module-missing";
    return fallbackWarning(paths, reason, selection.error);
  } catch {
    return undefined;
  }
}

/** Try to bind the port, then release it — the check must not keep the socket. */
async function checkPort(port: number, host: string): Promise<DoctorCheck> {
  if (port === 0) {
    return { name: "port", status: "ok", detail: "0 (system-assigned)", hard: false };
  }
  return new Promise<DoctorCheck>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      const reason = err.code === "EADDRINUSE" ? "in use" : `unavailable: ${err.code ?? err.message}`;
      resolve({
        name: "port",
        status: "fail",
        detail: `${host}:${port} ${reason}`,
        hard: false,
      });
    });
    server.listen({ port, host }, () => {
      server.close(() => {
        resolve({ name: "port", status: "ok", detail: `${host}:${port} is free`, hard: false });
      });
    });
  });
}

/**
 * Run every check independently: one throwing check reports itself as a
 * failure and the rest still run, so `doctor` never dies mid-report.
 */
export async function runDoctorChecks(opts: { configDir: string; port: number; host: string }): Promise<DoctorCheck[]> {
  const checks: Array<() => Promise<DoctorCheck>> = [
    checkNodeVersion,
    checkSandboxBackend,
    checkSandboxBinary,
    () => checkConfigDirWritable(opts.configDir),
    () => checkSessionStore(opts.configDir),
    () => checkPort(opts.port, opts.host),
  ];
  const results: DoctorCheck[] = [];
  const names = ["node version", "sandbox backend", "sandbox binary", "config dir", "sqlite", "port"];
  for (const [index, check] of checks.entries()) {
    try {
      results.push(await check());
    } catch (err) {
      // A check that throws is itself a failed hard requirement: it means the
      // environment could not answer, which is exactly what doctor reports.
      results.push({
        name: names[index] ?? `check ${index + 1}`,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
        hard: true,
      });
    }
  }
  return results;
}

function formatCheck(check: DoctorCheck): string {
  return `${check.name}: ${check.status} (${check.detail})\n`;
}

async function runDoctor(
  opts: CliOptions,
  configDir: string,
  out: (s: string) => void,
  errOut: (s: string) => void,
): Promise<number> {
  const checks = await runDoctorChecks({ configDir, port: opts.port, host: opts.host });
  for (const check of checks) out(formatCheck(check));
  // The one long explanation, printed exactly once and after the table so it
  // never separates the rows.
  const warning = checks.some((c) => c.name === "sqlite" && c.status === "warn")
    ? await storeWarning(configDir)
    : undefined;
  if (warning !== undefined) errOut(`${warning}\n`);
  // Only a hard requirement fails the run: an unenforceable sandbox, or no
  // session store at all. A busy port or a degraded store is reported, not
  // fatal.
  return checks.some((c) => c.status === "fail" && c.hard) ? 1 : 0;
}

// ──────────────────────────────────────────────
// default command: start the gateway
// ──────────────────────────────────────────────

/** The subset of `http.Server` binding waits on — a test can stand in for it. */
type ListeningServer = Pick<http.Server, "listening" | "once" | "removeListener" | "address">;

/**
 * Wait until the socket is actually bound, and fail when it never will be.
 *
 * `createServer` returns before `listen` completes, so `address()` is still
 * null here and the OS-assigned port (for `--port 0`) only exists once
 * `listening` fires. A failed bind emits `error` instead, and that must
 * surface as a rejection: the caller prints the two startup lines, so
 * resolving on `error` printed "listening on …" for a server that never
 * listened (and then left the process to die on an unhandled `error`).
 *
 * Only one of the two events wins, and the loser's listener is removed — both
 * orders (listening then error, error then listening) end up with exactly one
 * outcome. A bare `http.Server` turns an unhandled `error` into an
 * uncaughtException, and a rejection only settles once, so neither event can
 * escape this promise.
 */
async function waitForListening(server: ListeningServer): Promise<number | undefined> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}

/** A listen-phase failure, told apart from a wiring failure by its OS code. */
function isBindError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL";
}

/** `EADDRINUSE` and friends carry the OS code; a message is the fallback. */
export function bindFailureMessage(host: string, port: number, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const detail = typeof code === "string" && code !== "" ? code : err instanceof Error ? err.message : String(err);
  // `--port 0` asked the OS to choose, so "0" is not the port anyone tried to
  // bind — naming it would send the reader looking for a process on :0.
  const where = port === 0 ? `${host}:<system-assigned port>` : `${host}:${port}`;
  return `Could not listen on ${where}: ${detail}\n`;
}

/**
 * The bind-then-announce step both commands share: wait for the socket, and
 * when that fails report it (stderr, OS error code) and hand back `undefined`
 * so the caller exits 1 **without printing a single startup line**.
 *
 * One implementation, so `serve` and `web` cannot drift apart on what a
 * failed bind looks and exits like.
 */
async function bindOrReport(
  server: ListeningServer & Pick<http.Server, "close">,
  host: string,
  requestedPort: number,
  stderr: (s: string) => void,
): Promise<number | undefined> {
  try {
    return await waitForListening(server);
  } catch (err) {
    stderr(bindFailureMessage(host, requestedPort, err));
    // A server that never listened may still own a pending handle; closing is
    // cheap and keeps the process from lingering on it.
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    return undefined;
  }
}

/** Exit code for a bind that never happened. */
const BIND_FAILED = 1;

/** The seams `runServe` needs, with the defaults already applied by `main`. */
interface ServeDeps extends CliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  openBrowser: (url: string) => void;
  waitForShutdown: () => Promise<void>;
}

async function runServe(
  opts: CliOptions,
  deps: ServeDeps,
): Promise<number> {
  const startServer = deps.startServer ?? createServer;
  const out = deps.stdout;

  // Remote bindings only exist behind an explicit opt-in; `server.ts` refuses
  // a non-loopback host regardless, so say so here with the flag named.
  if (!LOOPBACK_HOSTS.has(opts.host) && !opts.serveRemote) {
    deps.stderr(
      `Refusing to bind to non-loopback host "${opts.host}" without --serve-remote. ` +
        "The gateway exposes this machine's filesystem and an arbitrary-command agent.\n",
    );
    return 1;
  }

  const corsOrigins = parseCorsOrigins(process.env["VOLTO_CORS_ORIGINS"]);
  let server: HeadlessServer;
  try {
    server = await startServer({
      port: opts.port,
      host: opts.host,
      // The posture the server records and reports as `mode`. `server.ts`
      // refuses a non-loopback host without it, so the flag is the single
      // switch — never inferred from the host here.
      serveRemote: opts.serveRemote,
      // Posture, like `serveRemote`: only an explicit flag makes forwarding
      // headers trustworthy, because only the operator knows whether a proxy
      // is in front of this process. Off by default — otherwise any client
      // that can reach the port could forge the address its guesses are
      // counted against.
      trustProxy: opts.trustProxy,
      ...(corsOrigins.length > 0 ? { corsOrigins } : {}),
      ...(opts.webRoot !== undefined ? { webRoot: opts.webRoot } : {}),
      // The CLI owns the startup output: these two lines are the contract.
      log: () => undefined,
    });
  } catch (err) {
    deps.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // A bind that never happened prints NOTHING on stdout: the two lines below
  // are a contract a script parses, and "listening" for a port this process
  // does not hold is a lie the caller cannot detect.
  const port = await bindOrReport(server, opts.host, opts.port, deps.stderr);
  if (port === undefined) return BIND_FAILED;
  const url = new URL(server.authenticatedUrl);
  // The return value is built from the configured port; `listen(0)` gets its
  // real port from the callback, so re-derive the URL against the bound port.
  url.port = String(port);
  const authenticatedUrl = url.toString();

  // R28: these two lines are the whole stdout contract — a script parses
  // them. Anything extra goes to stderr.
  out(`volto gateway ${packageVersion()} listening on http://${opts.host}:${port}\n`);
  out(`Open: ${authenticatedUrl}\n`);
  if (isRemoteMode(opts)) {
    deps.stderr(
      "Remote mode: native dialogs disabled (POST /fs/pick-directory and /fs/reveal answer 501); access token required.\n",
    );
  }
  const shouldOpen = opts.open ?? !isRemoteMode(opts);
  if (shouldOpen) deps.openBrowser(authenticatedUrl);

  await deps.waitForShutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

// ──────────────────────────────────────────────
// web
// ──────────────────────────────────────────────

/** The seams `runWeb` needs, with the defaults already applied by `main`. */
interface WebDeps extends CliDeps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  waitForShutdown: () => Promise<void>;
}

/**
 * `volto web` — the exported UI on its own port, every API path proxied to a
 * gateway.
 *
 * The query token must be one the GATEWAY accepts: its per-process launch
 * token today, and the persistent access token once Task 12 accepts it as a
 * credential. A valid one exchanges for a cookie (302) whatever the path —
 * `/?token=…` or any API path — because a token-bearing request is proxied
 * upstream instead of served from the local shell; an invalid one gets the
 * uniform 401, and a token-bearing request is never answered with the shell.
 *
 * Remote mode (`--serve-remote`) is the same explicit posture as `serve`:
 * it is what allows a non-loopback `--host`, and a non-loopback `--host`
 * without it is refused here, before any listener exists.
 */
async function runWeb(opts: CliOptions, deps: WebDeps): Promise<number> {
  const startWeb = deps.startWeb ?? startWebServer;
  const gateway = opts.gateway ?? DEFAULT_GATEWAY_URL;
  try {
    // Fail here, with the flag named, rather than on the first request.
    new URL(gateway);
  } catch {
    deps.stderr(`Invalid --gateway: ${gateway}\n`);
    return 2;
  }

  // Same rule as `serve` (server.ts refuses it too): exposing the UI and its
  // proxy to the network is an explicit choice, not a side effect of a host
  // value.
  if (!LOOPBACK_HOSTS.has(opts.host) && !opts.serveRemote) {
    deps.stderr(
      `Refusing to bind to non-loopback host "${opts.host}" without --serve-remote. ` +
        "The proxy exposes the gateway's API to the network.\n",
    );
    return 1;
  }

  const webRoot = opts.webRoot ?? path.join(packageRoot, "web");
  let server: http.Server;
  try {
    server = await startWeb({
      port: opts.port,
      // An unspecified bind stays loopback, like the gateway's own default.
      ...(opts.host !== DEFAULT_HOST ? { host: opts.host } : {}),
      gateway,
      webRoot,
    });
  } catch (err) {
    // `startWebServer` reports a failed bind by REJECTING (it resolves only
    // once the socket is listening), so the failure lands here, not in the
    // await below. Same wording as `serve`: both commands describe a bind
    // failure identically.
    if (isBindError(err)) deps.stderr(bindFailureMessage(opts.host, opts.port, err));
    else deps.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return BIND_FAILED;
  }

  // Same rule as `serve`, through the same helper: a failed bind prints none
  // of the startup lines. (A `startWeb` that resolves before binding — the
  // test seam — takes this path instead of the catch above.)
  const port = await bindOrReport(server, opts.host, opts.port, deps.stderr);
  if (port === undefined) return BIND_FAILED;
  // The printed URL must name the interface that was actually bound: with no
  // `--host` the listener stays loopback, and `opts.host` already defaults to
  // `127.0.0.1`, so the two agree for `--port 0` as well.
  const shownHost = opts.host;
  const out = deps.stdout;
  out(`volto web ${packageVersion()} listening on http://${shownHost}:${port} -> ${gateway}\n`);
  out(`Open: http://${shownHost}:${port}/\n`);
  // The query token must be one the gateway accepts. Since the gateway takes
  // the persistent access token as a credential this URL works as-is: the
  // proxy forwards `/?token=…` untouched, the gateway answers 302 with a
  // Set-Cookie, and the cookie is stored on the web app's own origin — the
  // origin every later API call through the proxy is sent from.
  const token = await loadOrCreateAccessToken(resolveConfigDir(opts, deps));
  out(`Login: http://${shownHost}:${port}/?token=${token}\n`);

  await deps.waitForShutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    err(`${parsed.reason}\n${USAGE}\n`);
    return 2;
  }
  const opts = parsed.options;

  if (opts.help) {
    out(`${USAGE}\n`);
    return 0;
  }

  const configDir = resolveConfigDir(opts, deps);
  // `--config-dir` has to reach every derived path in this process: the
  // gateway reads the config directory through this variable alone.
  process.env["VOLTO_CONFIG_DIR"] = configDir;

  switch (opts.command) {
    case "token":
      return runToken(opts, configDir, out);
    case "doctor":
      return runDoctor(opts, configDir, out, err);
    case "web":
      return runWeb(opts, {
        ...deps,
        stdout: out,
        stderr: err,
        waitForShutdown: deps.waitForShutdown ?? defaultWaitForShutdown,
      });
    case "serve":
      return runServe(opts, {
        ...deps,
        stdout: out,
        stderr: err,
        openBrowser: deps.openBrowser ?? defaultOpenBrowser,
        waitForShutdown: deps.waitForShutdown ?? defaultWaitForShutdown,
      });
  }
}

export { DEFAULT_GATEWAY_URL, USAGE, isRemoteMode, tokenFingerprint };