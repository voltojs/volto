/**
 * 用量卡片的数字语义（spec 2026-09-26 §3.5/§4）：金样本就是需求方给的截图，
 * 每一条断言都对准截图上的一个字面量。
 */
import { describe, it, expect } from 'vitest';
import {
  cacheHitLabel,
  cacheHitRate,
  formatCacheHitRate,
  formatExactTokens,
  formatRoute,
  promptTokens,
} from '@/lib/turn-usage-model';
import type { Provider } from '@/lib/config-api';
import type { TurnUsage } from '@volto/sdk/sse';

const GOLD: TurnUsage = {
  inputTokens: 19_352,
  outputTokens: 46_832,
  cacheReadTokens: 23_832_832,
  cacheWriteTokens: 0,
  totalTokens: 23_899_016,
  source: { providerId: 'deepseek-official', modelId: 'deepseek-flash' },
  missingUsageCalls: 0,
};

const KNOWN_PROVIDERS: Provider[] = [
  {
    kind: 'custom',
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    baseURL: null,
    apiKeyMasked: null,
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', code: 'deepseek-flash' },
    ],
  },
];

describe('turn usage formatting', () => {
  it('reproduces the screenshot numbers exactly', () => {
    expect(formatExactTokens(GOLD.totalTokens)).toBe('23,899,016');
    expect(formatExactTokens(GOLD.inputTokens)).toBe('19,352');
    expect(formatExactTokens(GOLD.cacheReadTokens)).toBe('23,832,832');
    expect(formatExactTokens(GOLD.cacheWriteTokens)).toBe('0');
    expect(formatExactTokens(GOLD.outputTokens)).toBe('46,832');
    expect(formatCacheHitRate(cacheHitRate(GOLD))).toBe('99.9%');
    expect(formatRoute(GOLD.source)).toBe('deepseek-official/deepseek-flash');
  });

  it('counts the prompt as uncached input + cache read + cache write', () => {
    expect(promptTokens(GOLD)).toBe(23_852_184);
  });

  it('keeps cache writes in the denominator, so a half-cached prompt reads 50.0%', () => {
    // GOLD 的 cacheWriteTokens 是 0，删掉 promptTokens 里的 + cacheWriteTokens 也不会变红；
    // 这条用例把 cacheWrite 单独撑起来：分母 1000+1000=2000，命中率 1000/2000=50.0%。
    // 一旦丢掉 cacheWrite 项，分母退化成 1000，命中率会被抬成 100.0%。
    const halfCached: TurnUsage = {
      ...GOLD,
      inputTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 1_000,
    };
    expect(promptTokens(halfCached)).toBe(2_000);
    expect(formatCacheHitRate(cacheHitRate(halfCached))).toBe('50.0%');
  });

  it('has no hit rate to show when the prompt is empty, and says so', () => {
    const zeroPrompt: TurnUsage = {
      ...GOLD,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(cacheHitRate(zeroPrompt)).toBeNull();
    expect(formatCacheHitRate(null)).toBe('—');
  });

  it('reports unknown cache state instead of a misleading zero', () => {
    const notReported: TurnUsage = { ...GOLD, cacheReporting: 'not-reported' };
    expect(cacheHitRate(notReported)).toBeNull();
    const t = (key: string) => key;
    expect(cacheHitLabel(notReported, t)).toBe('usage.cacheUnreported');
    expect(cacheHitLabel({ ...GOLD, cacheReporting: 'unsupported' }, t))
      .toBe('usage.cacheUnsupported');
  });

  it('renders a fully cached prompt as 100.0%', () => {
    const fullyCached: TurnUsage = {
      ...GOLD,
      inputTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
    };
    expect(formatCacheHitRate(cacheHitRate(fullyCached))).toBe('100.0%');
  });

  it('degrades to the bare model id when the transcript has no providerId', () => {
    expect(formatRoute({ modelId: 'deepseek-flash' })).toBe('deepseek-flash');
  });

  it('prefers configured display names over raw wire ids', () => {
    expect(formatRoute(GOLD.source, KNOWN_PROVIDERS)).toBe(
      'DeepSeek 官方/DeepSeek Flash',
    );
  });

  it('falls back to ids when the route names a provider config no longer knows', () => {
    expect(formatRoute(GOLD.source, [])).toBe(
      'deepseek-official/deepseek-flash',
    );
  });

  it('falls back to the model id when only the provider display name is known', () => {
    const providerWithoutModel: Provider[] = [
      {
        kind: 'custom',
        id: 'deepseek-official',
        name: 'DeepSeek 官方',
        baseURL: null,
        apiKeyMasked: null,
        models: [],
      },
    ];
    expect(formatRoute(GOLD.source, providerWithoutModel)).toBe(
      'DeepSeek 官方/deepseek-flash',
    );
  });

  it('returns null when the round recorded no source at all', () => {
    expect(formatRoute(undefined)).toBeNull();
  });
});
