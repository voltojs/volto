/**
 * Memo hardening of the chat feed leaves: during a pane-open sub-agent run
 * every delta re-renders the whole feed, so `Markdown` (shallow value props)
 * and `ToolCallCard` (args identity churns per projection) must be
 * memo-wrapped to skip re-parsing/re-rendering unchanged leaves.
 */

import { describe, it, expect } from 'vitest';
import { Markdown } from '@/components/chat/Markdown';
import {
  ToolCallCard,
  toolCallCardComparator,
} from '@/components/chat/ToolCallCard';

describe('memo hardening', () => {
  it('Markdown and ToolCallCard are memo-wrapped', () => {
    expect((Markdown as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
    expect((ToolCallCard as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('ToolCallCard comparator ignores args identity but reacts to result/approval changes', () => {
    const base = { call: { id: 'c1', name: 'task', args: {} } };
    const sameArgs = {
      call: { id: 'c1', name: 'task', args: { fresh: {} } },
    };
    const withResult = {
      call: { id: 'c1', name: 'task', args: {}, result: 'done' },
    };
    expect(toolCallCardComparator(base as never, sameArgs as never)).toBe(true);
    expect(toolCallCardComparator(base as never, withResult as never)).toBe(
      false,
    );
  });
});
