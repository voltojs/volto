/**
 * 已拉取过的 trajectory 行缓存，按会话 id 键控。transcript 只追加、
 * live 行在合流中永远胜出，所以缓存永不失效、滞后无碍（spec §2.2）。
 * 独立成模块以便脱离 React 单测。
 */

import type { TrajectoryRow } from '@volto/sdk/sse';

const cache = new Map<string, TrajectoryRow[]>();

export function getCachedTrajectory(sessionId: string): TrajectoryRow[] | undefined {
  return cache.get(sessionId);
}

export function setCachedTrajectory(sessionId: string, rows: TrajectoryRow[]): void {
  cache.set(sessionId, rows);
}

export function clearTrajectoryCache(): void {
  cache.clear();
}
