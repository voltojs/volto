import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubagentCard } from '../SubagentCard';
import { ToolCallCard } from '../ToolCallCard';

describe('verification badges', () => {
  it('shows the failed badge on a subagent card', () => {
    render(<SubagentCard call={{
      id: '1', name: 'task', args: { message: 'do it' }, result: 'out',
      childSessionId: 's-sub-1', verification: { status: 'failed', attempts: 2, failures: ['no tests'] },
    }} />);
    expect(screen.getByText('未通过（2 次）')).toBeInTheDocument();
  });
  it('shows verification on a task_output row', () => {
    render(<ToolCallCard call={{
      id: '2', name: 'task_output', args: { task_id: 't1' }, result: 'out',
      verification: { status: 'passed', attempts: 1, failures: [] },
    }} label="t1" />);
    expect(screen.getByText('已验收')).toBeInTheDocument();
  });
  it('keeps both facts in the merged warning slot', () => {
    render(<SubagentCard call={{
      id: '3', name: 'task', args: { message: 'do it' }, result: 'out',
      childSessionId: 's-sub-3', subagentDroppedTools: ['run_bash_command'],
      verification: { status: 'failed', attempts: 2, failures: ['no tests'] },
    }} />);
    // The marker text carries the dropped-tools count and the verdict badge,
    // joined with " · "; the hover detail merges both explanations.
    const marker = screen.getByText('1 项不可用 · 未通过（2 次）');
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveAttribute(
      'title',
      '工具派发时被丢弃：run_bash_command · 未通过：no tests',
    );
  });
});
