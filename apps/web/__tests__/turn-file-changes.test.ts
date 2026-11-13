import { describe, it, expect } from 'vitest';
import type { ConversationToolCall } from '@voltojs/sdk/sse';
import {
  collectTurnFileChanges,
  MAX_TURN_FILE_DIFF_CHARS,
  turnOfEntry,
} from '@/lib/turn-file-changes';
import type { ChatEntry } from '@/lib/projection';

function write(turn: number, step: number, calls: ConversationToolCall[]): ChatEntry {
  return {
    kind: 'message',
    message: {
      id: `${turn}:${step}`,
      role: 'assistant',
      content: '',
      timestamp: 0,
      blocks: calls.map((call) => ({ type: 'tool_call', call })),
    },
  };
}

function call(path: string, additions: number, deletions: number, diff = '@@ -1,1 +1,1 @@\n-a\n+b'): ConversationToolCall {
  return {
    id: `c-${path}-${additions}`,
    name: 'edit_file',
    args: { path },
    fileChange: { path, diff, additions, deletions },
  };
}

describe('turnOfEntry', () => {
  it('reads the turn prefix from a message id', () => {
    expect(turnOfEntry(write(3, 1, []))).toBe('3');
  });

  it('yields an empty turn for ids without one', () => {
    const entry: ChatEntry = { kind: 'notice', key: 'notice:x', text: 'hi', time: 0 };
    expect(turnOfEntry(entry)).toBe('');
  });
});

describe('collectTurnFileChanges', () => {
  it('groups changes per turn and per file', () => {
    const entries = [
      write(1, 1, [call('a.ts', 3, 1), call('b.ts', 1, 0)]),
      write(2, 1, [call('a.ts', 2, 2)]),
    ];
    const byTurn = collectTurnFileChanges(entries);
    expect([...byTurn.keys()]).toEqual(['1', '2']);
    expect(byTurn.get('1')!.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
    expect(byTurn.get('2')!.map((c) => c.path)).toEqual(['a.ts']);
    expect(byTurn.get('1')![0]).toMatchObject({ additions: 3, deletions: 1, edits: 1 });
  });

  it('merges repeated edits of the same file, summing counts and bodies', () => {
    const entries = [
      write(1, 1, [call('a.ts', 2, 1, '@@ -1,1 +1,1 @@\n-a\n+b')]),
      write(1, 2, [call('a.ts', 5, 0, '@@ -2,1 +2,1 @@\n-c\n+d')]),
    ];
    const [change] = collectTurnFileChanges(entries).get('1')!;
    expect(change).toMatchObject({ path: 'a.ts', additions: 7, deletions: 1, edits: 2 });
    expect(change!.diff).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -2,1 +2,1 @@\n-c\n+d');
    expect(change!.truncated).toBeUndefined();
  });

  it('keeps first-appearance order across steps', () => {
    const entries = [
      write(1, 1, [call('z.ts', 1, 0), call('a.ts', 1, 0)]),
      write(1, 2, [call('m.ts', 1, 0), call('z.ts', 1, 0)]),
    ];
    expect(collectTurnFileChanges(entries).get('1')!.map((c) => c.path)).toEqual([
      'z.ts',
      'a.ts',
      'm.ts',
    ]);
  });

  it('declares truncation when the merged body passes the cap', () => {
    const big = '+x'.repeat(Math.ceil(MAX_TURN_FILE_DIFF_CHARS / 2) + 10);
    const entries = [
      write(1, 1, [call('a.ts', 1, 0, big)]),
      write(1, 2, [call('a.ts', 1, 0, big)]),
    ];
    const [change] = collectTurnFileChanges(entries).get('1')!;
    expect(change!.edits).toBe(2);
    expect(change!.additions).toBe(2);
    expect(change!.truncated).toBe(true);
    expect(change!.diff.length).toBeLessThanOrEqual(MAX_TURN_FILE_DIFF_CHARS);
  });

  it('propagates a producer-side truncation flag', () => {
    const truncatedCall: ConversationToolCall = {
      id: 'c1',
      name: 'write_file',
      args: { path: 'a.ts' },
      fileChange: { path: 'a.ts', diff: '@@ -0,0 +1,1 @@\n+x', additions: 1, deletions: 0, truncated: true },
    };
    expect(collectTurnFileChanges([write(1, 1, [truncatedCall])]).get('1')![0]!.truncated).toBe(true);
  });

  it('ignores tool calls that did not report a change', () => {
    const plain: ConversationToolCall = { id: 'c9', name: 'read_file', args: { path: 'a.ts' } };
    expect(collectTurnFileChanges([write(1, 1, [plain])]).size).toBe(0);
  });
});