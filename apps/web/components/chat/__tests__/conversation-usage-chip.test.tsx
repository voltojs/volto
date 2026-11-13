/**
 * ConversationUsageChip: always-visible whole-conversation token summary,
 * hover panel with the same breakdown rows as the per-round chip.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationUsageChip } from '../ConversationUsageChip';
import { formatCompactTokens } from '@/lib/context-meter-model';
import { cacheHitRate, formatCacheHitRate } from '@/lib/turn-usage-model';
import { conversationUsage } from '@/lib/session-stats-model';
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
  missingUsageCalls: 0,
};

function setup(usage: TurnUsage = GOLD) {
  render(<ConversationUsageChip usage={usage} />);
  return userEvent.setup({ pointerEventsCheck: 0 });
}

describe('ConversationUsageChip', () => {
  it('summarises total tokens and cache hit in the always-on bar', () => {
    setup();
    const expected = `${formatCompactTokens(GOLD.totalTokens)} tok · 缓存命中 ${formatCacheHitRate(cacheHitRate(GOLD))}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('opens the panel with the whole-conversation breakdown', async () => {
    const user = setup();

    await user.click(screen.getByRole('button', { name: '整个对话用量' }));

    expect(await screen.findByText('整个对话用量')).toBeInTheDocument();
    expect(screen.getByText('23,899,016 tok')).toBeInTheDocument();
    expect(screen.getByText('缓存命中')).toBeInTheDocument();
    expect(screen.getByText('99.9%')).toBeInTheDocument();
    expect(screen.getByText('未缓存输入')).toBeInTheDocument();
    expect(screen.getByText('19,352 tok')).toBeInTheDocument();
    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(screen.getByText('46,832 tok')).toBeInTheDocument();
    expect(screen.queryByText(/未返回用量/)).toBeNull();
  });

  it('declares calls that reported nothing instead of counting them as zero', async () => {
    const user = setup({ ...GOLD, missingUsageCalls: 3 });

    await user.click(screen.getByRole('button', { name: '整个对话用量' }));

    expect(
      await screen.findByText('全部对话另有 3 次模型调用未返回用量，未计入'),
    ).toBeInTheDocument();
  });

  it('keeps header breathing room around a long total', async () => {
    const user = setup({ ...GOLD, totalTokens: 1_234_567_890 });

    await user.click(screen.getByRole('button', { name: '整个对话用量' }));

    const title = await screen.findByText('整个对话用量');
    const header = title.closest('div')!;
    expect(header.className).toContain('gap-3');
    expect(header.className).toContain('pb-2');

    // Long value: stays on one line and never gets squeezed by the title.
    const value = screen.getByText('1,234,567,890 tok');
    expect(value.className).toContain('whitespace-nowrap');
    expect(value.className).toContain('shrink-0');
  });

  it('folds trajectory rows into the bar summary (integration path)', () => {
    const rows = [
      {
        index: 1,
        id: 'a1',
        kind: 'assistant',
        turn: 1,
        step: 1,
        summary: '',
        startedAt: 0,
        metrics: {
          durationMs: 10,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 85,
            cacheWriteTokens: 0,
          },
        },
      },
    ];
    const usage = conversationUsage(rows as never);
    render(<ConversationUsageChip usage={usage} />);
    expect(
      screen.getByText(
        `${formatCompactTokens(100)} tok · 缓存命中 ${formatCacheHitRate(cacheHitRate(usage))}`,
      ),
    ).toBeInTheDocument();
  });
});
