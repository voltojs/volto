import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoDock } from '../TodoDock';
import type { TodoItem } from '@/lib/todos-model';

const list: TodoItem[] = [
  { content: 'Task 1-8 + R6', status: 'completed' },
  { content: '端到端手工验收', status: 'in_progress' },
  { content: '最终全分支 review', status: 'pending' },
  { content: '推送分支到远程', status: 'pending' },
];

describe('TodoDock', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<TodoDock todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows header progress and all items when expanded', () => {
    render(<TodoDock todos={list} />);
    expect(screen.getByTestId('todo-dock')).toBeInTheDocument();
    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('1 / 4 已完成')).toBeInTheDocument();
    expect(screen.getByText('Task 1-8 + R6')).toBeInTheDocument();
    expect(screen.getByText('端到端手工验收')).toBeInTheDocument();
  });

  it('collapses and expands via the header toggle', () => {
    render(<TodoDock todos={list} />);
    fireEvent.click(screen.getByRole('button', { name: /折叠任务列表/ }));
    expect(screen.queryByText('Task 1-8 + R6')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /展开任务列表/ }));
    expect(screen.getByText('Task 1-8 + R6')).toBeInTheDocument();
  });
});
