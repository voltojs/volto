/**
 * SubagentTab：RightPane 的子代理标签体。sessions-api mock 掉（沿用
 * subagent-pane.test 约定），chat store 与 subagent-cache 用真实模块。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SubagentTab } from '@/components/pane/SubagentTab';
import { useChatStore } from '@/stores/chat-store';
import { clearSubagentCache } from '@/lib/subagent-cache';
import { fetchSessionEvents } from '@/lib/sessions-api';
import type { TranscriptEventInput } from '@volto/sdk/sse';

vi.mock('@/lib/sessions-api', () => ({ fetchSessionEvents: vi.fn() }));
const fetchSessionEventsMock = vi.mocked(fetchSessionEvents);

Element.prototype.scrollIntoView ??= () => {};

const userGo: TranscriptEventInput = { time: 1, type: 'user_message', data: { content: 'go' }, turn: 1 };
const assistant = (text: string): TranscriptEventInput => ({
  time: 2,
  type: 'assistant_message',
  data: { content: [{ type: 'text', text }] },
  turn: 1,
  step: 1,
});

const tab = (childId: string) => ({ kind: 'subagent', id: `subagent:${childId}`, childSessionId: childId }) as const;

beforeEach(() => {
  clearSubagentCache();
  useChatStore.setState({ events: [], deltas: [], subagents: {} });
  fetchSessionEventsMock.mockReset();
});

describe('SubagentTab', () => {
  it('renders the live conversation from the bucket with the running status', async () => {
    useChatStore.setState({
      subagents: { 's-sub-0': { events: [userGo, assistant('hello from sub')], deltas: [], status: 'running' } },
    });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-0', events: [] });
    render(<SubagentTab tab={tab('s-sub-0')} />);
    expect(await screen.findByText(/hello from sub/)).toBeDefined();
    expect(screen.getByText('执行中')).toBeDefined();
  });

  it('shows the no-record empty state when the bucket is empty and done', async () => {
    useChatStore.setState({ subagents: { 's-sub-1': { events: [], deltas: [], status: 'done' } } });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-1', events: [] });
    render(<SubagentTab tab={tab('s-sub-1')} />);
    expect(await screen.findByText('无执行记录')).toBeDefined();
  });

  it('shows the no-record empty state when no bucket exists and the durable log is empty', async () => {
    useChatStore.setState({ subagents: {} });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-missing', events: [] });
    render(<SubagentTab tab={tab('s-sub-missing')} />);
    expect(await screen.findByText('无执行记录')).toBeDefined();
  });

  it('keeps the waiting MessageList for a running bucket whose entries are still empty', async () => {
    useChatStore.setState({ subagents: { 's-sub-wait': { events: [], deltas: [], status: 'running' } } });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-wait', events: [] });
    render(<SubagentTab tab={tab('s-sub-wait')} />);
    await waitFor(() => expect(screen.queryByText('加载执行记录…')).toBeNull());
    expect(screen.queryByText('无执行记录')).toBeNull();
  });

  it('offers retry when the durable feed fails and recovers when it is clicked', async () => {
    useChatStore.setState({ subagents: {} });
    fetchSessionEventsMock.mockRejectedValueOnce(new Error('网络故障'));
    render(<SubagentTab tab={tab('s-sub-err')} />);
    expect(await screen.findByText('网络故障')).toBeDefined();
    fetchSessionEventsMock.mockResolvedValue({
      sessionId: 's-sub-err',
      events: [userGo, assistant('recovered from disk')],
    });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(/recovered from disk/)).toBeDefined();
  });

  it('shows the finished duration from the bracket', async () => {
    useChatStore.setState({
      subagents: { 's-sub-2': { events: [], deltas: [], status: 'done', durationMs: 52_100 } },
    });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-2', events: [] });
    render(<SubagentTab tab={tab('s-sub-2')} />);
    expect(await screen.findByText(/已完成/)).toBeDefined();
  });
});
