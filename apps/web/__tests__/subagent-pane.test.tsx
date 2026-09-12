/**
 * SubagentPane：右侧分栏。sessions-api mock 掉（同 use-subagent-conversation
 * 约定），chat store 与 subagent-cache 用真实模块——feed 合流走真的那份。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentPane } from '@/components/chat/SubagentPane';
import { useChatStore } from '@/stores/chat-store';
import { clearSubagentCache } from '@/lib/subagent-cache';
import { fetchSessionEvents } from '@/lib/sessions-api';
import type { TranscriptEventInput } from '@volto/sdk/sse';

vi.mock('@/lib/sessions-api', () => ({
  fetchSessionEvents: vi.fn(),
}));

const fetchSessionEventsMock = vi.mocked(fetchSessionEvents);

Element.prototype.scrollIntoView ??= () => {};

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

beforeEach(() => {
  clearSubagentCache();
  useChatStore.setState({
    events: [],
    deltas: [],
    subagents: {},
    openSubagentId: null,
  });
  fetchSessionEventsMock.mockReset();
});

describe('SubagentPane', () => {
  it('renders the live conversation from the bucket and closes on demand', async () => {
    useChatStore.setState({
      openSubagentId: 's-sub-0',
      subagents: {
        's-sub-0': {
          events: [userGo, assistant('hello from sub')],
          deltas: [],
          status: 'running',
        },
      },
    });
    // 桶在运行中 → hook 每次都重拉盘上记录；mock 空事件避免真实网络。
    fetchSessionEventsMock.mockResolvedValue({
      sessionId: 's-sub-0',
      events: [],
    });
    const onClose = vi.fn();
    render(<SubagentPane onClose={onClose} />);
    // 桶在运行中 → hook 每次都重拉盘上记录，首帧在加载门后面；等拉取落定、
    // 实时桶内容渲染出来。
    expect(await screen.findByText(/hello from sub/)).toBeDefined();
    expect(screen.getByText(/运行中|执行中/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Pane 只回调 onClose，不自行改 store——落盘是 ChatPanel 回调的职责。
    expect(useChatStore.getState().openSubagentId).toBe('s-sub-0');
  });

  it('shows the no-record empty state when the bucket is empty and done', async () => {
    useChatStore.setState({
      openSubagentId: 's-sub-1',
      subagents: { 's-sub-1': { events: [], deltas: [], status: 'done' } },
    });
    fetchSessionEventsMock.mockResolvedValue({
      sessionId: 's-sub-1',
      events: [],
    });
    render(<SubagentPane onClose={vi.fn()} />);
    // 无缓存 + 桶终态也会先拉一次盘上记录；空态在拉取落定后出现。
    expect(await screen.findByText('无执行记录')).toBeDefined();
  });
});
