import { describe, expect, it } from 'vitest';
import { groupFeedEntries } from '../feed-groups';
import type { ChatEntry } from '../projection';
import type { ConversationMessage } from '@volto/sdk/sse';

const assistant = (
  id: string,
  blocks: ConversationMessage['blocks'],
  content = '',
): ChatEntry => ({
  kind: 'message',
  message: { id, role: 'assistant', blocks, content, timestamp: 1 },
});

const tool = (id: string): ConversationMessage['blocks'][number] => ({
  type: 'tool_call',
  call: { id, name: 'bash', args: { command: 'ls' }, result: 'a' },
});
const text = (t: string): ConversationMessage['blocks'][number] => ({ type: 'text', text: t });
const reasoning = (t: string): ConversationMessage['blocks'][number] => ({
  type: 'reasoning',
  text: t,
});

const kinds = (rows: ReturnType<typeof groupFeedEntries>) => rows.map((r) => r.kind);
const footerOf = (row: ReturnType<typeof groupFeedEntries>[number]) =>
  row.kind === 'entry' ? null : row.footer;

describe('groupFeedEntries', () => {
  it('splits a turn at every answer text', () => {
    const rows = groupFeedEntries([
      assistant('m1', [reasoning('think'), tool('t1'), text('第一段')]),
      assistant('m2', [tool('t2'), reasoning('think again'), text('结尾')]),
    ]);
    expect(kinds(rows)).toEqual(['activity', 'answer', 'activity', 'answer']);
    const [first, , second] = rows;
    expect(first!.kind === 'activity' && first!.blocks.map((b) => b.type)).toEqual([
      'reasoning',
      'tool_call',
    ]);
    expect(second!.kind === 'activity' && second!.blocks.map((b) => b.type)).toEqual([
      'tool_call',
      'reasoning',
    ]);
  });

  it('merges execution across message boundaries when no text separates it', () => {
    const rows = groupFeedEntries([
      assistant('m1', [reasoning('a'), tool('t1')]),
      assistant('m2', [reasoning('b'), tool('t2')]),
    ]);
    expect(kinds(rows)).toEqual(['activity']);
    expect(rows[0]!.kind === 'activity' && rows[0]!.blocks).toHaveLength(4);
  });

  it('leaves mid-turn execution without a footer', () => {
    const rows = groupFeedEntries([
      // Two steps of one turn; only the second ends it.
      assistant('1:1', [tool('t1')]),
      assistant('1:2', [text('answer')], 'answer'),
    ]);
    expect(kinds(rows)).toEqual(['activity', 'answer']);
    expect(footerOf(rows[0]!)).toBeNull();
    expect(footerOf(rows[1]!)?.id).toBe('1:2');
  });

  it('puts the footer on the row that holds the message tail', () => {
    const endingInText = groupFeedEntries([assistant('m1', [tool('t1'), text('done')], 'done')]);
    expect(footerOf(endingInText[0]!)).toBeNull();
    expect(footerOf(endingInText[1]!)?.id).toBe('m1');

    const endingInTools = groupFeedEntries([assistant('m1', [text('start'), tool('t1')], 'start')]);
    expect(endingInTools[1]!.kind).toBe('activity');
    expect(footerOf(endingInTools[1]!)?.id).toBe('m1');
  });

  it('keeps human turns and non-message entries as their own rows', () => {
    const user: ChatEntry = {
      kind: 'message',
      message: { id: 'u1', role: 'user', blocks: [], content: 'hi', timestamp: 1 },
    };
    const rows = groupFeedEntries([
      user,
      assistant('m1', [tool('t1')]),
      { kind: 'notice', key: '1:cancelled', text: 'x', time: 2 },
    ]);
    expect(kinds(rows)).toEqual(['entry', 'activity', 'entry']);
  });

  it('keeps the footer of an empty tail step (errored round)', () => {
    const rows = groupFeedEntries([
      assistant('1:1', [tool('t1')]),
      assistant('1:2', []),
    ]);
    const last = rows[rows.length - 1]!;
    expect(last.kind).toBe('answer');
    expect(footerOf(last)?.id).toBe('1:2');
  });

  it('drops nothing when a message is pure answer text', () => {
    const rows = groupFeedEntries([assistant('m1', [text('only words')], 'only words')]);
    expect(kinds(rows)).toEqual(['answer']);
    expect(footerOf(rows[0]!)?.id).toBe('m1');
  });
});
