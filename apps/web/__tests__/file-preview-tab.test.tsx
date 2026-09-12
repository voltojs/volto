// apps/web/__tests__/file-preview-tab.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreviewTab } from '@/components/pane/FilePreviewTab';
import { fetchFsFile } from '@/lib/fs-api';

vi.mock('@/lib/fs-api', () => ({ fetchFsFile: vi.fn() }));
const fileMock = vi.mocked(fetchFsFile);

const tab = (path: string) =>
  ({ kind: 'file-preview', id: `preview:p1:${path}`, projectId: 'p1', path }) as const;

beforeEach(() => fileMock.mockReset());

describe('FilePreviewTab', () => {
  it('renders highlighted text with line numbers', async () => {
    fileMock.mockResolvedValue({ kind: 'text', content: 'const a = 1;\nconst b = 2;\n', truncated: false, size: 30 });
    const { container } = render(<FilePreviewTab tab={tab('src/a.ts')} />);
    // highlight.js 拆分 keyword span，两行 `const` 产生多个匹配——断言非空而非单一元素
    expect((await screen.findAllByText(/const/)).length).toBeGreaterThan(0);
    expect(container.querySelector('pre[aria-hidden]')).not.toBeNull(); // 行号槽
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

  it('offers retry on fetch failure', async () => {
    fileMock.mockRejectedValueOnce(new Error('网络故障'));
    render(<FilePreviewTab tab={tab('x.ts')} />);
    expect(await screen.findByText('网络故障')).toBeDefined();
    fileMock.mockResolvedValue({ kind: 'text', content: 'ok', truncated: false, size: 2 });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('ok')).toBeDefined();
  });
});
