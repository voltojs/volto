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
  { type: 'reasoning', text: '内部推理' },
  {
    type: 'tool_call',
    call: { id: 't1', name: 'bash', args: { command: 'pnpm test' }, result: 'ok', durationMs: 5 },
  },
  { type: 'text', text: '跑完了' },
]);

describe('MessageBubble segments', () => {
  it('wraps activity blocks in their own container', () => {
    const { container } = render(<MessageBubble message={withOps} density="detailed" />);
    expect(container.querySelector('[data-testid="activity-rail"]')).not.toBeNull();
    expect(screen.getByText('我先看一下')).toBeInTheDocument();
  });

  it('hides reasoning in concise mode but keeps one line per tool', () => {
    render(<MessageBubble message={withOps} density="concise" />);
    expect(screen.queryByText('内部推理')).toBeNull();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });

  it('renders nothing for a reasoning-only message in concise mode', () => {
    const { container } = render(
      <MessageBubble message={message([{ type: 'reasoning', text: '只有推理' }])} density="concise" />,
    );
    expect(container.querySelector('[data-testid="activity-rail"]')).toBeNull();
    expect(screen.queryByText('只有推理')).toBeNull();
  });

  it('expands a detailed card to show the call arguments', () => {
    render(<MessageBubble message={withOps} density="detailed" />);
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
  });

  it('expands a concise one-liner into the same card', () => {
    render(<MessageBubble message={withOps} density="concise" />);
    fireEvent.click(screen.getByText('pnpm test'));
    expect(screen.getByText(/"command": "pnpm test"/)).toBeInTheDocument();
  });

  it('does not drop the tail text of a streaming message while a tool block is pending', () => {
    render(<MessageBubble message={{ ...withOps, isStreaming: true }} density="concise" />);
    expect(screen.getByText('跑完了')).toBeInTheDocument();
  });
});
