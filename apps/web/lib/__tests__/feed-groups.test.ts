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

describe('groupFeedEntries', () => {
  it('merges consecutive tool-only steps into one activity row', () => {
    const rows = groupFeedEntries([
      assistant('m1', [tool('t1')]),
      assistant('m2', [tool('t2')]),
      assistant('m3', [{ type: 'reasoning', text: 'r' }]),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('activity');
    expect(row.kind === 'activity' && row.blocks).toHaveLength(3);
  });

  it('keeps answer text as the boundary between two stretches', () => {
    const rows = groupFeedEntries([
      assistant('m1', [tool('t1')]),
      assistant('m2', [{ type: 'text', text: 'done' }], 'done'),
      assistant('m3', [tool('t3')]),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'entry', 'activity']);
  });

  it('never merges across a user message', () => {
    const user: ChatEntry = {
      kind: 'message',
      message: { id: 'u1', role: 'user', blocks: [], content: 'hi', timestamp: 1 },
    };
    const rows = groupFeedEntries([assistant('m1', [tool('t1')]), user, assistant('m2', [tool('t2')])]);
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'entry', 'activity']);
  });

  it('passes single rows through untouched when nothing is mergeable', () => {
    const rows = groupFeedEntries([{ kind: 'notice', key: '1:cancelled', text: 'x', time: 1 }]);
    expect(rows.map((r) => r.kind)).toEqual(['entry']);
  });
});
