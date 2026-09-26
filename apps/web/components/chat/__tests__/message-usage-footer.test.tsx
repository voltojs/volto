/**
 * 用量页脚（spec 2026-09-26 §3.5/§9-6/7）：顺序是 时间 → 复制 → 用量；
 * 纯工具调用结尾（没有正文）也要有 chip；流式期间整块不出现。
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../MessageBubble';
import type { ConversationMessage, TurnUsage } from '@volto/sdk/sse';

const TURN_USAGE: TurnUsage = {
  inputTokens: 19_352,
  outputTokens: 46_832,
  cacheReadTokens: 23_832_832,
  cacheWriteTokens: 0,
  totalTokens: 23_899_016,
  source: { providerId: 'deepseek-official', modelId: 'deepseek-flash' },
  missingUsageCalls: 0,
};

function assistantMessage(
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: '1:2',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'done' }],
    content: 'done',
    timestamp: 0,
    ...overrides,
  };
}

const timeLabel = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
}).format(0);

describe('MessageBubble usage footer', () => {
  it('renders the chip after the copy button, keeping the timestamp first', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage({ turnUsage: TURN_USAGE })} />,
    );

    const footer = container.querySelector('.group > div.mt-1')!;
    const sequence = Array.from(footer.querySelectorAll('span, button')).map((el) =>
      el.textContent?.trim(),
    );

    expect(sequence[0]).toBe(timeLabel);
    expect(sequence[1]).toContain('复制');
    expect(sequence[2]).toBe('用量 23.9M tok');
  });

  it('still shows the chip when the round ends on a tool call with no prose', () => {
    const toolOnly = assistantMessage({
      blocks: [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', args: {} } }],
      content: '',
      turnUsage: TURN_USAGE,
    });
    render(<MessageBubble message={toolOnly} />);

    expect(screen.getByText('用量 23.9M tok')).toBeInTheDocument();
    // 没有正文就没有可复制的东西：按钮不出现，但页脚仍在。
    expect(screen.queryByText('复制')).toBeNull();
  });

  it('hides the whole footer while the round is still streaming', () => {
    render(
      <MessageBubble
        message={assistantMessage({ turnUsage: TURN_USAGE, isStreaming: true })}
      />,
    );
    expect(screen.queryByText('用量 23.9M tok')).toBeNull();
  });

  it('shows no chip when the round reported no usage at all', () => {
    render(<MessageBubble message={assistantMessage()} />);
    expect(screen.queryByText('用量 23.9M tok')).toBeNull();
    expect(screen.getByText('复制')).toBeInTheDocument();
  });

  it('never renders a chip on a user bubble', () => {
    render(
      <MessageBubble
        message={{
          id: '1:u0',
          role: 'user',
          blocks: [{ type: 'text', text: 'hi' }],
          content: 'hi',
          timestamp: 0,
          turnUsage: TURN_USAGE,
        }}
      />,
    );
    expect(screen.queryByText('用量 23.9M tok')).toBeNull();
  });
});
