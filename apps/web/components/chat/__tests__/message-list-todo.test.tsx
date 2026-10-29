import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from '../MessageList';

// jsdom has no layout, so the list's scrollIntoView is missing; the real
// browser has it. Stub the minimum the component calls.
Element.prototype.scrollIntoView ??= () => {};

describe('MessageList todo entries', () => {
  it('renders a todo row from a feed entry', () => {
    render(
      <MessageList
        entries={[
          {
            kind: 'todo',
            key: '1:100:completed:a',
            time: 100,
            transition: { kind: 'completed', content: '写测试' },
          },
        ]}
      />,
    );
    expect(screen.getByText(/完成/)).toBeInTheDocument();
    expect(screen.getByText(/写测试/)).toBeInTheDocument();
  });
});
