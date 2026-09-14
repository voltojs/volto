// apps/web/components/chat/__tests__/file-mention-panel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import { FileMentionPanel, type FileMentionPanelHandle } from '../FileMentionPanel';
import { clearFileMentionCache } from '@/hooks/use-file-mention-items';

// jsdom 未实现 Element.scrollIntoView（真实浏览器都有），而 panel 的 active 行
// 滚动跟随 effect 依赖它——文件级补缺，同一个 vi.fn 兼作断言探针。
const scrollIntoViewSpy = vi.fn();
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
});
afterAll(() => {
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{"error":"nf"}', { status: 404 });
  });
}

const TREE = { path: '', entries: [{ name: 'src', type: 'dir', size: 0 }, { name: 'a.ts', type: 'file', size: 3 }] };

describe('FileMentionPanel', () => {
  beforeEach(() => clearFileMentionCache());
  afterEach(() => vi.unstubAllGlobals());

  it('渲染目录与文件行；点击文件回调 onSelect', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const onSelect = vi.fn();
    render(<FileMentionPanel query="" projectId="p1" onSelect={onSelect} onDrill={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
    fireEvent.click(screen.getByText('a.ts').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith({ name: 'a.ts', path: 'a.ts', type: 'file' });
  });

  it('点击目录回调 onDrill', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const onDrill = vi.fn();
    render(<FileMentionPanel query="" projectId="p1" onSelect={vi.fn()} onDrill={onDrill} />);
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    fireEvent.click(screen.getByText('src').closest('button')!);
    expect(onDrill).toHaveBeenCalledWith({ name: 'src', path: 'src', type: 'dir' });
  });

  it('键盘：Tab 在目录上进目录；Enter 在目录/文件上一律选中插入', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const onSelect = vi.fn();
    const onDrill = vi.fn();
    const ref = createRef<FileMentionPanelHandle>();
    render(<FileMentionPanel ref={ref} query="" projectId="p1" onSelect={onSelect} onDrill={onDrill} />);
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    // activeIndex 初始 0 = src（目录）
    expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);
    expect(onDrill).toHaveBeenCalledWith({ name: 'src', path: 'src', type: 'dir' });
    expect(onSelect).not.toHaveBeenCalled();
    // Enter 在目录上 = 选中插入（目录可直接被引用），不进目录
    expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ name: 'src', path: 'src', type: 'dir' });
    expect(onDrill).toHaveBeenCalledTimes(1); // 仅 Tab 一次
    // ArrowDown 移到文件行（a.ts）：Enter 选中文件
    expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(true);
    expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ name: 'a.ts', path: 'a.ts', type: 'file' });
    expect(onDrill).toHaveBeenCalledTimes(1);
  });

  it('行内提示：目录显示 Tab，文件显示 ⏎', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    render(<FileMentionPanel query="" projectId="p1" onSelect={vi.fn()} onDrill={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    const dirRow = screen.getByText('src').closest('button')!;
    const fileRow = screen.getByText('a.ts').closest('button')!;
    expect(dirRow.querySelector('kbd[data-slot="kbd"]')?.textContent).toBe('Tab');
    expect(fileRow.querySelector('kbd[data-slot="kbd"]')?.textContent).toBe('⏎');
  });

  it('search 请求失败显示重试（错误不再卡 loading）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
    render(<FileMentionPanel query="store" projectId="p1" onSelect={vi.fn()} onDrill={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('重试')).toBeTruthy());
    expect(screen.getByText('文件列表加载失败')).toBeTruthy();
  });

  it('错误态显示重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
    render(<FileMentionPanel query="" projectId="p1" onSelect={vi.fn()} onDrill={vi.fn()} />);
    // brief 原断言 getByText(/boom/) 与 brief 自身代码冲突：hook 契约
    // {entries, status, retry} 丢弃错误 message，panel 渲染静态文案。
    // 已裁决对齐测试到代码（保留意图：错误态渲染 + 重试按钮可见）。
    await waitFor(() => expect(screen.getByText('文件列表加载失败')).toBeTruthy());
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('ArrowDown 移动高亮时对 active 行 scrollIntoView（长列表滚动跟随）', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const ref = createRef<FileMentionPanelHandle>();
    render(<FileMentionPanel ref={ref} query="" projectId="p1" onSelect={vi.fn()} onDrill={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
    scrollIntoViewSpy.mockClear(); // 挂载期首次 effect（若行已渲染）不计入断言
    act(() => {
      ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
  });
});
