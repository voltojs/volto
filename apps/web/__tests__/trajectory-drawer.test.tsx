/**
 * TrajectoryDrawer：主轨迹面板行详情抽屉（R1 复活）。
 * 自包含——子会话行的「查看执行过程」直接往 pane-store 开 subagent 标签的
 * trajectory 视图，不再回调父级 onDrillDown。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrajectoryDrawer } from '@/components/trajectory/TrajectoryDrawer';
import { usePaneStore } from '@/stores/pane-store';
import { buildTurnRecords, toTrajectoryView } from '@volto/sdk/sse';
import type { TrajectoryRow, TranscriptEvent } from '@volto/sdk/sse';

const row = (over: Partial<TrajectoryRow> = {}): TrajectoryRow =>
  ({ id: 'r1', kind: 'assistant', summary: '回答了问题', startedAt: 1, outputDetail: 'hello', ...over }) as TrajectoryRow;

beforeEach(() => usePaneStore.setState({ tabs: [], activeTabId: null }));

describe('TrajectoryDrawer', () => {
  it('renders the overview fields of the row', () => {
    render(<TrajectoryDrawer row={row()} open onOpenChange={() => {}} />);
    expect(screen.getByText('回答了问题')).toBeInTheDocument();
  });

  // 与 plan 原稿的差异：Esc 关闭路径不可用——Base UI Drawer 的 Esc 逐出由
  // @floating-ui/react 的 focus manager 在 document 层处理，不在 window 上，
  // jsdom fireEvent 触发不到。改用抽屉头部真实的关闭钮（DrawerPrimitive.Close，
  // sr-only 文案「关闭」）——用户可真实触达的关闭路径。另：Base UI 以
  // onOpenChange(open, eventDetails) 两参回调，断言首参为 false。
  it('closes via onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(<TrajectoryDrawer row={row()} open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it('opens the subagent pane tab on its trajectory view for subagent rows', () => {
    const childRow = row({ kind: 'subagent', childSessionId: 'child-9' });
    render(<TrajectoryDrawer row={childRow} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText(/查看执行过程/));
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:child-9'))
      .toMatchObject({ kind: 'subagent', childSessionId: 'child-9', view: 'trajectory' });
    expect(usePaneStore.getState().activeTabId).toBe('subagent:child-9');
  });

  it('shows parent dispatch attribution, parent session and task id', () => {
    // Consume the real core projection instead of hand-crafting the row: the
    // task id must reach the drawer from user_message.source, not from the test.
    const events = [
      { seq: 0, time: 100, type: 'turn_start', data: { turn: 1 }, turn: 1 },
      {
        seq: 1,
        time: 110,
        type: 'user_message',
        data: {
          content: '子任务输入',
          source: {
            kind: 'subagent-task',
            parentSessionId: 'parent-9',
            taskId: 't1',
            label: 'explore',
          },
        },
        turn: 1,
      },
    ] as unknown as TranscriptEvent[];
    const userRow = toTrajectoryView(buildTurnRecords(events), events).rows[0]!;
    render(<TrajectoryDrawer row={userRow} open onOpenChange={() => {}} />);
    expect(screen.getByText('父代理派发')).toBeInTheDocument();
    expect(screen.getByText('parent-9')).toBeInTheDocument();
    expect(screen.getByText('t1')).toBeInTheDocument();
  });

  it('offers the child link for a task_output related session without upgrading it', () => {
    const outputRow = row({
      kind: 'tool',
      summary: '收集后台结果',
      relatedSessionId: 'child-9',
      taskId: 't1',
    });
    render(<TrajectoryDrawer row={outputRow} open onOpenChange={() => {}} />);
    expect(screen.queryByText('子agent')).toBeNull();
    fireEvent.click(screen.getByText(/查看执行过程/));
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:child-9'))
      .toMatchObject({ kind: 'subagent', childSessionId: 'child-9', view: 'trajectory' });
  });

  it('offers the child link for a background reminder', () => {
    const reminderRow = row({
      kind: 'reminder',
      reminderKind: 'background_task',
      summary: '后台任务完成',
      childSessionId: 'child-9',
      taskId: 't1',
    });
    render(<TrajectoryDrawer row={reminderRow} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText(/查看执行过程/));
    expect(usePaneStore.getState().tabs.find((t) => t.id === 'subagent:child-9'))
      .toMatchObject({ kind: 'subagent', childSessionId: 'child-9', view: 'trajectory' });
  });

  it('shows the tools a dispatch could not get, and the narrowed permission axes', () => {
    const childRow = row({
      kind: 'subagent',
      childSessionId: 'child-9',
      subagentTitle: '分析触发机制',
      subagentType: 'bug-analyzer',
      subagentDroppedTools: ['run_bash_command', 'search_files'],
      subagentDowngrades: [
        { field: 'sandbox', requested: 'danger-full-access', effective: 'workspace-write' },
      ],
    });
    render(<TrajectoryDrawer row={childRow} open onOpenChange={() => {}} />);
    expect(screen.getByText('分析触发机制')).toBeInTheDocument();
    expect(screen.getByText('bug-analyzer')).toBeInTheDocument();
    expect(screen.getByText('run_bash_command、search_files')).toBeInTheDocument();
    expect(
      screen.getByText('sandbox: danger-full-access → workspace-write'),
    ).toBeInTheDocument();
  });

  // Base UI 契约：Popup 必须渲染在 Viewport 内（滑动关闭 + 触摸滚动锁定的
  // 宿主）。缺 Viewport 时 Drawer.Popup 会在运行时告警——本断言把结构钉死。
  it('renders the popup inside a drawer viewport', () => {
    render(<TrajectoryDrawer row={row()} open onOpenChange={() => {}} />);
    expect(document.querySelector('[data-slot="drawer-viewport"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="drawer-viewport"] [data-slot="drawer-content"]')).not.toBeNull();
  });

  // 抽屉开着时换行（store.open 另一行）→ 内部 Tabs 随 row.id 重挂，
  // 不能残留上一行的激活 tab。
  it('resets the inner tabs when the row changes while open', () => {
    const toolRow = row({ id: 't1', kind: 'tool', summary: '读取文件', outputDetail: 'file contents' });
    const userRow = row({ id: 'u1', kind: 'user', summary: '用户提问', outputDetail: undefined });
    const { rerender } = render(<TrajectoryDrawer row={toolRow} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText('结果'));
    expect(screen.getByText('file contents')).toBeInTheDocument();

    rerender(<TrajectoryDrawer row={userRow} open onOpenChange={() => {}} />);
    expect(screen.getByText('用户提问')).toBeInTheDocument();
    expect(screen.queryByText('file contents')).toBeNull();
    expect(screen.queryByText('结果')).toBeNull();
  });
});
