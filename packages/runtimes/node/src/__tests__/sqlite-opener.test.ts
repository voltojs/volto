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
import type { FileSystem } from "@volto/core";
import { createNodeFileSystem } from "../filesystem.js";
import { createSqliteDatabaseOpener } from "../database.js";

const itDarwin = process.platform === "darwin" ? it : it.skip;
// Symlink creation needs developer mode (SeCreateSymbolicLinkPrivilege) on
// Windows, so those cases are skipped there rather than failing the suite.
const itUnlessWindows = process.platform === "win32" ? it.skip : it;

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

    const fs = createNodeFileSystem({ root });
    opener = createSqliteDatabaseOpener({ fs, workspaceRoot: root });
  });

  afterEach(async () => {
    await opener.closeAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("F-116 rejects an escaping path fail-closed", async () => {
    await expect(opener.open("../../etc/volto.db", { readonly: true })).rejects.toThrow(
      /outside the workspace/,
    );
  });

  itUnlessWindows("F-116 rejects a symlink pointing outside the workspace", async () => {
    // The outside database is valid, so if containment stopped before the
    // realpath step the open would *succeed* — this case fails for the right
    // reason only.
    symlinkSync(outside, join(root, "data", "link"));
    expect(existsSync(join(root, "data", "link", "secret.db"))).toBe(true);
    await expect(opener.open("data/link/secret.db", { readonly: true })).rejects.toThrow(
      /outside the workspace/,
    );
    await expect(opener.open("data/link/secret.db", { readonly: false })).rejects.toThrow(
      /outside the workspace/,
    );
  });

  itUnlessWindows("F-116 still opens a symlink that points inside the workspace", async () => {
    // The positive half: refusing every symlinked path is not containment.
    mkdirSync(join(root, "linked"));
    createFixtureDatabase(join(root, "linked", "target.db"));
    symlinkSync(join(root, "linked", "target.db"), join(root, "data", "alias.db"));

    const db = await opener.open("data/alias.db", { readonly: true });
    expect(await db.query("SELECT * FROM t")).toEqual([{ x: 1 }]);
    // It is the same file, so it is the same cached handle.
    const direct = await opener.open("linked/target.db", { readonly: true });
    expect(db).toBe(direct);
  });

  it("F-117 a read-only handle is refused a write by the engine", async () => {
    const db = await opener.open("data/app.db", { readonly: true });
    await expect(db.exec("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
      /readonly|read-only|attempt to write/i,
    );
  });

  it("F-118 refuses ATTACH and DETACH on both handle kinds", async () => {
    const readOnly = await opener.open("data/app.db", { readonly: true });
    await expect(readOnly.query("ATTACH DATABASE '/etc/passwd' AS leaked")).rejects.toThrow(/ATTACH/i);
    await expect(readOnly.exec("DETACH DATABASE main")).rejects.toThrow(/DETACH/i);

    const writable = await opener.open("data/app.db", { readonly: false });
    await expect(writable.query("ATTACH DATABASE '/etc/passwd' AS leaked")).rejects.toThrow(/ATTACH/i);
    await expect(writable.exec("DETACH DATABASE main")).rejects.toThrow(/DETACH/i);
  });

  it("F-118 refuses VACUUM INTO and load_extension", async () => {
    const db = await opener.open("data/app.db", { readonly: false });
    await expect(db.exec(`VACUUM INTO '${join(outside, "vacuum.db")}'`)).rejects.toThrow(/VACUUM INTO/i);
    await expect(db.query("SELECT load_extension('evil')")).rejects.toThrow(/load_extension/i);

    const readOnly = await opener.open("data/app.db", { readonly: true });
    await expect(readOnly.exec(`VACUUM INTO '${join(outside, "vacuum-ro.db")}'`)).rejects.toThrow(
      /VACUUM INTO/i,
    );
    await expect(readOnly.query("SELECT load_extension('evil')")).rejects.toThrow(/load_extension/i);
  });

  it("F-118 keeps a plain VACUUM and attach-looking text usable", async () => {
    const db = await opener.open("data/app.db", { readonly: false });
    // A plain VACUUM only rewrites the already-open database.
    expect((await db.exec("VACUUM")).changes).toBe(0);
    expect(await db.query("SELECT 'please attach the log' AS note")).toEqual([
      { note: "please attach the log" },
    ]);
    expect(await db.query("SELECT 2 AS x /* ATTACH nothing */")).toEqual([{ x: 2 }]);
    expect(await db.query("SELECT x FROM t /* ATTACH DATABASE 'x' AS y */")).toEqual([{ x: 1 }]);
    expect(await db.query("SELECT x FROM t -- DETACH DATABASE main")).toEqual([{ x: 1 }]);
  });

  it("F-118 a refused statement leaves no artifact outside the workspace", async () => {
    const db = await opener.open("data/app.db", { readonly: false });
    const targets = {
      attach: join(outside, "attached.db"),
      vacuum: join(outside, "vacuum.db"),
    };
    const refused: Array<[string, () => Promise<unknown>, string]> = [
      ["ATTACH", () => db.query(`ATTACH DATABASE '${targets.attach}' AS leaked`), targets.attach],
      ["DETACH", () => db.exec("DETACH DATABASE main"), targets.attach],
      ["VACUUM INTO", () => db.exec(`VACUUM INTO '${targets.vacuum}'`), targets.vacuum],
    ];

    for (const [name, run, target] of refused) {
      await expect(run(), name).rejects.toThrow();
      // The guard runs before `db.prepare`, so SQLite never sees the
      // statement — not even a 0-byte file may appear at the target.
      expect(existsSync(target), `${name} left an artifact at ${target}`).toBe(false);
    }
  });

  it("F-119 a read-only query leaves no -wal or -shm behind", async () => {
    const db = await opener.open("data/app.db", { readonly: true });
    const rows = await db.query("SELECT * FROM t");
    expect(rows).toEqual([{ x: 1 }]);
    expect(existsSync(join(root, "data", "app.db-wal"))).toBe(false);
    expect(existsSync(join(root, "data", "app.db-shm"))).toBe(false);
    // Leaving journal_mode untouched matters: WAL mode is sticky in the
    // database header, so a read-only open must not switch it on either.
    expect(existsSync(join(root, "data", "app.db-journal"))).toBe(false);
  });

  it("Review Focus 4: a database in a read-only location rejects the write instead of crashing", async () => {
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
    "Review Focus 4: a database on a read-only directory is readable and its write rejects",
    async () => {
      const db = await opener.open("data/readonly.db", { readonly: false });
      await expect(db.exec("INSERT INTO t (x) VALUES (1)")).rejects.toThrow(
        /readonly|read-only|attempt to write/i,
      );
      expect(await db.query("SELECT * FROM t")).toEqual([{ x: 1 }]);
    },
  );

  it("keeps read-only and writable handles apart in the cache", async () => {
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

  it("caches by realpath, so two spellings of one file share a handle", async () => {
    const direct = await opener.open("data/app.db", { readonly: true });
    const dotted = await opener.open("./data/../data/app.db", { readonly: true });
    expect(dotted).toBe(direct);
  });

  it("a read-only open of a missing database rejects instead of creating it", async () => {
    await expect(opener.open("data/missing.db", { readonly: true })).rejects.toThrow(
      /does not exist|unable to open/i,
    );
    expect(existsSync(join(root, "data", "missing.db"))).toBe(false);
  });

  it("a writable open creates a database that does not exist yet", async () => {
    const db = await opener.open("data/fresh.db", { readonly: false });
    expect((await db.exec("CREATE TABLE t (x INTEGER)")).changes).toBe(0);
    expect((await db.exec("INSERT INTO t (x) VALUES (7)")).changes).toBe(1);
    expect(await db.query("SELECT * FROM t")).toEqual([{ x: 7 }]);
  });

  it("propagates a non-containment resolvePath failure instead of relabelling it", async () => {
    // A sandbox denial is not a workspace rule. The path is inside the root,
    // so the opener must surface the original error untouched.
    const denial = new Error("Cannot read \"data/app.db\": it is inside a denied credential directory.");
    denial.name = "SandboxBoundaryError";
    const denying = {
      ...createNodeFileSystem({ root }),
      resolvePath: async () => {
        throw denial;
      },
    } as FileSystem;

    const guarded = createSqliteDatabaseOpener({ fs: denying, workspaceRoot: root });
    await expect(guarded.open("data/app.db", { readonly: true })).rejects.toBe(denial);
    await guarded.closeAll();
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
