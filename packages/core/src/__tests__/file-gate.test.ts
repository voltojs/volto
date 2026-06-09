import { describe, it, expect } from "vitest";
import {
  recordFileAccess,
  findReadRecord,
  evaluateEditGate,
  evaluateOverwriteGate,
  extractFileAccess,
} from "../file-gate.js";
import type { ReadFileRecord } from "../state.js";

describe("recordFileAccess", () => {
  it("inserts a new record at version 1", () => {
    const next = recordFileAccess([], { path: "a.ts", mtime: 100 });
    expect(next).toEqual([{ path: "a.ts", version: 1, mtime: 100 }]);
  });

  it("bumps version and updates mtime for an existing path", () => {
    const start: ReadFileRecord[] = [{ path: "a.ts", version: 1, mtime: 100 }];
    const next = recordFileAccess(start, { path: "a.ts", mtime: 250 });
    expect(next).toEqual([{ path: "a.ts", version: 2, mtime: 250 }]);
  });

  it("does not mutate the input array", () => {
    const start: ReadFileRecord[] = [{ path: "a.ts", version: 1, mtime: 100 }];
    recordFileAccess(start, { path: "a.ts", mtime: 250 });
    expect(start).toEqual([{ path: "a.ts", version: 1, mtime: 100 }]);
  });

  it("keeps unrelated records untouched", () => {
    const start: ReadFileRecord[] = [{ path: "a.ts", version: 3, mtime: 100 }];
    const next = recordFileAccess(start, { path: "b.ts", mtime: 50 });
    expect(next).toHaveLength(2);
    expect(findReadRecord(next, "a.ts")).toEqual({ path: "a.ts", version: 3, mtime: 100 });
  });
});

describe("evaluateEditGate", () => {
  const read: ReadFileRecord[] = [{ path: "a.ts", version: 1, mtime: 100 }];

  it("blocks editing a file that was never read", () => {
    const result = evaluateEditGate([], "a.ts", 100);
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("call read_file");
  });

  it("blocks editing when mtime changed since the read (stale)", () => {
    const result = evaluateEditGate(read, "a.ts", 999);
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("changed since the last read");
  });

  it("allows editing when mtime matches the recorded read", () => {
    expect(evaluateEditGate(read, "a.ts", 100)).toBeNull();
  });
});

describe("evaluateOverwriteGate", () => {
  it("allows creating a new (non-existent) file without a prior read", () => {
    expect(evaluateOverwriteGate([], "new.ts", false)).toBeNull();
  });

  it("blocks overwriting an existing file with no prior read", () => {
    const result = evaluateOverwriteGate([], "a.ts", true);
    expect(result?.isError).toBe(true);
    expect(result?.modelContent).toContain("before overwriting");
  });

  it("allows overwriting an existing file that was read", () => {
    const read: ReadFileRecord[] = [{ path: "a.ts", version: 1, mtime: 100 }];
    expect(evaluateOverwriteGate(read, "a.ts", true)).toBeNull();
  });
});

describe("extractFileAccess", () => {
  it("returns null for undefined metadata", () => {
    expect(extractFileAccess(undefined)).toBeNull();
  });

  it("extracts a readFile access fact", () => {
    expect(extractFileAccess({ readFile: { path: "a.ts", mtime: 100 } })).toEqual({
      path: "a.ts",
      mtime: 100,
    });
  });

  it("extracts a writeFile access fact", () => {
    expect(extractFileAccess({ writeFile: { path: "b.ts", mtime: 5 } })).toEqual({
      path: "b.ts",
      mtime: 5,
    });
  });

  it("returns null when the metadata shape is malformed", () => {
    expect(extractFileAccess({ readFile: { path: "a.ts" } })).toBeNull();
    expect(extractFileAccess({ readFile: { mtime: 100 } })).toBeNull();
    expect(extractFileAccess({ other: { path: "a.ts", mtime: 1 } })).toBeNull();
  });
});
