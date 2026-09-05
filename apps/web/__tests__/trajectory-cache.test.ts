import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedTrajectory,
  setCachedTrajectory,
  dropCachedTrajectory,
  clearTrajectoryCache,
} from '@/lib/trajectory-cache';
import { TrajectoryUnavailableError } from '@/lib/sessions-api';
import type { TrajectoryRow } from '@volto/sdk/sse';

const row = (id: string): TrajectoryRow => ({
  index: 1,
  id,
  kind: 'assistant',
  turn: 1,
  summary: id,
  startedAt: 100,
});

describe('trajectory cache', () => {
  beforeEach(() => clearTrajectoryCache());

  it('round-trips rows per session id', () => {
    expect(getCachedTrajectory('s1')).toBeUndefined();
    setCachedTrajectory('s1', [row('1:1')]);
    expect(getCachedTrajectory('s1')?.[0]!.id).toBe('1:1');
    setCachedTrajectory('s2', [row('2:1')]);
    expect(getCachedTrajectory('s1')).not.toEqual(getCachedTrajectory('s2'));
  });

  it('overwrites on re-set', () => {
    setCachedTrajectory('s1', [row('old')]);
    setCachedTrajectory('s1', [row('new')]);
    expect(getCachedTrajectory('s1')?.[0]!.id).toBe('new');
  });

  it('drops a session so its rows are refetched on return', () => {
    setCachedTrajectory('s1', [row('1:1')]);
    dropCachedTrajectory('s1');
    expect(getCachedTrajectory('s1')).toBeUndefined();
  });

  it('is a no-op for an id that was never cached', () => {
    setCachedTrajectory('s1', [row('1:1')]);
    expect(() => dropCachedTrajectory('ghost')).not.toThrow();
    expect(getCachedTrajectory('s1')?.[0]!.id).toBe('1:1');
  });
});

describe('TrajectoryUnavailableError', () => {
  it('maps 410 to legacy and other statuses to network', () => {
    expect(new TrajectoryUnavailableError(410, 'gone').kind).toBe('legacy');
    expect(new TrajectoryUnavailableError(500, 'boom').kind).toBe('network');
  });
});
