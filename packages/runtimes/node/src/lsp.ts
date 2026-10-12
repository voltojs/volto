/**
 * Node.js LSP manager — a per-session manager of language server processes.
 *
 * One lazy child process per language, shared by every file of that language
 * in the session. It owns everything the tools must not know about:
 *
 * - process lifetime (spawn under the session sandbox, kill on dispose)
 * - workspace containment (a request may only name a file inside the root)
 * - document sync (didOpen before the first request, didChange after a write)
 * - JSON-RPC framing, request id pairing and per-request timeouts
 *
 * Every failure path is normalized into an `Error` carrying one of
 * `LSP_ERROR_CODES`, so a caller (the `lsp_*` tools) can turn it into an
 * `isError: true` result instead of letting it escape and kill the turn.
 */

import { accessSync, constants, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { Clock, FileSystem } from "@volto/core";
import { fileToUri, uriToFile } from "@volto/tools-code";
import type {
  LspClient,
  LspClientProvider,
  LspDiagnostic,
  LspDiagnosticReport,
  LspHover,
  LspLocation,
  LspReference,
} from "@volto/tools-code";
import { createSandboxedProcessSpawner } from "./sandbox.js";
import type { SandboxConfig, SandboxedProcess } from "./sandbox.js";

/** Error codes every rejection from this module carries. */
export const LSP_ERROR_CODES = [
  "LSP_SERVER_MISSING",
  "LSP_PATH_OUTSIDE_WORKSPACE",
  "LSP_LANGUAGE_UNCONFIGURED",
  "LSP_UNAVAILABLE",
] as const;

export type LspErrorCode = (typeof LSP_ERROR_CODES)[number];

/** An error a caller can branch on: `code` is always one of `LSP_ERROR_CODES`. */
export class LspManagerError extends Error {
  readonly code: LspErrorCode;

  constructor(code: LspErrorCode, message: string) {
    super(message);
    this.name = "LspManagerError";
    this.code = code;
  }
}

/** How to launch one language server. */
export interface LspServerSpec {
  command: string;
  args?: string[];
  initializationParams?: Record<string, unknown>;
}

/** Result of the injectable executable probe. */
export interface LspProbeResult {
  available: boolean;
  /** Absolute location the probe resolved, when `available`. */
  path?: string;
}

export interface LspManagerOptions {
  /** Absolute root every file argument must resolve inside. */
  workspaceRoot: string;
  fs: FileSystem;
  /** Language id → server spec. `undefined` means "not configured". */
  servers: Record<string, LspServerSpec | undefined>;
  /** Session sandbox for the language server child. */
  sandbox?: SandboxConfig;
  /**
   * Session clock. Request/initialize timeouts currently use real timers,
   * because they bound a real child's response; the Clock port is here for
   * the idle-reclaim accounting (Task 4), which must be injectable to be
   * testable without waiting.
   */
  clock: Clock;
  /**
   * Idle reclaim budget before a server is shut down. Reserved for Task 4 —
   * accepted and exported as `DEFAULT_IDLE_TIMEOUT_MS` here so the option
   * surface is settled, but no reclaim runs yet.
   */
  idleTimeoutMs?: number;
  /** Timeout for a document request (definition/hover/...). Default: 15s. */
  requestTimeoutMs?: number;
  /**
   * Timeout for the `initialize` handshake. Separate from `requestTimeoutMs`
   * because the two measure different things: a caller may want a tight bound
   * on a hover (a slow answer is useless) while a server is still allowed a
   * realistic first-boot cost (indexing, `tsserver` spawn). Collapsing them
   * makes a short request timeout indistinguishable from "the server never
   * started", which is a different failure with a different remedy.
   * Default: `max(requestTimeoutMs, 15s)`.
   */
  initializationTimeoutMs?: number;
  /**
   * Executable probe, called once per language server start.
   *
   * Deliberately injected rather than reusing `sandbox.ts`'s `probeBinary`:
   * that helper memoizes a negative result in a module-level cache
   * (`probeCache`), so the ordinary "install the server, then retry in the
   * same session" flow would fail forever on a stale `false`. A probe whose
   * answer can change during the process lifetime must not be cached — hence
   * an injectable one, defaulting to an uncached `fs.accessSync(path, X_OK)`
   * for absolute paths and `which` for bare names.
   */
  probe?: (command: string) => LspProbeResult;
}

export interface LspManager extends LspClientProvider {
  forFile(file: string): Promise<LspClient>;
  dispose(): Promise<void>;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Extension → language id. Only languages with a known server mapping. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".json": "json",
};

function languageIdFor(filePath: string): string | undefined {
  const match = /(\.[^./\\]+)$/.exec(filePath);
  if (!match) return undefined;
  return LANGUAGE_BY_EXTENSION[match[1]!.toLowerCase()];
}

/**
 * Default executable probe — uncached on purpose (see `LspManagerOptions.probe`).
 * Absolute paths are checked directly with `X_OK`; bare names go through
 * `which`, since only the PATH can resolve them.
 */
function defaultProbe(command: string, cwd: string): LspProbeResult {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return { available: true, path: command };
    } catch {
      return { available: false };
    }
  }
  try {
    const resolved = execFileSync("which", [command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd,
    }).trim();
    return resolved.length > 0 ? { available: true, path: resolved } : { available: false };
  } catch {
    return { available: false };
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** LSP frame header/body separator. */
const FRAME_SEPARATOR = Buffer.from("\r\n\r\n");

/**
 * One language server process plus its JSON-RPC session.
 *
 * `request` registers the id before writing and deletes it when it settles,
 * so an exit/timeout and a late response can never settle the same request
 * twice.
 */
class LspServerConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly proc: SandboxedProcess;
  private readonly requestTimeoutMs: number;
  /**
   * Framing is byte-oriented, so the buffer stays a Buffer.
   *
   * `Content-Length` counts UTF-8 bytes while a decoded JS string indexes
   * UTF-16 code units; slicing the string by the byte count mangles every
   * frame carrying non-ASCII text (two units where there were three bytes),
   * and the session then mis-parses everything after it. Decode only a whole
   * frame.
   */
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private nextId = 1;
  private dead: Error | undefined;
  private disposed = false;
  /**
   * Whether the server advertised a `diagnosticProvider` in its `initialize`
   * result. Only then does `textDocument/diagnostic` exist; otherwise the
   * server's own `textDocument/publishDiagnostics` notifications are the only
   * diagnostics there will ever be.
   */
  private pullDiagnosticsSupported = false;
  /**
   * Latest `textDocument/publishDiagnostics` per document URI.
   *
   * Per connection, not per manager: a restart must not inherit the previous
   * process's reports, and a dead process must not leave any behind. An entry
   * present with an empty array means "reported and clean" — a different fact
   * from "absent", which is why the map, not a bare array, is the cache.
   */
  private readonly publishedDiagnostics = new Map<string, LspDiagnostic[]>();

  constructor(proc: SandboxedProcess, requestTimeoutMs: number) {
    this.proc = proc;
    this.requestTimeoutMs = requestTimeoutMs;
    proc.stdout.on("data", (chunk: Buffer | string) => {
      this.consume(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
    });
    proc.onError((err) => {
      this.failAll(
        new LspManagerError("LSP_UNAVAILABLE", `language server failed to start: ${err.message}`),
      );
    });
    proc.onExit((code, signal) => {
      // During dispose the exit is expected; a caller must be able to tell the
      // two apart, so the messages differ (and "exited unexpectedly" is what
      // the restart/lifecycle tests assert on).
      this.failAll(
        this.disposed
          ? new LspManagerError("LSP_UNAVAILABLE", "language server was shut down")
          : new LspManagerError(
              "LSP_UNAVAILABLE",
              `language server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
            ),
      );
    });
  }

  /** Reject every in-flight request exactly once; later arrivals see `dead`. */
  private failAll(error: Error): void {
    if (this.dead === undefined) this.dead = error;
    // The process is gone, so its reports are gone with it: serving them after
    // an exit (or after a restart reuses this object) would report the dead
    // server's last word as if it were current.
    this.publishedDiagnostics.clear();
    for (const pending of this.pending.values()) pending.reject(this.dead);
    this.pending.clear();
  }

  get alive(): boolean {
    return this.dead === undefined && !this.disposed;
  }

  /** Record the `initialize` result's `diagnosticProvider` presence. */
  markPullDiagnosticsSupported(): void {
    this.pullDiagnosticsSupported = true;
  }

  get supportsPullDiagnostics(): boolean {
    return this.pullDiagnosticsSupported;
  }

  /**
   * The cached report for `uri`, or `undefined` when nothing was published.
   *
   * A copy, not the stored array: `diagnostics()` hands this to a caller that
   * may sort or splice it, and that must not be able to corrupt what later
   * calls read back out of the cache.
   */
  publishedFor(uri: string): LspDiagnostic[] | undefined {
    const cached = this.publishedDiagnostics.get(uri);
    return cached === undefined ? undefined : [...cached];
  }

  /**
   * Drop the cached report for `uri`, without telling the server anything.
   *
   * Used when the document changes under the cache: the stored array describes
   * the previous version, and serving it as a current pushed report is exactly
   * the stale-answer false green this contract exists to remove. Until the
   * server publishes again, the honest answer is `"none"` — which an absent
   * entry expresses, where an empty array would wrongly claim "reported clean".
   */
  forgetPublished(uri: string): void {
    this.publishedDiagnostics.delete(uri);
  }

  /**
   * Tell the server a document is no longer open, and drop its cached report.
   *
   * A closed document has no diagnostics to report, so keeping the cache entry
   * would answer a later `diagnostics()` with a stale report for a document the
   * server no longer holds.
   */
  closeDocument(uri: string): void {
    this.forgetPublished(uri);
    try {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    } catch {
      // The server is already gone; there is nobody left to notify.
    }
  }

  private write(message: unknown): void {
    if (this.dead !== undefined) throw this.dead;
    const body = JSON.stringify(message);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = this.nextId++;
      let settled = false;
      /** Clears the timer created just below; every exit path calls it once. */
      const onSettled = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        finish();
      };
      const settle = (finish: () => void): void => {
        clearTimeout(timer);
        onSettled(finish);
      };

      const timer = setTimeout(() => {
        onSettled(() =>
          rejectRequest(
            new LspManagerError(
              "LSP_UNAVAILABLE",
              `language server did not respond to ${method} within ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => settle(() => resolveRequest(value)),
        reject: (error) => settle(() => rejectRequest(error)),
      });

      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        settle(() => rejectRequest(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  /** Content-Length framed JSON-RPC reader (byte-oriented, see `buffer`). */
  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(FRAME_SEPARATOR);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue; // malformed frame — ignore it rather than tear down the session
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message["id"];
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (pending === undefined) return; // already settled (timeout/exit) — never twice
      this.pending.delete(id);
      // `null` is a legal `error` member for a tolerant server, and this runs
      // inside the stdout 'data' callback — a TypeError here is an uncaught
      // host exception, not a rejected request.
      const error = message["error"] as { message?: string } | null | undefined;
      if (error !== undefined && error !== null) {
        pending.reject(
          new LspManagerError(
            "LSP_UNAVAILABLE",
            `language server returned an error for request ${id}: ${error.message ?? "unknown error"}`,
          ),
        );
        return;
      }
      pending.resolve(message["result"]);
      return;
    }
    // A server-initiated notification (no id). Push diagnostics arrive this
    // way and are the only thing this manager subscribes to.
    if (id === undefined || id === null) {
      if (message["method"] === "textDocument/publishDiagnostics") {
        const params = message["params"] as
          | { uri?: unknown; diagnostics?: unknown }
          | undefined;
        const uri = params?.uri;
        if (typeof uri === "string" && Array.isArray(params?.diagnostics)) {
          this.publishedDiagnostics.set(
            uri,
            (params.diagnostics as unknown[]).map(normalizeDiagnostic),
          );
        }
      }
      return;
    }
    // A server-initiated request (string id, no pending entry) is answered
    // "method not found": this manager only ever requests, and leaving a
    // server request unanswered would stall the server's own flow.
    if (typeof id === "string") {
      try {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
      } catch {
        // The process is already gone; there is nothing to answer.
      }
    }
  }

  close(): void {
    this.disposed = true;
    this.failAll(new LspManagerError("LSP_UNAVAILABLE", "language server was shut down"));
    try {
      this.proc.kill();
    } catch {
      // Already dead — nothing to reap.
    }
  }
}

/** Per-document sync bookkeeping for one connection. */
interface DocumentState {
  version: number;
  text: string;
}

export function createNodeLspManager(opts: LspManagerOptions): LspManager {
  const workspaceRoot = normalizeRoot(opts.workspaceRoot);
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const initializationTimeoutMs =
    opts.initializationTimeoutMs ?? Math.max(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const probe = opts.probe ?? ((command: string) => defaultProbe(command, workspaceRoot));

  const spawnUnder = createSandboxedProcessSpawner(opts.sandbox ?? { mode: "danger-full-access" });
  const connections = new Map<string, LspServerConnection>();
  const starting = new Map<string, Promise<LspServerConnection>>();
  const documents = new Map<string, Map<string, DocumentState>>();
  /** Per-file serialization: concurrent callers must not both send didOpen. */
  const locks = new Map<string, Promise<void>>();
  let disposed = false;

  async function resolveInsideWorkspace(file: string): Promise<string> {
    // The session FileSystem is the authority on what the workspace contains.
    // Its refusal is not necessarily an LspManagerError, so re-map it to the
    // stable code callers branch on.
    let hostPath: string;
    try {
      hostPath = opts.fs.resolvePath
        ? await opts.fs.resolvePath(file)
        : resolve(workspaceRoot, file);
    } catch {
      throw new LspManagerError(
        "LSP_PATH_OUTSIDE_WORKSPACE",
        `"${file}" is outside the workspace root ${workspaceRoot}`,
      );
    }
    // Second, realpath-based check: resolvePath is lexical, and a symlink
    // inside the workspace can still point out of it.
    let realPath: string;
    try {
      realPath = realpathSync(hostPath);
    } catch {
      realPath = hostPath; // not created yet — the lexical check above stands
    }
    if (!isInside(realPath, workspaceRoot)) {
      throw new LspManagerError(
        "LSP_PATH_OUTSIDE_WORKSPACE",
        `"${file}" resolves outside the workspace root ${workspaceRoot}`,
      );
    }
    return hostPath;
  }

  function languageFor(hostPath: string): string {
    const languageId = languageIdFor(hostPath);
    if (languageId === undefined || opts.servers[languageId] === undefined) {
      throw new LspManagerError(
        "LSP_LANGUAGE_UNCONFIGURED",
        `no language server configured for "${hostPath}"`,
      );
    }
    return languageId;
  }

  async function startConnection(languageId: string): Promise<LspServerConnection> {
    const spec = opts.servers[languageId];
    if (spec === undefined) {
      throw new LspManagerError(
        "LSP_LANGUAGE_UNCONFIGURED",
        `no language server configured for language "${languageId}"`,
      );
    }

    const probed = probe(spec.command);
    if (!probed.available) {
      throw new LspManagerError(
        "LSP_SERVER_MISSING",
        `language server "${spec.command}" for language "${languageId}" was not found or is not executable`,
      );
    }
    if (spawnUnder === undefined) {
      throw new LspManagerError(
        "LSP_UNAVAILABLE",
        "no sandbox spawner is available on this platform, so no language server can be started",
      );
    }

    const proc = spawnUnder({
      command: probed.path ?? spec.command,
      args: spec.args,
      cwd: workspaceRoot,
    });
    const connection = new LspServerConnection(proc, requestTimeoutMs);

    const initParams: Record<string, unknown> = {
      processId: process.pid,
      clientInfo: { name: "volto", version: "0.0.1" },
      rootUri: fileToUri(workspaceRoot),
      workspaceFolders: [{ uri: fileToUri(workspaceRoot), name: "workspace" }],
      capabilities: {
        // Full sync: the manager sends the whole document on every change.
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          // Both halves of the diagnostics contract are declared: pull support
          // so a pull-capable server may answer textDocument/diagnostic, and
          // push support so it may send publishDiagnostics without guessing.
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: { workspaceFolders: true },
      },
      ...(spec.initializationParams ?? {}),
    };

    let initializeResult: unknown;
    try {
      initializeResult = await connection.request("initialize", initParams, initializationTimeoutMs);
    } catch (err) {
      connection.close();
      throw err;
    }
    // Pull diagnostics exist only when the server says so; there is no
    // "push capability" to check, so absence here simply leaves the push cache
    // as the only source.
    const diagnosticProvider = (
      initializeResult as { capabilities?: { diagnosticProvider?: unknown } } | null | undefined
    )?.capabilities?.diagnosticProvider;
    if (diagnosticProvider !== undefined && diagnosticProvider !== null) {
      connection.markPullDiagnosticsSupported();
    }
    connection.notify("initialized", {});

    connections.set(languageId, connection);
    documents.set(languageId, new Map());
    return connection;
  }

  /** One start attempt per language, shared by every concurrent caller. */
  function ensureConnection(languageId: string): Promise<LspServerConnection> {
    const existing = connections.get(languageId);
    if (existing !== undefined && existing.alive) return Promise.resolve(existing);
    const inFlight = starting.get(languageId);
    if (inFlight !== undefined) return inFlight;

    const attempt = startConnection(languageId).finally(() => {
      starting.delete(languageId);
    });
    starting.set(languageId, attempt);
    return attempt;
  }

  /** Serialize per-file work so concurrent callers emit one didOpen, not two. */
  function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    // Drop the entry once it is the tail, or a session that touches many files
    // keeps one resolved promise per file forever.
    void settled.then(() => {
      if (locks.get(key) === settled) locks.delete(key);
    });
    return run;
  }

  /**
   * Ensure the server holds the current on-disk text of `file`.
   *
   * Read-then-send runs inside the per-file serialization so two concurrent
   * requests can never both observe "not opened yet" and each emit a didOpen.
   */
  async function syncDocument(
    languageId: string,
    connection: LspServerConnection,
    filePath: string,
    uri: string,
  ): Promise<void> {
    await withFileLock(uri, async () => {
      const text = await readText(opts.fs, filePath);
      const docs = documents.get(languageId) ?? new Map<string, DocumentState>();
      documents.set(languageId, docs);
      const current = docs.get(uri);

      if (current === undefined) {
        const state: DocumentState = { version: 1, text };
        docs.set(uri, state);
        connection.notify("textDocument/didOpen", {
          textDocument: { uri, languageId, version: state.version, text },
        });
        return;
      }
      if (current.text === text) return;

      // A version is per document and strictly increasing, as full sync requires.
      const state: DocumentState = { version: current.version + 1, text };
      docs.set(uri, state);
      // The cached push report describes the version that just went away.
      // Drop it BEFORE the notification leaves, so a `diagnostics()` call that
      // overlaps the server's re-analysis answers "none" instead of serving the
      // previous version's errors (or its previous "clean") as current.
      connection.forgetPublished(uri);
      connection.notify("textDocument/didChange", {
        textDocument: { uri, version: state.version },
        contentChanges: [{ text }],
      });
    });
  }

  /** Resolve → check language → ensure server → sync document → return both. */
  async function prepare(
    file: string,
    boundLanguageId?: string,
  ): Promise<{ connection: LspServerConnection; uri: string; languageId: string }> {
    if (disposed) {
      throw new LspManagerError("LSP_UNAVAILABLE", "the LSP manager has been disposed");
    }
    const filePath = await resolveInsideWorkspace(file);
    const languageId = languageFor(filePath);
    // A client is bound to one language's server. A URI for a different
    // language must say so rather than be answered by the wrong server (an
    // empty result would read as "no definition here", which is a lie).
    if (boundLanguageId !== undefined && languageId !== boundLanguageId) {
      throw new LspManagerError(
        "LSP_LANGUAGE_UNCONFIGURED",
        `"${file}" belongs to language "${languageId}", but this client is bound to "${boundLanguageId}"`,
      );
    }
    const connection = await ensureConnection(languageId);
    const uri = fileToUri(filePath);
    await syncDocument(languageId, connection, filePath, uri);
    return { connection, uri, languageId };
  }

  /**
   * A client bound to one document's language.
   *
   * The `uri` parameter stays meaningful — it names the document to ask about —
   * but it is never trusted: it is converted back to a path, re-checked against
   * the workspace and against the bound language, and the document it names is
   * opened/refreshed before the request. Otherwise a caller could reach outside
   * the workspace, or query a document the server never received.
   */
  function makeClient(boundFile: string, boundLanguageId: string): LspClient {
    /**
     * Resolve the caller's URI through exactly the same boundary as
     * `forFile`, then hand the canonical URI and a live connection to `fn`.
     * Every method goes through here, so no method can be a hole in the
     * containment checks.
     */
    const withConnection = async <T>(
      uri: string,
      fn: (connection: LspServerConnection, canonicalUri: string) => Promise<T>,
    ): Promise<T> => {
      // A non-`file:` URI or a malformed one must reject like any other bad
      // path, not surface a TypeError from the URI helper.
      let filePath: string;
      try {
        filePath = uriToFile(uri);
      } catch {
        throw new LspManagerError(
          "LSP_PATH_OUTSIDE_WORKSPACE",
          `"${uri}" is not a file:// URI inside the workspace root`,
        );
      }
      const { connection, uri: canonicalUri } = await prepare(filePath, boundLanguageId);
      return fn(connection, canonicalUri);
    };

    const request = (
      uri: string,
      method: string,
      buildParams: (canonicalUri: string) => Record<string, unknown>,
    ): Promise<unknown> =>
      withConnection(uri, (connection, canonicalUri) =>
        connection.request(method, buildParams(canonicalUri)),
      );

    return {
      definition: (uri, line, character) =>
        request(uri, "textDocument/definition", (u) => ({
          textDocument: { uri: u },
          position: { line, character },
        })).then((result) => normalizeLocations(result)),

      references: (uri, line, character) =>
        request(uri, "textDocument/references", (u) => ({
          textDocument: { uri: u },
          position: { line, character },
          context: { includeDeclaration: true },
        })).then((result) => normalizeReferences(result)),

      rename: (uri, line, character, newName) =>
        request(uri, "textDocument/rename", (u) => ({
          textDocument: { uri: u },
          position: { line, character },
          newName,
        })).then((result) => normalizeRename(result)),

      diagnostics: (uri) =>
        withConnection(uri, async (connection, canonicalUri): Promise<LspDiagnosticReport> => {
          if (connection.supportsPullDiagnostics) {
            const result = await connection.request("textDocument/diagnostic", {
              textDocument: { uri: canonicalUri },
            });
            // Requested without a previousResultId, so the answer is a full
            // report; an empty `items` is still an answer from the server.
            return { diagnostics: normalizeDiagnostics(result), source: "pull" };
          }
          const published = connection.publishedFor(canonicalUri);
          if (published === undefined) return { diagnostics: [], source: "none" };
          return { diagnostics: published, source: "push" };
        }),

      hover: (uri, line, character) =>
        request(uri, "textDocument/hover", (u) => ({
          textDocument: { uri: u },
          position: { line, character },
        })).then((result) => normalizeHover(result)),
    };
  }

  return {
    async forFile(file: string): Promise<LspClient> {
      const { languageId } = await prepare(file);
      return makeClient(file, languageId);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const [languageId, connection] of connections) {
        // Close the documents this manager opened before killing the process:
        // that is the `didClose` half of the push-cache rule (the other half is
        // `failAll` on exit), and it keeps the last thing the server hears a
        // coherent session.
        for (const uri of documents.get(languageId)?.keys() ?? []) {
          connection.closeDocument(uri);
        }
        connection.close();
      }
      // A start that was still in flight when dispose() landed would otherwise
      // leak its child: close it as soon as it resolves.
      for (const attempt of starting.values()) {
        void attempt.then(
          (connection) => connection.close(),
          () => undefined,
        );
      }
      connections.clear();
      documents.clear();
      locks.clear();
    },
  };
}

function normalizeRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Read the whole document as text; a missing file syncs as empty. */
async function readText(fs: FileSystem, filePath: string): Promise<string> {
  try {
    const result = await fs.read(filePath, 1, Number.MAX_SAFE_INTEGER);
    return result.content;
  } catch {
    return "";
  }
}

function normalizeLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result as LspLocation[];
  return [result as LspLocation];
}

function normalizeReferences(result: unknown): LspReference[] {
  return Array.isArray(result) ? (result as LspReference[]) : [];
}

function normalizeRename(
  result: unknown,
): Record<
  string,
  Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>
> {
  if (result === null || result === undefined || typeof result !== "object") return {};
  return result as Record<
    string,
    Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } } }>
  >;
}

function normalizeHover(result: unknown): LspHover | null {
  if (result === null || result === undefined || typeof result !== "object") return null;
  const contents = (result as { contents?: unknown }).contents;
  if (typeof contents === "string") return { contents };
  if (contents !== null && typeof contents === "object" && "value" in contents) {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === "string") return { contents: value };
  }
  return null;
}

/** LSP `DiagnosticSeverity` numbers → the contract's word for each. */
const SEVERITY_BY_NUMBER: Record<number, LspDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

const SEVERITIES = new Set<string>(["error", "warning", "information", "hint"]);

/**
 * Normalize one wire diagnostic into the contract's shape.
 *
 * LSP puts `severity` on the wire as a number (1..4). Passing that through
 * would type-check nowhere and — worse — make every `severity === "error"`
 * filter downstream count zero, so a file full of type errors would be
 * reported as clean. A missing or unknown severity becomes `"error"`, which is
 * the client's documented discretion and the safe reading for a tool whose job
 * is to surface problems.
 */
function normalizeDiagnostic(item: unknown): LspDiagnostic {
  const wire = (item ?? {}) as Record<string, unknown>;
  const severity = wire["severity"];
  const word =
    typeof severity === "number"
      ? SEVERITY_BY_NUMBER[severity]
      : typeof severity === "string" && SEVERITIES.has(severity)
        ? (severity as LspDiagnostic["severity"])
        : undefined;
  return {
    range: (wire["range"] as LspDiagnostic["range"] | undefined) ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    severity: word ?? "error",
    message: typeof wire["message"] === "string" ? wire["message"] : "",
    ...(typeof wire["source"] === "string" ? { source: wire["source"] } : {}),
  };
}

/**
 * Normalize a `textDocument/diagnostic` result into `LspDiagnostic[]`.
 *
 * `items` is the only member this manager asks for: it never sends a
 * `previousResultId`, so a conforming server always answers with a full
 * report and never `{ kind: "unchanged" }`.
 */
function normalizeDiagnostics(result: unknown): LspDiagnostic[] {
  if (result === null || result === undefined || typeof result !== "object") return [];
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeDiagnostic(item));
}
