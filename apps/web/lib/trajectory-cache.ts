/**
 * 已拉取过的 trajectory 行缓存，按会话 id 键控。transcript 只追加、
 * live 行在合流中永远胜出，所以缓存不随拉取失效、滞后无碍（spec §2.2）。
 * 唯一的失效点是切走会话时丢弃该会话的行：离开期间完成的轮次不在缓存
 * 里，切回时须重拉（见 use-conversation 的切换 effect）。
 * 独立成模块以便脱离 React 单测。
 */

import type { TrajectoryRow } from '@volto/sdk/sse';

const cache = new Map<string, TrajectoryRow[]>();

export function getCachedTrajectory(sessionId: string): TrajectoryRow[] | undefined {
  const rows = cache.get(sessionId);
  // A poisoned entry (whatever wrote a non-array) must read as a miss, or
  // it would flow into the row merge and take the feed down.
  return Array.isArray(rows) ? rows : undefined;
}

export function setCachedTrajectory(sessionId: string, rows: TrajectoryRow[]): void {
  cache.set(sessionId, rows);
}

/** 丢弃一个会话的缓存行，下次展示时重新拉取；未缓存过的 id 是空操作。 */
export function dropCachedTrajectory(sessionId: string): void {
  cache.delete(sessionId);
}

export function clearTrajectoryCache(): void {
  cache.clear();
}
