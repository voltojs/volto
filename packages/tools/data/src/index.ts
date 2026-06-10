/**
 * @agent-core/tools-data — structured data tools: HTTP query + database
 *
 * http_query wraps the existing Network port with structured output.
 * db_query / db_exec provide SQL access via a DatabaseAdapter.
 */

import type { Network } from "@agent-core/core";
import { z } from "zod";
import { defineTool } from "@agent-core/tools-common";
import type { Tool } from "@agent-core/tools-common";

// ──────────────────────────────────────────────
// DatabaseAdapter — abstract interface for SQL access
// ──────────────────────────────────────────────

/** A single row returned from a SQL query */
export type SqlRow = Record<string, unknown>;

/** DatabaseAdapter — abstract interface consumed by db_query / db_exec tools */
export interface DatabaseAdapter {
  /** Execute a read-only SQL query and return rows */
  query(sql: string, params?: unknown[]): Promise<SqlRow[]>;
  /** Execute a write/DDL statement and return affected row count */
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

// ──────────────────────────────────────────────
// HTTP query tool
// ──────────────────────────────────────────────

const CAP_NETWORK = "network:fetch";

const MAX_BODY = 50000;

const schema = z.object({
  url: z.string().describe("URL to send the request to."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional().describe("HTTP method (default: GET)."),
  headers: z.record(z.string(), z.string()).optional().describe("Request headers."),
  body: z.string().optional().describe("Request body (for POST/PUT/PATCH)."),
});

export function createHttpQueryTool(network: Network): Tool {
  return defineTool({
    name: "http_query",
    description: "Send an HTTP request with custom method, headers, and body. Returns status code, response headers, and body.",
    schema,
    requires: [CAP_NETWORK],
    riskTier: "READ_ONLY",
    run: async ({ url, method, headers, body }) => {
      try {
        const response = await network.fetch({
          url,
          method: method ?? "GET",
          headers,
          body,
        });

        let responseBody = response.body;
        let truncated = false;
        if (responseBody.length > MAX_BODY) {
          responseBody = responseBody.slice(0, MAX_BODY) + "\n... [truncated]";
          truncated = true;
        }

        const summary = `HTTP ${response.status} ${response.status < 400 ? "OK" : "Error"}\n${responseBody}`;

        return {
          modelContent: summary,
          displayMetadata: {
            status: response.status,
            headers: response.headers,
            bodyLength: response.body.length,
            truncated,
          },
        };
      } catch (err) {
        return {
          modelContent: `http_query failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

export const HTTP_TOOL_NAMES: ReadonlySet<string> = new Set(["http_query"]);

// ──────────────────────────────────────────────
// Database tools
// ──────────────────────────────────────────────

const CAP_DB_READ = "db:query";
const CAP_DB_WRITE = "db:exec";
const MAX_ROWS = 500;

const dbQuerySchema = z.object({
  sql: z.string().describe("A read-only SQL SELECT query."),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
    .describe("Optional positional parameters for the SQL query."),
});

const dbExecSchema = z.object({
  sql: z.string().describe("A SQL statement (INSERT, UPDATE, DELETE, DDL)."),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
    .describe("Optional positional parameters for the SQL statement."),
});

/**
 * Create a db_query tool — executes read-only SQL and returns structured rows.
 */
export function createDbQueryTool(db: DatabaseAdapter): Tool {
  return defineTool({
    name: "db_query",
    description:
      "Execute a read-only SQL query and return the result rows. " +
      "Only SELECT queries are allowed. Returns column names and up to 500 rows.",
    schema: dbQuerySchema,
    requires: [CAP_DB_READ],
    riskTier: "READ_ONLY",
    run: async ({ sql, params }) => {
      try {
        const rows = await db.query(sql, params);
        const truncated = rows.length > MAX_ROWS;
        const displayRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

        const modelContent = rows.length === 0
          ? "Query returned 0 rows."
          : `Query returned ${rows.length} row${rows.length === 1 ? "" : "s"}.\nColumns: ${columns.join(", ")}\n${JSON.stringify(displayRows, null, 2).slice(0, 10_000)}`;

        return {
          modelContent,
          displayMetadata: {
            rowCount: rows.length,
            columns,
            truncated,
          },
        };
      } catch (err) {
        return {
          modelContent: `db_query failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

/**
 * Create a db_exec tool — executes write/DDL statements.
 */
export function createDbExecTool(db: DatabaseAdapter): Tool {
  return defineTool({
    name: "db_exec",
    description:
      "Execute a SQL write statement (INSERT, UPDATE, DELETE, or DDL). " +
      "Returns the number of affected rows. Requires user approval.",
    schema: dbExecSchema,
    requires: [CAP_DB_WRITE],
    riskTier: "WRITE_HIGH",
    run: async ({ sql, params }) => {
      try {
        const { changes } = await db.exec(sql, params);
        return {
          modelContent: `Statement executed successfully. ${changes} row${changes === 1 ? "" : "s"} affected.`,
          displayMetadata: { changes },
        };
      } catch (err) {
        return {
          modelContent: `db_exec failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

export const DB_TOOL_NAMES: ReadonlySet<string> = new Set(["db_query", "db_exec"]);
