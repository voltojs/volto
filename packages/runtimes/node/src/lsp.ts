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
import { fileToUri } from "@volto/tools-code";
import type {
  LspClient,
  LspClientProvider,
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
    for (const pending of this.pending.values()) pending.reject(this.dead);
    this.pending.clear();
  }

  get alive(): boolean {
    return this.dead === undefined && !this.disposed;
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
      const error = message["error"] as { message?: string } | undefined;
      if (error !== undefined) {
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
        textDocument: { synchronization: { didSave: false, dynamicRegistration: false } },
        workspace: { workspaceFolders: true },
      },
      ...(spec.initializationParams ?? {}),
    };

    try {
      await connection.request("initialize", initParams, initializationTimeoutMs);
    } catch (err) {
      connection.close();
      throw err;
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
    locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
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
      connection.notify("textDocument/didChange", {
        textDocument: { uri, version: state.version },
        contentChanges: [{ text }],
      });
    });
  }

  /** Resolve → check language → ensure server → sync document → return both. */
  async function prepare(
    file: string,
  ): Promise<{ connection: LspServerConnection; uri: string; languageId: string }> {
    if (disposed) {
      throw new LspManagerError("LSP_UNAVAILABLE", "the LSP manager has been disposed");
    }
    const filePath = await resolveInsideWorkspace(file);
    const languageId = languageFor(filePath);
    const connection = await ensureConnection(languageId);
    const uri = fileToUri(filePath);
    await syncDocument(languageId, connection, filePath, uri);
    return { connection, uri, languageId };
  }

  /** A client bound to one document: the tool layer speaks in URIs. */
  function makeClient(boundFile: string): LspClient {
    const request = async (
      method: string,
      buildParams: (uri: string) => Record<string, unknown>,
    ): Promise<unknown> => {
      const { connection, uri } = await prepare(boundFile);
      return connection.request(method, buildParams(uri));
    };

    return {
      definition: (uri, line, character) =>
        request("textDocument/definition", () => ({
          textDocument: { uri },
          position: { line, character },
        })).then((result) => normalizeLocations(result)),

      references: (uri, line, character) =>
        request("textDocument/references", () => ({
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: true },
        })).then((result) => normalizeReferences(result)),

      rename: (uri, line, character, newName) =>
        request("textDocument/rename", () => ({
          textDocument: { uri },
          position: { line, character },
          newName,
        })).then((result) => normalizeRename(result)),

      // Task 3 turns this into a report carrying a source; the signature is
      // frozen until then (controller ruling 3).
      async diagnostics(_uri: string): Promise<never[]> {
        return [];
      },

      hover: (uri, line, character) =>
        request("textDocument/hover", () => ({
          textDocument: { uri },
          position: { line, character },
        })).then((result) => normalizeHover(result)),
    };
  }

  return {
    async forFile(file: string): Promise<LspClient> {
      await prepare(file);
      return makeClient(file);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const connection of connections.values()) connection.close();
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
