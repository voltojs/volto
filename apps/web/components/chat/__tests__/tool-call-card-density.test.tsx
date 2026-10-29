import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

describe('ToolCallCard failure timing', () => {
  it('opens when a failure lands after the card was already mounted', () => {
    const running: ConversationToolCall = {
      id: '3',
      name: 'bash',
      args: { command: 'false' },
      // No result yet: mounted while the tool was still running.
    };
    const { rerender } = render(<ToolCallCard call={running} />);
    expect(screen.queryByText(/boom/)).toBeNull();

    rerender(
      <ToolCallCard
        call={{ ...running, result: 'boom: command failed', isError: true }}
      />,
    );
    expect(screen.getByText(/boom: command failed/)).toBeInTheDocument();
  });

  it('shows the tool name next to the label in compact mode', () => {
    render(
      <ToolCallCard
        call={{ id: '4', name: 'edit_file', args: { path: 'src/a.ts' }, result: 'ok' }}
        compact
        label="src/a.ts"
      />,
    );
    expect(screen.getByText('edit_file')).toBeInTheDocument();
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
  });

  it('keeps an inline error summary visible after the user collapses it', () => {
    const { container } = render(<ToolCallCard call={failed} compact label="false" />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    expect(screen.getByTestId('tool-error-summary')).toHaveTextContent(/boom: command failed/);
  });
});
