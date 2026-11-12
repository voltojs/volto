/**
 * Session-store factory: sqlite when the native module loads, the JSON
 * directory store otherwise — and never a path that loses existing sessions.
 *
 * Every case injects `loadSqlite`, so nothing here depends on whether this
 * machine's `better-sqlite3` happens to build.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSnapshot, SessionStore } from "@volto/core";
import { createSessionStore, describeSessionStoreKind } from "../session-store-factory.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env["VOLTO_SESSION_STORE"];
});

function fakeStore(): SessionStore {
  return {
    save: async () => {},
    load: async () => undefined,
    list: async () => [],
  };
}

it("sqlite 可用时返回 sqlite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-store-"));
  const fake = { save: async () => {}, load: async () => null, list: async () => [], delete: async () => {} };
  const r = await createSessionStore({
    dbPath: path.join(dir, "a.db"),
    fallbackDir: dir,
    loadSqlite: async () => fake as unknown as SessionStore,
    // Explicit env so the case means the same thing under
    // `VOLTO_SESSION_STORE=file npx vitest run` as in a plain run.
    env: {},
  });
  expect(r.kind).toBe("sqlite");
});

it("sqlite 载入失败时回退 file 并回调", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "volto-store-"));
  const errors: unknown[] = [];
  const r = await createSessionStore({
    dbPath: path.join(dir, "a.db"), fallbackDir: dir,
    loadSqlite: async () => { throw new Error("Cannot find module 'better-sqlite3'"); },
    onFallback: (e) => errors.push(e),
    env: {},
  });
  expect(r.kind).toBe("file");
  expect(errors).toHaveLength(1);
  expect(typeof r.store.save).toBe("function");
});

describe("sqlite 回退", () => {
  it("回退 store 落在 fallbackDir，可读写，且不创建也不改动 sessions.db", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "db", "sessions.db");
    const fallbackDir = path.join(dir, "sessions-store");
    // A pre-existing database that cannot be parsed by the file store either:
    // its bytes must survive the fallback untouched.
    await mkdir(path.join(dir, "db"), { recursive: true });
    await writeFile(dbPath, "not-a-real-sqlite-db-but-precious", "utf-8");
    const before = await stat(dbPath);

    const r = await createSessionStore({
      dbPath,
      fallbackDir,
      loadSqlite: async () => {
        throw new Error("Cannot find module 'better-sqlite3'");
      },
    });
    expect(r.kind).toBe("file");

    // Real file-store round trip, in the fallback directory only.
    const snapshot = { id: "s1", state: {}, createdAt: 1 } as unknown as SessionSnapshot;
    await r.store.save(snapshot);
    expect(await r.store.load("s1")).toEqual(snapshot);
    expect((await r.store.list()).map((s) => s.id)).toEqual(["s1"]);

    const after = await stat(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(await readFile(dbPath, "utf-8")).toBe("not-a-real-sqlite-db-but-precious");
  });

  it("db 不存在时回退也不创建它", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "db", "sessions.db");
    const r = await createSessionStore({
      dbPath,
      fallbackDir: path.join(dir, "sessions-store"),
      loadSqlite: async () => {
        throw new Error("Cannot find module 'better-sqlite3'");
      },
    });
    expect(r.kind).toBe("file");
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("VOLTO_SESSION_STORE=file 强制回退且完全不载入 sqlite", async () => {
    process.env["VOLTO_SESSION_STORE"] = "file";
    const dir = await tempDir();
    let loads = 0;
    const errors: unknown[] = [];
    const r = await createSessionStore({
      dbPath: path.join(dir, "sessions.db"),
      fallbackDir: path.join(dir, "sessions-store"),
      loadSqlite: async () => {
        loads += 1;
        return fakeStore();
      },
      onFallback: (e) => errors.push(e),
    });
    expect(r.kind).toBe("file");
    expect(r.reason).toBe("forced");
    // Forced, not a failure: sqlite is never even attempted and no error is
    // reported.
    expect(loads).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it("VOLTO_SESSION_STORE 的其它取值不影响 sqlite 选择", async () => {
    process.env["VOLTO_SESSION_STORE"] = "sqlite";
    const dir = await tempDir();
    const r = await createSessionStore({
      dbPath: path.join(dir, "sessions.db"),
      fallbackDir: path.join(dir, "sessions-store"),
      loadSqlite: async () => fakeStore(),
    });
    expect(r.kind).toBe("sqlite");
  });
});

describe("describeSessionStoreKind", () => {
  it("区分 sqlite / 强制 file / 回退 file", () => {
    expect(describeSessionStoreKind("sqlite")).toContain("available");
    expect(describeSessionStoreKind("file", "forced")).toContain("forced");
    expect(describeSessionStoreKind("file", "fallback")).toContain("fallback");
  });
});