/**
 * file-gate — pure decisions for read-before-edit + version (staleness) gating.
 *
 * All state lives in AgentState.readFiles (serializable → survives resume/replay).
 * I/O facts (current mtime, file existence) are passed in by the imperative shell;
 * the decision itself stays pure.
 */

import type { ReadFileRecord } from "./state.js";
import type { ToolResult } from "./tool.js";

/** A file-access fact reported by a read/write tool via ToolResult.displayMetadata. */
export interface FileAccess {
  path: string;
  mtime: number;
}

/** Pure: upsert a read/write observation into readFiles (version bump + latest mtime). */
export function recordFileAccess(readFiles: ReadFileRecord[], access: FileAccess): ReadFileRecord[] {
  const existing = readFiles.find((r) => r.path === access.path);
  if (existing) {
    return readFiles.map((r) =>
      r.path === access.path ? { path: r.path, version: r.version + 1, mtime: access.mtime } : r,
    );
  }
  return [...readFiles, { path: access.path, version: 1, mtime: access.mtime }];
}

/** Pure: find the read record for a path, if any. */
export function findReadRecord(readFiles: ReadFileRecord[], path: string): ReadFileRecord | undefined {
  return readFiles.find((r) => r.path === path);
}

/**
 * Pure: decide whether an edit may proceed, given prior read records and the
 * file's current mtime on disk. Returns an isError ToolResult if blocked, else null.
 */
export function evaluateEditGate(
  readFiles: ReadFileRecord[],
  path: string,
  currentMtime: number,
): ToolResult | null {
  const record = findReadRecord(readFiles, path);
  if (!record) {
    return {
      modelContent: `edit_file blocked: call read_file on "${path}" before editing.`,
      isError: true,
    };
  }
  if (currentMtime !== record.mtime) {
    return {
      modelContent: `edit_file blocked: "${path}" changed since the last read. Re-read it before editing.`,
      isError: true,
    };
  }
  return null;
}

/**
 * Pure: decide whether a write may proceed. Creating a new file is always allowed;
 * overwriting an existing file requires a prior read. Returns an isError ToolResult
 * if blocked, else null.
 */
export function evaluateOverwriteGate(
  readFiles: ReadFileRecord[],
  path: string,
  fileExists: boolean,
): ToolResult | null {
  if (!fileExists) {
    return null;
  }
  if (!findReadRecord(readFiles, path)) {
    return {
      modelContent: `write_file blocked: call read_file on "${path}" before overwriting it.`,
      isError: true,
    };
  }
  return null;
}

/** Pure: extract a file-access fact from a tool result's displayMetadata, if present. */
export function extractFileAccess(displayMetadata: Record<string, unknown> | undefined): FileAccess | null {
  if (!displayMetadata) return null;
  for (const key of ["readFile", "writeFile"]) {
    const meta = displayMetadata[key] as { path?: unknown; mtime?: unknown } | undefined;
    if (meta && typeof meta.path === "string" && typeof meta.mtime === "number") {
      return { path: meta.path, mtime: meta.mtime };
    }
  }
  return null;
}
