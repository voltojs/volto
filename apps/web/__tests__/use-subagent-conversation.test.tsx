/**
 * useSubagentConversation：盘上恢复 + 实时合并。sessions-api mock 掉（同
 * use-server-sessions.test.ts 约定），chat store 与 subagent-cache 用真实
 * 模块——合并逻辑（mergeStoredAndLive live 胜出）就是要走真的那一份。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useChatStore, type SubagentBucket } from '@/stores/chat-store';
import { useSubagentConversation } from '@/hooks/use-subagent-conversation';
import {
  setCachedSubagentEvents,
  clearSubagentCache,
} from '@/lib/subagent-cache';
import { fetchSessionEvents } from '@/lib/sessions-api';
import type { ChatEntry } from '@/lib/projection';
import type { TranscriptEventInput } from '@volto/sdk/sse';

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn(),
}));

const fetchSessionEventsMock = vi.mocked(fetchSessionEvents);

const userGo: TranscriptEventInput = {
  time: 1,
  type: 'user_message',
  data: { content: 'go' },
  turn: 1,
};

const assistant = (text: string): TranscriptEventInput => ({
  time: 2,
  type: 'assistant_message',
  data: { content: [{ type: 'text', text }] },
  // 投影把 assistant_message 折进 step（stepFor 对缺 step 的事件直接丢弃），
  // 真实事件流（reducer 打标）必带 turn/step——fixture 亦然。
  turn: 1,
  step: 1,
});

function bucket(partial: Partial<SubagentBucket>): SubagentBucket {
  return { events: [], deltas: [], status: 'running', ...partial };
}

function messageTexts(entries: ChatEntry[]): string[] {
  return entries
    .filter((e) => e.kind === 'message')
    .map((e) => (e.kind === 'message' ? e.message.content : ''));
}

beforeEach(() => {
  clearSubagentCache();
  useChatStore.setState({ subagents: {}, openSubagentId: null });
  fetchSessionEventsMock.mockReset();
});

describe('useSubagentConversation', () => {
  it('merges stored events with the live bucket, live side winning on id collisions', async () => {
    setCachedSubagentEvents('s-sub-0', [userGo, assistant('stored final')]);
    useChatStore.setState({
      subagents: {
        's-sub-0': bucket({
          events: [userGo, assistant('live final')],
          status: 'done',
        }),
      },
    });
    const { result } = renderHook(() => useSubagentConversation('s-sub-0'));
    // 桶已 done 且有缓存：不重拉，entries 直接来自实时桶。
    expect(fetchSessionEventsMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe('done');
    const texts = messageTexts(result.current.entries);
    expect(texts).toContain('live final');
    expect(texts).not.toContain('stored final');
  });

  it('keeps the live version of a colliding message once the stored fetch lands', async () => {
    // 桶在运行中（done 括号未到）→ 不命中「done + 缓存」跳过分支，真发拉取：
    // stored 与 live 在同一条消息 id 上相遇（同 turn/step 形状 → 同 id），
    // 合并必须保留 live 版本，而 stored 独有的行存活。
    useChatStore.setState({
      subagents: {
        's-sub-2': bucket({ events: [assistant('live final')] }),
      },
    });
    fetchSessionEventsMock.mockResolvedValue({
      sessionId: 's-sub-2',
      events: [userGo, assistant('stored final')],
    });
    const { result } = renderHook(() => useSubagentConversation('s-sub-2'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // 桶状态在场时胜出：running 不会因拉取成功而被改写成 done。
    expect(result.current.status).toBe('running');
    expect(messageTexts(result.current.entries)).toEqual(['go', 'live final']);
  });

  it('fetches stored events when no bucket and no cache, entering loading first', async () => {
    fetchSessionEventsMock.mockResolvedValue({
      sessionId: 's-sub-1',
      events: [userGo, assistant('stored final')],
    });
    const { result } = renderHook(() => useSubagentConversation('s-sub-1'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchSessionEventsMock).toHaveBeenCalledWith('s-sub-1');
    // 无桶 + 拉取成功 → status done（盘上记录就是终态）。
    expect(result.current.status).toBe('done');
    expect(result.current.error).toBeNull();
    expect(messageTexts(result.current.entries)).toContain('stored final');
  });

  it('is idle and never fetches for a null childId', () => {
    const { result } = renderHook(() => useSubagentConversation(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.entries).toEqual([]);
    expect(fetchSessionEventsMock).not.toHaveBeenCalled();
  });

  it('refetches on retry and clears the error on success', async () => {
    fetchSessionEventsMock.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSubagentConversation('s-sub-3'));
    await waitFor(() => expect(result.current.error).toBe('offline'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.entries).toEqual([]);

    fetchSessionEventsMock.mockResolvedValueOnce({
      sessionId: 's-sub-3',
      events: [userGo, assistant('stored final')],
    });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchSessionEventsMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(messageTexts(result.current.entries)).toContain('stored final');
  });
});
