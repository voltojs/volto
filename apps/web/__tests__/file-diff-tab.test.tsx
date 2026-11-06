import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileDiffTab } from '@/components/pane/FileDiffTab';
import { usePaneStore, type PaneTab } from '@/stores/pane-store';

const tab = (overrides: Partial<Extract<PaneTab, { kind: 'file-diff' }>> = {}): PaneTab => ({
  kind: 'file-diff',
  id: 'diff:p1:2:src/a.ts',
  projectId: 'p1',
  path: 'src/a.ts',
  turn: '2',
  diff: ['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n'),
  additions: 1,
  deletions: 1,
  edits: 1,
  ...overrides,
});

beforeEach(() => {
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
});

describe('FileDiffTab', () => {
  it('renders the header with the path and counts', () => {
    render(<FileDiffTab tab={tab()} />);
    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByText('+1')).toBeDefined();
    expect(screen.getByText('-1')).toBeDefined();
  });

  it('renders added and removed lines with their own kind', () => {
    const { container } = render(<FileDiffTab tab={tab()} />);
    expect(container.querySelectorAll('[data-kind="add"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="remove"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-kind="context"]')).toHaveLength(1);
    expect(screen.getByText('@@ -1,2 +1,2 @@')).toBeDefined();
  });

  it('declares a truncated body', () => {
    render(<FileDiffTab tab={tab({ truncated: true })} />);
    expect(screen.getByText('diff 内容已截断，仅显示前一部分')).toBeDefined();
  });

  it('shows the edit count only when a file was edited more than once', () => {
    const { unmount } = render(<FileDiffTab tab={tab({ edits: 1 })} />);
    expect(screen.queryByText('1 次编辑')).toBeNull();
    unmount();
    render(<FileDiffTab tab={tab({ edits: 3 })} />);
    expect(screen.getByText('3 次编辑')).toBeDefined();
  });

  it('opens the file preview from the header action', () => {
    render(<FileDiffTab tab={tab()} />);
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(usePaneStore.getState().tabs[0]).toMatchObject({
      kind: 'file-preview',
      projectId: 'p1',
      path: 'src/a.ts',
    });
  });

  it('renders an empty state for an empty body', () => {
    render(<FileDiffTab tab={tab({ diff: '' })} />);
    expect(screen.getByText('无差异')).toBeDefined();
  });
});