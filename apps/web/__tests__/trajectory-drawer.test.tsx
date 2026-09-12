/**
 * TrajectoryDrawer：子代理行的「查看执行过程 →」按钮触发下钻回调
 * onDrillDown（携带整行，语义 = 下钻该子会话的轨迹审计行）。
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
  it('sub-agent rows drill into the child trajectory via onDrillDown', () => {
    const onDrillDown = vi.fn();
    render(
      <TrajectoryDrawer
        open
        row={subagentRow}
        onOpenChange={vi.fn()}
        onDrillDown={onDrillDown}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /查看执行过程/ }));
    const drilled = onDrillDown.mock.calls[0]?.[0] as TrajectoryRow | undefined;
    expect(drilled?.childSessionId).toBe('s-sub-0');
    expect(onDrillDown).toHaveBeenCalledWith(subagentRow);
  });
});
