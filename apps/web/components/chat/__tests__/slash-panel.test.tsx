// apps/web/components/chat/__tests__/slash-panel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createRef } from 'react';
import { SlashPanel, type SlashPanelHandle } from '../SlashPanel';
import { clearSlashCommandCache } from '@/hooks/use-slash-command-items';

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

describe('SlashPanel', () => {
  beforeEach(() => clearSlashCommandCache());
  afterEach(() => vi.unstubAllGlobals());

  it('渲染两组（系统内置 + SKILLS）并高亮 activeIndex', async () => {
    vi.stubGlobal('fetch', stubFetch({
      '/commands': { commands: [{ name: 'plan', description: '制定计划' }] },
      '/skills': { skills: [{ name: 'pdf', description: 'PDF', modelInvocable: true, userInvocable: true }] },
    }));
    render(<SlashPanel query="" projectId="p1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('SKILLS')).toBeTruthy());
    expect(screen.getByText('系统内置')).toBeTruthy();
    expect(screen.getByText('/plan')).toBeTruthy();
    expect(screen.getByText('/pdf')).toBeTruthy();
    // 命令名强制单行：whitespace-nowrap + truncate，description 走 flex truncate
    const name = screen.getByText('/plan');
    expect(name.className).toContain('whitespace-nowrap');
    expect(name.className).toContain('truncate');
  });

  it('query 过滤 + 空态 + error 重试', async () => {
    vi.stubGlobal('fetch', stubFetch({
      '/commands': { commands: [{ name: 'plan', description: '制定计划' }] },
      '/skills': { skills: [] },
    }));
    const { rerender } = render(<SlashPanel query="zz" projectId="p1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('无匹配命令')).toBeTruthy());
    rerender(<SlashPanel query="pl" projectId="p1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/plan')).toBeTruthy());

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
    clearSlashCommandCache();
    rerender(<SlashPanel query="" projectId="p2" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('点击行回调 onSelect；键盘 Enter 选中首个并恒消费', async () => {
    const onSelect = vi.fn();
    vi.stubGlobal('fetch', stubFetch({
      '/commands': { commands: [{ name: 'plan', description: '制定计划' }] },
      '/skills': { skills: [] },
    }));
    const ref = createRef<SlashPanelHandle>();
    render(<SlashPanel ref={ref} query="" projectId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('/plan')).toBeTruthy());
    fireEvent.click(screen.getByText('/plan').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'template', name: 'plan' }));
    expect(ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
  });

  it('ArrowDown 移动高亮时对 active 行 scrollIntoView（长列表滚动跟随）', async () => {
    vi.stubGlobal('fetch', stubFetch({
      '/commands': {
        commands: [
          { name: 'plan', description: '制定计划' },
          { name: 'review', description: '审查改动' },
        ],
      },
      '/skills': { skills: [] },
    }));
    const ref = createRef<SlashPanelHandle>();
    render(<SlashPanel ref={ref} query="" projectId="p1" onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('/review')).toBeTruthy());
    scrollIntoViewSpy.mockClear(); // 挂载期首次 effect（若行已渲染）不计入断言
    act(() => {
      ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
  });
});
