/**
 * SessionStatsChip: always-visible round/step/TPS summary, hover panel with
 * model time, tool time, average TTFT and output speed (reference layout).
 * Base UI Popover under jsdom needs the pointer-capture shims.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionStatsChip } from '../SessionStatsChip';
import type { SessionStats } from '@/lib/session-stats-model';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const GOLD: SessionStats = {
  turns: 11,
  steps: 897,
  modelMs: 3_664_000,
  toolMs: 2_224_000,
  avgTtftMs: 1300,
  outputTokens: 750_000,
  tps: 204.7,
};

function setup(stats: SessionStats = GOLD) {
  render(<SessionStatsChip stats={stats} />);
  return userEvent.setup({ pointerEventsCheck: 0 });
}

describe('SessionStatsChip', () => {
  it('summarises rounds, steps and output speed in the always-on bar', () => {
    setup();
    expect(screen.getByText('11 轮 897 步 · 205 tok/s')).toBeInTheDocument();
  });

  it('drops the speed segment when no model time exists yet', () => {
    setup({ ...GOLD, tps: null, turns: 0, steps: 0 });
    expect(screen.getByText('0 轮 0 步')).toBeInTheDocument();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
  });

  it('opens the panel with the four reference rows', async () => {
    const user = setup();

    await user.click(screen.getByRole('button', { name: '会话统计' }));

    expect(await screen.findByText('模型用时')).toBeInTheDocument();
    expect(screen.getByText('61分4秒')).toBeInTheDocument();
    expect(screen.getByText('工具调用用时')).toBeInTheDocument();
    expect(screen.getByText('37分4秒')).toBeInTheDocument();
    expect(screen.getByText('首 token 平均（TTFT）')).toBeInTheDocument();
    expect(screen.getByText('1.3秒')).toBeInTheDocument();
    expect(screen.getByText('输出速度（TPS）')).toBeInTheDocument();
    expect(screen.getByText('205 tok/s')).toBeInTheDocument();
  });

  it('shows an em dash for metrics that have nothing to average yet', async () => {
    const user = setup({ ...GOLD, avgTtftMs: null, tps: null });

    await user.click(screen.getByRole('button', { name: '会话统计' }));

    expect(await screen.findByText('首 token 平均（TTFT）')).toBeInTheDocument();
    const dashes = screen.getAllByText('—');
    expect(dashes).toHaveLength(2);
  });
});
