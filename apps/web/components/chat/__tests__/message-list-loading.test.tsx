/**
 * The feed's unified loading affordance: a wave indicator pinned at the
 * bottom of the message list for the whole round (send → first token →
 * tools → prose), replacing the per-bubble caret affordances entirely.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MessageList } from '../MessageList';
import type { ChatEntry } from '@/lib/projection';

Element.prototype.scrollIntoView ??= () => {};

const ENTRIES: ChatEntry[] = [
  {
    kind: 'message',
    message: {
      id: '1:1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      content: 'hello',
      timestamp: 0,
    },
  },
];

describe('MessageList wave loading', () => {
  it('shows the wave after the last entry while the round generates', () => {
    const { container } = render(
      <MessageList entries={ENTRIES} isGenerating />,
    );

    expect(screen.getByTestId('wave-loading')).toBeInTheDocument();
    // Bottom of the feed: after every entry, before the scroll anchor.
    const html = container.innerHTML;
    expect(html.indexOf('wave-loading')).toBeGreaterThan(
      html.indexOf('hello'),
    );
  });

  it('hides the wave once the round ends', () => {
    render(<MessageList entries={ENTRIES} isGenerating={false} />);
    expect(screen.queryByTestId('wave-loading')).toBeNull();
  });

  it('defines the wave animation in the global stylesheet', () => {
    const css = readFileSync(
      path.resolve(process.cwd(), 'app/globals.css'),
      'utf8',
    );
    expect(css).toMatch(/\.wave-dot\s*\{/);
    expect(css).toMatch(/@keyframes wave-bounce/);
  });
});
