/**
 * Trajectory shape guard: a server answer that breaks the {rows: [...]}
 * contract — or a poisoned cache entry — must degrade to "no stored rows"
 * instead of feeding undefined into mergeStoredAndLiveRows, where
 * `[...stored]` threw "stored is not iterable" and took the whole ChatPanel
 * down whenever the live feed was still empty.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTrajectory } from '@/hooks/use-trajectory';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { setCachedTrajectory } from '@/lib/trajectory-cache';
import { fetchServerTrajectory } from '@/lib/sessions-api';

vi.mock('@/lib/sessions-api', () => ({
  fetchServerTrajectory: vi.fn(),
  TrajectoryUnavailableError: class TrajectoryUnavailableError extends Error {
    kind: 'legacy' | 'network' = 'network';
    constructor(message: string) {
      super(message);
    }
  },
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchServerTrajectory).mockReset();
  useSessionStore.setState({ currentSessionId: 's1' });
  useChatStore.setState({
    events: [],
    deltas: [],
    currentSessionId: null,
    isGenerating: false,
  });
});

describe('useTrajectory shape guard', () => {
  it('treats a contract-breaking response as an empty feed', async () => {
    vi.mocked(fetchServerTrajectory).mockResolvedValue({
      unexpected: 'shape',
    } as never);

    const { result } = renderHook(() => useTrajectory());

    await waitFor(() =>
      expect(result.current.isLoading).toBe(false),
    );
    expect(result.current.rows).toEqual([]);
  });

  it('treats a poisoned cache entry as a cache miss', async () => {
    // A bad value once written must not survive into the merge.
    setCachedTrajectory('s1', undefined as never);
    vi.mocked(fetchServerTrajectory).mockResolvedValue({ rows: [] });

    const { result } = renderHook(() => useTrajectory());

    expect(result.current.rows).toEqual([]);
    await waitFor(() =>
      expect(result.current.isLoading).toBe(false),
    );
  });
});
