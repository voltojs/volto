/**
 * Session-store selection for the gateway: sqlite when its native driver
 * loads, the JSON-directory file store otherwise.
 *
 * Why a factory instead of a static import: `@voltojs/store-sqlite` pulls in
 * `better-sqlite3`, a native module that fails to load on a machine without
 * a prebuilt binary (a Node upgrade, a libc it was not built for). A static
 * import turns that into a startup crash — `volto doctor` could not even run
 * to say why. Loaded dynamically, the same failure degrades to the file store
 * and is reported.
 *
 * The fallback deliberately does NOT read, migrate or delete the sqlite file:
 * a machine that temporarily loses the native module must not present an
 * empty session list and then have the original data garbage-collected or
 * overwritten. The two stores sit side by side, and every fallback is loud
 * about which file is now unread (see `WARNING_FOR`).
 *
 * A fallback is not one thing, though. "The native module is absent" and "the
 * database exists but cannot be opened" (EACCES, SQLITE_CANTOPEN, a corrupt
 * file) both leave the user with an empty-looking session list, but only the
 * second one means their data is still there and something else is wrong.
 * `classifyStoreFailure` separates them so the warning and `doctor` can say
 * which one happened.
 *
 * Everything is injectable (`loadSqlite`, `env`) so tests never depend on
 * breaking the real module.
 */

import type { SessionStore } from "@voltojs/core";

export type SessionStoreKind = "sqlite" | "file";

/**
 * With `kind: "sqlite"` the reason is always `primary`. With `kind: "file"` it
 * says why the file store is in use:
 *   - `forced` — `VOLTO_SESSION_STORE=file`, the operator's choice;
 *   - `module-missing` — the native driver could not be resolved at all;
 *   - `db-unusable` — the driver loaded but the database could not be opened
 *     (permissions, locking, corruption). The file may still hold sessions.
 */
export type SessionStoreReason = "primary" | "forced" | "module-missing" | "db-unusable";

export interface CreateSessionStoreOptions {
  /** sqlite database file (not touched on the fallback path). */
  dbPath: string;
  /** Directory of the JSON file store used when sqlite is unavailable. */
  fallbackDir: string;
  /** Injection seam for tests; defaults to importing `@voltojs/store-sqlite`. */
  loadSqlite?: () => Promise<SessionStore>;
  /**
   * Called once with the load failure before the fallback is used, after the
   * failure has been classified so the message can match the class.
   */
  onFallback?: (err: unknown, reason: Exclude<SessionStoreReason, "primary" | "forced">) => void;
  /** Environment to read `VOLTO_SESSION_STORE` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface SessionStoreSelection {
  kind: SessionStoreKind;
  reason: SessionStoreReason;
  store: SessionStore;
  /** The sqlite file that is NOT read whenever `kind` is `file`. */
  dbPath?: string;
  /** The sqlite load failure, when the file store replaced a working sqlite. */
  error?: unknown;
}

/** `VOLTO_SESSION_STORE=file` is the operator's escape hatch to the file store. */
function fileStoreForced(env: NodeJS.ProcessEnv): boolean {
  return env["VOLTO_SESSION_STORE"]?.toLowerCase() === "file";
}

async function loadFileStore(directory: string): Promise<SessionStore> {
  const { createStore } = await import("@voltojs/stores/file");
  return createStore({ directory });
}

/** Node's module-not-found codes (ESM and CJS). */
const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * Native-addon failures that are still "the module did not load", not "the
 * database is unusable": a missing or unloadable `.node` binary (Node ABI
 * mismatch, wrong libc, missing shared library).
 */
const ADDON_LOAD_CODES = new Set([
  "ERR_DLOPEN_FAILED",
  "ERR_DLOPEN_DISABLED",
  "ERR_DLOPEN_NOT_SUPPORTED",
]);

/** `Cannot find module`, `Cannot find package`, `Failed to load the ES module` ... */
const MODULE_MESSAGE = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i;

/** The error as a message string, including the `code` Node puts on it. */
function failureOf(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { message: err.message, ...(code !== undefined ? { code } : {}) };
  }
  if (typeof err === "object" && err !== null) {
    const { message, code } = err as { message?: unknown; code?: unknown };
    return {
      message: typeof message === "string" ? message : String(err),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(err) };
}

/**
 * Which fallback class a failed `loadSqlite` belongs to.
 *
 * Module resolution / addon loading failures mean the driver is not there at
 * all. Everything else — EACCES, SQLITE_CANTOPEN, SQLITE_BUSY, a corrupt file,
 * and any unclassified error — means the driver was there and the database
 * would not open or read. That is the case where the user's sessions still
 * exist and the warning must say so, so the default is deliberately the
 * louder, more specific class rather than a catch-all "module missing".
 */
export function classifyStoreFailure(err: unknown): "module-missing" | "db-unusable" {
  const { message, code } = failureOf(err);
  if (code !== undefined && MODULE_NOT_FOUND_CODES.has(code)) return "module-missing";
  if (code !== undefined && ADDON_LOAD_CODES.has(code)) return "module-missing";
  if (message.includes("Cannot find native binding")) return "module-missing";
  if (code === undefined && MODULE_MESSAGE.test(message)) return "module-missing";
  return "db-unusable";
}

/** `CODE: message` when a code is present, the message alone otherwise. */
function describeError(err: unknown): string {
  const { message, code } = failureOf(err);
  return code !== undefined && !message.includes(code) ? `${code}: ${message}` : message;
}

/**
 * Pick the session store.
 *
 * Throws only if the file store itself cannot be used — that is not a
 * degradation but a broken install, and a silent empty store would be the
 * exact data-loss path this module exists to avoid.
 */
export async function createSessionStore(
  opts: CreateSessionStoreOptions,
): Promise<SessionStoreSelection> {
  const env = opts.env ?? process.env;
  if (fileStoreForced(env)) {
    return {
      kind: "file",
      reason: "forced",
      store: await loadFileStore(opts.fallbackDir),
      dbPath: opts.dbPath,
    };
  }

  const loadSqlite =
    opts.loadSqlite ??
    (async () => {
      const { createStore } = await import("@voltojs/store-sqlite");
      return createStore({ path: opts.dbPath });
    });

  try {
    const store = await loadSqlite();
    return { kind: "sqlite", reason: "primary", store };
  } catch (error) {
    const reason = classifyStoreFailure(error);
    opts.onFallback?.(error, reason);
    return {
      kind: "file",
      reason,
      store: await loadFileStore(opts.fallbackDir),
      dbPath: opts.dbPath,
      error,
    };
  }
}

export interface DefaultPaths {
  /** sqlite database file. */
  dbPath: string;
  /** JSON store directory used when sqlite is unavailable. */
  fallbackDir: string;
}

/**
 * The warning for a fallback. Loud, and it always names the file that is now
 * unread — the two classes differ in what they claim about it.
 */
export function fallbackWarning(
  paths: DefaultPaths,
  reason: "module-missing" | "db-unusable",
  err: unknown,
): string {
  const detail = describeError(err);
  if (reason === "module-missing") {
    return (
      `volto: WARNING — the sqlite session store at ${paths.dbPath} could not be loaded (${detail}). ` +
      `Sessions are now saved to ${paths.fallbackDir} instead. ` +
      `Existing sessions in ${paths.dbPath} are NOT deleted or migrated and stay invisible to this process ` +
      `until sqlite loads again; diagnose with \`volto doctor\`.`
    );
  }
  return (
    `volto: WARNING — the session database ${paths.dbPath} EXISTS but cannot be opened (${detail}). ` +
    `Sessions are now saved to ${paths.fallbackDir} instead. ` +
    `The existing sessions are NOT being read, and nothing was written to, migrated or deleted from ${paths.dbPath}: ` +
    `repair it (permissions, locks, corruption) and restart to see them again; diagnose with \`volto doctor\`.`
  );
}

/**
 * The selection the wiring would make for `paths`, including the warning the
 * server prints — same call, same message, so `doctor` cannot drift from the
 * server. Pass `warn: false` to probe silently (doctor prints the failure in
 * its own table instead of twice).
 */
export function selectSessionStore(
  paths: DefaultPaths,
  opts: { warn?: boolean } = {},
): Promise<SessionStoreSelection> {
  return createSessionStore({
    dbPath: paths.dbPath,
    fallbackDir: paths.fallbackDir,
    ...(opts.warn === false
      ? {}
      : { onFallback: (err, reason) => console.warn(fallbackWarning(paths, reason, err)) }),
  });
}

/**
 * The `doctor` detail column and the server's one-line summary: same
 * vocabulary for every outcome.
 */
export function describeSessionStoreKind(
  kind: SessionStoreKind,
  reason: SessionStoreReason = kind === "sqlite" ? "primary" : "forced",
): string {
  if (kind === "sqlite") return "sqlite (primary)";
  if (reason === "db-unusable") return "file (fallback: db unusable)";
  if (reason === "module-missing") return "file (fallback: module missing)";
  return "file (forced)";
}