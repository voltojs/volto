/**
 * Per-turn file changes, folded from the conversation feed.
 *
 * A write tool captures its own unified diff into the tool result's
 * `displayMetadata.fileChange`; core projects that onto
 * `ConversationToolCall.fileChange`, so everything needed to summarise "what
 * did this turn change" is already in the feed — no extra request, no git.
 *
 * Pure: the fold only reads the entries it is given.
 */

import type { FileChange } from '@voltojs/sdk/sse';
import type { ChatEntry } from './projection';

/**
 * Cap on the aggregated body of one file within one turn. A long turn can
 * edit the same file many times; the card's counts stay exact (they are
 * summed), only the rendered body is cut — and says so.
 */
export const MAX_TURN_FILE_DIFF_CHARS = 40_000;

export interface TurnFileChange extends FileChange {
  /** How many edits of this file contributed to the entry. */
  edits: number;
}

/** The turn an entry belongs to, from its `${turn}:…` message/key id. */
export function turnOfEntry(entry: ChatEntry): string {
  const head = (entry.kind === 'message' ? entry.message.id : entry.key).split(':')[0];
  return head !== undefined && head !== '' && !Number.isNaN(Number(head)) ? head : '';
}

/**
 * Folds every tool call's captured change into per-turn, per-file entries.
 *
 * Order is first appearance, so the summary lists files in the order the
 * agent touched them. Repeated edits of one file merge into a single row:
 * counts add up and the diff bodies concatenate, each hunk still describing
 * the state it was applied to.
 */
export function collectTurnFileChanges(
  entries: readonly ChatEntry[],
): Map<string, TurnFileChange[]> {
  const byTurn = new Map<string, TurnFileChange[]>();
  const indexByTurn = new Map<string, Map<string, number>>();

  for (const entry of entries) {
    if (entry.kind !== 'message') continue;
    const turn = turnOfEntry(entry);
    if (turn === '') continue;
    for (const block of entry.message.blocks) {
      if (block.type !== 'tool_call') continue;
      const change = block.call.fileChange;
      if (change === undefined) continue;

      let rows = byTurn.get(turn);
      if (rows === undefined) {
        rows = [];
        byTurn.set(turn, rows);
        indexByTurn.set(turn, new Map());
      }
      const index = indexByTurn.get(turn)!;
      const current = index.get(change.path);
      if (current === undefined) {
        index.set(change.path, rows.length);
        rows.push({ ...change, edits: 1 });
        continue;
      }
      const existing = rows[current]!;
      rows[current] = mergeChange(existing, change);
    }
  }

  return byTurn;
}

function mergeChange(existing: TurnFileChange, next: FileChange): TurnFileChange {
  const joined = `${existing.diff}\n${next.diff}`;
  const overCap = joined.length > MAX_TURN_FILE_DIFF_CHARS;
  return {
    path: existing.path,
    diff: overCap ? joined.slice(0, MAX_TURN_FILE_DIFF_CHARS) : joined,
    additions: existing.additions + next.additions,
    deletions: existing.deletions + next.deletions,
    edits: existing.edits + 1,
    ...(existing.truncated === true || next.truncated === true || overCap
      ? { truncated: true }
      : {}),
  };
}