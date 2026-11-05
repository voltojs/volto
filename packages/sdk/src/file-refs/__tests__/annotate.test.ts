import { describe, expect, it } from 'vitest';
import { collectInlineCodeSpans, resolveMessageRefs } from '../annotate.js';

describe('collectInlineCodeSpans', () => {
  it('collects inline-code spans with content offsets', () => {
    expect(collectInlineCodeSpans('text `a.ts` and `b.ts`')).toEqual([
      { start: 6, end: 10, text: 'a.ts' },
      { start: 17, end: 21, text: 'b.ts' },
    ]);
  });

  it('ignores backticks inside fenced code blocks', () => {
    const md = ['intro', '```ts', 'const s = `x.ts`;', '```', 'outro'].join('\n');
    expect(collectInlineCodeSpans(md)).toEqual([]);
  });
});

describe('resolveMessageRefs', () => {
  const row = (blocks: string[], turn = '1', rowKey = '1:a0') => ({ rowKey, turn, blocks });

  it('annotates a full-path ref that exists', async () => {
    const result = await resolveMessageRefs({
      rows: [row(['see `apps/web/lib/fs-api.ts:42`'])],
      touchedByTurn: new Map(),
      touchedAll: [],
      exists: async (path) => path === 'apps/web/lib/fs-api.ts',
    });
    expect(result).toEqual([
      {
        rowKey: '1:a0',
        blockRefs: [
          [
            {
              start: 5,
              end: 30,
              path: 'apps/web/lib/fs-api.ts',
              line: 42,
              source: 'exact',
            },
          ],
        ],
      },
    ]);
  });

  it('resolves a bare name via session facts with same-turn locality', async () => {
    const result = await resolveMessageRefs({
      rows: [row(['see `MessageBubble.tsx`'], '2', '2:a0')],
      touchedByTurn: new Map([['2', ['apps/web/components/chat/MessageBubble.tsx']]]),
      touchedAll: ['x/MessageBubble.tsx', 'apps/web/components/chat/MessageBubble.tsx'],
      exists: async () => false,
    });
    expect(result[0]?.blockRefs[0]?.[0]).toMatchObject({
      path: 'apps/web/components/chat/MessageBubble.tsx',
      source: 'session',
    });
  });

  it('resolves nothing when two touched files share the basename', async () => {
    const result = await resolveMessageRefs({
      rows: [row(['see `MessageBubble.tsx`'], '2', '2:a0')],
      touchedByTurn: new Map(),
      touchedAll: ['x/MessageBubble.tsx', 'apps/web/components/chat/MessageBubble.tsx'],
      exists: async () => false,
    });
    expect(result).toEqual([{ rowKey: '2:a0', blockRefs: [[]] }]);
  });

  it('keeps the line target on session matches', async () => {
    const result = await resolveMessageRefs({
      rows: [row(['see `MessageBubble.tsx:12`'], '2', '2:a0')],
      touchedByTurn: new Map(),
      touchedAll: ['apps/web/components/chat/MessageBubble.tsx'],
      exists: async () => false,
    });
    expect(result[0]?.blockRefs[0]?.[0]).toMatchObject({
      path: 'apps/web/components/chat/MessageBubble.tsx',
      line: 12,
      source: 'session',
    });
  });

  it('leaves unmatched refs plain', async () => {
    const result = await resolveMessageRefs({
      rows: [row(['see `nope.ts`'])],
      touchedByTurn: new Map(),
      touchedAll: [],
      exists: async () => false,
    });
    expect(result).toEqual([{ rowKey: '1:a0', blockRefs: [[]] }]);
  });
});

describe('resolveMessageRefs annotation refs', () => {
  it('annotates extensionless files that exist (prompt-contract output)', async () => {
    const result = await resolveMessageRefs({
      rows: [{ rowKey: '1:a0', turn: '1', blocks: ['see `go.mod`'] }],
      touchedByTurn: new Map(),
      touchedAll: [],
      exists: async (path) => path === 'go.mod',
    });
    expect(result[0]?.blockRefs[0]?.[0]).toMatchObject({
      path: 'go.mod',
      source: 'exact',
    });
  });
});
