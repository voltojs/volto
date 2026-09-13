import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { InputBar, type InputBarProps } from '../InputBar';
import { clearSlashCommandCache } from '@/hooks/use-slash-command-items';

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
