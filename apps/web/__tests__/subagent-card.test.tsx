/**
 * SubagentCard：主对话中 subagent 调用（带 childSessionId 的 tool_call 块）
 * 的紧凑单行渲染——整行可点打开 Pane，无折叠展开、无 footer 按钮。
 * plain 调用仍走 ToolCallCard（见 tool-call-card.test.tsx）。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageBubble } from '@/components/chat/MessageBubble';
import {
  SubagentCard,
  subagentCardComparator,
} from '@/components/chat/SubagentCard';

const runningCall = {
  id: 'c1',
  name: 'task',
  args: { message: 'T13: fresh-context self-test report\nsecond line' },
  childSessionId: 's-sub-0',
  startedAt: Date.now() - 3000,
};

describe('SubagentCard', () => {
  it('renders the compact row: muted label, primary type chip, first-line title', () => {
    render(<SubagentCard call={runningCall} />);
    expect(screen.getByText('子智能体')).toBeDefined();
    expect(screen.getByText('task')).toBeDefined();
    // 标题只取 message 首行，不渲染后续行
    expect(screen.getByText('T13: fresh-context self-test report')).toBeDefined();
    expect(screen.queryByText(/second line/)).toBeNull();
    // 无折叠展开、无「查看执行过程」footer 残留
    expect(screen.queryByText('查看执行过程')).toBeNull();
    expect(screen.queryByText('参数')).toBeNull();
  });

  it('shows no title when args.message is not a string', () => {
    render(<SubagentCard call={{ ...runningCall, args: { message: 42 } }} />);
    expect(screen.getByText('子智能体')).toBeDefined();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('opens the pane when the whole row is clicked', () => {
    const onOpenSubagent = vi.fn();
    render(<SubagentCard call={runningCall} onOpenSubagent={onOpenSubagent} />);
    fireEvent.click(screen.getByRole('button', { name: /子智能体/ }));
    expect(onOpenSubagent).toHaveBeenCalledWith('s-sub-0');
  });

  it('shows the running state (spinner + 运行中) while the result is pending', () => {
    const { container } = render(<SubagentCard call={runningCall} />);
    expect(screen.getByText('运行中')).toBeDefined();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows the done state (success icon + duration) once the result lands', () => {
    const { container } = render(
      <SubagentCard
        call={{ ...runningCall, result: 'ok', isError: false, durationMs: 4200 }}
      />,
    );
    expect(screen.queryByText('运行中')).toBeNull();
    expect(container.querySelector('.text-success')).not.toBeNull();
    expect(screen.getByText('4.2s')).toBeDefined();
  });

  it('marks errored calls with the destructive style', () => {
    const { container } = render(
      <SubagentCard
        call={{ ...runningCall, result: 'boom', isError: true, durationMs: 120 }}
      />,
    );
    expect(container.querySelector('.text-destructive')).not.toBeNull();
    expect(screen.getByText('120ms')).toBeDefined();
  });

  it('is memo-wrapped and the comparator reacts to result changes but ignores args identity', () => {
    expect((SubagentCard as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
    const base = { call: { id: 'c1', name: 'task', args: {} } };
    const sameArgs = { call: { id: 'c1', name: 'task', args: { fresh: {} } } };
    const withResult = { call: { id: 'c1', name: 'task', args: {}, result: 'done' } };
    expect(subagentCardComparator(base as never, sameArgs as never)).toBe(true);
    expect(subagentCardComparator(base as never, withResult as never)).toBe(
      false,
    );
  });
});

describe('MessageBubble sub-agent routing', () => {
  it('renders sub-agent calls as SubagentCard while plain calls keep ToolCallCard', () => {
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          blocks: [
            {
              type: 'tool_call',
              call: { id: 'c2', name: 'read_file', args: {}, result: 'ok' },
            },
            {
              type: 'tool_call',
              call: {
                id: 'c3',
                name: 'task',
                args: { message: 'hi' },
                childSessionId: 's-sub-1',
                result: 'done',
                durationMs: 900,
              },
            },
          ],
          content: '',
          timestamp: 0,
        }}
      />,
    );
    // plain 调用仍走 ToolCallCard（工具名以 mono 折叠行展示）
    expect(screen.getByText('read_file')).toBeDefined();
    // subagent 调用走 SubagentCard（紧凑单行）
    expect(screen.getAllByText('子智能体')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /子智能体/ })).toBeDefined();
  });
});
