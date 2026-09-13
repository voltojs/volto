import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { InputBar, type InputBarProps } from '../InputBar';
import { applyTopStartAnchor } from '../suggestion-popup';
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

const ROUTES = {
  '/commands': {
    commands: [
      { name: 'plan', description: '制定计划' },
      { name: 'review', description: '审查改动' },
      { name: 'explain', description: '解释实现' },
    ],
  },
  '/skills': { skills: [] },
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

describe('applyTopStartAnchor（top-start 应用时锚定）', () => {
  function el(height: number) {
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetHeight', { value: height, configurable: true });
    return element;
  }

  it('按 caret rect 与实时元素高度写 position/left/top', () => {
    const element = el(40);
    applyTopStartAnchor(element, new DOMRect(50, 100, 0, 0));
    expect(element.style.position).toBe('fixed'); // caretRect 是视口坐标
    expect(element.style.left).toBe('50px');
    expect(element.style.top).toBe('56px'); // 100 − 40 − 4
  });

  it('上方空间不足时钳制在 8px（不做翻转逻辑）', () => {
    const element = el(40);
    applyTopStartAnchor(element, new DOMRect(0, 20, 0, 0));
    expect(element.style.top).toBe('8px'); // max(8, 20 − 40 − 4)
  });

  it('caretRect 为 null 时不写任何样式', () => {
    const element = el(40);
    applyTopStartAnchor(element, null);
    expect(element.style.position).toBe('');
    expect(element.style.left).toBe('');
    expect(element.style.top).toBe('');
  });
});

describe('InputBar / 斜杠命令面板', () => {
  beforeEach(() => {
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

  it('文档首字符输入 / 弹出面板（挂到 body）且显示内置命令', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('/pl'));
    await waitFor(() => expect(document.body.querySelector('[data-testid="slash-panel"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('/plan')).toBeTruthy());
  });

  it('面板以 onPosition 应用时锚定：挂载元素 inline position=fixed（非插件默认 style 写入路径）', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('/pl'));
    await waitFor(() => expect(document.body.querySelector('[data-testid="slash-panel"]')).toBeTruthy());
    // 锚定样式写在 mount 挂载的包装元素（ReactRenderer.element，面板的父节点）上，
    // 不在面板组件根上——position=fixed 证明 onPosition 路径生效，插件默认
    // style 写入路径（absolute + 空 panel 高度测量）已被接管。
    const mounted = document.body.querySelector('[data-testid="slash-panel"]')!.parentElement as HTMLElement;
    await waitFor(() => expect(mounted.style.position).toBe('fixed'));
  });

  it('选中命令：编辑器文本替换为 /plan （纯文本），面板关闭', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('/pl'));
    await waitFor(() => expect(screen.getByText('/plan')).toBeTruthy());
    fireEvent.click(screen.getByText('/plan').closest('button')!);
    expect(editor.getText()).toBe('/plan ');
    await waitFor(() => expect(document.body.querySelector('[data-testid="slash-panel"]')).toBeNull());
  });

  it('面板打开时 Enter 被面板消费：不发送、不插段落（用无匹配 query 排除选中竞态）', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor } = setup();
    const editorEl = () => document.querySelector('[data-testid="input-editor"]')!;
    act(() => void editor.commands.insertContent('/zz')); // 无匹配 → filtered 空，Enter 无论 fetch 时序都只吞咽
    await waitFor(() => expect(document.body.querySelector('[data-testid="slash-panel"]')).toBeTruthy());
    fireEvent.keyDown(editorEl(), { key: 'Enter', bubbles: true, cancelable: true });
    expect(editor.getText()).toBe('/zz');
    expect(editor.getJSON().content?.length).toBe(1);
  });

  it('非首字符的 / 不触发', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor } = setup();
    act(() => void editor.commands.insertContent('hello /'));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.querySelector('[data-testid="slash-panel"]')).toBeNull();
  });

  it('选中后补参数发送 → onSubmit 收到完整 /plan 命令文本', async () => {
    vi.stubGlobal('fetch', stubFetch(ROUTES));
    const { editor, onSubmit } = setup();
    const sendButton = () => screen.getByRole('button', { name: '发送' });
    act(() => void editor.commands.insertContent('/pl'));
    await waitFor(() => expect(screen.getByText('/plan')).toBeTruthy());
    fireEvent.click(screen.getByText('/plan').closest('button')!);
    act(() => void editor.commands.insertContent('做个深色模式'));
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledWith('/plan 做个深色模式');
  });
});
