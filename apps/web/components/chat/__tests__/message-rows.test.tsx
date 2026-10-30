import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageList } from '../MessageList';
import type { ChatEntry } from '@/lib/projection';
import type { ConversationMessage } from '@volto/sdk/sse';

// jsdom has no layout; the list scrolls its bottom anchor into view.
Element.prototype.scrollIntoView ??= () => {};

const assistant = (
  id: string,
  blocks: ConversationMessage['blocks'],
  content = '',
): ChatEntry => ({
  kind: 'message',
  message: { id, role: 'assistant', blocks, content, timestamp: 1 },
});

const tool = (id: string, command: string): ConversationMessage['blocks'][number] => ({
  type: 'tool_call',
  call: { id, name: 'bash', args: { command }, result: 'ok', durationMs: 5 },
});
const text = (t: string): ConversationMessage['blocks'][number] => ({ type: 'text', text: t });
const reasoning = (t: string): ConversationMessage['blocks'][number] => ({
  type: 'reasoning',
  text: t,
});

/** 思考 - 工具 - 正文 - 工具 - 思考 - 正文 */
const turn = [
  assistant('1:1', [reasoning('第一段思考'), tool('t1', 'pnpm test'), text('第一段正文')], '第一段正文'),
  assistant('1:2', [tool('t2', 'pnpm build'), reasoning('第二段思考'), text('结尾正文')], '第一段正文结尾正文'),
];

describe('concise density', () => {
  it('keeps every answer text visible and folds the execution between them', () => {
    render(<MessageList entries={turn} density="concise" />);
    expect(screen.getByText('第一段正文')).toBeInTheDocument();
    expect(screen.getByText('结尾正文')).toBeInTheDocument();
    // Two stretches of execution, neither leaking its rows while folded.
    expect(screen.getAllByTestId('activity-group')).toHaveLength(2);
    expect(screen.queryByText('pnpm test')).toBeNull();
    expect(screen.queryByText('第一段思考')).toBeNull();
  });

  it('shows the folded steps on demand', () => {
    render(<MessageList entries={turn} density="concise" />);
    fireEvent.click(screen.getAllByText(/已执行 1 步/)[0]!);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });

  it('never leaks a failure body outside the fold', () => {
    render(
      <MessageList
        density="concise"
        entries={[
          assistant('2:1', [
            {
              type: 'tool_call',
              call: { id: 't9', name: 'bash', args: { command: 'false' }, result: 'boom: failed', isError: true },
            },
            {
              type: 'tool_call',
              call: { id: 't8', name: 'bash', args: { command: 'ls' }, result: 'ok' },
            },
          ]),
        ]}
      />,
    );
    expect(screen.getByText(/1 步失败/)).toBeInTheDocument();
    expect(screen.queryByText(/boom: failed/)).toBeNull();
  });
});

describe('detailed density', () => {
  it('lays the same rows out flat between the answer texts', () => {
    render(<MessageList entries={turn} density="detailed" />);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('pnpm build')).toBeInTheDocument();
    expect(screen.getByText('第一段思考')).toBeInTheDocument();
    expect(screen.getByText('第一段正文')).toBeInTheDocument();
  });
});

describe('message footer', () => {
  it('appears once per turn, on the row holding its tail', () => {
    const { container } = render(<MessageList entries={turn} density="concise" />);
    // Two steps of one turn → a single footer, however many rows it spans.
    expect(container.querySelectorAll('[aria-label="复制"]')).toHaveLength(1);
  });
});
