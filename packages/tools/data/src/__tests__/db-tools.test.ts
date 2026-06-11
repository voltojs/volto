import { describe, it, expect } from "vitest";
import { createDbQueryTool, createDbExecTool, DB_TOOL_NAMES } from "../index.js";
import type { DatabaseAdapter, SqlRow } from "../index.js";

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

describe("db_query tool", () => {
  it("has correct tool definition", () => {
    const tool = createDbQueryTool(createMockDb());
    expect(tool.definition.name).toBe("db_query");
    expect(tool.definition.riskTier).toBe("READ_ONLY");
    expect(tool.definition.requires).toContain("db:query");
  });

  it("returns structured rows", async () => {
    const db = createMockDb([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ sql: "SELECT * FROM users" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("2 rows");
    expect(result.modelContent).toContain("Alice");
    expect(result.displayMetadata?.rowCount).toBe(2);
  });

  it("returns message for empty result", async () => {
    const db = createMockDb([]);
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ sql: "SELECT * FROM users WHERE 1=0" });
    expect(result.modelContent).toContain("0 rows");
  });

  it("returns isError for db failure", async () => {
    const db = createFailingDb("connection refused");
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ sql: "SELECT * FROM users" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("connection refused");
  });

  it("truncates large result sets", async () => {
    const bigRows = Array.from({ length: 600 }, (_, i) => ({ id: i, val: `v${i}` }));
    const db = createMockDb(bigRows);
    const tool = createDbQueryTool(db);
    const result = await tool.handler({ sql: "SELECT * FROM big_table" });
    expect(result.displayMetadata?.truncated).toBe(true);
    expect(result.displayMetadata?.rowCount).toBe(600);
  });
});

describe("db_exec tool", () => {
  it("has correct tool definition", () => {
    const tool = createDbExecTool(createMockDb());
    expect(tool.definition.name).toBe("db_exec");
    expect(tool.definition.riskTier).toBe("WRITE_HIGH");
    expect(tool.definition.requires).toContain("db:exec");
  });

  it("returns affected row count", async () => {
    const db = createMockDb([], 3);
    const tool = createDbExecTool(db);
    const result = await tool.handler({ sql: "UPDATE users SET active = true" });
    expect(result.isError).toBeFalsy();
    expect(result.modelContent).toContain("3 rows affected");
    expect(result.displayMetadata?.changes).toBe(3);
  });

  it("returns isError for db failure", async () => {
    const db = createFailingDb("syntax error");
    const tool = createDbExecTool(db);
    const result = await tool.handler({ sql: "INVALID SQL" });
    expect(result.isError).toBe(true);
    expect(result.modelContent).toContain("syntax error");
  });
});

describe("DB_TOOL_NAMES", () => {
  it("includes both db tools", () => {
    expect(DB_TOOL_NAMES.has("db_query")).toBe(true);
    expect(DB_TOOL_NAMES.has("db_exec")).toBe(true);
    expect(DB_TOOL_NAMES.size).toBe(2);
  });
});
