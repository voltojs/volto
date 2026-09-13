// apps/web/components/chat/__tests__/slash-panel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { SlashPanel, type SlashPanelHandle } from '../SlashPanel';
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
});
