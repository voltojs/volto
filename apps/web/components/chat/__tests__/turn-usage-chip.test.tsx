/**
 * TurnUsageChip：常驻 chip + 展开的七行明细（spec 2026-09-26 §4）。
 * Base UI 的 Popover 在 jsdom 下需要指针捕获/滚动补丁（与
 * model-settings-picker.test.tsx 同型）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TurnUsageChip } from '../TurnUsageChip';
import { useConfigStore } from '@/stores/config-store';
import type { Provider } from '@/lib/config-api';
import type { TurnUsage } from '@voltojs/sdk/sse';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const GOLD: TurnUsage = {
  inputTokens: 19_352,
  outputTokens: 46_832,
  cacheReadTokens: 23_832_832,
  cacheWriteTokens: 0,
  totalTokens: 23_899_016,
  source: { providerId: 'deepseek-official', modelId: 'deepseek-flash' },
  missingUsageCalls: 0,
};

const KNOWN_PROVIDER: Provider = {
  kind: 'custom',
  id: 'deepseek-official',
  name: 'DeepSeek 官方',
  baseURL: null,
  apiKeyMasked: null,
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', code: 'deepseek-flash' },
  ],
};

function setup(usage: TurnUsage) {
  render(<TurnUsageChip usage={usage} />);
  return userEvent.setup({ pointerEventsCheck: 0 });
}

describe('TurnUsageChip', () => {
  it('summarises the round in the always-visible chip', () => {
    setup(GOLD);
    expect(screen.getByText('用量 23.9M tok')).toBeInTheDocument();
  });

  it('opens the seven-row breakdown with the screenshot labels and numbers', async () => {
    const user = setup(GOLD);

    await user.click(screen.getByRole('button', { name: '本轮用量' }));

    expect(await screen.findByText('本轮用量')).toBeInTheDocument();
    expect(screen.getByText('23,899,016 tok')).toBeInTheDocument();
    expect(screen.getByText('提供方 / 模型')).toBeInTheDocument();
    expect(screen.getByText('deepseek-official/deepseek-flash')).toBeInTheDocument();
    expect(screen.getByText('缓存命中')).toBeInTheDocument();
    expect(screen.getByText('99.9%')).toBeInTheDocument();
    expect(screen.getByText('未缓存输入')).toBeInTheDocument();
    expect(screen.getByText('19,352 tok')).toBeInTheDocument();
    expect(screen.getByText('缓存读取')).toBeInTheDocument();
    expect(screen.getByText('23,832,832 tok')).toBeInTheDocument();
    expect(screen.getByText('缓存写入')).toBeInTheDocument();
    expect(screen.getByText('0 tok')).toBeInTheDocument();
    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(screen.getByText('46,832 tok')).toBeInTheDocument();
    // 全部调用都上报了用量 → 不出现缺口脚注。
    expect(screen.queryByText(/未返回用量/)).toBeNull();
  });

  it('declares calls that reported nothing instead of counting them as zero', async () => {
    const user = setup({ ...GOLD, missingUsageCalls: 1 });

    await user.click(screen.getByRole('button', { name: '本轮用量' }));

    expect(
      await screen.findByText('本轮另有 1 次模型调用未返回用量，未计入'),
    ).toBeInTheDocument();
  });

  it('hides the route row entirely when the transcript recorded no source', async () => {
    const user = setup({ ...GOLD, missingUsageCalls: 0, source: undefined });

    await user.click(screen.getByRole('button', { name: '本轮用量' }));

    await screen.findByText('本轮用量');
    expect(screen.queryByText('提供方 / 模型')).toBeNull();
  });

  afterEach(() => {
    useConfigStore.setState({ providers: [], catalogProviders: [] });
  });

  it('shows provider and model display names, not wire ids, once config knows them', async () => {
    useConfigStore.setState({ providers: [KNOWN_PROVIDER] });
    const user = setup(GOLD);

    await user.click(screen.getByRole('button', { name: '本轮用量' }));

    expect(
      await screen.findByText('DeepSeek 官方/DeepSeek Flash'),
    ).toBeInTheDocument();
    expect(screen.queryByText('deepseek-official/deepseek-flash')).toBeNull();
  });

  it('sizes the panel to its content and keeps values on one line', async () => {
    useConfigStore.setState({ providers: [KNOWN_PROVIDER] });
    const user = setup(GOLD);

    await user.click(screen.getByRole('button', { name: '本轮用量' }));

    // No fixed w-64: the panel grows with its longest row (capped so it
    // cannot burst the viewport).
    const panel = document.querySelector('.min-w-32');
    expect(panel).not.toBeNull();
    expect(panel!.className).not.toContain('w-64');
    expect(panel!.className).toMatch(/max-w-/);

    // A long route (provider name + model name) stays on a single line.
    const route = await screen.findByText('DeepSeek 官方/DeepSeek Flash');
    expect(route.className).toContain('truncate');
  });
});
