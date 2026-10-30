/**
 * Coalesces a chat feed into rows where consecutive tool-bearing steps share
 * one execution group.
 *
 * A turn is several steps, each its own `ConversationMessage`. In concise
 * density, folding per message produces a stack of one-line "已执行 N 步"
 * bars for what the user reads as a single stretch of work — and leaves the
 * reasoning of the final step stranded in a group of its own.
 *
 * The rule is therefore about what a step *is*, not what its blocks look
 * like: a message that calls any tool is execution (reasoning, the preamble
 * text it writes before calling, and the calls themselves), while a message
 * with no tool call is the answer. Order is never rearranged.
 */

import type { ConversationBlock } from '@volto/sdk/sse';
import type { ChatEntry } from './projection';

/** The block kinds the execution layer can carry. */
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' | 'text' }>;

export type FeedRow =
  | { kind: 'entry'; key: string; entry: ChatEntry }
  | { kind: 'activity'; key: string; blocks: ActivityBlock[] };

function entryKey(entry: ChatEntry): string {
  return entry.kind === 'message' ? entry.message.id : entry.key;
}

/** A step that called at least one tool is execution, whatever else it wrote. */
function isToolBearing(entry: ChatEntry): boolean {
  if (entry.kind !== 'message' || entry.message.role !== 'assistant') return false;
  return entry.message.blocks.some((block) => block.type === 'tool_call');
}

/** Groups consecutive tool-bearing steps; every other entry stays its own row. */
export function groupFeedEntries(entries: readonly ChatEntry[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let open: { key: string; blocks: ActivityBlock[] } | null = null;

  const flush = (): void => {
    if (open !== null) {
      rows.push({ kind: 'activity', key: open.key, blocks: open.blocks });
      open = null;
    }
  };

  for (const entry of entries) {
    if (isToolBearing(entry) && entry.kind === 'message') {
      if (open === null) open = { key: `activity-${entry.message.id}`, blocks: [] };
      open.blocks.push(...(entry.message.blocks as ActivityBlock[]));
      continue;
    }
    flush();
    rows.push({ kind: 'entry', key: entryKey(entry), entry });
  }
  flush();
  return rows;
}
