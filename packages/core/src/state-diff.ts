/**
 * diffState — pure function that computes a structured diff between two
 * ReducerState snapshots. Used by the time-travel debugger to show
 * what changed between checkpoints.
 */

import type { ReducerState } from "./reducer.js";

export interface StateDiff {
  /** Messages added (indices in the later state not in the earlier) */
  messagesAdded: number;
  /** Messages removed */
  messagesRemoved: number;
  /** Status changed */
  statusChanged: { from: string; to: string } | null;
  /** Pending tool calls changed */
  pendingToolsChanged: boolean;
  /** Token usage delta */
  tokensDelta: number;
  /** Iteration count delta */
  iterationsDelta: number;
  /** Read files added */
  readFilesAdded: string[];
  /** Read files removed */
  readFilesRemoved: string[];
  /** Whether any change occurred */
  hasChanges: boolean;
}

/**
 * Compute a structured diff between two ReducerState snapshots.
 * Pure function — no I/O, deterministic output for identical inputs.
 */
export function diffState(a: ReducerState, b: ReducerState): StateDiff {
  const statusChanged = a.status !== b.status
    ? { from: a.status, to: b.status }
    : null;

  const pendingToolsChanged = JSON.stringify(a.pendingTools) !== JSON.stringify(b.pendingTools);

  const readFilesA = new Set(a.readFiles.map((r) => r.path));
  const readFilesB = new Set(b.readFiles.map((r) => r.path));
  const readFilesAdded = [...readFilesB].filter((p) => !readFilesA.has(p));
  const readFilesRemoved = [...readFilesA].filter((p) => !readFilesB.has(p));

  // Message diff: count how many messages in b are not in a (by content)
  // This is a simplified diff — for precise sequence alignment, use LCS.
  const messagesAdded = Math.max(0, b.messages.length - a.messages.length);
  const messagesRemoved = Math.max(0, a.messages.length - b.messages.length);

  const tokensDelta = b.tokensUsed - a.tokensUsed;
  const iterationsDelta = b.iterationCount - a.iterationCount;

  const hasChanges = statusChanged !== null
    || pendingToolsChanged
    || readFilesAdded.length > 0
    || readFilesRemoved.length > 0
    || messagesAdded > 0
    || messagesRemoved > 0
    || tokensDelta !== 0
    || iterationsDelta !== 0;

  return {
    messagesAdded,
    messagesRemoved,
    statusChanged,
    pendingToolsChanged,
    tokensDelta,
    iterationsDelta,
    readFilesAdded,
    readFilesRemoved,
    hasChanges,
  };
}
