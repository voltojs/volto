import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedSubagentEvents,
  setCachedSubagentEvents,
  clearSubagentCache,
} from '@/lib/subagent-cache';
import type { TranscriptEventInput } from '@voltojs/sdk/sse';

const events = (text: string): TranscriptEventInput[] => [
  { time: 1, type: 'user_message', data: { content: 'go' } },
  { time: 2, type: 'assistant_message', data: { content: [{ type: 'text', text }] } },
];

describe('subagent cache', () => {
  beforeEach(() => clearSubagentCache());

  it('round-trips events per child session id, preserving reference', () => {
    const stored = events('stored final');
    expect(getCachedSubagentEvents('s-sub-0')).toBeUndefined();
    setCachedSubagentEvents('s-sub-0', stored);
    // 同一引用：命中路径不需要再次投影前的深比较。
    expect(getCachedSubagentEvents('s-sub-0')).toBe(stored);
  });

  it('keys independently per child session id', () => {
    setCachedSubagentEvents('s-sub-0', events('a'));
    setCachedSubagentEvents('s-sub-1', events('b'));
    expect(getCachedSubagentEvents('s-sub-0')).not.toEqual(
      getCachedSubagentEvents('s-sub-1'),
    );
  });

  it('overwrites on re-set', () => {
    setCachedSubagentEvents('s-sub-0', events('old'));
    setCachedSubagentEvents('s-sub-0', events('new'));
    expect(getCachedSubagentEvents('s-sub-0')?.at(-1)).toEqual(
      events('new').at(-1),
    );
  });

  it('is undefined again after a clear', () => {
    setCachedSubagentEvents('s-sub-0', events('a'));
    clearSubagentCache();
    expect(getCachedSubagentEvents('s-sub-0')).toBeUndefined();
  });
});
