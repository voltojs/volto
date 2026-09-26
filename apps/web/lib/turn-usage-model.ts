/**
 * 每轮用量卡片的纯派生（spec 2026-09-26 §3.5）。无 React、无 IO：数字语义
 * 全部来自 TurnUsage，组件只负责画。命中率的分母是 prompt 总量，不是
 * totalTokens —— total 含 output，拿它做分母会系统性低估缓存命中。
 *
 * 与 context-meter-model.ts 同一分层：纯函数 + 独立测试，组件不内联算术。
 */
import type { RouteSource, TurnUsage } from '@volto/sdk/sse';

/** prompt 总量 = 未缓存输入 + 缓存读取 + 缓存写入（adapter 归一化后的恒等式）。 */
export function promptTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 缓存命中率 0..1；prompt 为 0 时无意义 → null（显示为「—」，不显示 0%）。 */
export function cacheHitRate(usage: TurnUsage): number | null {
  const total = promptTokens(usage);
  if (total <= 0) return null;
  return usage.cacheReadTokens / total;
}

/** '99.9%'；null → '—'。 */
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}

/** 千分位精确值：'23,899,016'（卡片用精确值；chip 才用紧凑格式）。 */
export function formatExactTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/** 'provider/model'；无 providerId 只给 modelId；都没有 → null（该行不渲染）。 */
export function formatRoute(source: RouteSource | undefined): string | null {
  if (source === undefined) return null;
  return source.providerId !== undefined
    ? `${source.providerId}/${source.modelId}`
    : source.modelId;
}
