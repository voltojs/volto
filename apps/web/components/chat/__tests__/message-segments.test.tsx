import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from '../MessageBubble';
import type { ConversationMessage } from '@volto/sdk/sse';

const message = (blocks: ConversationMessage['blocks']): ConversationMessage => ({
  id: 'm1',
  role: 'assistant',
  blocks,
  content: 'answer',
  timestamp: 1,
  isStreaming: false,
});

const withOps = message([
  { type: 'text', text: '我先看一下' },
  { type: 'reasoning', text: '内部推理\n第二行' },
  {
    type: 'tool_call',
    call: { id: 't1', name: 'bash', args: { command: 'pnpm test' }, result: 'ok', durationMs: 5 },
  },
  { type: 'text', text: '跑完了' },
]);

const running = message([
  {
    type: 'tool_call',
    call: { id: 't1b', name: 'bash', args: { command: 'pnpm test' }, result: 'ok', durationMs: 5 },
  },
  {
    type: 'tool_call',
    call: { id: 't2', name: 'bash', args: { command: 'pnpm build' } },
  },
]);

describe('MessageBubble detailed density', () => {
  it('lays every step out flat with its summary visible', () => {
    const { container } = render(<MessageBubble message={withOps} density="detailed" />);
    expect(container.querySelector('[data-testid="activity-rail"]')).not.toBeNull();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.getByText('内部推理')).toBeInTheDocument();
  });

  it('expands a row to show the call arguments', () => {
    render(<MessageBubble message={withOps} density="detailed" />);
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
  });
});

describe('MessageBubble concise density', () => {
  it('folds the whole segment behind one control', () => {
    const { container } = render(<MessageBubble message={withOps} density="concise" />);
    expect(container.querySelector('[data-testid="activity-group"]')).not.toBeNull();
    expect(screen.queryByText('pnpm test')).toBeNull();
    expect(screen.getByText('已执行 1 步')).toBeInTheDocument();
  });

  it('shows the running step in the control label', () => {
    render(<MessageBubble message={running} density="concise" />);
    expect(screen.getByText(/执行中 · bash · pnpm build/)).toBeInTheDocument();
  });

  it('opens on demand to reveal the same rows', () => {
    render(<MessageBubble message={withOps} density="concise" />);
    fireEvent.click(screen.getByText('已执行 1 步'));
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
  });

  it('stays folded on failure but names the failure in the control', () => {
    render(
      <MessageBubble
        message={message([
          {
            type: 'tool_call',
            call: { id: 't4', name: 'bash', args: { command: 'ls' }, result: 'a' },
          },
          {
            type: 'tool_call',
            call: {
              id: 't3',
              name: 'bash',
              args: { command: 'false' },
              result: 'boom: command failed',
              isError: true,
            },
          },
        ])}
        density="concise"
      />,
    );
    expect(screen.getByText(/1 步失败/)).toBeInTheDocument();
    expect(screen.getByTestId('activity-group-failure')).toHaveTextContent(/boom: command failed/);
    // The step rows themselves stay behind the fold.
    expect(screen.queryByText('bash')).toBeNull();
  });

  it('renders a lone reasoning step bare, without a group around it', () => {
    const { container } = render(
      <MessageBubble message={message([{ type: 'reasoning', text: '只有推理' }])} density="concise" />,
    );
    expect(container.querySelector('[data-testid="activity-group"]')).toBeNull();
    expect(container.querySelector('[data-testid="activity-rail"]')).toBeNull();
    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText(/思考 1 段/)).toBeNull();
  });
});

describe('MessageBubble streaming', () => {
  it('does not drop the tail text of a streaming message while a tool block is pending', () => {
    render(<MessageBubble message={{ ...withOps, isStreaming: true }} density="concise" />);
    expect(screen.getByText('跑完了')).toBeInTheDocument();
  });
});
