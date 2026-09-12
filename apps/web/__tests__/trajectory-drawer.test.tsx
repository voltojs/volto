/**
 * TrajectoryDrawer：子代理行的「查看执行过程 →」按钮统一路由到
 * onOpenSubagent（Task 10 起抽屉不再自行下钻，入口统一到子代理分栏）。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrajectoryDrawer } from '@/components/trajectory/TrajectoryDrawer';
import type { TrajectoryRow } from '@volto/sdk/sse';

const subagentRow: TrajectoryRow = {
  index: 1,
  id: 'c1',
  kind: 'subagent',
  turn: 2,
  summary: 'task(...)',
  startedAt: 1,
  childSessionId: 's-sub-0',
};

describe('TrajectoryDrawer', () => {
  it('sub-agent rows open the pane via onOpenSubagent', () => {
    const onOpenSubagent = vi.fn();
    render(
      <TrajectoryDrawer
        open
        row={subagentRow}
        onOpenChange={vi.fn()}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /查看执行过程/ }));
    expect(onOpenSubagent).toHaveBeenCalledWith('s-sub-0');
  });
});
