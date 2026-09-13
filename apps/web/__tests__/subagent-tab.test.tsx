/**
 * SubagentTab：RightPane 的子代理标签体。sessions-api mock 掉（沿用
 * subagent-pane.test 约定），chat store 与 subagent-cache 用真实模块。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SubagentTab } from '@/components/pane/SubagentTab';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { useTrajectoryDrawerStore } from '@/stores/trajectory-drawer-store';
import { clearSubagentCache } from '@/lib/subagent-cache';
import { clearTrajectoryCache } from '@/lib/trajectory-cache';
import { fetchSessionEvents, fetchServerTrajectory } from '@/lib/sessions-api';
import type { TranscriptEventInput } from '@volto/sdk/sse';

vi.mock('@/lib/sessions-api', () => {
  // useStoredRows 以 instanceof 识别 trajectory 接口失败，mock 工厂必须
  // 提供同类形状的类（照抄 sessions-api 的 TrajectoryUnavailableError）。
  class TrajectoryUnavailableError extends Error {}
  return {
    fetchSessionEvents: vi.fn(),
    fetchServerTrajectory: vi.fn(),
    TrajectoryUnavailableError,
  };
});
const fetchSessionEventsMock = vi.mocked(fetchSessionEvents);
const fetchServerTrajectoryMock = vi.mocked(fetchServerTrajectory);

Element.prototype.scrollIntoView ??= () => {};

const userGo: TranscriptEventInput = { time: 1, type: 'user_message', data: { content: 'go' }, turn: 1 };
const assistant = (text: string): TranscriptEventInput => ({
  time: 2,
  type: 'assistant_message',
  data: { content: [{ type: 'text', text }] },
  turn: 1,
  step: 1,
});

const tab = (childId: string) => ({ kind: 'subagent', id: `subagent:${childId}`, childSessionId: childId, view: 'chat' }) as const;

beforeEach(() => {
  clearSubagentCache();
  clearTrajectoryCache();
  useChatStore.setState({ events: [], deltas: [], subagents: {} });
  usePaneStore.setState({ tabs: [], activeTabId: null });
  useTrajectoryDrawerStore.setState({ row: null });
  fetchSessionEventsMock.mockReset();
  fetchServerTrajectoryMock.mockReset();
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

  it('shows the trajectory sub-view with stored rows and switches via the tab payload', async () => {
    useChatStore.setState({
      subagents: { 's-sub-0': { events: [userGo], deltas: [], status: 'done' } },
    });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-0', events: [] });
    fetchServerTrajectoryMock.mockResolvedValue({
      rows: [{ index: 1, id: 'a1', kind: 'user', turn: 1, summary: 'go', startedAt: 1 }],
    });
    const trajectoryTab = {
      kind: 'subagent',
      id: 'subagent:s-sub-0',
      childSessionId: 's-sub-0',
      view: 'trajectory',
    } as const;
    const { rerender } = render(<SubagentTab tab={trajectoryTab} />);
    // 对话面板 keepMounted（隐藏挂载），其消息 div 与轨迹行 span 同时在 DOM
    // 中——审计行断言以 TrajectoryRowItem 实际渲染为准：summary 在 <span>
    // 里，用 span 选择器锁定，避免命中对话气泡的 div。
    expect(await screen.findByText('go', { selector: 'span' })).toBeDefined();
    // 切回对话：openTab 用 view:'chat' 载荷覆盖同一标签 → 组件受控于载荷，
    // 用覆盖后的最新 tab 重渲染，对话消息流出现、轨迹面板卸载。
    usePaneStore
      .getState()
      .openTab({ kind: 'subagent', id: 'subagent:s-sub-0', childSessionId: 's-sub-0', view: 'chat' });
    rerender(
      <SubagentTab tab={usePaneStore.getState().tabs.find((t) => t.id === 'subagent:s-sub-0')!} />,
    );
    expect(await screen.findByText('go', { selector: 'p, span, div' })).toBeDefined();
  });

  // 轨迹子视图的行点击经全局抽屉 store 打开行详情（抽屉由主轨迹面板渲染，
  // 这里只断言 store 收到行快照——渲染方的行为由 trajectory-drawer.test 覆盖）。
  it('opens the row-detail drawer from a trajectory row click', async () => {
    useChatStore.setState({
      subagents: { 's-sub-0': { events: [], deltas: [], status: 'done' } },
    });
    fetchSessionEventsMock.mockResolvedValue({ sessionId: 's-sub-0', events: [] });
    fetchServerTrajectoryMock.mockResolvedValue({
      rows: [{ index: 1, id: 'a1', kind: 'user', turn: 1, summary: 'go', startedAt: 1 }],
    });
    render(
      <SubagentTab
        tab={{ kind: 'subagent', id: 'subagent:s-sub-0', childSessionId: 's-sub-0', view: 'trajectory' }}
      />,
    );
    fireEvent.click(await screen.findByText('go', { selector: 'span' }));
    expect(useTrajectoryDrawerStore.getState().row).toMatchObject({ id: 'a1', summary: 'go' });
  });
});
