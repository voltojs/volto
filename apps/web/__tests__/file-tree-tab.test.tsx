import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTreeTab } from '@/components/pane/FileTreeTab';
import { usePaneStore } from '@/stores/pane-store';
import { fetchFsTree, searchFsFiles } from '@/lib/fs-api';

vi.mock('@/lib/fs-api', () => ({ fetchFsTree: vi.fn(), searchFsFiles: vi.fn() }));
const treeMock = vi.mocked(fetchFsTree);
const searchMock = vi.mocked(searchFsFiles);

const tab = { kind: 'files', id: 'files:p1', projectId: 'p1' } as const;

beforeEach(() => {
  usePaneStore.setState({ tabs: [tab], activeTabId: 'files:p1' });
  treeMock.mockReset();
  searchMock.mockReset();
  treeMock.mockResolvedValue({
    path: '',
    entries: [
      { name: 'src', type: 'dir', size: 0 },
      { name: 'README.md', type: 'file', size: 5 },
    ],
  });
  searchMock.mockResolvedValue({ matches: [{ path: 'src/a.ts', type: 'file' }] });
});

describe('FileTreeTab', () => {
  it('loads and renders the root lazily', async () => {
    render(<FileTreeTab tab={tab} />);
    expect(await screen.findByText('README.md')).toBeDefined();
    expect(treeMock).toHaveBeenCalledWith('p1', '');
  });

  it('expands a directory on demand', async () => {
    treeMock.mockResolvedValueOnce({
      path: '',
      entries: [{ name: 'src', type: 'dir', size: 0 }],
    });
    treeMock.mockResolvedValueOnce({
      path: 'src',
      entries: [{ name: 'a.ts', type: 'file', size: 3 }],
    });
    render(<FileTreeTab tab={tab} />);
    fireEvent.click(await screen.findByText('src'));
    expect(await screen.findByText('a.ts')).toBeDefined();
    expect(treeMock).toHaveBeenLastCalledWith('p1', 'src');
  });

  it('opens a file-preview tab when a file is clicked', async () => {
    render(<FileTreeTab tab={tab} />);
    fireEvent.click(await screen.findByText('README.md'));
    const { tabs, activeTabId } = usePaneStore.getState();
    expect(tabs.find((t) => t.id === 'preview:p1:README.md')).toMatchObject({
      kind: 'file-preview',
      projectId: 'p1',
      path: 'README.md',
    });
    expect(activeTabId).toBe('preview:p1:README.md');
  });

  it('switches to search results when the filter is non-empty (debounced)', async () => {
    // shouldAdvanceTime: vitest fake timers + RTL findBy* 需要真实时间流逝推进
    // waitFor 的轮询与 React 调度提交（testing-library 只识别 jest 全局，vitest 下
    // 纯假定时器会让 findByText 永久挂起——实测 verbatim 版本挂死，见 task-9-report.md）。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<FileTreeTab tab={tab} />);
      await screen.findByText('README.md');
      fireEvent.change(screen.getByPlaceholderText('搜索文件或目录'), { target: { value: 'a.ts' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(await screen.findByText('src/a.ts')).toBeDefined();
      expect(searchMock).toHaveBeenCalledWith('p1', 'a.ts');
    } finally {
      vi.useRealTimers();
    }
  });

  it('directory search hits exit search mode and expand the tree to that folder', async () => {
    searchMock.mockResolvedValue({ matches: [{ path: 'src/components', type: 'dir' }] });
    treeMock.mockImplementation((pid: string, rel = '') =>
      Promise.resolve({
        path: rel,
        entries:
          rel === ''
            ? [
                { name: 'src', type: 'dir', size: 0 },
                { name: 'README.md', type: 'file', size: 5 },
              ]
            : rel === 'src'
              ? [
                  { name: 'components', type: 'dir', size: 0 },
                  { name: 'a.ts', type: 'file', size: 1 },
                ]
              : [{ name: 'Button.tsx', type: 'file', size: 2 }],
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<FileTreeTab tab={tab} />);
      await screen.findByText('README.md');
      fireEvent.change(screen.getByPlaceholderText('搜索文件或目录'), { target: { value: 'comp' } });
      await vi.advanceTimersByTimeAsync(300);
      fireEvent.click(await screen.findByText('src/components'));
      // Back in tree mode with the target directory expanded.
      expect(await screen.findByText('Button.tsx')).toBeDefined();
      const filter = screen.getByPlaceholderText('搜索文件或目录') as HTMLInputElement;
      expect(filter.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error with retry when the tree fetch fails', async () => {
    treeMock.mockRejectedValue(new Error('boom'));
    render(<FileTreeTab tab={tab} />);
    expect(await screen.findByText('boom')).toBeDefined();
  });

  it('remounts fresh when the projectId changes (stale expansion and cache dropped)', async () => {
    treeMock.mockImplementation((pid: string, rel = '') =>
      Promise.resolve({
        path: rel,
        entries:
          rel === ''
            ? [{ name: 'src', type: 'dir', size: 0 }]
            : [{ name: `${pid}-child.ts`, type: 'file', size: 1 }],
      }),
    );
    const { rerender } = render(<FileTreeTab tab={tab} />);
    fireEvent.click(await screen.findByText('src'));
    expect(await screen.findByText('p1-child.ts')).toBeDefined();
    const next = { kind: 'files', id: 'files:p2', projectId: 'p2' } as const;
    rerender(<FileTreeTab tab={next} />);
    // 无 key 修复时：src 仍展开且复用 p1 缓存的子项，点击只会收起，p2-child.ts 永不出现。
    fireEvent.click(await screen.findByText('src'));
    expect(await screen.findByText('p2-child.ts')).toBeDefined();
    expect(treeMock).toHaveBeenLastCalledWith('p2', 'src');
  });
});

describe('FileTreeTab error domain', () => {
  it('keeps the tree usable when expanding a directory fails', async () => {
    treeMock.mockImplementation(async (_projectId: string, rel = '') => {
      if (rel === '') {
        return {
          path: '',
          entries: [
            { name: 'src', type: 'dir', size: 0 },
            { name: 'README.md', type: 'file', size: 5 },
          ],
        };
      }
      throw new Error('Not found');
    });
    render(<FileTreeTab tab={tab} />);
    fireEvent.click(await screen.findByText('src'));
    await waitFor(() => expect(treeMock).toHaveBeenCalledWith('p1', 'src'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A failed background expansion must not clobber the tree with an error page.
    expect(screen.getByText('README.md')).toBeDefined();
    expect(screen.queryByText('Not found')).toBeNull();
  });
});
