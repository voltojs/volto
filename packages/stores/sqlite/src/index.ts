/**
 * SQLite-backed SessionStore implementation.
 * Uses better-sqlite3 for synchronous access wrapped in async interface.
 * Persists snapshots in a local SQLite database file.
 */

import type { SessionStore, SessionSnapshot } from "@voltojs/core";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SqliteStoreOptions {
  /** Path to the SQLite database file (e.g. "./sessions.db") */
  path: string;
}

export function createStore(opts: SqliteStoreOptions): SessionStore {
  const dir = path.dirname(opts.path);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  const saveStmt = db.prepare(
    "INSERT INTO sessions (id, state, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, created_at = excluded.created_at",
  );
  const loadStmt = db.prepare("SELECT id, state, created_at FROM sessions WHERE id = ?");
  const listStmt = db.prepare("SELECT id, state, created_at FROM sessions");

  return {
    async save(snapshot: SessionSnapshot): Promise<void> {
      saveStmt.run(snapshot.id, JSON.stringify(snapshot.state), snapshot.createdAt);
    },

    async load(id: string): Promise<SessionSnapshot | undefined> {
      const row = loadStmt.get(id) as { id: string; state: string; created_at: number } | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        state: JSON.parse(row.state),
        createdAt: row.created_at,
      };
    },

    async list(): Promise<SessionSnapshot[]> {
      const rows = listStmt.all() as { id: string; state: string; created_at: number }[];
      return rows.map((row) => ({
        id: row.id,
        state: JSON.parse(row.state),
        createdAt: row.created_at,
      }));
    },
  };
}
