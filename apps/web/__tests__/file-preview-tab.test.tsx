// apps/web/__tests__/file-preview-tab.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePreviewTab } from '@/components/pane/FilePreviewTab';
import { fetchFsFile, type FsFilePayload } from '@/lib/fs-api';
import { usePaneStore } from '@/stores/pane-store';
import { useConfigStore } from '@/stores/config-store';
import { revealPath } from '@/lib/config-api';
import type { PaneTab } from '@/stores/pane-store';

vi.mock('@/lib/fs-api', () => ({ fetchFsFile: vi.fn() }));
vi.mock('@/lib/config-api', () => ({ revealPath: vi.fn().mockResolvedValue({ ok: true }) }));
const fileMock = vi.mocked(fetchFsFile);

const tab = (path: string) =>
  ({ kind: 'file-preview', id: `preview:p1:${path}`, projectId: 'p1', path }) as const;

beforeEach(() => {
  fileMock.mockReset();
  usePaneStore.setState({ tabs: [], activeTabId: null, open: false, hidden: true });
});

describe('FilePreviewTab', () => {
  it('renders highlighted text with line numbers', async () => {
    fileMock.mockResolvedValue({ kind: 'text', content: 'const a = 1;\nconst b = 2;\n', truncated: false, size: 30 });
    const { container } = render(<FilePreviewTab tab={tab('src/a.ts')} />);
    // highlight.js 拆分 keyword span，两行 `const` 产生多个匹配——断言非空而非单一元素
    expect((await screen.findAllByText(/const/)).length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-line]').length).toBe(3); // per-line gutter rows
  });

  it('renders markdown with a rendered/raw toggle', async () => {
    fileMock.mockResolvedValue({ kind: 'text', content: '# Title\n\nbody text', truncated: false, size: 20 });
    render(<FilePreviewTab tab={tab('README.md')} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '原文' }));
    expect(screen.getByText(/# Title/)).toBeDefined();
  });

  it('renders an image from the base64 payload', async () => {
    fileMock.mockResolvedValue({ kind: 'image', base64: 'aGk=', mediaType: 'image/png', size: 2 });
    render(<FilePreviewTab tab={tab('pic.png')} />);
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'data:image/png;base64,aGk=');
  });

  it('declares truncation', async () => {
    fileMock.mockResolvedValue({ kind: 'text', content: 'part', truncated: true, size: 999_999 });
    render(<FilePreviewTab tab={tab('big.log')} />);
    expect(await screen.findByText(/文件过大/)).toBeDefined();
  });

  it('shows the binary placeholder', async () => {
    fileMock.mockResolvedValue({ kind: 'binary', size: 4096 });
    render(<FilePreviewTab tab={tab('blob.dat')} />);
    expect(await screen.findByText(/不支持预览二进制文件/)).toBeDefined();
  });

  it('remounts on path change so the previous file never flashes', async () => {
    fileMock.mockResolvedValueOnce({ kind: 'text', content: 'aaa', truncated: false, size: 3 });
    const { rerender } = render(<FilePreviewTab tab={tab('a.ts')} />);
    expect(await screen.findByText('aaa')).toBeDefined();
    fileMock.mockResolvedValueOnce({ kind: 'text', content: 'bbb', truncated: false, size: 3 });
    rerender(<FilePreviewTab tab={tab('b.ts')} />);
    // b.ts 拉取期间不得残留 a.ts 内容（path-keyed 重挂载清空旧 state）
    expect(screen.queryByText('aaa')).toBeNull();
    expect(await screen.findByText('bbb')).toBeDefined();
  });

  it('offers retry on fetch failure', async () => {
    fileMock.mockRejectedValueOnce(new Error('网络故障'));
    render(<FilePreviewTab tab={tab('x.ts')} />);
    expect(await screen.findByText('网络故障')).toBeDefined();
    fileMock.mockResolvedValue({ kind: 'text', content: 'ok', truncated: false, size: 2 });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('ok')).toBeDefined();
  });
});


// --- line targeting (openFilePreview refs: `path:42`, ranges) -----------------
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

function textPayload(content: string): FsFilePayload {
  return { kind: 'text', content, truncated: false, size: content.length };
}

function makeTab(overrides: Partial<Extract<PaneTab, { kind: 'file-preview' }>> = {}): PaneTab {
  return {
    kind: 'file-preview',
    id: 'preview:p1:a.ts',
    projectId: 'p1',
    path: 'a.ts',
    ...overrides,
  };
}

const scrollIntoView = vi.fn();

/** hljs splits text across spans, so wait on the row anchors instead of text. */
async function waitForRows(n: number): Promise<void> {
  await waitFor(() => expect(document.querySelectorAll('[data-line]')).toHaveLength(n));
}

beforeEach(() => {
  vi.mocked(fetchFsFile).mockReset();
  scrollIntoView.mockReset();
  // jsdom has no layout; record the scroll target instead of performing it.
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe('FilePreviewTab line targeting', () => {
  it('renders one anchored row per line of the file', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab()} />);
    await waitForRows(10);
    for (let n = 1; n <= 10; n += 1) {
      expect(document.querySelector(`[data-line="${n}"]`)).not.toBeNull();
    }
  });

  it('highlights only the targeted line', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
      el.className.includes('bg-primary/10'),
    );
    expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['3']);
  });

  it('highlights the whole range of a range target', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3, endLine: 5 })} />);
    await waitForRows(10);
    const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
      el.className.includes('bg-primary/10'),
    );
    expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['3', '4', '5']);
  });

  it('scrolls the target line into view once the file is loaded', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const target = scrollIntoView.mock.contexts[0] as Element;
    expect(target.getAttribute('data-line')).toBe('3');
  });

  it('does not scroll when the tab carries no line target', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    render(<FilePreviewTab tab={makeTab()} />);
    await waitForRows(10);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('moves the highlight when the line target changes without a remount', async () => {
    vi.mocked(fetchFsFile).mockResolvedValue(textPayload(TEN_LINES));
    const { rerender } = render(<FilePreviewTab tab={makeTab({ line: 3 })} />);
    await waitForRows(10);
    rerender(<FilePreviewTab tab={makeTab({ line: 7 })} />);
    await waitFor(() => {
      const highlighted = [...document.querySelectorAll('[data-line]')].filter((el) =>
        el.className.includes('bg-primary/10'),
      );
      expect(highlighted.map((el) => el.getAttribute('data-line'))).toEqual(['7']);
    });
  });
});

describe('FilePreviewTab failure stays put', () => {
  it('shows the error state without navigating anywhere else', async () => {
    fileMock.mockRejectedValueOnce(new Error('Not found'));
    usePaneStore.setState({
      tabs: [tab('missing.ts')],
      activeTabId: 'preview:p1:missing.ts',
    });
    render(<FilePreviewTab tab={tab('missing.ts')} />);
    expect(await screen.findByText('Not found')).toBeDefined();
    expect(usePaneStore.getState().tabs.map((t) => t.id)).toEqual(['preview:p1:missing.ts']);
  });
});

describe('FilePreviewTab header row', () => {
  it('shows the full project path in the preview header', async () => {
    fileMock.mockResolvedValue(textPayload('hello'));
    render(<FilePreviewTab tab={tab('apps/web/lib/fs-api.ts')} />);
    await screen.findByText('hello');
    const header = screen.getByText('apps/web/lib/fs-api.ts');
    expect(header).toHaveAttribute('title', 'apps/web/lib/fs-api.ts');
  });

  it('keeps the raw toggle in the markdown header row', async () => {
    fileMock.mockResolvedValue(textPayload('# Title'));
    render(<FilePreviewTab tab={tab('docs/readme.md')} />);
    await screen.findByRole('heading', { level: 1, name: 'Title' });
    expect(screen.getByText('docs/readme.md')).toBeDefined();
    expect(screen.getByRole('button', { name: '原文' })).toBeDefined();
  });

  it('shows the path header for image previews too', async () => {
    fileMock.mockResolvedValue({ kind: 'image', base64: 'aGk=', mediaType: 'image/png', size: 2 });
    render(<FilePreviewTab tab={tab('assets/pic.png')} />);
    await screen.findByRole('img');
    expect(screen.getByText('assets/pic.png')).toBeDefined();
  });
});

describe('FilePreviewTab header actions', () => {
  it('copies the full system path from the header action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    useConfigStore.setState({
      projects: [{ id: 'p1', name: 'proj', path: '/proj', createdAt: 0 }],
    });
    fileMock.mockResolvedValue(textPayload('copy me'));
    render(<FilePreviewTab tab={tab('apps/web/lib/fs-api.ts')} />);
    await screen.findByText('copy me');
    fireEvent.click(screen.getByRole('button', { name: '复制完整路径' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('/proj/apps/web/lib/fs-api.ts'),
    );
  });

  it('copies the file content from the display area action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    fileMock.mockResolvedValue(textPayload('copy me'));
    render(<FilePreviewTab tab={tab('a.ts')} />);
    await screen.findByText('copy me');
    fireEvent.click(screen.getByRole('button', { name: '复制文件内容' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('copy me'));
  });

  it('reveals the file in the OS file manager', async () => {
    useConfigStore.setState({
      projects: [{ id: 'p1', name: 'proj', path: '/proj', createdAt: 0 }],
    });
    fileMock.mockResolvedValue(textPayload('hello'));
    render(<FilePreviewTab tab={tab('apps/web/lib/fs-api.ts')} />);
    await screen.findByText('hello');
    fireEvent.click(screen.getByRole('button', { name: '在 Finder 中显示' }));
    await waitFor(() =>
      expect(revealPath).toHaveBeenCalledWith('/proj/apps/web/lib/fs-api.ts'),
    );
  });
});
