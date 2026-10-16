import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createStore } from "../index.js";
import { runStoreContractTests } from "@volto/core/testing";
import pg from "pg";

const { Pool } = pg;

const POSTGRES_URL = process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/agent_core_test";

let pool: pg.Pool;
let canConnect = false;

beforeAll(async () => {
  try {
    pool = new Pool({ connectionString: POSTGRES_URL, max: 5 });
    await pool.query("SELECT 1");
    canConnect = true;
  } catch {
    canConnect = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

// Use the contract tests if Postgres is available
describe.runIf(canConnect)("SessionStore contract (postgres)", () => {
  let testTable: string;

  beforeEach(async () => {
    testTable = `test_sessions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    if (canConnect) {
      await pool.query(`DROP TABLE IF EXISTS ${testTable}`);
    }
  });

  runStoreContractTests(() => createStore({ pool, table: testTable }));
});

describe.runIf(canConnect)("PostgresStore specifics", () => {
  let testTable: string;

  beforeEach(async () => {
    testTable = `test_sessions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    if (canConnect) {
      await pool.query(`DROP TABLE IF EXISTS ${testTable}`);
    }
  });

  it("concurrent upserts on same id converge idempotently", async () => {
    const store = createStore({ pool, table: testTable });
    const snapshot = {
      id: "concurrent",
      state: {
        messages: [],
        pendingTools: [],
        status: "idle" as const,
        tokenBudget: undefined,
        tokensUsed: 0,
        maxIterations: 20,
        iterationCount: 0,
        readFiles: [],
        queuedUserInputs: [],
        toolCallCount: 0,
        maxToolCalls: undefined,
        maxCostDollars: undefined,
      maxTokensPerTurn: undefined,
        maxWallclockMs: undefined,
        maxLoopCount: undefined,
        selfCorrectionCount: 0,
        maxSelfCorrections: undefined,
        loopInterventionCount: 0,
        loopRemindedCount: 0,
      },
      createdAt: 5000,
    };

    // Run 5 concurrent saves of the same id
    await Promise.all(
      Array.from({ length: 5 }, () => store.save(snapshot)),
    );

    const loaded = await store.load("concurrent");
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe("concurrent");

    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it("list returns all saved snapshots", async () => {
    const store = createStore({ pool, table: testTable });
    const base = {
      state: {
        messages: [],
        pendingTools: [],
        status: "idle" as const,
        tokenBudget: undefined,
        tokensUsed: 0,
        maxIterations: 20,
        iterationCount: 0,
        readFiles: [],
        queuedUserInputs: [],
        toolCallCount: 0,
        maxToolCalls: undefined,
        maxCostDollars: undefined,
      maxTokensPerTurn: undefined,
        maxWallclockMs: undefined,
        maxLoopCount: undefined,
        selfCorrectionCount: 0,
        maxSelfCorrections: undefined,
        loopInterventionCount: 0,
        loopRemindedCount: 0,
      },
    };

    await store.save({ ...base, id: "a", createdAt: 100 });
    await store.save({ ...base, id: "b", createdAt: 200 });
    await store.save({ ...base, id: "c", createdAt: 300 });

    const list = await store.list();
    expect(list).toHaveLength(3);
  });
});

// Graceful skip if no Postgres
describe.skipIf(canConnect)("PostgresStore", () => {
  it("skips when no Postgres available", () => {
    // This test is only to show a clear skip message in CI
    expect(true).toBe(true);
  });
});
