/**
 * plain（非 sub-agent）工具调用卡片：ToolCallCard 保持原有折叠渲染，
 * 不含任何 subagent 分支（sub-agent 调用改由 SubagentCard 渲染，
 * 见 subagent-card.test.tsx）。
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallCard } from '@/components/chat/ToolCallCard';

describe('ToolCallCard', () => {
  it('plain tool calls keep the existing rendering (no open button, no 运行中)', () => {
    render(<ToolCallCard call={{ id: 'c2', name: 'read_file', args: {} }} />);
    expect(screen.getByText('read_file')).toBeDefined();
    expect(screen.queryByRole('button', { name: /查看执行过程/ })).toBeNull();
    expect(screen.queryByText('运行中')).toBeNull();
  });

  it('renders even a child-bearing call as a plain card (no sub-agent branch)', () => {
    render(
      <ToolCallCard
        call={{
          id: 'c3',
          name: 'task',
          args: { message: 'go' },
          childSessionId: 's-sub-0',
          startedAt: Date.now() - 3000,
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /查看执行过程/ })).toBeNull();
    expect(screen.queryByText('运行中')).toBeNull();
  });
});
