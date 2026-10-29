import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallCard, toolCallCardComparator } from '../ToolCallCard';
import type { ConversationToolCall } from '@volto/sdk/sse';

const failed: ConversationToolCall = {
  id: '1',
  name: 'bash',
  args: { command: 'false' },
  result: 'boom: command failed',
  isError: true,
  durationMs: 12,
};

describe('ToolCallCard density', () => {
  it('shows the error body without a click, in compact mode too', () => {
    render(<ToolCallCard call={failed} compact label="false" />);
    expect(screen.getByText(/boom: command failed/)).toBeInTheDocument();
  });

  it('keeps args hidden until expanded in compact mode', () => {
    render(
      <ToolCallCard
        call={{ id: '2', name: 'bash', args: { command: 'ls' }, result: 'a' }}
        compact
        label="ls"
      />,
    );
    expect(screen.getByText('ls')).toBeInTheDocument();
    expect(screen.queryByText(/"command"/)).toBeNull();
  });

  it('re-renders when compact changes', () => {
    const a = { call: failed, compact: true, label: 'false' } as const;
    const b = { call: failed, compact: false, label: 'false' } as const;
    expect(toolCallCardComparator(a, b)).toBe(false);
  });
});
