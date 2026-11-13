import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCallCard, toolCallCardComparator } from '../ToolCallCard';
import type { ConversationToolCall } from '@voltojs/sdk/sse';

const failed: ConversationToolCall = {
  id: '1',
  name: 'bash',
  args: { command: 'false' },
  result: 'boom: command failed',
  isError: true,
  durationMs: 12,
};

describe('ToolCallCard rows', () => {
  it('shows the error body without a click', () => {
    render(<ToolCallCard call={failed} label="false" />);
    expect(screen.getByText(/boom: command failed/)).toBeInTheDocument();
  });

  it('keeps args hidden until expanded', () => {
    render(
      <ToolCallCard
        call={{ id: '2', name: 'bash', args: { command: 'ls' }, result: 'a' }}
        label="ls"
      />,
    );
    expect(screen.getByText('ls')).toBeInTheDocument();
    expect(screen.queryByText(/"command"/)).toBeNull();
  });

  it('shows the tool name next to the summary', () => {
    render(
      <ToolCallCard
        call={{ id: '4', name: 'edit_file', args: { path: 'src/a.ts' }, result: 'ok' }}
        label="src/a.ts"
      />,
    );
    expect(screen.getByText('edit_file')).toBeInTheDocument();
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
  });

  it('collapses the failure body too, leaving only the red row', () => {
    const { container } = render(<ToolCallCard call={failed} label="false" />);
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    // Nothing survives outside the fold: the failure is still legible from the
    // red tool name and the red status icon on the row.
    expect(screen.queryByText(/boom: command failed/)).toBeNull();
    expect(screen.getByText('bash')).toHaveClass('text-destructive');
  });

  it('re-renders when the summary changes', () => {
    const a = { call: failed, label: 'false' } as const;
    const b = { call: failed, label: 'other' } as const;
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

    rerender(<ToolCallCard call={{ ...running, result: 'boom: command failed', isError: true }} />);
    expect(screen.getByText(/boom: command failed/)).toBeInTheDocument();
  });
});
