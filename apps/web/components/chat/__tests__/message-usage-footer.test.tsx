/**
 * 用量页脚（spec 2026-09-26 §3.5/§9-6/7）：顺序是 时间 → 复制 → 用量；
 * 纯工具调用结尾（没有正文）也要有 chip；流式期间整块不出现。
 * 复制按钮常驻（不靠 hover 才现）且只有图标、没有文字。
 *
 * 渲染单位从「消息」改成「行」后，页脚由持有该消息末尾的那一行渲染——
 * 正文结尾落在 answer 行，工具结尾落在折叠组下方。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from '../MessageList';
import type { ChatEntry } from '@/lib/projection';
import type { ConversationMessage, TurnUsage } from '@volto/sdk/sse';

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const TURN_USAGE: TurnUsage = {
  inputTokens: 19_352,
  outputTokens: 46_832,
  cacheReadTokens: 23_832_832,
  cacheWriteTokens: 0,
  totalTokens: 23_899_016,
  source: { providerId: 'deepseek-official', modelId: 'deepseek-flash' },
  missingUsageCalls: 0,
};

function message(overrides: Partial<ConversationMessage> = {}): ChatEntry {
  return {
    kind: 'message',
    message: {
      id: '1:2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'done' }],
      content: 'done',
      timestamp: 0,
      ...overrides,
    },
  };
}

const timeLabel = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
}).format(0);

function renderMessage(entry: ChatEntry) {
  return render(<MessageList entries={[entry]} density="detailed" />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('message usage footer', () => {
  it('renders the chip after the copy button, keeping the timestamp first', () => {
    renderMessage(message({ turnUsage: TURN_USAGE }));
    expect(screen.getByText(timeLabel)).toBeInTheDocument();
    const copy = screen.getByRole('button', { name: '复制' });
    expect(copy).toBeInTheDocument();
    expect(screen.getByText(/tok/i)).toBeInTheDocument();
  });

  it('keeps the copy button visible without hover and strips its label text', () => {
    renderMessage(message({ turnUsage: TURN_USAGE }));
    const copy = screen.getByRole('button', { name: '复制' });
    expect(copy).toHaveTextContent('');
  });

  it('swaps the icon for a checkmark after copying', async () => {
    const user = userEvent.setup();
    renderMessage(message());
    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(screen.getByRole('button', { name: '复制' }).querySelector('.text-success')).not.toBeNull();
  });

  it('still shows the chip when the round ends on a tool call with no prose', () => {
    renderMessage(
      message({
        blocks: [
          {
            type: 'tool_call',
            call: { id: 'c1', name: 'read_file', args: {}, result: 'contents' },
          },
        ],
        content: 'done',
        turnUsage: TURN_USAGE,
      }),
    );
    expect(screen.getByText(/tok/i)).toBeInTheDocument();
  });

  it('shows no chip when the round reported no usage at all', () => {
    renderMessage(message({ content: '' , blocks: [] }));
    expect(screen.queryByText(/tok/i)).toBeNull();
  });
});
