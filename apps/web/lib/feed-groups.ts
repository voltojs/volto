/**
 * Coalesces a chat feed into rows where consecutive tool-only steps share one
 * execution group.
 *
 * A turn is several steps, each its own `ConversationMessage`. In concise
 * density, folding per message produces a stack of one-line "已执行 N 步"
 * bars for what the user reads as a single stretch of work. Merging the
 * messages that carry no answer text at all — only reasoning and tool calls —
 * is what makes one turn one group.
 *
 * A message that contains any answer text is never merged: the text is the
 * boundary between two stretches of execution, and the order the model
 * produced them in must survive.
 */

import type { ConversationBlock } from '@volto/sdk/sse';
import type { ChatEntry } from './projection';

/** The block kinds the execution layer owns. */
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' }>;

export type FeedRow =
  | { kind: 'entry'; key: string; entry: ChatEntry }
  | { kind: 'activity'; key: string; blocks: ActivityBlock[] };

function entryKey(entry: ChatEntry): string {
  return entry.kind === 'message' ? entry.message.id : entry.key;
}

/** True when a message is nothing but execution: no answer text, no image. */
function isActivityOnly(entry: ChatEntry): boolean {
  if (entry.kind !== 'message') return false;
  const { blocks, content } = entry.message;
  if (blocks.length === 0 || content !== '') return false;
  return blocks.every((block) => block.type === 'reasoning' || block.type === 'tool_call');
}

/** Groups consecutive tool-only messages; every other entry stays its own row. */
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
    if (isActivityOnly(entry) && entry.kind === 'message') {
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
