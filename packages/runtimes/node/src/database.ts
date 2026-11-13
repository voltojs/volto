/**
 * Node.js SQLite database opener — implements DatabaseOpener via better-sqlite3.
 *
 * Workspace containment and the read-only boundary live here, at the point a
 * handle is opened, so the db_query / db_exec tools only pass a model-given
 * path through:
 *
 *   - `open()` resolves the requested path through the injected FileSystem and
 *     then realpaths it, rejecting anything that leaves the workspace root.
 *   - Read-only handles are opened with better-sqlite3's `{ readonly: true,
 *     fileMustExist: true }` and pinned with `PRAGMA query_only = ON`, so a
 *     write is refused by the engine rather than by a regex.
 *   - `journal_mode` is never set. It is sticky in the database header, and
 *     turning WAL on from a read-only handle would leave `-wal` / `-shm`
 *     files behind — a read-only query must not write anything.
 *   - `ATTACH` / `DETACH`, `VACUUM INTO` and `load_extension` are refused
 *     outright, keyword-level and fail-closed: `query_only` stops none of them.
 *     Probed on a read-only handle, `ATTACH` still runs and `VACUUM INTO`
 *     creates a 0-byte file at the outside path before failing; on a
 *     read-write handle that same statement writes a full 8192-byte database
 *     there. A plain `VACUUM` stays allowed — it only rewrites the open
 *     database.
 *
 * ASSUMPTION this boundary rests on: the set refused above is the entirety of
 * SQLite's statement surface that can touch a file other than the opened
 * database. A future SQLite release adding another such shape is therefore a
 * documented risk to revisit here, not something the classifier silently
 * permits.
 *
 * better-sqlite3 must be installed by the host application:
 *   pnpm add better-sqlite3  (or npm install better-sqlite3)
 *
 * Types for better-sqlite3 are optional — the import is fully dynamic.
 */

import path from "node:path";
import type { FileSystem } from "@voltojs/core";
import type { DatabaseAdapter, DatabaseOpener, SqlRow } from "@voltojs/tools-data";
import { realResolve, realResolveRoot } from "./sandboxed-filesystem.js";

/** Raised when a requested database path leaves the workspace. */
export class DatabasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasePathError";
  }
}

export interface SqliteDatabaseOpenerOptions {
  /** Filesystem whose boundary the database path is resolved against. */
  fs: FileSystem;
  /** Absolute workspace root every opened database must live under. */
  workspaceRoot: string;
}

/**
 * The file-touching SQL surface this boundary refuses, keyword-level and
 * fail-closed, after literals/comments are stripped:
 *
 *   - `ATTACH` / `DETACH` — open or close another database file.
 *   - `VACUUM INTO` — writes a whole copy of the database to a named path.
 *     A plain `VACUUM` is allowed: it only rewrites the already-open file.
 *   - `load_extension` — SQL-level extension loading can pull in native code.
 *     better-sqlite3 does not enable extension loading by default (probed:
 *     `SELECT load_extension(...)` fails with "not authorized"), but it is
 *     refused anyway so the refusal does not depend on that default.
 *
 * ASSUMPTION, stated so it is a documented risk rather than a silently open
 * door: this set — `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension` — is
 * the entirety of SQLite's statement surface that can touch a file other than
 * the opened database. `query_only` covers none of them (probed: ATTACH and
 * `VACUUM INTO` both still run on a read-only handle), so this classifier is
 * the whole defense and a future SQLite addition to that surface would need a
 * matching entry here.
 */
const ATTACH_RE = /\bATTACH\b/i;
const DETACH_RE = /\bDETACH\b/i;
const VACUUM_INTO_RE = /\bVACUUM\s+\w+\s+INTO\b|\bVACUUM\s+INTO\b/i;
const LOAD_EXTENSION_RE = /\bload_extension\b/i;

const MISSING_DRIVER_MESSAGE =
  "better-sqlite3 is required for SQLite adapter. Install with: pnpm add better-sqlite3";

type SqliteDatabase = InstanceType<typeof import("better-sqlite3")>;

/**
 * Create a DatabaseOpener over one workspace.
 *
 * Handles are cached by `(realpath, readonly)` and reused; `closeAll()`
 * closes every handle the opener created.
 */
export function createSqliteDatabaseOpener(opts: SqliteDatabaseOpenerOptions): DatabaseOpener {
  const { fs, workspaceRoot } = opts;

  /** Handles are cached by `(realpath, readonly)` and reused until closed. */
  const pool = new Map<string, DatabaseAdapter>();
  /** Every handle we opened, for `closeAll()`. */
  const handles = new Set<SqliteDatabase>();
  /** Serializes concurrent opens of the same key so only one handle exists. */
  const opening = new Map<string, Promise<DatabaseAdapter>>();

  async function resolveWithinWorkspace(requested: string): Promise<string> {
    const root = await realResolveRoot(workspaceRoot);

    // The injected filesystem owns the first containment check. It can also
    // fail for reasons that are NOT containment (a denied credential
    // directory, a permission error), and those must reach the caller as
    // themselves — a sandbox denial relabelled as a workspace rule is a lie.
    // So on failure, re-check containment independently: only when the
    // requested path really does resolve outside the root do we restate it
    // with the message callers match on; otherwise the original error stands.
    let absolute: string;
    try {
      absolute = fs.resolvePath ? await fs.resolvePath(requested) : requested;
    } catch (err) {
      if (await isOutsideWorkspace(requested, root)) {
        throw new DatabasePathError(
          `Cannot open database "${requested}": outside the workspace (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      throw err;
    }

    // `realResolve`, not `fs.realpath`: the root was canonicalized by
    // `realResolveRoot` above, so the target has to be canonicalized the same
    // way or the comparison below would reject legal paths (on macOS
    // `os.tmpdir()` is itself a symlink). This also dereferences a symlinked
    // ancestor, which the injected FileSystem's lexical resolve does not.
    const target = await realResolve(absolute);
    if (!isWithin(root, target)) {
      throw new DatabasePathError(
        `Cannot open database "${requested}": resolved path "${target}" is outside the workspace root "${root}".`,
      );
    }
    return target;
  }

  /** Whether `requested` really resolves outside `root`, checked without the injected fs. */
  async function isOutsideWorkspace(requested: string, root: string): Promise<boolean> {
    try {
      // Relative model paths name something under the workspace root; without
      // this they would be resolved against `process.cwd()` and every
      // relative path would look like an escape.
      const candidate = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
      return !isWithin(root, await realResolve(candidate));
    } catch {
      // The path cannot be resolved at all (a symlink cycle, a candidate the
      // OS refuses to inspect): that is not proof of escape, so leave the
      // original error untouched.
      return false;
    }
  }

  async function openHandle(file: string, readonly: boolean): Promise<DatabaseAdapter> {
    let Database: typeof import("better-sqlite3");
    try {
      Database = (await import("better-sqlite3")).default;
    } catch {
      throw new Error(MISSING_DRIVER_MESSAGE);
    }

    // `readonly` is engine-level: better-sqlite3 opens the file read-only and
    // refuses to create one that is missing. No `journal_mode` here — see the
    // file header for why a read-only open must not switch WAL on.
    const db = new Database(file, { readonly, fileMustExist: readonly });
    if (readonly) {
      db.pragma("query_only = ON");
    }

    const adapter: DatabaseAdapter = {
      async query(sql, params): Promise<SqlRow[]> {
        assertStatementAllowed(sql);
        const stmt = db.prepare(sql);
        const rows = (params ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
        return rows;
      },
      async exec(sql, params): Promise<{ changes: number }> {
        assertStatementAllowed(sql);
        const stmt = db.prepare(sql);
        const result = params ? stmt.run(...params) : stmt.run();
        return { changes: result.changes };
      },
    };

    handles.add(db);
    pool.set(cacheKey(file, readonly), adapter);
    return adapter;
  }

  function assertStatementAllowed(sql: string): void {
    // Match on the code, not on string literals / comments: `SELECT 'please
    // attach the log'` is a legitimate query, and `-- DETACH` is not one.
    const code = stripLiteralsAndComments(sql);
    if (ATTACH_RE.test(code)) {
      throw new Error(
        "ATTACH is not permitted: attaching another database file would escape the workspace boundary.",
      );
    }
    if (DETACH_RE.test(code)) {
      throw new Error("DETACH is not permitted.");
    }
    if (VACUUM_INTO_RE.test(code)) {
      throw new Error(
        "VACUUM INTO is not permitted: it would write a database file outside the workspace boundary.",
      );
    }
    if (LOAD_EXTENSION_RE.test(code)) {
      throw new Error(
        "load_extension is not permitted: loading a SQL extension can pull native code into the process.",
      );
    }
  }

  return {
    async open(requested, openOpts): Promise<DatabaseAdapter> {
      const file = await resolveWithinWorkspace(requested);
      const key = cacheKey(file, openOpts.readonly);

      const cached = pool.get(key);
      if (cached) return cached;

      const inFlight = opening.get(key);
      if (inFlight) return inFlight;

      const pending = openHandle(file, openOpts.readonly).finally(() => {
        opening.delete(key);
      });
      opening.set(key, pending);
      return pending;
    },

    async closeAll(): Promise<void> {
      // Drain opens already in flight before closing, so a handle they are
      // still building does not outlive the close.
      await Promise.allSettled([...opening.values()]);
      for (const db of handles) {
        try {
          db.close();
        } catch {
          // Already closed (or never fully opened): nothing left to release.
        }
      }
      handles.clear();
      pool.clear();
      opening.clear();
    },
  };
}

function cacheKey(file: string, readonly: boolean): string {
  return `${readonly ? "ro" : "rw"}:${file}`;
}

/** Whether `target` is `root` itself or lives underneath it. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Drop SQL string literals (`'…'`, `"…"`, backticked and `[…]` identifiers)
 * and comments so keyword refusal cannot be fooled by, or trip over, text
 * that only looks like SQL. Unterminated constructs consume the rest of the
 * input: a truncated statement cannot hide a keyword after them.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }

    if (ch === "[") {
      i++;
      while (i < sql.length && sql[i] !== "]") i++;
      i++;
      out += " ";
      continue;
    }

    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
