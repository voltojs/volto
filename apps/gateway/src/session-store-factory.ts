/**
 * Session-store selection for the gateway: sqlite when its native driver
 * loads, the JSON-directory file store otherwise.
 *
 * Why a factory instead of a static import: `@volto/store-sqlite` pulls in
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
 * about which file is now unread (see `createSessionStore`'s `onFallback`).
 *
 * Everything is injectable (`loadSqlite`, `env`) so tests never depend on
 * breaking the real module.
 */

import type { SessionStore } from "@volto/core";

export type SessionStoreKind = "sqlite" | "file";

export interface CreateSessionStoreOptions {
  /** sqlite database file (not touched on the fallback path). */
  dbPath: string;
  /** Directory of the JSON file store used when sqlite is unavailable. */
  fallbackDir: string;
  /** Injection seam for tests; defaults to importing `@volto/store-sqlite`. */
  loadSqlite?: () => Promise<SessionStore>;
  /** Called once with the load failure before the fallback is used. */
  onFallback?: (err: unknown) => void;
  /** Environment to read `VOLTO_SESSION_STORE` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface SessionStoreSelection {
  kind: SessionStoreKind;
  store: SessionStore;
  /**
   * Why the kind is what it is: `forced` (operator asked for the file store),
   * `fallback` (sqlite failed to load) or `primary` (sqlite loaded). `doctor`
   * distinguishes `file (forced)` from `file (fallback)` with this.
   */
  reason: "primary" | "forced" | "fallback";
  /** The sqlite file that is NOT being read when `kind` is `file`. */
  dbPath?: string;
  /** The sqlite load failure, when `reason` is `fallback`. */
  error?: unknown;
}

/** `VOLTO_SESSION_STORE=file` is the operator's escape hatch to the file store. */
function fileStoreForced(env: NodeJS.ProcessEnv): boolean {
  return env["VOLTO_SESSION_STORE"]?.toLowerCase() === "file";
}

async function loadFileStore(directory: string): Promise<SessionStore> {
  const { createStore } = await import("@volto/store-file");
  return createStore({ directory });
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
      const { createStore } = await import("@volto/store-sqlite");
      return createStore({ path: opts.dbPath });
    });

  try {
    const store = await loadSqlite();
    return { kind: "sqlite", reason: "primary", store };
  } catch (error) {
    opts.onFallback?.(error);
    return {
      kind: "file",
      reason: "fallback",
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
 * The selection the wiring would make for `paths`, warning and all — the
 * same `onFallback` message the server prints, emitted only when a probe
 * actually falls back. `doctor` calls this so its answer cannot drift from
 * the server's.
 */
export function selectSessionStore(paths: DefaultPaths): Promise<SessionStoreSelection> {
  return createSessionStore({
    dbPath: paths.dbPath,
    fallbackDir: paths.fallbackDir,
    onFallback: (err) => console.warn(warningFor(paths, err)),
  });
}

/** The loud line printed when sqlite cannot be loaded. Names the unread file. */
function warningFor(paths: DefaultPaths, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (
    `volto: WARNING — the sqlite session store at ${paths.dbPath} could not be loaded (${message}). ` +
    `Sessions are now saved to ${paths.fallbackDir} instead. ` +
    `Existing sessions in ${paths.dbPath} are NOT deleted or migrated and stay invisible to this process ` +
    `until sqlite loads again; diagnose with \`volto doctor\`.`
  );
}

/**
 * The operator-facing one-liner for `doctor`: which store the server would
 * actually use. Kept next to the factory so the two cannot drift.
 */
export function describeSessionStoreKind(
  kind: SessionStoreKind,
  reason: SessionStoreSelection["reason"] = "primary",
): string {
  if (kind === "sqlite") return "available (@volto/store-sqlite loaded)";
  return reason === "forced" ? "file (forced)" : "file (fallback)";
}