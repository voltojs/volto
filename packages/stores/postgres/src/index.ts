/**
 * PostgreSQL-backed SessionStore implementation.
 * Uses pg connection pool for async access.
 * Persists snapshots in a PostgreSQL database table.
 */

import type { SessionStore, SessionSnapshot } from "@voltojs/core";
import pg from "pg";

const { Pool } = pg;

export interface PostgresStoreOptions {
  /** PostgreSQL connection string or pool config */
  connectionString?: string;
  /** Database table name (default: "sessions") */
  table?: string;
  /** Pre-created pg Pool instance (overrides connectionString) */
  pool?: pg.Pool;
}

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function createStore(opts: PostgresStoreOptions = {}): SessionStore {
  const tableName = opts.table ?? "sessions";
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(
      `Invalid table name: "${tableName}". Only alphanumeric and underscore, starting with a letter or underscore.`,
    );
  }
  const pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });

  let initialized = false;

  async function ensureTable(): Promise<void> {
    if (initialized) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    initialized = true;
  }

  return {
    async save(snapshot: SessionSnapshot): Promise<void> {
      await ensureTable();
      await pool.query(
        `INSERT INTO ${tableName} (id, state, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, created_at = EXCLUDED.created_at`,
        [snapshot.id, JSON.stringify(snapshot.state), snapshot.createdAt],
      );
    },

    async load(id: string): Promise<SessionSnapshot | undefined> {
      await ensureTable();
      const result = await pool.query(
        `SELECT id, state, created_at FROM ${tableName} WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: row["id"] as string,
        state: typeof row["state"] === "string" ? JSON.parse(row["state"] as string) : row["state"],
        createdAt: Number(row["created_at"]),
      };
    },

    async list(): Promise<SessionSnapshot[]> {
      await ensureTable();
      const result = await pool.query(
        `SELECT id, state, created_at FROM ${tableName}`,
      );
      return result.rows.map((row) => ({
        id: row["id"] as string,
        state: typeof row["state"] === "string" ? JSON.parse(row["state"] as string) : row["state"],
        createdAt: Number(row["created_at"]),
      }));
    },
  };
}
