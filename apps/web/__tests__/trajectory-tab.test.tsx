import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrajectoryTab } from '@/components/pane/TrajectoryTab';
import { usePaneStore } from '@/stores/pane-store';
import { fetchServerTrajectory } from '@/lib/sessions-api';
import { clearTrajectoryCache } from '@/lib/trajectory-cache';
import type { TrajectoryRow } from '@volto/sdk/sse';

// 与 plan 的差异：mock 工厂须带上 TrajectoryUnavailableError——use-trajectory
// 的错误归一化在 catch 里 `instanceof` 该类，工厂缺了它会让 instanceof 的
// RHS 变成 undefined 抛 TypeError，错误态永远渲染不出来。
vi.mock('@/lib/sessions-api', () => ({
  fetchServerTrajectory: vi.fn(),
  TrajectoryUnavailableError: class TrajectoryUnavailableError extends Error {
    readonly kind: 'legacy' | 'network' = 'network';
  },
}));
const fetchMock = vi.mocked(fetchServerTrajectory);

const rows = [
  { id: 'a1', kind: 'user', summary: 'hi', startedAt: 1 },
  { id: 'a2', kind: 'assistant', summary: 'hello', startedAt: 2 },
] as unknown as TrajectoryRow[];

beforeEach(() => {
  clearTrajectoryCache();
  usePaneStore.setState({ tabs: [], activeTabId: null });
  fetchMock.mockReset();
});

describe('TrajectoryTab', () => {
  it('renders stored rows as a snapshot list', async () => {
    fetchMock.mockResolvedValue({ rows, streamingRowId: null } as never);
    render(<TrajectoryTab tab={{ kind: 'trajectory', id: 'trajectory:c1', sessionId: 'c1' }} />);
    expect(await screen.findByText('hello')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith('c1');
  });

  it('offers retry on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('网络故障'));
    render(<TrajectoryTab tab={{ kind: 'trajectory', id: 'trajectory:c1', sessionId: 'c1' }} />);
    expect(await screen.findByText(/加载轨迹失败/)).toBeDefined();
    fetchMock.mockResolvedValue({ rows, streamingRowId: null } as never);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('hello')).toBeDefined();
  });
});
