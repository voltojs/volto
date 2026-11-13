/**
 * 已拉取过的子代理盘上事件缓存，按 childSessionId 键控（id 不透明，只作
 * Map 键用，从不解析）。transcript 只追加、实时桶在合流中永远胜出，所以
 * 缓存不随拉取失效、滞后无碍——滞后只出现在桶还开着的时候，而那种情况下
 * 消费 hook 每次打开都会重拉（见 use-subagent-conversation 的拉取 effect：
 * 仅「桶已 done 且已有缓存」才跳过重拉）。
 * 独立成模块以便脱离 React 单测。
 */

import type { TranscriptEventInput } from '@voltojs/sdk/sse';

const cache = new Map<string, TranscriptEventInput[]>();

export function getCachedSubagentEvents(
  childSessionId: string,
): TranscriptEventInput[] | undefined {
  return cache.get(childSessionId);
}

export function setCachedSubagentEvents(
  childSessionId: string,
  events: TranscriptEventInput[],
): void {
  cache.set(childSessionId, events);
}

export function clearSubagentCache(): void {
  cache.clear();
}
