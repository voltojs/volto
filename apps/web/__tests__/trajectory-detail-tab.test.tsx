/**
 * TrajectoryDetailTab：TrajectoryDrawer 内容体平移。关键行为差异：
 * 「查看执行过程 →」不再回调父级，而是直接往 pane-store 开 trajectory 标签。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrajectoryDetailTab } from '@/components/pane/TrajectoryDetailTab';
import { usePaneStore } from '@/stores/pane-store';
import type { TrajectoryRow } from '@volto/sdk/sse';

const row = (over: Partial<TrajectoryRow> = {}): TrajectoryRow =>
  ({
    id: 'r1',
    kind: 'assistant',
    summary: '回答了问题',
    startedAt: 1_700_000_000_000,
    durationMs: 1200,
    inputDetail: 'hi',
    outputDetail: 'hello',
    ...over,
  }) as TrajectoryRow;

const tab = (r: TrajectoryRow) =>
  ({ kind: 'trajectory-detail', id: 'row:s1:r1', sessionId: 's1', rowId: 'r1', row: r }) as const;

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null });
});

describe('TrajectoryDetailTab', () => {
  it('renders overview fields from the row snapshot', () => {
    render(<TrajectoryDetailTab tab={tab(row())} />);
    expect(screen.getByText('回答了问题')).toBeDefined();
    expect(screen.getByText('已完成')).toBeDefined();
  });

  // 与 plan 的差异：plan 原稿用 assistant 行点击「输入」/「输出」，但
  // TAB_LABELS 实际是「参数」/「结果」（trajectory-view-model.test 锚定），
  // 且 assistant 行没有 input tab（spec §四 per-kind 裁剪）。这里用同时拥有
  // input/output tab 的 tool 行 + 实际标签，测试意图（input/output 内容体）
  // 不变。
  it('shows input/output tab bodies', () => {
    render(<TrajectoryDetailTab tab={tab(row({ kind: 'tool' }))} />);
    fireEvent.click(screen.getByText('参数'));
    expect(screen.getByText('hi')).toBeDefined();
    fireEvent.click(screen.getByText('结果'));
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('opens a trajectory pane tab for a subagent row instead of calling a parent callback', () => {
    const childRow = row({ kind: 'subagent', childSessionId: 'child-9' });
    usePaneStore.getState().openTab(tab(childRow));
    usePaneStore.getState().setActive('row:s1:r1');
    render(<TrajectoryDetailTab tab={tab(childRow)} />);
    fireEvent.click(screen.getByText(/查看执行过程/));
    const { tabs, activeTabId } = usePaneStore.getState();
    expect(tabs.find((t) => t.id === 'trajectory:child-9')).toMatchObject({ kind: 'trajectory', sessionId: 'child-9' });
    expect(activeTabId).toBe('trajectory:child-9');
  });

  it('ignores non-detail tabs', () => {
    const { container } = render(
      <TrajectoryDetailTab tab={({ kind: 'files', id: 'files:x', projectId: 'x' }) as never} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
