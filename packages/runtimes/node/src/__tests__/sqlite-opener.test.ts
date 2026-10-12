/**
 * sqlite opener tests — real temp-root filesystem, real database files.
 *
 * The filesystem under test is a real `createNodeFileSystem({ root: tmp })`
 * and every database is a real file created with `better-sqlite3`; nothing
 * here is mocked. Fixtures are created in `beforeEach` so each case starts
 * from its own handle cache (a cached handle is exactly what makes the
 * read-only file reachable for writing).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystem } from "../filesystem.js";
import { createSqliteDatabaseOpener } from "../database.js";

const itDarwin = process.platform === "darwin" ? it : it.skip;

describe("createSqliteDatabaseOpener", () => {
  let root: string;
  let outside: string;
  let opener: ReturnType<typeof createSqliteDatabaseOpener>;

  beforeEach(() => {
    // Canonicalize the temp parent first: `os.tmpdir()` is itself a symlink on
    // macOS, so a raw `mkdtempSync` root would be non-canonical while
    // `realResolveRoot` canonicalizes it — making every check reject for that
    // unrelated mismatch and hiding whether the realpath step does anything.
    // With a canonical root the lexical check alone would accept the symlink
    // escape below, so only `realResolve` can catch it.
    const canonicalTmp = realpathSync(tmpdir());
    root = mkdtempSync(join(canonicalTmp, "volto-sqlite-"));
    mkdirSync(join(root, "data"));
    createFixtureDatabase(join(root, "data", "app.db"));
    // A database file that really cannot be written: its directory forbids
    // writes for the owner, so both SQLite's own open and any statement
    // against it fail without root privileges.
    createFixtureDatabase(join(root, "data", "readonly.db"));
    chmodSync(join(root, "data", "readonly.db"), 0o444);

    // A valid database outside the workspace, reachable from inside it via
    // `data/link`. Only the realpath step can see this escape: the injected
    // FileSystem's `resolvePath` is purely lexical, so `data/link/secret.db`
    // looks like an inside path to it.
    outside = mkdtempSync(join(canonicalTmp, "volto-sqlite-outside-"));
    createFixtureDatabase(join(outside, "secret.db"));
    symlinkSync(outside, join(root, "data", "link"));

    const fs = createNodeFileSystem({ root });
    opener = createSqliteDatabaseOpener({ fs, workspaceRoot: root });
  });

  afterEach(async () => {
    await opener.closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("F-116 越界路径被拒（fail-closed）", async () => {
    await expect(opener.open("../../etc/volto.db", { readonly: true })).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("F-116 指向工作区外的符号链接被 realpath 步拒绝", async () => {
    // The outside database is valid, so if containment stopped before the
    // realpath step the open would *succeed* — this case fails for the right
    // reason only.
    expect(existsSync(join(root, "data", "link", "secret.db"))).toBe(true);
    await expect(opener.open("data/link/secret.db", { readonly: true })).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(opener.open("data/link/secret.db", { readonly: false })).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("F-117 只读连接由引擎拒写", async () => {
    const db = await opener.open("data/app.db", { readonly: true });
    await expect(db.exec("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
      /readonly|read-only|attempt to write/i,
    );
  });

  it("F-118 ATTACH / DETACH 被拒", async () => {
    const readOnly = await opener.open("data/app.db", { readonly: true });
    await expect(readOnly.query("ATTACH DATABASE '/etc/passwd' AS leaked")).rejects.toThrow(/ATTACH/i);
    await expect(readOnly.exec("DETACH DATABASE main")).rejects.toThrow(/DETACH/i);

    const writable = await opener.open("data/app.db", { readonly: false });
    await expect(writable.query("ATTACH DATABASE '/etc/passwd' AS leaked")).rejects.toThrow(/ATTACH/i);
    await expect(writable.exec("DETACH DATABASE main")).rejects.toThrow(/DETACH/i);
  });

  it("F-118 attach-looking text in a literal or comment is not a false rejection", async () => {
    const db = await opener.open("data/app.db", { readonly: true });
    expect(await db.query("SELECT 'please attach the log' AS note")).toEqual([
      { note: "please attach the log" },
    ]);
    expect(await db.query("SELECT 1 AS x -- detach later")).toEqual([{ x: 1 }]);
    expect(await db.query("SELECT 2 AS x /* ATTACH nothing */")).toEqual([{ x: 2 }]);
    // A comment may spell the refused keyword without the statement being
    // refused; the code keyword is what the guard looks for.
    expect(await db.query("SELECT x FROM t /* ATTACH DATABASE 'x' AS y */")).toEqual([{ x: 1 }]);
    expect(await db.query("SELECT x FROM t -- DETACH DATABASE main")).toEqual([{ x: 1 }]);
  });

  it("F-119 只读查询不产生 -wal / -shm", async () => {
    const db = await opener.open("data/app.db", { readonly: true });
    const rows = await db.query("SELECT * FROM t");
    expect(rows).toEqual([{ x: 1 }]);
    expect(existsSync(join(root, "data", "app.db-wal"))).toBe(false);
    expect(existsSync(join(root, "data", "app.db-shm"))).toBe(false);
    // Leaving journal_mode untouched matters: WAL mode is sticky in the
    // database header, so a read-only open must not switch it on either.
    expect(existsSync(join(root, "data", "app.db-journal"))).toBe(false);
  });

  it("Review Focus 4：库文件落在只读位置时不抛异常击穿", async () => {
    // Same realpath and same `readonly: false` request as the opener below,
    // so this second handle must be the cached one — the file is reachable
    // for writing only through that cache.
    const cached = await opener.open("data/readonly.db", { readonly: true });
    expect(await cached.query("SELECT * FROM t")).toEqual([{ x: 1 }]);

    const db = await opener.open("data/readonly.db", { readonly: false });
    await expect(db.exec("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
      /readonly|read-only|attempt to write/i,
    );
  });

  itDarwin(
    "Review Focus 4: 只读目录上的库文件可读、写入被拒",
    async () => {
      const db = await opener.open("data/readonly.db", { readonly: false });
      await expect(db.exec("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
        /readonly|read-only|attempt to write/i,
      );
      expect(await db.query("SELECT * FROM t")).toEqual([{ x: 1 }]);
    },
  );

  it("只读与读写句柄在缓存中互不串用", async () => {
    const readOnly = await opener.open("data/app.db", { readonly: true });
    const writable = await opener.open("data/app.db", { readonly: false });
    expect(writable).not.toBe(readOnly);

    const inserted = await writable.exec("INSERT INTO t (x) VALUES (2)");
    expect(inserted.changes).toBe(1);
    expect(await writable.query("SELECT x FROM t ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }]);
    await expect(readOnly.exec("INSERT INTO t (x) VALUES (3)")).rejects.toThrow(
      /readonly|read-only|attempt to write/i,
    );
  });

  it("按 realpath 缓存：同一文件的两种写法共享一个句柄", async () => {
    const direct = await opener.open("data/app.db", { readonly: true });
    const dotted = await opener.open("./data/../data/app.db", { readonly: true });
    expect(dotted).toBe(direct);
  });

  it("只读打开不存在的库文件时拒绝，且不创建文件", async () => {
    await expect(opener.open("data/missing.db", { readonly: true })).rejects.toThrow(
      /does not exist|unable to open/i,
    );
    expect(existsSync(join(root, "data", "missing.db"))).toBe(false);
  });

  it("读写打开会创建尚不存在的库文件", async () => {
    const db = await opener.open("data/fresh.db", { readonly: false });
    expect((await db.exec("CREATE TABLE t (x INTEGER)")).changes).toBe(0);
    expect((await db.exec("INSERT INTO t (x) VALUES (7)")).changes).toBe(1);
    expect(await db.query("SELECT * FROM t")).toEqual([{ x: 7 }]);
  });

  it("concurrent opens of the same key share one handle", async () => {
    const handles = await Promise.all(
      Array.from({ length: 8 }, () => opener.open("data/app.db", { readonly: true })),
    );
    expect(new Set(handles).size).toBe(1);
  });

  it("closeAll closes every handle it opened", async () => {
    const stale = await opener.open("data/app.db", { readonly: false });
    expect(await stale.query("SELECT * FROM t")).toEqual([{ x: 1 }]);

    await opener.closeAll();
    await expect(stale.query("SELECT * FROM t")).rejects.toThrow();

    // The cache is empty again, so the same request opens a fresh handle.
    const reopened = await opener.open("data/app.db", { readonly: false });
    expect(reopened).not.toBe(stale);
    expect(await reopened.query("SELECT * FROM t")).toEqual([{ x: 1 }]);
  });
});

function createFixtureDatabase(file: string): void {
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t (x) VALUES (1)");
  } finally {
    db.close();
  }
}
