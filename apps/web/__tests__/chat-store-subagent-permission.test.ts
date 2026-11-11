// @vitest-environment jsdom
/**
 * The child's permission must survive the paths that rebuild its bucket
 * (spec 2026-11-11 review #4): a page refresh lands on the finish bracket
 * with no live bucket, and that is the most common way a user opens a
 * finished sub-agent tab.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '@/stores/chat-store';
import type { TranscriptEventInput } from '@volto/sdk/sse';

const started = (childId: string): TranscriptEventInput =>
  ({
    type: 'subagent_started',
    data: {
      childSessionId: childId,
      label: 'task',
      depth: 1,
      permission: { sandbox: 'read-only', approval: 'never', preset: 'read-only' },
    },
  }) as unknown as TranscriptEventInput;

const finished = (childId: string): TranscriptEventInput =>
  ({
    type: 'subagent_finished',
    data: { childSessionId: childId, isError: false, durationMs: 12 },
  }) as unknown as TranscriptEventInput;

describe('chat store — sub-agent permission recovery', () => {
  beforeEach(() => {
    useChatStore.setState({ events: [], deltas: [], subagents: {}, currentSessionId: 's1' });
  });

  it('recovers the permission from the buffer when the bucket is created lazily', () => {
    // A refresh replays both brackets into `events`; the bucket is built on
    // first access and must still know the boundary.
    useChatStore.setState({ events: [started('c1'), finished('c1')] });

    const bucket = useChatStore.getState().subagents['c1'];
    // Nothing builds it until something asks; the finish mark is what creates
    // it in practice.
    useChatStore.getState().markSubagentFinished('c1', false, 12);
    expect(useChatStore.getState().subagents['c1']?.permission?.preset).toBe('read-only');
    expect(bucket).toBeUndefined();
  });

  it('keeps the permission when the finish bracket arrives with no live bucket', () => {
    useChatStore.setState({ events: [started('c1')] });
    useChatStore.getState().markSubagentFinished('c1', false, 12);

    const bucket = useChatStore.getState().subagents['c1'];
    expect(bucket?.status).toBe('done');
    expect(bucket?.permission).toEqual({
      sandbox: 'read-only',
      approval: 'never',
      preset: 'read-only',
    });
  });

  it('records the permission when the started bracket arrives live', () => {
    useChatStore.getState().markSubagentStarted('c2', {
      sandbox: 'workspace-write',
      approval: 'never',
      preset: 'auto',
    });

    expect(useChatStore.getState().subagents['c2']?.permission?.preset).toBe('auto');
  });
});
