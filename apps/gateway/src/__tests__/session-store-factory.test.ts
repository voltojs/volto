/**
 * Session-store factory: sqlite when the native driver loads, the JSON
 * directory store otherwise — and never a path that loses existing sessions.
 *
 * Every case injects `loadSqlite` *and* passes `env: {}`, so nothing here
 * depends on this machine's `better-sqlite3` or on the caller's environment:
 * under `VOLTO_SESSION_STORE=file` the fallback cases would otherwise be
 * rerouted through the forced branch and stop covering the fallback.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSnapshot, SessionStore } from "@voltojs/core";
import {
  classifyStoreFailure,
  createSessionStore,
  describeSessionStoreKind,
  fallbackWarning,
} from "../session-store-factory.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "volto-store-"));
}

function fakeStore(): SessionStore {
  return {
    save: async () => {},
    load: async () => undefined,
    list: async () => [],
  };
}

/** An error shaped like Node's module-not-found (ESM code + message). */
function moduleMissingError(): NodeJS.ErrnoException {
  const err = new Error(
    "Cannot find package 'better-sqlite3' imported from /pkg/packages/stores/sqlite/dist/index.js",
  ) as NodeJS.ErrnoException;
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

describe("sqlite 可用", () => {
  it("sqlite 可用时返回 sqlite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "volto-store-"));
    const fake = { save: async () => {}, load: async () => null, list: async () => [], delete: async () => {} };
    const r = await createSessionStore({
      dbPath: path.join(dir, "a.db"),
      fallbackDir: dir,
      loadSqlite: async () => fake as unknown as SessionStore,
      env: {},
    });
    expect(r.kind).toBe("sqlite");
    expect(r.reason).toBe("primary");
    expect(describeSessionStoreKind(r.kind, r.reason)).toBe("sqlite (primary)");
  });
});

describe("sqlite 回退：模块缺失", () => {
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
    expect(r.reason).toBe("module-missing");
    expect(errors).toHaveLength(1);
    expect(typeof r.store.save).toBe("function");
  });

  it("ERR_MODULE_NOT_FOUND 归为 module-missing，警告说明库文件未被读取也未被删除", async () => {
    const dir = await tempDir();
    const dbPath = path.join(dir, "db", "sessions.db");
    const fallbackDir = path.join(dir, "sessions-store");
    const grabbed: Array<{ reason: string; message: string }> = [];
    const r = await createSessionStore({
      dbPath,
      fallbackDir,
      loadSqlite: async () => {
        throw moduleMissingError();
      },
      onFallback: (err, reason) => grabbed.push({ reason, message: fallbackWarning({ dbPath, fallbackDir }, reason, err) }),
      env: {},
    });
    expect(r.kind).toBe("file");
    expect(r.reason).toBe("module-missing");
    expect(grabbed[0]!.reason).toBe("module-missing");
    const warning = grabbed[0]!.message;
    expect(warning).toContain(dbPath);
    expect(warning).toContain("could not be loaded");
    expect(warning).toContain("NOT deleted or migrated");
    // The module-missing warning must not claim the database exists.
    expect(warning).not.toContain("EXISTS");
    expect(describeSessionStoreKind(r.kind, r.reason)).toBe("file (fallback: module missing)");
  });
});

describe("sqlite 回退：库不可用", () => {
  const cases: Array<{ name: string; err: () => unknown }> = [
    {
      name: "EACCES（权限）",
      err: () => {
        const e = new Error("unable to open database file") as NodeJS.ErrnoException;
        e.code = "EACCES";
        return e;
      },
    },
    {
      name: "SQLITE_CANTOPEN 风格",
      err: () => Object.assign(new Error("SQLITE_CANTOPEN: unable to open database file"), { code: "SQLITE_CANTOPEN" }),
    },
    {
      name: "损坏的库",
      err: () => Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
    },
  ];

  for (const { name, err } of cases) {
    it(`${name} 归为 db-unusable，警告明确说库存在但没被读取`, async () => {
      const dir = await tempDir();
      const dbPath = path.join(dir, "db", "sessions.db");
      const fallbackDir = path.join(dir, "sessions-store");
      // A db that a later stat can compare against.
      await mkdir(path.join(dir, "db"), { recursive: true });
      await writeFile(dbPath, "precious", "utf-8");
      const before = await stat(dbPath);

      const grabbed: Array<{ reason: string; message: string }> = [];
      const r = await createSessionStore({
        dbPath,
        fallbackDir,
        loadSqlite: async () => {
          throw err();
        },
        onFallback: (e, reason) => grabbed.push({ reason, message: fallbackWarning({ dbPath, fallbackDir }, reason, e) }),
        env: {},
      });

      expect(r.kind).toBe("file");
      expect(r.reason).toBe("db-unusable");
      const warning = grabbed[0]!.message;
      expect(warning).toContain(dbPath);
      expect(warning).toContain("EXISTS but cannot be opened");
      expect(warning).toContain("NOT being read");
      // Names the underlying code, not just a generic sentence.
      const code = (err() as NodeJS.ErrnoException).code!;
      expect(warning).toContain(code);
      expect(describeSessionStoreKind(r.kind, r.reason)).toBe("file (fallback: db unusable)");

      const after = await stat(dbPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(dbPath, "utf-8")).toBe("precious");
    });
  }

  it("两类失败给出的警告与 doctor 描述都不同", () => {
    const paths = { dbPath: "/v/db/sessions.db", fallbackDir: "/v/sessions-store" };
    const missing = fallbackWarning(paths, "module-missing", moduleMissingError());
    const unusable = fallbackWarning(paths, "db-unusable", Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }));
    expect(missing).not.toBe(unusable);
    expect(describeSessionStoreKind("file", "module-missing")).not.toBe(
      describeSessionStoreKind("file", "db-unusable"),
    );
  });
});

describe("classifyStoreFailure", () => {
  it("只有模块解析/原生插件加载失败算 module-missing", () => {
    expect(classifyStoreFailure(moduleMissingError())).toBe("module-missing");
    expect(classifyStoreFailure(new Error("Cannot find module 'better-sqlite3'"))).toBe("module-missing");
    expect(
      classifyStoreFailure(
        Object.assign(new Error("Cannot find native binding."), { code: "ERR_DLOPEN_FAILED" }),
      ),
    ).toBe("module-missing");
  });

  it("库打不开/损坏一律算 db-unusable", () => {
    expect(classifyStoreFailure(Object.assign(new Error("cannot open"), { code: "EACCES" }))).toBe("db-unusable");
    expect(classifyStoreFailure(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))).toBe("db-unusable");
    expect(
      classifyStoreFailure(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" })),
    ).toBe("db-unusable");
    // A bare message with no code is classified by content, not assumed.
    expect(classifyStoreFailure(new Error("file is not a database"))).toBe("db-unusable");
  });
});

describe("sqlite 回退：文件存储与数据保全", () => {
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
      env: {},
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
      env: {},
    });
    expect(r.kind).toBe("file");
    await expect(stat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("VOLTO_SESSION_STORE=file 强制回退且完全不载入 sqlite", async () => {
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
      // Passed explicitly rather than through the process environment, so the
      // case cannot be shadowed by (or leak into) the caller's env.
      env: { VOLTO_SESSION_STORE: "file" },
    });
    expect(r.kind).toBe("file");
    expect(r.reason).toBe("forced");
    // Forced, not a failure: sqlite is never even attempted and no error is
    // reported.
    expect(loads).toBe(0);
    expect(errors).toHaveLength(0);
    expect(describeSessionStoreKind(r.kind, r.reason)).toBe("file (forced)");
  });

  it("VOLTO_SESSION_STORE 的其它取值不影响 sqlite 选择", async () => {
    const dir = await tempDir();
    const r = await createSessionStore({
      dbPath: path.join(dir, "sessions.db"),
      fallbackDir: path.join(dir, "sessions-store"),
      loadSqlite: async () => fakeStore(),
      env: { VOLTO_SESSION_STORE: "sqlite" },
    });
    expect(r.kind).toBe("sqlite");
  });
});