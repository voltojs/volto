import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrajectoryRowItem } from '@/components/trajectory/TrajectoryRowItem';
import type { TrajectoryRow } from '@volto/sdk/sse';

const row = (over: Partial<TrajectoryRow> = {}): TrajectoryRow =>
  ({
    index: 1,
    id: 'r1',
    kind: 'user',
    summary: '子任务输入',
    startedAt: 1,
    ...over,
  }) as TrajectoryRow;

describe('TrajectoryRowItem', () => {
  it('prefixes a user row with its source label without changing the summary', () => {
    render(
      <TrajectoryRowItem
        row={row({
          messageSource: { kind: 'host-continuation', parentSessionId: 'parent-9' },
        })}
        streaming={false}
        isSelected={false}
      />,
    );
    expect(screen.getByText('宿主继续')).toBeInTheDocument();
    expect(screen.getByText('子任务输入')).toBeInTheDocument();
  });
});
