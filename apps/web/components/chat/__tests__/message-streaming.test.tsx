/**
 * Agent-bubble streaming affordances:
 * - the reasoning panel is collapsed by default, including mid-stream;
 * - no caret affordances live in the bubble — the bottom wave indicator
 *   owns loading for the whole round;
 * - block groups stack tightly (no doubled paddings/margins).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageBubble } from '../MessageBubble';
import type {
  ConversationMessage,
  ConversationToolCall,
} from '@volto/sdk/sse';

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

function assistant(
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

describe('reasoning panel default state', () => {
  it('keeps the thinking panel collapsed on a closed message', () => {
    render(
      <MessageBubble
        message={assistant({
          blocks: [{ type: 'reasoning', text: 'step by step' }],
          content: '',
        })}
      />,
    );
    expect(screen.queryByText('step by step')).toBeNull();
  });

  it('keeps it collapsed while the reasoning is still streaming', () => {
    render(
      <MessageBubble
        message={assistant({
          blocks: [{ type: 'reasoning', text: 'mid-flight thought' }],
          content: '',
          isStreaming: true,
        })}
      />,
    );
    expect(screen.queryByText('mid-flight thought')).toBeNull();
  });

  it('opens the panel on demand', async () => {
    const user = userEvent.setup();
    render(
      <MessageBubble
        message={assistant({
          blocks: [{ type: 'reasoning', text: 'revealed' }],
          content: '',
        })}
      />,
    );
    await user.click(screen.getByText('思考过程'));
    expect(await screen.findByText('revealed')).toBeInTheDocument();
  });
});

describe('no caret affordances (the unified wave indicator owns loading)', () => {
  it('renders no caret after a trailing tool card while the round streams', () => {
    const { container } = render(
      <MessageBubble
        message={assistant({
          blocks: [{ type: 'tool_call', call: DONE_TOOL }],
          content: '',
          isStreaming: true,
        })}
      />,
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
  });

  it('renders no caret on a streaming text tail, only the text', () => {
    const { container } = render(
      <MessageBubble message={assistant({ isStreaming: true })} />,
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('renders no caret for a still-empty streaming bubble', () => {
    const { container } = render(
      <MessageBubble
        message={assistant({ blocks: [], content: '', isStreaming: true })}
      />,
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
  });

  it('shows no caret once the round closes on a tool card', () => {
    const { container } = render(
      <MessageBubble
        message={assistant({
          blocks: [{ type: 'tool_call', call: DONE_TOOL }],
          content: '',
        })}
      />,
    );
    expect(container.querySelector('.caret-blink')).toBeNull();
  });
});

describe('block spacing stays compact', () => {
  it('drops the stacked paddings and margins around every group', () => {
    const { container } = render(
      <MessageBubble
        message={assistant({
          blocks: [
            { type: 'reasoning', text: 'think' },
            { type: 'tool_call', call: DONE_TOOL },
          ],
          content: '',
        })}
      />,
    );

    // Message groups: 8px apart, not py-2 + py-2 stacking to 16px.
    const root = container.firstElementChild!;
    expect(root.className).toContain('py-1');
    expect(root.className).not.toContain('py-2');

    // Block-to-block inside one message keeps the roomier 8px so the groups
    // read as one unit — only the doubled outer paddings were tightened.
    const stack = container.querySelector('div[class*="space-y-"]')!;
    expect(stack.className).toContain('space-y-2');
    expect(stack.className).not.toContain('space-y-1');

    // The reasoning panel carries no outer margin of its own and a slimmer
    // inner padding.
    const reasoning = container.querySelector('[data-slot="collapsible"]')!;
    expect(reasoning.className).not.toContain('my-2');
    expect(reasoning.className).toContain('py-1.5');
    expect(reasoning.className).not.toContain('py-2');
  });
});
