/**
 * file-change — the display contract for "this tool call changed one file".
 *
 * A write tool captures the unified diff of the edit it just made and rides it
 * on `ToolResult.displayMetadata.fileChange`; the reducer persists that with
 * the `tool_result` event, so the diff survives reloads and replays without a
 * server round trip or a dependency on the project being a git repository.
 * Core owns the shape (like {@link FileAccess}) and exposes it on the
 * conversation view; the web renders it.
 */

/** One file's change, as a UI can present it. */
export interface FileChange {
  path: string;
  /**
   * Unified hunk body (`@@` headers plus ` `/`+`/`-` lines). Empty when the
   * tool wrote the same bytes back.
   */
  diff: string;
  additions: number;
  deletions: number;
  /** The diff hit the capture cap and is cut short — the UI must say so. */
  truncated?: boolean;
}

function isLineCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Pure: read a change fact out of a tool result's displayMetadata. Anything
 * malformed yields null — a UI must never render half a diff.
 */
export function extractFileChange(
  displayMetadata: Record<string, unknown> | undefined,
): FileChange | null {
  if (!displayMetadata) return null;
  const raw = displayMetadata["fileChange"];
  if (typeof raw !== "object" || raw === null) return null;
  const meta = raw as Record<string, unknown>;
  const { path, diff, additions, deletions } = meta;
  if (typeof path !== "string" || path === "") return null;
  if (typeof diff !== "string" || diff === "") return null;
  if (!isLineCount(additions) || !isLineCount(deletions)) return null;
  return {
    path,
    diff,
    additions,
    deletions,
    ...(meta["truncated"] === true ? { truncated: true } : {}),
  };
}