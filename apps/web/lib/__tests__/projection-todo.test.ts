import { describe, expect, it } from 'vitest';
import { composeChatEntries } from '../projection';
import type { ConversationMessage } from '@volto/sdk/sse';

const msg = (id: string, timestamp: number): ConversationMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text: id }],
  content: id,
  timestamp,
});

const todo = (time: number, kind: 'started' | 'completed', content: string) => ({
  key: `1:${time}:${kind}:${content}`,
  time,
  transition: { kind, content } as const,
});

describe('composeChatEntries todo rows', () => {
  it('places a todo row after the message at the same time', () => {
    const entries = composeChatEntries([msg('m1', 100), msg('m2', 200)], [], [
      todo(100, 'started', 'a'),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['message', 'todo', 'message']);
  });

  it('places a todo row between messages by time', () => {
    const entries = composeChatEntries([msg('m1', 100), msg('m2', 200)], [], [
      todo(150, 'completed', 'a'),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['message', 'todo', 'message']);
    const middle = entries[1];
    expect(middle?.kind === 'todo' && middle.key).toBe('1:150:completed:a');
  });

  it('keeps the existing output when no todo rows are passed', () => {
    expect(composeChatEntries([msg('m1', 100)], []).map((e) => e.kind)).toEqual(['message']);
  });
});
