/**
 * TrajectoryDrawer：主轨迹面板行详情抽屉（R1 复活）。
 * 自包含——子会话行的「查看执行过程」直接往 pane-store 开 subagent 标签的
 * trajectory 视图，不再回调父级 onDrillDown。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrajectoryDrawer } from '@/components/trajectory/TrajectoryDrawer';
import { usePaneStore } from '@/stores/pane-store';
import type { TrajectoryRow } from '@volto/sdk/sse';

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
});
