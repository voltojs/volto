import { describe, it, expect, vi } from "vitest";
import { createDbQueryTool, createDbExecTool, DB_TOOL_NAMES } from "../index.js";
import type { DatabaseAdapter, DatabaseOpener, SqlRow } from "../index.js";

function createMockDb(rows: SqlRow[] = [], changes = 0): DatabaseAdapter {
  return {
    async query(_sql: string, _params?: unknown[]): Promise<SqlRow[]> {
      return rows;
    },
    async exec(_sql: string, _params?: unknown[]): Promise<{ changes: number }> {
      return { changes };
    },
  };
}

function createFailingDb(errorMsg: string): DatabaseAdapter {
  return {
    async query(): Promise<SqlRow[]> {
      throw new Error(errorMsg);
    },
    async exec(): Promise<{ changes: number }> {
      throw new Error(errorMsg);
    },
  };
}

/** Stub opener that hands back `adapter` and records every open(path, opts) call. */
function createOpenerSpy(adapter: DatabaseAdapter): {
  opener: DatabaseOpener;
  open: ReturnType<typeof vi.fn<DatabaseOpener["open"]>>;
} {
  const open = vi.fn<DatabaseOpener["open"]>(async () => adapter);
  return {
    opener: { open, closeAll: vi.fn<DatabaseOpener["closeAll"]>(async () => {}) },
    open,
  };
}

function createRejectingOpener(message: string): DatabaseOpener {
  return {
    async open(): Promise<DatabaseAdapter> {
      throw new Error(message);
    },
    async closeAll(): Promise<void> {},
  };
}

/**
 * Stub engine: a read-only sqlite handle rejects any writing statement with the
 * driver's own error. It also records the SQL it was handed, which is how the
 * tests prove the statement reached the engine instead of a regex guard.
 */
function createEngineRejectingWrite(): { adapter: DatabaseAdapter; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    adapter: {
      async query(sql: string): Promise<SqlRow[]> {
        statements.push(sql);
        throw new Error("SqliteError: attempt to write a readonly database");
      },
      async exec(sql: string): Promise<{ changes: number }> {
        statements.push(sql);
        throw new Error("SqliteError: attempt to write a readonly database");
      },
    },
  };
}

describe("db_query tool", () => {
  it("has correct tool definition", () => {
    const tool = createDbQueryTool(createOpenerSpy(createMockDb()).opener);
    expect(tool.definition.name).toBe("db_query");
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.requires).toEqual(["db:read"]);
    expect(tool.definition.pathInputs).toEqual(["path"]);
  });

  it("F-121 opens the model-given path read-only", async () => {
    const { opener, open } = createOpenerSpy(createMockDb());
    const tool = createDbQueryTool(opener);
    await tool.handler({ path: "data/app.db", sql: "SELECT 1" });
    expect(open).toHaveBeenCalledWith("data/app.db", { readonly: true });
  });

  it("returns structured rows", async () => {
    const db = createMockDb([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
    const tool = createDbQueryTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "SELECT * FROM users" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("2 rows");
    expect(result.modelContent).toContain("Alice");
    expect(result.displayMetadata?.rowCount).toBe(2);
  });

  it("returns message for empty result", async () => {
    const db = createMockDb([]);
    const tool = createDbQueryTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "SELECT * FROM users WHERE 1=0" });
    expect(result.modelContent).toContain("0 rows");
  });

  it("returns isError for db failure", async () => {
    const db = createFailingDb("connection refused");
    const tool = createDbQueryTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "SELECT * FROM users" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("connection refused");
  });

  it("truncates large result sets", async () => {
    const bigRows = Array.from({ length: 600 }, (_, i) => ({ id: i, val: `v${i}` }));
    const db = createMockDb(bigRows);
    const tool = createDbQueryTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "SELECT * FROM big_table" });
    expect(result.displayMetadata?.truncated).toBe(true);
    expect(result.displayMetadata?.rowCount).toBe(600);
  });

  it("F-121 hands a destructive statement to the engine instead of a regex guard", async () => {
    const engine = createEngineRejectingWrite();
    const { opener, open } = createOpenerSpy(engine.adapter);
    const result = await createDbQueryTool(opener).handler({ path: "data/app.db", sql: "DELETE FROM t" });

    // The refusal comes from the engine: the statement was forwarded verbatim
    // after the read-only handle was opened, not screened by a verb regex.
    expect(open).toHaveBeenCalledWith("data/app.db", { readonly: true });
    expect(engine.statements).toEqual(["DELETE FROM t"]);
    expect(result.isError).toBe(true);
    expect(result.modelContent).toMatch(/readonly|read-only/i);
  });

  it("F-121 normalizes an opener rejection (path outside the workspace) to isError", async () => {
    const opener = createRejectingOpener("db path escapes the workspace: ../../etc/app.db");
    const result = await createDbQueryTool(opener).handler({ path: "../../etc/app.db", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("escapes the workspace");
  });
});

describe("db_exec tool", () => {
  it("has correct tool definition", () => {
    const tool = createDbExecTool(createOpenerSpy(createMockDb()).opener);
    expect(tool.definition.name).toBe("db_exec");
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
    expect(tool.definition.requires).toEqual(["db:write"]);
    expect(tool.definition.pathInputs).toEqual(["path"]);
  });

  it("F-121 opens the model-given path read-write", async () => {
    const { opener, open } = createOpenerSpy(createMockDb());
    const tool = createDbExecTool(opener);
    await tool.handler({ path: "data/app.db", sql: "UPDATE t SET a = 1" });
    expect(open).toHaveBeenCalledWith("data/app.db", { readonly: false });
  });

  it("returns affected row count", async () => {
    const db = createMockDb([], 3);
    const tool = createDbExecTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "UPDATE users SET active = true" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("3 rows affected");
    expect(result.displayMetadata?.changes).toBe(3);
  });

  it("returns isError for db failure", async () => {
    const db = createFailingDb("syntax error");
    const tool = createDbExecTool(createOpenerSpy(db).opener);
    const result = await tool.handler({ path: "data/app.db", sql: "INVALID SQL" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("syntax error");
  });

  it("F-121 normalizes an opener rejection (path outside the workspace) to isError", async () => {
    const opener = createRejectingOpener("db path escapes the workspace: ../../etc/app.db");
    const result = await createDbExecTool(opener).handler({ path: "../../etc/app.db", sql: "DROP TABLE t" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("escapes the workspace");
  });
});

describe("DB_TOOL_NAMES", () => {
  it("includes both db tools", () => {
    expect(DB_TOOL_NAMES.has("db_query")).toBe(true);
    expect(DB_TOOL_NAMES.has("db_exec")).toBe(true);
    expect(DB_TOOL_NAMES.size).toBe(2);
  });
});
