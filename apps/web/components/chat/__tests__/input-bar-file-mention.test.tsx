import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { InputBar, type InputBarProps } from '../InputBar';
import { clearFileMentionCache } from '@/hooks/use-file-mention-items';
import { clearSlashCommandCache } from '@/hooks/use-slash-command-items';

// jsdom 未实现 Range.getClientRects / Range.getBoundingClientRect（真实浏览器
// 都有）。tiptap 的 focus() 命令在 requestAnimationFrame 里才执行
// scrollIntoView（@tiptap/core focus.ts），该 rAF 回调经常晚于测试结束才触发，
// 此时 prosemirror coordsAtPos 的文本路径对 Range 调用上述 API → TypeError →
// vitest 记为 unhandled error（测试本身全绿，但进程退出码 1），全量跑偶发
// 击穿门禁。补齐空实现：singleRect 拿到空 rects 后走 getBoundingClientRect
// 兜底返回零矩形（jsdom 无布局，滚动为无害 no-op）。每个测试文件持有独立
// jsdom 环境，顶层补丁不跨文件泄漏（与文件级 ResizeObserver stub 同一模式）。
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const emptyRectList: DOMRectList = Object.assign([] as DOMRect[], { item: () => null });
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{"error":"nf"}', { status: 404 });
  });
}

const TREE = {
  path: '',
  entries: [
    { name: 'src', type: 'dir', size: 0 },
    { name: 'a.ts', type: 'file', size: 3 },
  ],
};

function setup(props: Partial<InputBarProps> = {}) {
  const onSubmit = vi.fn();
  let editor: Editor | undefined;
  const utils = render(
    <InputBar
      onSubmit={onSubmit}
      projectId="p1"
      onEditorReady={(e) => {
        editor = e;
      }}
      {...props}
    />,
  );
  return { onSubmit, get editor() { return editor!; }, ...utils };
}

describe('InputBar @ 文件面板', () => {
  beforeEach(() => {
    clearFileMentionCache();
    clearSlashCommandCache();
    // tiptap Suggestion 的托管 mount（props.mount）走 floating-ui autoUpdate，
    // 其 elementResize 分支默认探测 `typeof ResizeObserver === 'function'`——
    // jsdom 没有该构造器，须文件级 stub 才激活（IntersectionObserver 同样缺失
    // 时 layoutShift 分支保持自动关闭，无需额外 stub）。刻意不进
    // vitest.setup.ts：全局 RO stub 会连带激活 base-ui ScrollArea 的
    // getAnimations 路径（jsdom 也没有 getAnimations），T9 实测会让
    // subagent-tab.test 抛未捕获异常，而补偿性 getAnimations stub 又破坏
    // catalog-provider-form——故只在本文件 stub，afterEach 统一还原。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('输入 @ 弹面板并列出根目录', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('@'));
    await waitFor(() => expect(document.body.querySelector('[data-testid="file-mention-panel"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
  });

  it('点击文件 → mention chip 插入，序列化为 @路径+空格', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('@'));
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
    fireEvent.click(screen.getByText('a.ts').closest('button')!);
    expect(editor.getText()).toBe('@a.ts ');
    const chip = document.querySelector('.file-mention-chip');
    expect(chip).toBeTruthy();
  });

  it('点击目录 → 查询改写为 src/（进目录），面板按新查询重拉', async () => {
    const fetchMock = stubFetch({
      // 顺序敏感：'path=src%2F' 必须在 '/fs/tree' 之前命中（includes 匹配取第一个）
      'path=src%2F': { path: 'src/', entries: [{ name: 'main.ts', type: 'file', size: 1 }] },
      '/fs/tree': TREE,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { editor } = setup();
    act(() => void editor.commands.insertContent('@'));
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    fireEvent.click(screen.getByText('src').closest('button')!);
    expect(editor.getText()).toBe('@src/');
    await waitFor(() => expect(screen.getByText('main.ts')).toBeTruthy());
  });

  it('Tab 在目录上 = 进目录（与点击等价）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      // 顺序敏感：'path=src%2F' 必须在 '/fs/tree' 之前命中
      'path=src%2F': { path: 'src/', entries: [] },
      '/fs/tree': TREE,
    }));
    const { editor } = setup();
    const editorEl = () => document.querySelector('[data-testid="input-editor"]')!;
    act(() => void editor.commands.insertContent('@'));
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    // 行首渲染的 commit 与 passive effect（useMenuNavigation 的 itemCountRef 镜像）
    // 之间存在微任务级窗口：waitFor 的 MutationObserver 可先于 effect flush 解析，
    // 此时 Tab 命中 stale itemCount=0，onTab 被吞（实测全量跑偶发 '@' 不变）。
    // act 收尾强制 flush effect 消除竞态；点击路径不走 ref 镜像，无此问题。
    await act(async () => {});
    fireEvent.keyDown(editorEl(), { key: 'Tab', bubbles: true, cancelable: true });
    expect(editor.getText()).toBe('@src/');
  });

  it('filter 模式进目录：@src/com 点击 components → @src/components/（只替换 query 段，保留 @）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      // 顺序敏感：'path=src%2F' 必须在 '/fs/tree' 之前命中
      'path=src%2F': {
        path: 'src/',
        entries: [
          { name: 'components', type: 'dir', size: 0 },
          { name: 'main.ts', type: 'file', size: 1 },
        ],
      },
      '/fs/tree': TREE,
    }));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('@src/com'));
    await waitFor(() => expect(screen.getByText('components')).toBeTruthy());
    fireEvent.click(screen.getByText('components').closest('button')!);
    expect(editor.getText()).toBe('@src/components/');
  });

  it('选中文件后发送 → onSubmit 收到 @路径 纯文本', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const { editor, onSubmit } = setup();
    act(() => {
      editor.commands.insertContent('看 ');
      editor.commands.insertContent('@');
    });
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
    fireEvent.click(screen.getByText('a.ts').closest('button')!);
    const sendButton = screen.getByRole('button', { name: '发送' });
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith('看 @a.ts');
  });

  it('未绑定项目时 @ 不触发面板', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const { editor } = setup({ projectId: null });
    act(() => void editor.commands.insertContent('@'));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.querySelector('[data-testid="file-mention-panel"]')).toBeNull();
  });

  it('词中 @（x@）也触发（spec §4：@ 可在消息任意位置）', async () => {
    vi.stubGlobal('fetch', stubFetch({ '/fs/tree': TREE }));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('x@'));
    await waitFor(() => expect(document.body.querySelector('[data-testid="file-mention-panel"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
  });
});
