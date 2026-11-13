/**
 * Agent feed streaming affordances:
 * - reasoning rows stay closed (preview only), including mid-stream;
 * - no caret affordances live in the feed — the bottom wave indicator owns
 *   loading for the whole round.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from '../MessageList';
import type { ChatEntry } from '@/lib/projection';
import type { ConversationMessage, ConversationToolCall } from '@voltojs/sdk/sse';

// Base UI Collapsible under jsdom needs the pointer-capture shims (same as
// turn-usage-chip.test.tsx).
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const DONE_TOOL: ConversationToolCall = {
  id: 'c1',
  name: 'read_file',
  args: {},
  result: 'contents',
};

function entry(overrides: Partial<ConversationMessage> = {}): ChatEntry {
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

function renderFeed(item: ChatEntry) {
  return render(<MessageList entries={[item]} density="detailed" />);
}

describe('reasoning rows', () => {
  it('shows only the first line of a closed reasoning row', () => {
    renderFeed(
      entry({
        blocks: [
          { type: 'reasoning', text: 'step by step\nsecond line' },
          { type: 'tool_call', call: DONE_TOOL },
        ],
        content: '',
      }),
    );
    expect(screen.getByText('step by step')).toBeInTheDocument();
    expect(screen.queryByText(/second line/)).toBeNull();
  });

  it('keeps the body closed while the reasoning is still streaming', () => {
    renderFeed(
      entry({
        blocks: [
          { type: 'reasoning', text: 'mid-flight thought\nstill typing' },
          { type: 'tool_call', call: DONE_TOOL },
        ],
        content: '',
        isStreaming: true,
      }),
    );
    expect(screen.getByText('mid-flight thought')).toBeInTheDocument();
    expect(screen.queryByText(/still typing/)).toBeNull();
  });

  it('opens the row on demand', async () => {
    const user = userEvent.setup();
    renderFeed(
      entry({
        blocks: [{ type: 'reasoning', text: 'revealed\nand the rest' }],
        content: '',
      }),
    );
    await user.click(screen.getByText('思考'));
    expect(await screen.findByText(/and the rest/)).toBeInTheDocument();
  });
});

describe('no caret affordances (the unified wave indicator owns loading)', () => {
  it('renders no caret after a trailing tool card while the round streams', () => {
    const { container } = renderFeed(
      entry({
        blocks: [{ type: 'tool_call', call: DONE_TOOL }],
        content: '',
        isStreaming: true,
      }),
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
  });

  it('renders no caret on a streaming text tail, only the text', () => {
    const { container } = renderFeed(
      entry({ blocks: [{ type: 'text', text: 'streaming…' }], content: 'streaming…', isStreaming: true }),
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
    expect(screen.getByText('streaming…')).toBeInTheDocument();
  });
});
