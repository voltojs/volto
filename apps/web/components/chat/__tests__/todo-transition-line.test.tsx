import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TodoTransitionLine } from '../TodoTransitionLine';

describe('TodoTransitionLine', () => {
  it('renders each transition kind with its verb', () => {
    render(<TodoTransitionLine transition={{ kind: 'completed', content: '写测试' }} />);
    expect(screen.getByText(/完成/)).toBeInTheDocument();
    expect(screen.getByText(/写测试/)).toBeInTheDocument();
  });

  it.each([
    ['started', '开始'],
    ['completed', '完成'],
    ['reopened', '重新打开'],
    ['added', '新增'],
    ['removed', '移除'],
  ] as const)('renders %s as "%s"', (kind, verb) => {
    render(<TodoTransitionLine transition={{ kind, content: '任务项' }} />);
    expect(screen.getByText(new RegExp(verb))).toBeInTheDocument();
    expect(screen.getByText('任务项')).toBeInTheDocument();
  });

  it('marks completions with the success tone class', () => {
    const { container } = render(
      <TodoTransitionLine transition={{ kind: 'completed', content: 'x' }} />,
    );
    expect(container.textContent).toContain('完成');
    expect(container.querySelector('.text-success')).not.toBeNull();
  });
});
