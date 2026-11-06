/**
 * Turns the chat feed into rows split at answer text.
 *
 * A turn's blocks look like `reasoning, tool, tool, text, tool, text`: the
 * text can arrive *between* tool runs, and often inside the same message that
 * called them. Grouping by message therefore hid prose inside the execution
 * group and produced a stack of one-line groups.
 *
 * The boundary is now the text block itself: every text/image block renders
 * as its own answer row, and the reasoning and tool calls between two answer
 * rows merge into one execution group — across message boundaries, because
 * those boundaries are an artefact of how the model was called, not of how
 * the work happened.
 *
 * The footer (time, copy, usage) rides the row holding the message's tail, so
 * a message split across rows still shows exactly one footer.
 */

import { groupConversationBlocks } from '@volto/sdk/sse';
import type { ConversationBlock, ConversationMessage } from '@volto/sdk/sse';
import type { ChatEntry } from './projection';

type AnswerBlock = Extract<ConversationBlock, { type: 'text' | 'image' }>;
type ActivityBlock = Extract<ConversationBlock, { type: 'reasoning' | 'tool_call' }>;

export type FeedRow =
  | { kind: 'entry'; key: string; turn: string; entry: ChatEntry }
  | { kind: 'answer'; key: string; turn: string; blocks: AnswerBlock[]; footer: ConversationMessage | null }
  | { kind: 'activity'; key: string; turn: string; blocks: ActivityBlock[]; footer: ConversationMessage | null };

/**
 * The turn a row belongs to, as the `${turn}` string the message ids use. A
 * row whose id has no turn prefix yields '' — it can still render, it just
 * cannot anchor turn-scoped UI (the file-change card).
 */
function rowTurn(id: string): string {
  const head = id.split(':')[0];
  return head !== undefined && head !== '' && !Number.isNaN(Number(head)) ? head : '';
}

function entryKey(entry: ChatEntry): string {
  return entry.kind === 'message' ? entry.message.id : entry.key;
}

/**
 * The turn a message belongs to, parsed off its `${turn}:${step}` id. Messages
 * that do not carry a turn id are treated as their own turn, so they still get
 * a footer rather than none.
 */
function turnOf(message: ConversationMessage): string {
  const head = message.id.split(':')[0] ?? message.id;
  return Number.isNaN(Number(head)) ? message.id : head;
}

export function groupFeedEntries(entries: readonly ChatEntry[]): FeedRow[] {
  // Time, copy and usage are per turn, not per step: a turn is several model
  // calls, and only the last one's tail should carry them.
  const lastMessageOfTurn = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.message.role !== 'assistant') continue;
    lastMessageOfTurn.set(turnOf(entry.message), entry.message.id);
  }

  const rows: FeedRow[] = [];
  // One message can carry several execution runs (`tool → text → tool`); the
  // message id alone would repeat as the row key, so each run gets a counter.
  let activityRun = 0;
  let open: {
    key: string;
    turn: string;
    blocks: ActivityBlock[];
    footer: ConversationMessage | null;
  } | null = null;

  const flush = (): void => {
    if (open !== null) {
      rows.push({ kind: 'activity', ...open });
      open = null;
    }
  };

  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.message.role !== 'assistant') {
      flush();
      const key = entryKey(entry);
      rows.push({ kind: 'entry', key, turn: rowTurn(key), entry });
      continue;
    }

    const message = entry.message;
    const isTurnTail = lastMessageOfTurn.get(turnOf(message)) === message.id;
    const footerFor = (): ConversationMessage | null => (isTurnTail ? message : null);
    const segments = groupConversationBlocks(message.blocks);
    if (segments.length === 0) {
      // A step that errored before producing content still carries the round's
      // usage. Dropping the row would drop the only trace of that round, so an
      // empty answer row keeps the footer alive.
      flush();
      if (isTurnTail) {
        rows.push({
          kind: 'answer',
          key: `${message.id}:footer`,
          turn: rowTurn(message.id),
          blocks: [],
          footer: message,
        });
      }
      continue;
    }

    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;
      if (segment.kind === 'activity') {
        open ??= {
          key: `activity-${message.id}-${activityRun++}`,
          turn: rowTurn(message.id),
          blocks: [],
          footer: null,
        };
        open.blocks.push(...segment.blocks);
        // The tail of a message may sit inside a run that keeps growing; the
        // last message to end in activity owns the footer of that run.
        if (isLast) open.footer = footerFor();
        return;
      }
      flush();
      rows.push({
        kind: 'answer',
        key: `${message.id}:a${index}`,
        turn: rowTurn(message.id),
        blocks: segment.blocks,
        footer: isLast ? footerFor() : null,
      });
    });
  }
  flush();
  return rows;
}
