/**
 * Node.js SQLite database adapter — implements DatabaseAdapter via better-sqlite3.
 *
 * better-sqlite3 must be installed by the host application:
 *   pnpm add better-sqlite3  (or npm install better-sqlite3)
 *
 * Types for better-sqlite3 are optional — the import is fully dynamic.
 */

import type { DatabaseAdapter, SqlRow } from "@volto/tools-data";

export interface SqliteDatabaseOptions {
  /** Path to the SQLite database file (":memory:" for in-memory) */
  filename: string;
}

export async function createSqliteDatabaseAdapter(
  opts: SqliteDatabaseOptions,
): Promise<DatabaseAdapter> {
  let Database: typeof import("better-sqlite3");
  try {
    Database = (await import("better-sqlite3")).default;
  } catch {
    throw new Error(
      "better-sqlite3 is required for SQLite adapter. Install with: pnpm add better-sqlite3",
    );
  }

  const db = new Database(opts.filename);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  return {
    async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
      const stmt = db.prepare(sql);
      const rows = (params ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
      return rows;
    },

    async exec(sql: string, params?: unknown[]): Promise<{ changes: number }> {
      const stmt = db.prepare(sql);
      const result = params ? stmt.run(...params) : stmt.run();
      return { changes: result.changes };
    },
  };
}
