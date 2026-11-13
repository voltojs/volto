/**
 * 每轮用量卡片的纯派生（spec 2026-09-26 §3.5）。无 React、无 IO：数字语义
 * 全部来自 TurnUsage，组件只负责画。命中率的分母是 prompt 总量，不是
 * totalTokens —— total 含 output，拿它做分母会系统性低估缓存命中。
 *
 * 与 context-meter-model.ts 同一分层：纯函数 + 独立测试，组件不内联算术。
 */
import type { RouteSource, TurnUsage } from '@voltojs/sdk/sse';
import type { CatalogProvider, Provider } from '@/lib/config-api';
import { providerModels } from '@/stores/config-store';

/** prompt 总量 = 未缓存输入 + 缓存读取 + 缓存写入（adapter 归一化后的恒等式）。 */
export function promptTokens(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 缓存命中率 0..1；prompt 为 0 时无意义 → null（显示为「—」，不显示 0%）。 */
export function cacheHitRate(usage: TurnUsage): number | null {
  if (usage.cacheReporting === 'not-reported' || usage.cacheReporting === 'unsupported') {
    return null;
  }
  const total = promptTokens(usage);
  if (total <= 0) return null;
  return usage.cacheReadTokens / total;
}

/** Human-readable cache value; null means the protocol never reports it. */
export function cacheHitLabel(
  usage: TurnUsage,
  t: (key: string) => string,
): string {
  if (usage.cacheReporting === 'unsupported') return t('usage.cacheUnsupported');
  if (usage.cacheReporting === 'not-reported') return t('usage.cacheUnreported');
  return formatCacheHitRate(cacheHitRate(usage));
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

/**
 * 'provider/model' built from display names, ids only as the fallback.
 *
 * The transcript records wire ids (`RouteSource`), which mean nothing to a
 * user — so each side resolves against config when possible: the provider's
 * own name, then the model's display name (via `providerModels`, which
 * itself falls back to the code). Anything config no longer knows (a
 * deleted provider, a stale model) degrades to its raw id rather than
 * disappearing: the row still says which route ran. Empty/absent config
 * keeps the previous id-only behaviour.
 */
export function formatRoute(
  source: RouteSource | undefined,
  providers: readonly Provider[] = [],
  catalogProviders: readonly CatalogProvider[] = [],
): string | null {
  if (source === undefined) return null;

  const provider =
    source.providerId !== undefined
      ? providers.find((p) => p.id === source.providerId)
      : undefined;
  const model =
    provider !== undefined
      ? providerModels(provider, catalogProviders).find(
          (m) => m.id === source.modelId,
        )
      : undefined;
  const modelLabel = model?.name ?? source.modelId;

  if (source.providerId === undefined) return modelLabel;
  return `${provider?.name ?? source.providerId}/${modelLabel}`;
}
