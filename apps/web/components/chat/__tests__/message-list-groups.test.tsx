import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from '../MessageList';
import type { ChatEntry } from '@/lib/projection';

// jsdom has no layout, so the list's scrollIntoView is missing.
Element.prototype.scrollIntoView ??= () => {};

const step = (id: string, command: string): ChatEntry => ({
  kind: 'message',
  message: {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_call',
        call: { id: `t-${id}`, name: 'bash', args: { command }, result: 'ok', durationMs: 5 },
      },
    ],
    content: '',
    timestamp: 1,
  },
});

describe('MessageList execution grouping', () => {
  it('folds a whole turn of tool steps into one control in concise density', () => {
    const { container } = render(
      <MessageList entries={[step('m1', 'pnpm test'), step('m2', 'pnpm build'), step('m3', 'git status')]} density="concise" />,
    );
    expect(container.querySelectorAll('[data-testid="activity-group"]')).toHaveLength(1);
    expect(screen.getByText('已执行 3 步')).toBeInTheDocument();
  });

  it('keeps each step as its own row in detailed density', () => {
    const { container } = render(
      <MessageList entries={[step('m1', 'pnpm test'), step('m2', 'pnpm build')]} density="detailed" />,
    );
    expect(container.querySelectorAll('[data-testid="activity-rail"]')).toHaveLength(1);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('pnpm build')).toBeInTheDocument();
  });
});
