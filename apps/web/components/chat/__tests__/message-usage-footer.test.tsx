/**
 * 用量页脚（spec 2026-09-26 §3.5/§9-6/7）：顺序是 时间 → 复制 → 用量；
 * 纯工具调用结尾（没有正文）也要有 chip；流式期间整块不出现。
 * 复制按钮常驻（不靠 hover 才现）且只有图标、没有文字。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** The footer's copy button: icon-only, labelled, always visible. */
function copyButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="复制"]');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe('MessageBubble usage footer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the chip after the copy button, keeping the timestamp first', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage({ turnUsage: TURN_USAGE })} />,
    );

    const footer = container.querySelector('.group > div.mt-1')!;
    const timestamp = footer.querySelector('span')!;
    const button = copyButton(container);

    expect(timestamp.textContent?.trim()).toBe(timeLabel);
    // 时间 → 复制 → 用量：按文档顺序核对，而不是靠文字内容。
    expect(
      timestamp.compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      button.compareDocumentPosition(
        footer.querySelector('button[aria-label="本轮用量"]')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('用量 23.9M tok')).toBeInTheDocument();
  });

  it('keeps the copy button visible without hover and strips its label text', () => {
    const { container } = render(
      <MessageBubble message={assistantMessage({ turnUsage: TURN_USAGE })} />,
    );

    const button = copyButton(container);
    expect(button.textContent).toBe('');
    // 常驻：不再用 opacity-0 + group-hover 才显形。
    expect(button.className).not.toContain('opacity-0');
  });

  it('swaps the icon for a checkmark after copying', async () => {
    // userEvent.setup() installs its own clipboard mock, so the spy has to
    // land after it to be the one the button actually writes to.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const { container } = render(<MessageBubble message={assistantMessage()} />);
    await user.click(copyButton(container));

    expect(writeText).toHaveBeenCalledWith('done');
    expect(container.querySelector('button[aria-label="复制"] .lucide-check')).not.toBeNull();
  });

  it('still shows the chip when the round ends on a tool call with no prose', () => {
    const toolOnly = assistantMessage({
      blocks: [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', args: {} } }],
      content: '',
      turnUsage: TURN_USAGE,
    });
    const { container } = render(<MessageBubble message={toolOnly} />);

    expect(screen.getByText('用量 23.9M tok')).toBeInTheDocument();
    // 没有正文就没有可复制的东西：按钮不出现，但页脚仍在。
    expect(container.querySelector('button[aria-label="复制"]')).toBeNull();
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
    const { container } = render(<MessageBubble message={assistantMessage()} />);
    expect(screen.queryByText('用量 23.9M tok')).toBeNull();
    expect(copyButton(container)).not.toBeNull();
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
