// apps/web/hooks/__tests__/use-slash-command-items.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSlashCommandItems, clearSlashCommandCache } from '../use-slash-command-items';

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

describe('useSlashCommandItems', () => {
  beforeEach(() => clearSlashCommandCache());
  afterEach(() => vi.unstubAllGlobals());

  it('合并 action + templates + skills（顺序 verbatim），skills 过滤 userInvocable', async () => {
    vi.stubGlobal('fetch', stubFetch({
      '/commands': { commands: [{ name: 'plan', description: '制定计划', args: { type: 'string' } }] },
      '/skills': { skills: [
        { name: 'pdf', description: 'PDF 工具', modelInvocable: true, userInvocable: true },
        { name: 'hidden', description: '不给用户用', modelInvocable: true, userInvocable: false },
      ] },
    }));
    const { result } = renderHook(() => useSlashCommandItems('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.name)).toEqual(['clear', 'plan', 'pdf']);
  });

  it('缓存命中：第二个 hook 实例不再发请求', async () => {
    const fetchMock = stubFetch({
      '/commands': { commands: [] },
      '/skills': { skills: [] },
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useSlashCommandItems('p1'));
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = renderHook(() => useSlashCommandItems('p1'));
    expect(second.result.current.items).toEqual(first.result.current.items);
    expect(second.result.current.isLoading).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('projectId 不同则缓存键不同（重新拉取）', async () => {
    const fetchMock = stubFetch({ '/commands': { commands: [] }, '/skills': { skills: [] } });
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useSlashCommandItems('p1'));
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    const calls = fetchMock.mock.calls.length;
    const second = renderHook(() => useSlashCommandItems('p2'));
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('失败态 + retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })));
    const { result } = renderHook(() => useSlashCommandItems(null));
    await waitFor(() => expect(result.current.error).toContain('boom'));
    vi.stubGlobal('fetch', stubFetch({ '/commands': { commands: [] }, '/skills': { skills: [] } }));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.items.map((i) => i.name)).toEqual(['clear']));
  });
});
